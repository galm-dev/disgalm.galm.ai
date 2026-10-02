// Entrada local do ensaio do SFU (tests/e2e/sfu.mjs). Sala e Orcamento de
// verdade (worker/src), o app SFU de verdade (SFU_APP_ID e SFU_APP_SECRET no
// .dev.vars, nunca commitado) e o login trocado por um membro fixo. Sem os
// secrets de analytics o orçamento fica no modo sem medição; com eles,
// /_e2e/orcamento grava um retrato (turn_gb=N simula consumo). Nunca publicar:
// não tem auth.
import { Sala, Orcamento } from '../../../worker/src/index.js'

export { Sala, Orcamento }

const AUTH = `(() => {
  const nome = new URL(location.href).searchParams.get('nome') || 'E2E'
  const sempre = async () => 'e2e'
  window.disgalmAuth = {
    ready: Promise.resolve(), login() {}, logout: async () => {}, accessToken: sempre,
    currentToken: () => 'e2e', isGuest: () => false, member: () => true, guestInvite: () => null,
    account: async () => ({ name: nome, email: nome.toLowerCase() + '@e2e', picture: null }),
  }
})()`

const membro = headers => {
  headers.set('x-disgalm-role', 'member')
  headers.set('x-disgalm-exp', String(Math.floor(Date.now() / 1000) + 3600))
  headers.set('x-disgalm-sub', 'e2e')
  return headers
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const sala = (url.searchParams.get('sala') || '').trim().toLowerCase()
    if (url.pathname === '/auth.js')
      return new Response(AUTH, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } })
    if (url.pathname === '/ice')
      return Response.json([{ urls: 'stun:stun.cloudflare.com:3478' }], { headers: { 'x-disgalm-ice-validade': '300' } })
    if (url.pathname === '/_e2e/orcamento') {
      const agora = Date.now(), hora = new Date(agora); hora.setUTCMinutes(0, 0, 0)
      const o = env.ORCAMENTO.get(env.ORCAMENTO.idFromName('conta'))
      // ?ler=1 só lê; sem os secrets de analytics o retrato nem é usado.
      if (url.searchParams.has('ler')) return Response.json(await o.estado())
      await o.gravarSnapshot({ mes: new Date(agora).toISOString().slice(0, 7), coletado_em: agora,
        medido_ate: +hora - 3600_000, completo: true, turn_bytes: Number(url.searchParams.get('turn_gb') || 0) * 1e9, turn_bytes_sfu: 0, sfu_bytes: 0, sfu_fonte: 'graphql' })
      return Response.json(await o.estado())
    }
    if (url.pathname === '/ws')
      return env.SALA.get(env.SALA.idFromName(sala)).fetch(new Request(req, { headers: membro(new Headers(req.headers)) }))
    if (url.pathname === '/sfu') {
      const headers = membro(new Headers({ 'content-type': 'application/json',
        'x-disgalm-sfu': req.headers.get('x-disgalm-sfu') || '' }))
      return env.SALA.get(env.SALA.idFromName(sala)).fetch(new Request(`${url.origin}/sfu?sala=${sala}`,
        { method: 'POST', headers, body: await req.text() }))
    }
    return env.ASSETS.fetch(req)
  },
}
