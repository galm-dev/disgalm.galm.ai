// Sinalização do Disgalm. Sem dependências: WebSocket na mão sobre os built-ins.
// Só transporta SDP/ICE entre pares de uma sala — nunca toca em mídia.
import { createServer as criarHttp } from 'node:http'
import { createServer as criarHttps } from 'node:https'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

// getUserMedia e getDisplayMedia só existem em contexto seguro. localhost já é
// seguro; qualquer outro endereço exige TLS, senão as APIs somem para os amigos.
const local = f => new URL(`./local/${f}`, import.meta.url)
const tls = await Promise.all([readFile(local('key.pem')), readFile(local('cert.pem'))])
  .then(([key, cert]) => ({ key, cert }))
  .catch(() => null)

// 8443 está ocupada pelo Tailscale nesta máquina.
const PORT = process.env.PORT || (tls ? 8444 : 8080)
const RAIZ = new URL('./public/', import.meta.url).pathname
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11' // RFC 6455

const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wav': 'audio/wav',
  '.svg': 'image/svg+xml', '.png': 'image/png' }

// Chaves do TURN vivem em local/ (fora do git). Quando são da Cloudflare,
// o navegador recebe apenas credenciais efêmeras geradas pela API.
async function iceServers() {
  const env = {}
  try {
    for (const linha of (await readFile(new URL('./local/turn.env', import.meta.url), 'utf8')).split('\n')) {
      const i = linha.indexOf('=')
      if (i > 0) env[linha.slice(0, i).trim()] = linha.slice(i + 1).trim()
    }
  } catch {
    return [{ urls: 'stun:stun.cloudflare.com:3478' }]
  }

  const lista = []
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    try {
      const r = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        },
      )
      if (r.ok) lista.push(...((await r.json()).iceServers || []))
    } catch { /* o TURN estático abaixo ainda pode estar disponível */ }
  }
  if (env.TURN_HOST && env.TURN_USER && env.TURN_PASS) {
    const host = `${env.TURN_HOST}:${env.TURN_PORT || '3478'}`
    lista.push({
      urls: [`turn:${host}?transport=udp`, `turn:${host}?transport=tcp`],
      username: env.TURN_USER,
      credential: env.TURN_PASS,
    })
  }
  return lista.length ? lista : [{ urls: 'stun:stun.cloudflare.com:3478' }]
}

const servidor = (tls ? criarHttps : criarHttp)(tls || {}, async (req, res) => {
  if (req.url === '/ice') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(await iceServers()))
  }
  const caminho = normalize(req.url.split('?')[0]).replace(/^(\.\.[/\\])+/, '')
  const arquivo = join(RAIZ, caminho === '/' ? 'index.html' : caminho)
  try {
    const corpo = await readFile(arquivo)
    res.writeHead(200, { 'content-type': TIPOS[extname(arquivo)] || 'application/octet-stream' })
    res.end(corpo)
  } catch {
    res.writeHead(404).end('nao encontrado')
  }
})

// ---------- WebSocket ----------

servidor.on('upgrade', (req, socket) => {
  const chave = req.headers['sec-websocket-key']
  if (!chave) return socket.destroy()
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${createHash('sha1').update(chave + GUID).digest('base64')}\r\n\r\n`
  )
  socket.setNoDelay(true)
  conectar(socket)
})

// Envia um frame de texto (servidor nunca mascara).
function enviar(socket, obj) {
  const dados = Buffer.from(JSON.stringify(obj))
  const n = dados.length
  let cab
  if (n < 126) cab = Buffer.from([0x81, n])
  else if (n < 65536) { cab = Buffer.alloc(4); cab[0] = 0x81; cab[1] = 126; cab.writeUInt16BE(n, 2) }
  else { cab = Buffer.alloc(10); cab[0] = 0x81; cab[1] = 127; cab.writeBigUInt64BE(BigInt(n), 2) }
  socket.write(Buffer.concat([cab, dados]))
}

// Acumula bytes do TCP e emite frames completos. SDP passa de 1 pacote, então
// nunca dá para supor que um 'data' do socket é um frame inteiro.
function conectar(socket) {
  let buf = Buffer.alloc(0)
  socket.on('data', pedaco => {
    buf = Buffer.concat([buf, pedaco])
    for (;;) {
      if (buf.length < 2) return
      const opcode = buf[0] & 0x0f
      const mascarado = (buf[1] & 0x80) !== 0
      let n = buf[1] & 0x7f
      let off = 2
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); off = 4 }
      else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); off = 10 }
      const chave = mascarado ? buf.subarray(off, off + 4) : null
      if (mascarado) off += 4
      if (buf.length < off + n) return // frame incompleto, espera mais TCP

      const carga = Buffer.from(buf.subarray(off, off + n))
      if (chave) for (let i = 0; i < n; i++) carga[i] ^= chave[i & 3]
      buf = buf.subarray(off + n)

      if (opcode === 0x8) return socket.end()            // close
      if (opcode === 0x9) { socket.write(Buffer.from([0x8a, 0])); continue } // ping -> pong
      if (opcode !== 0x1) continue
      try { receber(socket, JSON.parse(carga.toString())) } catch {}
    }
  })
  socket.on('error', () => sair(socket))
  socket.on('close', () => sair(socket))
}

// ---------- salas ----------

const salas = new Map()   // codigo -> Map(id -> {socket, nome})
const onde = new Map()    // socket -> {codigo, id}

function receber(socket, msg) {
  // Batimento do cliente. Aqui não há retomada de id: quem reconecta entra
  // como pessoa nova e o cliente refaz as conexões.
  if (msg.t === 'ping') return enviar(socket, { t: 'pong' })
  if (msg.t === 'join') {
    const codigo = String(msg.room || '').trim().toLowerCase()
    if (!codigo) return
    const id = randomUUID().slice(0, 8)
    const nome = String(msg.name || 'anon').slice(0, 24)
    if (!salas.has(codigo)) salas.set(codigo, new Map())
    const sala = salas.get(codigo)

    // Mesh de 4: além disso a conta de upload não fecha (ver PLANO-POC.md).
    if (sala.size >= 4) return enviar(socket, { t: 'cheia' })

    // Quem chega recebe a lista e é o polite; quem já estava manda a oferta.
    enviar(socket, { t: 'welcome', id, peers: [...sala].map(([pid, p]) => ({ id: pid, name: p.nome })) })
    for (const [, p] of sala) enviar(p.socket, { t: 'peer-join', id, name: nome })
    sala.set(id, { socket, nome })
    onde.set(socket, { codigo, id })
    console.log(`[${codigo}] entrou ${nome}/${id} (${sala.size})`)
    return
  }

  if (msg.t === 'signal') {
    const eu = onde.get(socket)
    if (!eu) return
    const destino = salas.get(eu.codigo)?.get(msg.to)
    if (destino) enviar(destino.socket, { t: 'signal', from: eu.id, data: msg.data })
  }
}

function sair(socket) {
  const eu = onde.get(socket)
  if (!eu) return
  onde.delete(socket)
  const sala = salas.get(eu.codigo)
  if (!sala) return
  sala.delete(eu.id)
  for (const [, p] of sala) enviar(p.socket, { t: 'peer-left', id: eu.id })
  if (sala.size === 0) salas.delete(eu.codigo)
  console.log(`[${eu.codigo}] saiu ${eu.id} (${sala.size})`)
}

servidor.listen(PORT, () => {
  console.log(`Disgalm em ${tls ? 'https' : 'http'}://localhost:${PORT}`)
  if (!tls) console.log('SEM TLS: só funciona em localhost. Amigos de fora não terão getUserMedia.')
})
