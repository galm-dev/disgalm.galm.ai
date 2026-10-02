// Sinalização do Disgalm na Cloudflare. Só repassa SDP/ICE — nunca toca mídia.
//
// Uma Durable Object por sala. A DO existe porque Workers comuns rodam em
// isolates independentes: os dois navegadores cairiam em instâncias diferentes
// e o recado nunca passaria. idFromName(sala) é o que os faz cair no mesmo lugar.
import { DurableObject } from 'cloudflare:workers'
import { bearer, session, sessionPaths, verifyAccess, websocketToken } from './auth.js'
import { enviarLogs, linhaWorker } from './logs.js'
import { TAG_MALHA, TAG_SFU, TAXA_TURN, TTL_TURN_S, autorizarCom, coletarUso, liberarCom, orcamentoDa }
  from './orcamento.js'

export { Orcamento } from './orcamento.js'
import { CAPACIDADE, catalogo, chamarApi, encerrarChamada, limparPessoa, novoEstado, operar, rotaSfu,
  salaEmEnsaio } from './sfu.js'

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
//
// A validade é curta (TTL_TURN_S) para que o bloqueio do orçamento valha em
// minutos: credencial vencida para de ser cobrada na hora e a alocação cai. A
// etiqueta (customIdentifier) separa na analytics o TURN que leva ao SFU, que
// não é cobrado de novo.
// https://developers.cloudflare.com/realtime/turn/generate-credentials/
const turnConfigurado = env => !!(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN)
async function turnCloudflare(env, etiqueta) {
  if (!turnConfigurado(env)) return []
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_TURN_S, customIdentifier: etiqueta }),
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

// TURN da Cloudflare só com o orçamento liberando. Negado, o cliente fica com
// STUN (e o coturn de casa, que não é cobrado) e o motivo vai num cabeçalho:
// o corpo continua a lista de sempre, que cliente antigo entende.
async function env2ice(env, { sala, modo }) {
  let cf = [], negado = null
  if (turnConfigurado(env)) {
    const sfu = modo === 'sfu'
    const r = await autorizarCom(env, { recurso: 'turn', op: 'ice', sala,
      // Relay até o SFU não é cobrado como TURN: a reserva fica com a assinatura.
      reservas: sfu ? [] : [{ tipo: 'turn', bps: TAXA_TURN, duracao_ms: TTL_TURN_S * 1000 }] })
    if (r.ok) cf = await turnCloudflare(env, sfu ? TAG_SFU : TAG_MALHA)
    else negado = r.motivo
  }
  const lista = [...cf, ...turnDeCasa(env)]
  return { lista: lista.length ? lista : [{ urls: 'stun:stun.cloudflare.com:3478' }], negado, validade: cf.length ? TTL_TURN_S : null }
}

