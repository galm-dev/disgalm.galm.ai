// Sinalização do Disgalm na Cloudflare. Só repassa SDP/ICE — nunca toca mídia.
//
// Uma Durable Object por sala. A DO existe porque Workers comuns rodam em
// isolates independentes: os dois navegadores cairiam em instâncias diferentes
// e o recado nunca passaria. idFromName(sala) é o que os faz cair no mesmo lugar.
import { DurableObject } from 'cloudflare:workers'

const MAX = 4  // ver a conta de banda em PLANO-POC.md

const env2ice = env => {
  const host = `${env.TURN_HOST}:${env.TURN_PORT || '3478'}`
  if (!env.TURN_HOST || !env.TURN_USER || !env.TURN_PASS)
    return [{ urls: 'stun:stun.cloudflare.com:3478' }]
  return [
    { urls: `stun:${host}` },
    {
      urls: [`turn:${host}?transport=udp`, `turn:${host}?transport=tcp`],
      username: env.TURN_USER, credential: env.TURN_PASS,
    },
  ]
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
      return Response.json(env2ice(env), { headers: { 'cache-control': 'no-store' } })

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
