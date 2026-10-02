// Entrada de teste: a sinalização é a Sala de produção; o login vira um membro
// fixo cujo nome vem de ?nome=. /ice devolve só candidatos locais.
import { Sala } from '../../../worker/src/index.js'

export { Sala }

const AUTH = `(() => {
  const nome = new URL(location.href).searchParams.get('nome') || 'E2E'
  const sempre = async () => 'e2e'
  window.disgalmAuth = {
    ready: Promise.resolve(), login() {}, logout: async () => {}, accessToken: sempre,
    currentToken: () => 'e2e', isGuest: () => false, member: () => true, guestInvite: () => null,
    account: async () => ({ name: nome, email: nome.toLowerCase() + '@e2e', picture: null }),
  }
})()`

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (url.pathname === '/auth.js')
      return new Response(AUTH, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } })
    if (url.pathname === '/ice') return Response.json([])
    if (url.pathname === '/ws') {
      const sala = (url.searchParams.get('sala') || '').trim().toLowerCase()
      const headers = new Headers(req.headers)
      headers.set('x-disgalm-role', 'member')
      headers.set('x-disgalm-exp', String(Math.floor(Date.now() / 1000) + 3600))
      headers.set('x-disgalm-sub', 'e2e-' + (url.searchParams.get('nome') || ''))
      return env.SALA.get(env.SALA.idFromName(sala)).fetch(new Request(req, { headers }))
    }
    return env.ASSETS.fetch(req)
  },
}