// Batimento do cliente. A resposta automática não acorda o objeto hibernado, e
// o horário da última resposta, por socket, é o que separa vivo de fantasma.
const PING = '{"t":"ping"}', PONG = '{"t":"pong"}'
// Nome que o cliente antigo mostra no lugar de uma pessoa (cabe nos 24 do tile).
const AVISO_VERSAO = 'Recarregue o Disgalm'
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

  // ---------- SFU (fase 1, ensaio) ----------
  // O catálogo e as sessões ficam no storage (ver sfu.js), não em memória: a
  // sala hiberna entre uma operação e outra.

  async #estadoSfu() {
    const est = await this.ctx.storage.get('sfu')
    return est ? structuredClone(est) : null
  }

  #contextoSfu(autor, sala) {
    return {
      autor,
      presentes: new Set(this.#peers().filter(p => p.a.modo === 'sfu').map(p => p.a.id)),
      carregar: () => this.#estadoSfu(),
      salvar: est => this.ctx.storage.put('sfu', est),
      api: (metodo, caminho, corpo) => chamarApi(this.env, metodo, caminho, corpo),
      registrar: (evento, campos) => this.#registrar(evento, { sala, ...campos }),
      difundir: est => {
        const msg = { t: 'sfu', versao: est.versao, fontes: catalogo(est) }
        for (const p of this.#peers()) if (p.a.modo === 'sfu') this.#envia(p.ws, msg)
      },
      agora: () => Date.now(),
      orcamento: {
        autorizar: pedido => autorizarCom(this.env, { sala, ...pedido }),
        liberar: pedido => liberarCom(this.env, pedido),
      },
    }
  }

  // Pessoa que saiu de vez perde as fontes no catálogo. A API é chamada fora do
  // caminho de quem disparou a saída.
  #saiuDoSfu(a, motivo) {
    if (a?.modo !== 'sfu') return
    const tarefa = limparPessoa(this.#contextoSfu({ id: a.id }, a.sala), a.id, motivo).catch(e => console.log('sfu:', e.message))
    if (this.ctx.waitUntil) this.ctx.waitUntil(tarefa)
    return tarefa
  }

  // Quem pede é a conexão viva com aquele id, nesta sala, com a mesma chave que
  // recebeu no welcome, ainda dentro do prazo e com a mesma credencial: membro
  // pelo sub, convidado pelo convite, que ainda precisa valer.
  async #autorSfu(req, id) {
    if (!/^[0-9a-f]{8}$/.test(id || '')) return null
    const chave = req.headers.get('x-disgalm-sfu') || ''
    const p = this.#peers().find(p => p.a.id === id)
    const agora = Math.floor(Date.now() / 1000)
    const exp = Number(req.headers.get('x-disgalm-exp'))
    if (!p || p.a.modo !== 'sfu' || !p.a.chaveSfu || p.a.exp <= agora || !(exp > agora)) return null
    if (p.a.chaveSfu !== await tokenHash(chave)) return null
    const role = req.headers.get('x-disgalm-role')
    if (role !== p.a.role) return null
    if (role === 'member' && (!p.a.sub || req.headers.get('x-disgalm-sub') !== p.a.sub)) return null
    if (role === 'guest' && !await this.#guestExpiry(req.headers.get('x-disgalm-guest-token'))) return null
    return { id, exp: Math.min(exp, p.a.exp), sala: p.a.sala }
  }

  async #sfu(req) {
    let corpo = null
    try { corpo = await req.json() } catch {}
    const op = typeof corpo?.op === 'string' ? corpo.op.slice(0, 20) : null
    const autor = op && await this.#autorSfu(req, corpo.id)
    if (!autor) {
      this.#registrar('sfu_recusado', { sala: new URL(req.url).searchParams.get('sala'), op,
        motivo: op ? 'fora da sala' : 'pedido inválido' })
      return Response.json({ erro: op ? 'fora da sala' : 'pedido inválido' }, { status: op ? 403 : 400, headers: noStore })
    }
    const r = await operar(this.#contextoSfu(autor, autor.sala), op, corpo)
    if (r.status >= 400 && r.status !== 502)
      this.#registrar('sfu_recusado', { sala: autor.sala, id: autor.id, op, motivo: r.corpo.erro, status: r.status })
    return Response.json(r.corpo, { status: r.status, headers: noStore })
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
      await this.#saiuDoSfu(p.a, 'expirou')
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
    if (path === '/sfu' && req.method === 'POST') return this.#sfu(req)
    // Modo da chamada em andamento, para a etiqueta da credencial TURN. Só
    // conta quem está na sala: o estado de uma chamada que acabou não vale.
    if (path === '/modo') return Response.json({ modo: this.#peers().some(p => p.a.modo === 'sfu') ? 'sfu' : 'mesh' })
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
        this.#saiuDoSfu(p.a, 'expirou')
        continue
      }
      const ultimo = Math.max(p.a.desde || 0, this.ctx.getWebSocketAutoResponseTimestamp(p.ws)?.getTime() || 0)
      if (p.a.bate && agora - ultimo > FANTASMA_MS) {
        this.#registrar('fantasma', { sala: p.a.sala, id: p.a.id, semBatimentoS: Math.round((agora - ultimo) / 1000) })
        this.#descarta(p, 'sem batimento')
        this.#avisaSaida(p.a.id, servidor, true)
        this.#saiuDoSfu(p.a, 'fantasma')
      }
    }

    // Mesma aba de novo. Com o id antigo, é reconexão e o socket velho só é
    // substituído. Sem ele, a página foi recarregada e a pessoa antiga saiu.
    for (const p of this.#peers(servidor)) {
      if (!aba || p.a.aba !== aba) continue
      this.#descarta(p, 'substituída')
      this.#registrar('substituida', { sala: p.a.sala, id: p.a.id, retomada: p.a.id === retomar })
      if (p.a.id !== retomar) {
        this.#avisaSaida(p.a.id, servidor, false)
        this.#saiuDoSfu(p.a, 'substituida')
      }
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

    // Modo da chamada: decide quem abre a sala vazia e vale até ela esvaziar.
    // SFU só em sala da lista de ensaio e com cliente que sabe usar; o resto,
    // inclusive cliente antigo, fica na malha. Retomada numa sala que parece
    // vazia (o objeto reiniciou) continua a chamada que havia.
    const capaz = (q.get('cap') || '').split(',').includes(CAPACIDADE)
    let sfu = await this.#estadoSfu()
    let aviso = null
    if (!jaEstavam.length && !(retomada && sfu)) {
      const anterior = sfu
      // Sala de ensaio com o orçamento negando: a chamada inteira fica na malha,
      // e o compartilhamento continua direto.
      let querSfu = salaEmEnsaio(this.env, sala) && capaz
      if (querSfu) {
        const r = await autorizarCom(this.env, { recurso: 'sfu', op: 'chamada', sala })
        if (!r.ok) { querSfu = false; aviso = 'sfu_cota' }
      }
      sfu = novoEstado(querSfu ? 'sfu' : 'mesh', crypto.randomUUID().slice(0, 8))
      // O motivo vale para a chamada inteira: quem entra depois também é avisado.
      if (aviso) sfu.aviso = aviso
      await this.ctx.storage.put('sfu', sfu)
      if (anterior?.modo === 'sfu') {
        const tarefa = encerrarChamada(this.#contextoSfu({ id }, sala), anterior).catch(e => console.log('sfu:', e.message))
        if (this.ctx.waitUntil) this.ctx.waitUntil(tarefa)
      }
    }
    const modo = sfu?.modo === 'sfu' ? 'sfu' : 'mesh'
    // Cliente sem SFU numa chamada em SFU não veria ninguém. Sem mexer no
    // protocolo, o aviso vai no que ele já mostra: um welcome com uma pessoa
    // fictícia cujo nome é o recado, e o fechamento com o motivo 'substituída',
    // que desde adff869 faz o cliente parar de religar. Quem ainda manda o
    // 'join' mas não tem 'aba' é anterior a isso e recebe 'cheia', que também
    // para o ciclo.
    if (modo === 'sfu' && !capaz) {
      this.#registrar('sfu_recusado', { sala, op: 'entrar', motivo: 'cliente sem SFU' })
      if (q.has('aba')) {
        this.#envia(servidor, { t: 'welcome', id: crypto.randomUUID().slice(0, 8), retomada: false,
          peers: [{ id: '00000000', name: AVISO_VERSAO }] })
        servidor.close(4001, 'substituída')
      } else {
        this.#envia(servidor, { t: 'cheia', motivo: 'versao' })
        servidor.close(1013, 'cliente sem SFU')
      }
      return aceitar()
    }
    // A chave liga as chamadas HTTP do gateway a esta conexão; só o hash fica.
    const chave = modo === 'sfu' ? randomToken() : null
    // Só a comparação sai daqui: dois celulares atrás do mesmo NAT dependem de
    // hairpin ou de relay para se falarem. O IP fica em hash e nunca é logado.
    const ipHash = await this.#ipHash(req)
    const sub = role === 'member' ? req.headers.get('x-disgalm-sub') : null
    servidor.serializeAttachment({ id, nome, aba, desde: agora, bate: q.has('aba'), exp, role, sub, ipHash, sala,
      modo, ...(chave && { chaveSfu: await tokenHash(chave) }) })
    await this.#alarme()
    this.#registrar(retomada ? 'voltou' : 'entrou', { sala, id, papel: role, sub, naSala: jaEstavam.length + 1, modo,
      pares: jaEstavam.map(p => ({ id: p.a.id, mesmoIpPublico: !!ipHash && p.a.ipHash === ipHash })) })

    this.#envia(servidor, {
      t: 'welcome', id, retomada,
      peers: jaEstavam.map(p => ({ id: p.a.id, name: p.a.nome })),
      // Clientes antigos ignoram os campos abaixo e seguem na malha.
      protocolo: 1, modo, ...(sfu?.aviso && { aviso: sfu.aviso }),
      ...(chave && { sfu: { chave, versao: sfu.versao, fontes: catalogo(sfu) } }),
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
    if (!volta) await this.#saiuDoSfu(a, 'saiu')
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
      if (claims) return { papel: 'member', sub: claims.sub, exp: claims.exp }
      const token = guestCookie(req)
      if (!validRoom(room) || !token) return null
      const check = await roomObject(env, room).fetch(internal(`${url.origin}/guest/check`, 'POST',
        { 'x-disgalm-guest-token': token }))
      if (!check.ok) return null
      const { exp } = await check.json()
      return { papel: 'guest', sub: null, exp, convite: token }
    }

    if (url.pathname === '/sfu') {
      if (!validRoom(room)) return new Response('sala inválida', { status: 400 })
      return rotaSfu(req, env, { sala: room, mesmaOrigem: sameOrigin, identificar: quem,
        objeto: roomObject(env, room), origem: url.origin })
    }

    if (url.pathname === '/ice') {
      if (!await quem()) return new Response('acesso negado', { status: 401, headers: noStore })
      // O modo da chamada em andamento decide a etiqueta da credencial.
      let modo = 'mesh'
      if (validRoom(room)) try {
        modo = (await (await roomObject(env, room).fetch(internal(`${url.origin}/modo`, 'GET'))).json()).modo
      } catch {}
      const { lista, negado, validade } = await env2ice(env, { sala: validRoom(room) ? room : null, modo })
      // Validade: quando buscar de novo. Negado, uma nova tentativa bem mais tarde.
      return Response.json(lista, { headers: { ...noStore, 'x-disgalm-ice-validade': String(validade ?? 600),
        ...(negado && { 'x-disgalm-relay': `negado;${negado}` }) } })
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

  // Cron do wrangler.toml: mede TURN e SFU, manda turn_uso ao Better Stack e
  // grava o retrato no orçamento da conta.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const r = await coletarUso(env, new Date(controller.scheduledTime))
      if (!r) return
      await enviarLogs(env, r.linhas)
      if (r.snapshot.completo) await orcamentoDa(env)?.gravarSnapshot(r.snapshot)
    })())
  },
}
