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
    if (!r.ok) { console.log('TURN Cloudflare: HTTP', r.status); return [] }
    return (await r.json()).iceServers || []
  } catch (e) {
    console.log('TURN Cloudflare falhou:', e.message)
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
        console.log(`fantasma ${p.a.nome}/${p.a.id}: sem batimento há ${Math.round((agora - ultimo) / 1000)}s`)
        this.#descarta(p, 'sem batimento')
        this.#avisaSaida(p.a.id, servidor, true)
      }
    }

    // Mesma aba de novo. Com o id antigo, é reconexão e o socket velho só é
    // substituído. Sem ele, a página foi recarregada e a pessoa antiga saiu.
    for (const p of this.#peers(servidor)) {
      if (!aba || p.a.aba !== aba) continue
      this.#descarta(p, 'substituída')
      if (p.a.id !== retomar) this.#avisaSaida(p.a.id, servidor, false)
    }

    const jaEstavam = this.#peers(servidor)
    if (jaEstavam.length >= MAX) {
      this.#envia(servidor, { t: 'cheia' })
      servidor.close(1013, 'sala cheia')
      return new Response(null, { status: 101, webSocket: cliente })
    }

    // Retomar o id mantém as RTCPeerConnection dos outros: a mídia nunca
    // dependeu do WebSocket. Depois de um reinício do objeto ninguém mais tem
    // o id, então ele também volta.
    const retomada = !!retomar && !jaEstavam.some(p => p.a.id === retomar)
    const id = retomada ? retomar : crypto.randomUUID().slice(0, 8)
    servidor.serializeAttachment({ id, nome, aba, desde: agora, bate: q.has('aba'), exp,
      role, sub: role === 'member' ? req.headers.get('x-disgalm-sub') : null })
    await this.#alarme()
    console.log(`${retomada ? 'voltou' : 'entrou'} ${nome}/${id} (${jaEstavam.length + 1})`)

    this.#envia(servidor, {
      t: 'welcome', id, retomada,
      peers: jaEstavam.map(p => ({ id: p.a.id, name: p.a.nome })),
    })
    for (const p of jaEstavam)
      this.#envia(p.ws, { t: retomada ? 'peer-back' : 'peer-join', id, name: nome })

    return new Response(null, { status: 101, webSocket: cliente,
      headers: { 'sec-websocket-protocol': 'disgalm' } })
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
    console.log(`saiu ${a.nome}/${a.id} (${motivo}${volta ? ', pode voltar' : ''})`)
    this.#avisaSaida(a.id, ws, volta)
    await this.#alarme()
  }
}

export default {
  async fetch(req, env) {
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

    if (url.pathname === '/ice') {
      const claims = await verifyAccess(bearer(req))
      if (!claims) {
        const token = guestCookie(req)
        if (!validRoom(room) || !token) return new Response('acesso negado', { status: 401, headers: noStore })
        const check = await roomObject(env, room).fetch(internal(`${url.origin}/guest/check`, 'POST',
          { 'x-disgalm-guest-token': token }))
        if (!check.ok) return new Response('acesso negado', { status: 401, headers: noStore })
      }
      return Response.json(await env2ice(env), { headers: noStore })
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
}
