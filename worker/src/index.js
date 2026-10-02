// Sinalização do Disgalm na Cloudflare. Só repassa SDP/ICE — nunca toca mídia.
//
// Uma Durable Object por sala. A DO existe porque Workers comuns rodam em
// isolates independentes: os dois navegadores cairiam em instâncias diferentes
// e o recado nunca passaria. idFromName(sala) é o que os faz cair no mesmo lugar.
import { DurableObject } from 'cloudflare:workers'
import { bearer, session, sessionPaths, verifyAccess, websocketToken } from './auth.js'

const MAX = 4  // ver a conta de banda em PLANO-POC.md
const INVITE_SECONDS = 24 * 60 * 60
const GUEST_COOKIE = '__Host-disgalm_guest'
const noStore = { 'cache-control': 'no-store' }
const roomName = url => (url.searchParams.get('sala') || '').trim().toLowerCase()
const validRoom = room => room.length > 0 && room.length <= 80
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),
  n => n.toString(16).padStart(2, '0')).join('')
const tokenHash = async token => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(token))), n => n.toString(16).padStart(2, '0')).join('')
const guestCookie = req => /^([0-9a-f]{64})$/.exec((req.headers.get('cookie') || '')
  .split(';').map(s => s.trim()).find(s => s.startsWith(`${GUEST_COOKIE}=`))?.split('=')[1] || '')?.[1] || null
const roomObject = (env, room) => env.SALA.get(env.SALA.idFromName(room))
const internal = (url, method, headers = {}, body) => new Request(url, { method, headers, body })

