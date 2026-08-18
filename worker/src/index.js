// Sinalização do Disgalm na Cloudflare. Só repassa SDP/ICE — nunca toca mídia.
//
// Uma Durable Object por sala. A DO existe porque Workers comuns rodam em
// isolates independentes: os dois navegadores cairiam em instâncias diferentes
// e o recado nunca passaria. idFromName(sala) é o que os faz cair no mesmo lugar.
import { DurableObject } from 'cloudflare:workers'

const MAX = 4  // ver a conta de banda em PLANO-POC.md

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

export class Sala extends DurableObject {
  // NÃO há estado em memória aqui, de propósito. Com hibernação o objeto é
  // descarregado e qualquer Map viraria vazio ao acordar — a sala esqueceria
  // quem está nela, e só numa call longa. Tudo é derivado de getWebSockets()
  // e do que foi anexado a cada socket, que sobrevivem.
  #peers(exceto) {
    return this.ctx.getWebSockets()
      .filter(ws => ws !== exceto)
      .map(ws => ({ ws, a: ws.deserializeAttachment() }))
      .filter(p => p.a)
  }

  #envia(ws, obj) {
    try { ws.send(JSON.stringify(obj)) } catch {}
  }

  async fetch(req) {
    const nome = (new URL(req.url).searchParams.get('nome') || 'anon').slice(0, 24)
    const [cliente, servidor] = Object.values(new WebSocketPair())

    // acceptWebSocket, não servidor.accept(): é o que permite hibernar.
    // Medido em worker-poc: 0,02 GB-s contra 48,63 GB-s pelo outro caminho.
    this.ctx.acceptWebSocket(servidor)

    const jaEstavam = this.#peers(servidor)
    if (jaEstavam.length >= MAX) {
      this.#envia(servidor, { t: 'cheia' })
      servidor.close(1013, 'sala cheia')
      return new Response(null, { status: 101, webSocket: cliente })
    }

    const id = crypto.randomUUID().slice(0, 8)
    servidor.serializeAttachment({ id, nome })   // sobrevive à hibernação

    this.#envia(servidor, {
      t: 'welcome', id,
      peers: jaEstavam.map(p => ({ id: p.a.id, name: p.a.nome })),
    })
    for (const p of jaEstavam) this.#envia(p.ws, { t: 'peer-join', id, name: nome })

    return new Response(null, { status: 101, webSocket: cliente })
  }

  async webSocketMessage(ws, bruto) {
    let m
    try { m = JSON.parse(bruto) } catch { return }
    if (m.t !== 'signal') return          // 'join' vem do cliente compartilhado; ignorar
    const eu = ws.deserializeAttachment()
    if (!eu) return
    for (const p of this.#peers(ws))
      if (p.a.id === m.to)
        return this.#envia(p.ws, { t: 'signal', from: eu.id, data: m.data })
  }

  async webSocketClose(ws) { this.#saiu(ws) }
  async webSocketError(ws) { this.#saiu(ws) }

  #saiu(ws) {
    const a = ws.deserializeAttachment()
    if (!a) return
    for (const p of this.#peers(ws)) this.#envia(p.ws, { t: 'peer-left', id: a.id })
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)

    if (url.pathname === '/ice')
      return Response.json(await env2ice(env), { headers: { 'cache-control': 'no-store' } })

    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket')
        return new Response('esperava um upgrade de websocket', { status: 426 })
      const sala = (url.searchParams.get('sala') || '').trim().toLowerCase()
      if (!sala) return new Response('falta ?sala=', { status: 400 })
      return env.SALA.get(env.SALA.idFromName(sala)).fetch(req)
    }

    return env.ASSETS.fetch(req)
  },
}
