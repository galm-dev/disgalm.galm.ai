// PoC para medir consumo de Durable Object no plano gratuito.
//
// Duas classes com a MESMA função e um único ponto de diferença: como aceitam
// o WebSocket. É esse ponto que decide se o limite de 13.000 GB-s/dia aperta.
import { DurableObject } from 'cloudflare:workers'

// --- HIBERNADA: ctx.acceptWebSocket ---------------------------------------
// O runtime pode descarregar o objeto da memória enquanto ninguém troca
// mensagem, SEM derrubar os clientes, e só cobra o tempo ativo.
export class SalaHibernada extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    // Estado em memória NÃO sobrevive à hibernação. Reconstruir a partir dos
    // sockets vivos e do que foi anexado a cada um é obrigatório: um Map
    // comum funciona nos testes curtos e some quando o objeto acorda.
    this.sessoes = new Map()
    for (const ws of ctx.getWebSockets()) {
      const anexo = ws.deserializeAttachment()
      if (anexo) this.sessoes.set(ws, anexo)
    }
  }

  async fetch() {
    const [cliente, servidor] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(servidor)
    const info = { id: crypto.randomUUID().slice(0, 8), desde: Date.now() }
    servidor.serializeAttachment(info)   // sobrevive à hibernação
    this.sessoes.set(servidor, info)
    return new Response(null, { status: 101, webSocket: cliente })
  }

  async webSocketMessage(ws, msg) {
    const s = this.sessoes.get(ws) || ws.deserializeAttachment() || {}
    ws.send(JSON.stringify({
      modo: 'hibernada', id: s.id,
      conectados: this.ctx.getWebSockets().length,
      // Se o objeto tivesse hibernado e o Map fosse a única fonte, isto viria
      // errado. Serve para provar que a reconstrução no construtor funciona.
      viaAnexo: !this.sessoes.has(ws),
      eco: String(msg).slice(0, 80),
    }))
  }

  async webSocketClose(ws, code, reason) {
    this.sessoes.delete(ws)
    ws.close(code, reason)
  }
}

// --- VIVA: servidor.accept() ----------------------------------------------
// Handler clássico. O objeto fica residente enquanto houver conexão aberta,
// e a duração é cobrada em tempo de parede mesmo com a sala em silêncio.
export class SalaViva extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sockets = new Set()
  }

  async fetch() {
    const [cliente, servidor] = Object.values(new WebSocketPair())
    servidor.accept()
    this.sockets.add(servidor)
    const id = crypto.randomUUID().slice(0, 8)
    servidor.addEventListener('message', e => {
      servidor.send(JSON.stringify({
        modo: 'viva', id, conectados: this.sockets.size,
        eco: String(e.data).slice(0, 80),
      }))
    })
    servidor.addEventListener('close', () => this.sockets.delete(servidor))
    return new Response(null, { status: 101, webSocket: cliente })
  }
}

// --- Worker ---------------------------------------------------------------

export default {
  async fetch(req, env) {
    const url = new URL(req.url)

    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket')
        return new Response('esperava um upgrade de websocket', { status: 426 })

      const viva = url.searchParams.get('modo') === 'viva'
      const ns = viva ? env.VIVA : env.HIBERNADA
      const sala = url.searchParams.get('sala') || 'teste'
      // idFromName: mesmo nome, mesma instância, no mundo todo. É isto que
      // faz as duas conexões caírem no mesmo lugar.
      return ns.get(ns.idFromName(sala)).fetch(req)
    }

    return env.ASSETS.fetch(req)
  },
}