// Logs estruturados. Sempre no console do Worker; com BETTERSTACK_TOKEN e
// BETTERSTACK_HOST (secrets), também no Better Stack, num POST por lote. O plano
// gratuito do Workers não tem Logpush, por isso o envio sai daqui mesmo.
// Regra da Galm: nunca nome, email, token, credencial TURN nem IP cru; id de
// conexão e sub (UUID) podem ir.
async function enviarLogs(env, linhas) {
  if (!linhas.length) return
  for (const l of linhas) console.log(JSON.stringify(l))
  if (!env?.BETTERSTACK_TOKEN || !env?.BETTERSTACK_HOST) return
  try {
    const r = await fetch(`https://${env.BETTERSTACK_HOST.replace(/^https?:\/\//, '')}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.BETTERSTACK_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(linhas),
    })
    if (!r.ok) console.log('Better Stack: HTTP', r.status)
  } catch (e) { console.log('Better Stack falhou:', e.message) }
}
const linhaWorker = (evento, campos) =>
  ({ dt: new Date().toISOString(), message: evento, origem: 'worker', evento, ...campos })

// Eventos que o navegador manda sobre as próprias conexões. Limites para que um
// cliente não encha a cota: lote pequeno, corpo pequeno, só campos simples.
const MAX_EVENTOS = 100, MAX_CORPO = 64 * 1024
const campoSimples = v => v === null || ['string', 'number', 'boolean'].includes(typeof v)
function limparEvento(e) {
  if (!e || typeof e !== 'object' || typeof e.evento !== 'string') return null
  const out = {}
  for (const [k, v] of Object.entries(e).slice(0, 30)) {
    if (campoSimples(v)) out[k] = typeof v === 'string' ? v.slice(0, 500) : v
    else if (Array.isArray(v) || typeof v === 'object') out[k] = JSON.stringify(v).slice(0, 2000)
  }
  return out
}

// O TURN da Cloudflare não tem usuário e senha fixos: credenciais são geradas
// por API, com validade. O par (key id, api token) fica em secrets e NUNCA
// chega ao navegador — só o usuário/senha efêmeros descem para o cliente.
async function turnCloudflare(env) {
  if (!env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN) return []
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      })
    if (!r.ok) { await enviarLogs(env, [linhaWorker('turn_cloudflare_falhou', { status: r.status })]); return [] }
    return (await r.json()).iceServers || []
  } catch (e) {
    await enviarLogs(env, [linhaWorker('turn_cloudflare_falhou', { erro: e.message })])
    return []
  }
}

// coturn de casa, como segunda opção. Ter os dois é de graça e cobre o caso de
// um deles estar inalcançável para algum par — que é exatamente o defeito que
// nunca conseguimos descartar no coturn (só houve teste com hairpin).
const turnDeCasa = env => {
  if (!env.TURN_HOST || !env.TURN_USER || !env.TURN_PASS) return []
  // Se TURN_HOST já é a Cloudflare, esta entrada duplicaria os endereços dela
  // com uma senha estática que lá não existe — e o navegador gasta dezenas de
  // tentativas com erro 701 antes de desistir.
  if (/turn\.cloudflare\.com$/.test(env.TURN_HOST)) return []
  const host = `${env.TURN_HOST}:${env.TURN_PORT || '3478'}`
  return [{
    urls: [`turn:${host}?transport=udp`, `turn:${host}?transport=tcp`],
    username: env.TURN_USER, credential: env.TURN_PASS,
  }]
}

async function env2ice(env) {
  const lista = [...await turnCloudflare(env), ...turnDeCasa(env)]
  return lista.length ? lista : [{ urls: 'stun:stun.cloudflare.com:3478' }]
}

// Consumo do TURN da Cloudflare, para acompanhar a cota grátis de 1.000 GB/mês
// (dividida com o SFU, que não usamos). Só a saída (egressBytes) é cobrada.
// Fonte: GraphQL Analytics, dataset callsTurnUsageAdaptiveGroups, com um token
// de API da conta com "Account Analytics: Read". O CF_TURN_API_TOKEN não serve:
// é o token da chave TURN, que só gera credenciais.
// https://developers.cloudflare.com/realtime/turn/analytics/
const COTA_TURN_GB = 1000
const GB = 1e9
const USO_TURN = `query ($conta: string!, $de: Date!, $ate: Date!) {
  viewer { accounts(filter: { accountTag: $conta }) {
    callsTurnUsageAdaptiveGroups(limit: 10000, filter: { date_geq: $de, date_leq: $ate }) {
      dimensions { datetimeHour }
      sum { egressBytes ingressBytes }
    }
  } }
}`

// Uma consulta por execução traz o mês (UTC) em fatias de uma hora: a soma
// delas é o acumulado, e a fatia da hora cheia anterior é o período. A hora
// corrente ainda está enchendo, por isso entra só no acumulado. Na virada do
// mês a hora anterior é do mês passado: a consulta começa nela.
async function usoTurn(env, agora = new Date()) {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null
  const dia = d => d.toISOString().slice(0, 10)
  const inicioMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1))
  const horaAtual = new Date(agora); horaAtual.setUTCMinutes(0, 0, 0)
  const horaAnterior = new Date(horaAtual - 3600_000)
  const falhou = campos => linhaWorker('turn_uso_falhou', campos)
  let r
  try {
    r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: USO_TURN,
        variables: { conta: env.CF_ACCOUNT_ID, de: dia(new Date(Math.min(inicioMes, horaAnterior))), ate: dia(agora) } }),
    })
  } catch (e) { return falhou({ erro: e.message }) }
  if (!r.ok) return falhou({ status: r.status })
  const corpo = await r.json().catch(() => null)
  if (corpo?.errors?.length) return falhou({ erro: corpo.errors.map(e => e.message).join('; ').slice(0, 500) })
  const grupos = corpo?.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups
  if (!Array.isArray(grupos)) return falhou({ erro: 'resposta sem callsTurnUsageAdaptiveGroups' })

  const soma = lista => lista.reduce((t, g) => ({
    egress: t.egress + (g.sum?.egressBytes || 0), ingress: t.ingress + (g.sum?.ingressBytes || 0),
  }), { egress: 0, ingress: 0 })
  const hora = g => Date.parse(g.dimensions?.datetimeHour)
  const mes = soma(grupos.filter(g => hora(g) >= +inicioMes))
  const periodo = soma(grupos.filter(g => hora(g) === +horaAnterior))
  return linhaWorker('turn_uso', {
    periodo_inicio: horaAnterior.toISOString(), periodo_fim: horaAtual.toISOString(),
    egress_bytes_periodo: periodo.egress, ingress_bytes_periodo: periodo.ingress,
    mes: dia(inicioMes).slice(0, 7),
    egress_bytes_mes: mes.egress, ingress_bytes_mes: mes.ingress,
    egress_gb_mes: Math.round(mes.egress / GB * 1000) / 1000,
    cota_gb: COTA_TURN_GB,
    cota_pct: Math.round(mes.egress / (COTA_TURN_GB * GB) * 10000) / 100,
  })
}

async function registrarUsoTurn(env, agora) {
  const linha = await usoTurn(env, agora)
  if (linha) await enviarLogs(env, [linha])
}

// Batimento do cliente. A resposta automática não acorda o objeto hibernado, e
// o horário da última resposta, por socket, é o que separa vivo de fantasma.
const PING = '{"t":"ping"}', PONG = '{"t":"pong"}'
const FANTASMA_MS = 60_000   // cliente pinga a cada 20 s: três batidas perdidas

export class Sala extends DurableObject {
  // NÃO há estado em memória aqui, de propósito. Com hibernação o objeto é
  // descarregado e qualquer Map viraria vazio ao acordar — a sala esqueceria
  // quem está nela, e só numa call longa. Tudo é derivado de getWebSockets()
  // e do que foi anexado a cada socket, que sobrevivem.
  constructor(ctx, env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
  }

  #peers(exceto) {
    return this.ctx.getWebSockets()
      .filter(ws => ws !== exceto)
      .map(ws => ({ ws, a: ws.deserializeAttachment() }))
      .filter(p => p.a)
  }

  // O objeto não tem ctx de request: o envio segura o objeto vivo por waitUntil.
  #registrar(evento, campos) {
    const envio = enviarLogs(this.env, [linhaWorker(evento, campos)])
    if (this.ctx.waitUntil) this.ctx.waitUntil(envio)
  }

  // SHA de IPv4 puro se reverte por força bruta; com sal aleatório da sala, não.
  async #ipHash(req) {
    const ip = req.headers.get('cf-connecting-ip')
    if (!ip) return null
    let sal = await this.ctx.storage.get('sal-ip')
    if (!sal) await this.ctx.storage.put('sal-ip', sal = randomToken())
    return (await tokenHash(sal + ip)).slice(0, 16)
  }

  #envia(ws, obj) {
    try { ws.send(JSON.stringify(obj)) } catch {}
  }

  // Tira o socket da sala sem passar por webSocketClose: sem anexo, ele some
  // de #peers na hora, e o aviso de saída fica a critério de quem chamou.
  #descarta(p, motivo) {
    p.ws.serializeAttachment(null)
    try { p.ws.close(1000, motivo) } catch {}
  }

  // volta=true: a pessoa caiu e deve retomar o id. Os outros mantêm a mídia
  // viva em vez de desmontar a conexão, que é o que deixava a sala pela metade.
  #avisaSaida(id, exceto, volta) {
    for (const p of this.#peers(exceto)) this.#envia(p.ws, { t: 'peer-left', id, volta })
  }

  async #alarme() {
    const exp = this.#peers().map(p => p.a.exp).filter(Number.isFinite)
    if (exp.length) await this.ctx.storage?.setAlarm(Math.min(...exp) * 1000)
    else await this.ctx.storage?.deleteAlarm()
  }

  async alarm() {
    const agora = Math.floor(Date.now() / 1000)
    for (const p of this.#peers()) {
      if (p.a.exp > agora) continue
      this.#descarta(p, 'acesso expirado')
      this.#avisaSaida(p.a.id, p.ws, false)
    }
    await this.#alarme()
  }

  async #guestExpiry(token) {
    if (!/^[0-9a-f]{64}$/.test(token || '')) return null
    const exp = await this.ctx.storage.get(`invite:${await tokenHash(token)}`)
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null
    return exp
  }

  #activeMember(p) {
    if (p.a.role !== 'member' || p.a.exp <= Math.floor(Date.now() / 1000)) return false
    const last = Math.max(p.a.desde || 0, this.ctx.getWebSocketAutoResponseTimestamp(p.ws)?.getTime() || 0)
    return !p.a.bate || Date.now() - last <= FANTASMA_MS
  }

  #hasMember() {
    return this.#peers().some(p => this.#activeMember(p))
  }

  async #invite(req) {
    const sub = req.headers.get('x-disgalm-sub')
    if (!sub || !this.#peers().some(p => p.a.sub === sub && this.#activeMember(p)))
      return new Response('entre na sala para convidar', { status: 403 })
    const token = randomToken()
    const exp = Math.floor(Date.now() / 1000) + INVITE_SECONDS
    await this.ctx.storage.put(`invite:${await tokenHash(token)}`, exp)
    return Response.json({ token, expiresAt: exp }, { headers: noStore })
  }

  async #checkGuest(req) {
    const exp = await this.#guestExpiry(req.headers.get('x-disgalm-guest-token'))
    if (!exp || !this.#hasMember()) return new Response('convite inválido ou sala vazia', { status: 401 })
    return Response.json({ exp }, { headers: noStore })
  }

  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/invite' && req.method === 'POST') return this.#invite(req)
    if (path === '/guest/check' && req.method === 'POST') return this.#checkGuest(req)
    if (path !== '/ws') return new Response('não encontrado', { status: 404 })
    const role = req.headers.get('x-disgalm-role')
    let exp = Number(req.headers.get('x-disgalm-exp'))
    if (role === 'guest') {
      const guestExp = await this.#guestExpiry(req.headers.get('x-disgalm-guest-token'))
      if (!guestExp || !this.#hasMember()) return new Response('convite inválido ou sala vazia', { status: 401 })
      exp = guestExp
    } else if (role !== 'member') return new Response('acesso negado', { status: 401 })
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000))
      return new Response('acesso expirado', { status: 401 })
    const q = new URL(req.url).searchParams
    const sala = (q.get('sala') || '').slice(0, 80)
    const nome = (q.get('nome') || 'anon').slice(0, 24)
    const aba = (q.get('aba') || '').slice(0, 64)
    const retomar = /^[0-9a-f]{8}$/.test(q.get('id') || '') ? q.get('id') : null
    const [cliente, servidor] = Object.values(new WebSocketPair())

    // acceptWebSocket, não servidor.accept(): é o que permite hibernar.
    // Medido em worker-poc: 0,02 GB-s contra 48,63 GB-s pelo outro caminho.
    this.ctx.acceptWebSocket(servidor)

    // Fantasmas: conexão meio aberta que o runtime ainda lista. Só vale para
    // quem pinga (bate=true); cliente antigo sem batimento não é julgado.
    const agora = Date.now()
    for (const p of this.#peers(servidor)) {
      if (p.a.exp <= Math.floor(agora / 1000)) {
        this.#descarta(p, 'acesso expirado')
        this.#avisaSaida(p.a.id, servidor, false)
        continue
      }
      const ultimo = Math.max(p.a.desde || 0, this.ctx.getWebSocketAutoResponseTimestamp(p.ws)?.getTime() || 0)
      if (p.a.bate && agora - ultimo > FANTASMA_MS) {
        this.#registrar('fantasma', { sala: p.a.sala, id: p.a.id, semBatimentoS: Math.round((agora - ultimo) / 1000) })
        this.#descarta(p, 'sem batimento')
        this.#avisaSaida(p.a.id, servidor, true)
      }
    }

    // Mesma aba de novo. Com o id antigo, é reconexão e o socket velho só é
    // substituído. Sem ele, a página foi recarregada e a pessoa antiga saiu.
    for (const p of this.#peers(servidor)) {
      if (!aba || p.a.aba !== aba) continue
      this.#descarta(p, 'substituída')
      this.#registrar('substituida', { sala: p.a.sala, id: p.a.id, retomada: p.a.id === retomar })
      if (p.a.id !== retomar) this.#avisaSaida(p.a.id, servidor, false)
    }

    // Todo cliente pede o subprotocolo 'disgalm'. Sem ele na resposta, o
    // navegador recusa o upgrade, inclusive o de sala cheia: o 'cheia' nunca
    // chega e o cliente religa para sempre, vendo só um 1006.
    const aceitar = () => new Response(null, { status: 101, webSocket: cliente,
      headers: { 'sec-websocket-protocol': 'disgalm' } })

    const jaEstavam = this.#peers(servidor)
    if (jaEstavam.length >= MAX) {
      this.#registrar('cheia', { sala, papel: role, naSala: jaEstavam.length })
      this.#envia(servidor, { t: 'cheia' })
      servidor.close(1013, 'sala cheia')
      return aceitar()
    }

    // Retomar o id mantém as RTCPeerConnection dos outros: a mídia nunca
    // dependeu do WebSocket. Depois de um reinício do objeto ninguém mais tem
    // o id, então ele também volta.
    const retomada = !!retomar && !jaEstavam.some(p => p.a.id === retomar)
    const id = retomada ? retomar : crypto.randomUUID().slice(0, 8)
    // Só a comparação sai daqui: dois celulares atrás do mesmo NAT dependem de
    // hairpin ou de relay para se falarem. O IP fica em hash e nunca é logado.
    const ipHash = await this.#ipHash(req)
    const sub = role === 'member' ? req.headers.get('x-disgalm-sub') : null
    servidor.serializeAttachment({ id, nome, aba, desde: agora, bate: q.has('aba'), exp, role, sub, ipHash, sala })
    await this.#alarme()
    this.#registrar(retomada ? 'voltou' : 'entrou', { sala, id, papel: role, sub, naSala: jaEstavam.length + 1,
      pares: jaEstavam.map(p => ({ id: p.a.id, mesmoIpPublico: !!ipHash && p.a.ipHash === ipHash })) })

    this.#envia(servidor, {
      t: 'welcome', id, retomada,
      peers: jaEstavam.map(p => ({ id: p.a.id, name: p.a.nome })),
    })
    for (const p of jaEstavam)
      this.#envia(p.ws, { t: retomada ? 'peer-back' : 'peer-join', id, name: nome })

    return aceitar()
  }

  async webSocketMessage(ws, bruto) {
    let m
    try { m = JSON.parse(bruto) } catch { return }
    if (m.t !== 'signal') return          // 'join' vem do cliente compartilhado; ignorar
    const eu = ws.deserializeAttachment()
    if (!eu) return
    if (eu.exp <= Math.floor(Date.now() / 1000)) {
      this.#descarta({ ws, a: eu }, 'acesso expirado')
      this.#avisaSaida(eu.id, ws, false)
      await this.#alarme()
      return
    }
    for (const p of this.#peers(ws))
      if (p.a.id === m.to)
        return this.#envia(p.ws, { t: 'signal', from: eu.id, data: m.data })
  }

  // 1000 e 1001 são saída de verdade: botão Sair, aba fechada, F5. O resto
  // (1006 de rede caída, 4000 do batimento do cliente, erro) é queda.
  async webSocketClose(ws, code) { await this.#saiu(ws, code !== 1000 && code !== 1001, code) }
  async webSocketError(ws) { await this.#saiu(ws, true, 'erro') }

  async #saiu(ws, volta, motivo) {
    const a = ws.deserializeAttachment()
    if (!a) return
    ws.serializeAttachment(null)
    this.#registrar('saiu', { sala: a.sala, id: a.id, motivo: String(motivo), volta })
    this.#avisaSaida(a.id, ws, volta)
    await this.#alarme()
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    const room = roomName(url)
    const sameOrigin = req.headers.get('Origin') === url.origin

    if (url.pathname === '/invite') {
      if (req.method !== 'POST') return new Response('método inválido', { status: 405 })
      if (!sameOrigin) return new Response('origem inválida', { status: 403 })
      const claims = await verifyAccess(bearer(req))
      if (!claims) return new Response('acesso negado', { status: 401 })
      if (!validRoom(room)) return new Response('sala inválida', { status: 400 })
      return roomObject(env, room).fetch(internal(`${url.origin}/invite`, 'POST', { 'x-disgalm-sub': claims.sub }))
    }

    if (url.pathname === '/guest/redeem' || url.pathname === '/guest/session') {
      const redeem = url.pathname === '/guest/redeem'
      if (req.method !== (redeem ? 'POST' : 'GET')) return new Response('método inválido', { status: 405 })
      if (redeem && !sameOrigin) return new Response('origem inválida', { status: 403 })
      if (!validRoom(room)) return new Response('sala inválida', { status: 400 })
      let token = guestCookie(req)
      if (redeem) {
        if (req.headers.get('content-type')?.split(';')[0] !== 'application/json')
          return new Response('conteúdo inválido', { status: 415 })
        const body = await req.json().catch(() => null)
        token = body?.token
      }
      if (!/^[0-9a-f]{64}$/.test(token || '')) return new Response('convite inválido', { status: 401, headers: noStore })
      const check = await roomObject(env, room).fetch(internal(`${url.origin}/guest/check`, 'POST',
        { 'x-disgalm-guest-token': token }))
      if (!check.ok) return new Response('convite inválido ou sala vazia', { status: 401, headers: noStore })
      const { exp } = await check.json()
      const headers = new Headers(noStore)
      if (redeem) headers.set('set-cookie', `${GUEST_COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, exp - Math.floor(Date.now() / 1000))}; HttpOnly; Secure; SameSite=Lax`)
      return Response.json({ room, expiresAt: exp }, { headers })
    }

    // Membro pelo bearer; convidado pelo cookie, válido para esta sala.
    const quem = async () => {
      const claims = await verifyAccess(bearer(req))
      if (claims) return { papel: 'member', sub: claims.sub }
      const token = guestCookie(req)
      if (!validRoom(room) || !token) return null
      const check = await roomObject(env, room).fetch(internal(`${url.origin}/guest/check`, 'POST',
        { 'x-disgalm-guest-token': token }))
      return check.ok ? { papel: 'guest', sub: null } : null
    }

    if (url.pathname === '/ice') {
      if (!await quem()) return new Response('acesso negado', { status: 401, headers: noStore })
      return Response.json(await env2ice(env), { headers: noStore })
    }

    if (url.pathname === '/telemetria') {
      if (req.method !== 'POST') return new Response('método inválido', { status: 405 })
      if (!sameOrigin) return new Response('origem inválida', { status: 403 })
      if (!validRoom(room)) return new Response('sala inválida', { status: 400 })
      const autor = await quem()
      if (!autor) return new Response('acesso negado', { status: 401, headers: noStore })
      const corpo = await req.text()
      if (corpo.length > MAX_CORPO) return new Response('lote grande demais', { status: 413 })
      let eventos
      try { eventos = JSON.parse(corpo)?.eventos } catch {}
      if (!Array.isArray(eventos)) return new Response('lote inválido', { status: 400 })
      const linhas = eventos.slice(0, MAX_EVENTOS).map(limparEvento).filter(Boolean).map(e => ({
        ...e, dt: typeof e.dt === 'string' ? e.dt : new Date().toISOString(), message: e.evento,
        origem: 'navegador', sala: room, papel: autor.papel, sub: autor.sub,
      }))
      ctx.waitUntil(enviarLogs(env, linhas))
      return new Response(null, { status: 204, headers: noStore })
    }

    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket')
        return new Response('esperava um upgrade de websocket', { status: 426 })
      if (!sameOrigin)
        return new Response('origem inválida', { status: 403 })
      const claims = await verifyAccess(websocketToken(req))
      const token = claims ? null : guestCookie(req)
      if (!claims && !token) return new Response('acesso negado', { status: 401 })
      if (!claims && req.headers.get('sec-websocket-protocol')?.trim() !== 'disgalm')
        return new Response('protocolo inválido', { status: 400 })
      if (!validRoom(room)) return new Response('sala inválida', { status: 400 })
      const headers = new Headers(req.headers)
      headers.delete('x-disgalm-exp')
      headers.delete('x-disgalm-sub')
      headers.delete('x-disgalm-role')
      headers.delete('x-disgalm-guest-token')
      headers.set('x-disgalm-role', claims ? 'member' : 'guest')
      if (claims) {
        headers.set('x-disgalm-exp', String(claims.exp))
        headers.set('x-disgalm-sub', claims.sub)
      } else headers.set('x-disgalm-guest-token', token)
      return roomObject(env, room).fetch(new Request(req, { headers }))
    }

    if (sessionPaths.includes(url.pathname)) return session(req, url)

    if (url.pathname === '/auth/callback') {
      const response = await env.ASSETS.fetch(new Request(new URL('/', url), req))
      const headers = new Headers(response.headers)
      headers.set('cache-control', 'no-store')
      headers.set('referrer-policy', 'no-referrer')
      return new Response(response.body, { status: response.status, headers })
    }

    return env.ASSETS.fetch(req)
  },

  // Cron do wrangler.toml: registra o consumo do TURN no Better Stack.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(registrarUsoTurn(env, new Date(controller.scheduledTime)))
  },
}
