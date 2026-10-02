// Client público OAuth: code + PKCE. O access token fica só na memória desta
// aba. O refresh fica num cookie HttpOnly host-only que só o Worker lê, para a
// sessão sobreviver ao recarregar; nenhum token entra em URL de sala,
// localStorage ou cookie compartilhado.
(() => {
  const issuer = 'https://auth.galm.ai'
  const clientId = 'disgalm'
  const scope = 'disgalm:use'
  const pendingKey = 'disgalm.oauth'
  const encoder = new TextEncoder()
  const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const random = n => b64(crypto.getRandomValues(new Uint8Array(n)))

  let tokens = null
  let expiresAt = 0
  let refreshing = null
  let error = ''
  let guestRoom = null
  let guestPending = false
  let profile = null

  function showStatus() {
    const state = document.getElementById('auth-state')
    const login = document.getElementById('auth-login')
    const guest = document.getElementById('guest-entry')
    if (!state || !login || !guest) return
    const authenticated = !!tokens
    state.textContent = authenticated ? 'Conectado com GALM' : guestRoom ?
      `Convite para a sala ${guestRoom} · acesso válido por 24 horas` : guestPending ?
      'Verificando convite…' : error || 'Entre com sua conta GALM ou abra um convite.'
    state.classList.toggle('erro', !!error)
    login.hidden = authenticated || !!guestRoom || guestPending
    guest.hidden = authenticated || !guestRoom
  }

  function accept(body) {
    if (!body?.access_token || !String(body.scope || '').split(' ').includes(scope))
      throw new Error('Sua conta ainda não tem acesso ao Disgalm.')
    const renewed = !!tokens
    tokens = body
    expiresAt = Date.now() + Math.max(0, Number(body.expires_in) || 0) * 1000
    error = ''
    showStatus()
    if (renewed) dispatchEvent(new Event('disgalm-token-refreshed'))
    const delay = Math.max(1000, expiresAt - Date.now() - 40_000)
    setTimeout(() => accessToken().catch(() => {}), delay)
  }

  // O auth rotaciona o refresh e derruba a família se um já trocado voltar.
  // Abas do mesmo navegador dividem o cookie, então uma troca por vez.
  async function postSession(path, json) {
    const run = async () => {
      const response = await fetch(path, {
        method: 'POST',
        headers: json ? { 'content-type': 'application/json' } : {},
        body: json ? JSON.stringify(json) : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (response.status === 204) return null
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw Object.assign(new Error(body.error_description || 'Falha no login GALM.'),
        { status: response.status })
      return body
    }
    return navigator.locks ? navigator.locks.request('disgalm.sessao', run) : run()
  }

  async function callback() {
    if (location.pathname !== '/auth/callback') return
    const params = new URLSearchParams(location.search)
    const saved = JSON.parse(sessionStorage.getItem(pendingKey) || 'null')
    sessionStorage.removeItem(pendingKey)
    const returnTo = saved?.returnTo?.startsWith('/') && !saved.returnTo.startsWith('//')
      ? saved.returnTo : '/'
    history.replaceState(null, '', returnTo)
    try {
      if (params.has('error')) throw new Error(params.get('error_description') || params.get('error'))
      if (!saved || !params.get('code') || params.get('state') !== saved.state ||
          params.get('iss') !== issuer) throw new Error('Resposta do login inválida. Tente novamente.')
      accept(await postSession('/auth/code', { code: params.get('code'), code_verifier: saved.verifier }))
    } catch (e) {
      error = e.message
      showStatus()
    }
  }

  // Nome e foto vêm da conta; o access token só carrega o email. Sem /userinfo,
  // o email ainda dá um nome razoável.
  function claims() {
    try {
      const part = tokens.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), c => c.charCodeAt(0))))
    } catch { return {} }
  }

  async function loadProfile() {
    const email = String(claims().email || '')
    const fallback = { name: email.split('@')[0] || '', email, picture: null }
    try {
      const response = await fetch(`${issuer}/userinfo`, {
        headers: { authorization: `Bearer ${await accessToken()}` },
        credentials: 'omit', cache: 'no-store' })
      if (!response.ok) return fallback
      const body = await response.json()
      return { name: String(body.name || '').trim() || fallback.name, email: body.email || email,
        picture: /^https:\/\/[^\s"'<>]{1,2000}$/.test(body.picture || '') ? body.picture : null }
    } catch { return fallback }
  }

  async function login() {
    const verifier = random(32)
    const state = random(16)
    const challenge = b64(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))
    const returnTo = location.pathname === '/auth/callback' ? '/' : location.pathname + location.search
    sessionStorage.setItem(pendingKey, JSON.stringify({ verifier, state, returnTo }))
    const url = new URL('/authorize', issuer)
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId,
      redirect_uri: `${location.origin}/auth/callback`, scope, state, code_challenge: challenge,
      code_challenge_method: 'S256' })
    location.assign(url.href)
  }

  async function accessToken() {
    if (tokens && Date.now() < expiresAt - 45_000) return tokens.access_token
    if (!tokens) throw new Error('Entre com GALM para usar o Disgalm.')
    if (!refreshing) refreshing = postSession('/auth/refresh').then(accept).then(() => tokens.access_token)
      .catch(e => {
        // Falha de rede não derruba a sessão; recusa do auth sim.
        if (e.status === 401 || e.status === 403) {
          tokens = null
          error = 'Sessão expirada. Entre com GALM novamente.'
          showStatus()
        }
        throw e
      })
      .finally(() => { refreshing = null })
    return refreshing
  }

  // Volta da última visita: o cookie do Worker vira um access token novo sem
  // passar pela tela de login. Sem cookie (401) a tela aparece calada.
  async function restore() {
    if (tokens) return
    try { accept(await postSession('/auth/refresh')) }
    catch (e) {
      if (e.status !== 401) error = e.status === 403 ? e.message :
        'Não foi possível verificar sua sessão GALM. Tente entrar de novo.'
    }
  }

  // Sair revoga a família no auth e apaga o cookie; as outras abas recarregam.
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('disgalm.auth') : null
  channel?.addEventListener('message', e => { if (e.data === 'logout') location.assign('/') })

  async function logout() {
    await postSession('/auth/logout')
    tokens = null
    try { localStorage.removeItem('disgalm.apelido') } catch {}
    channel?.postMessage('logout')
    location.assign('/')
  }

  function currentToken() {
    return tokens && Date.now() < expiresAt - 10_000 ? tokens.access_token : null
  }

  async function guestBootstrap() {
    if (tokens) return
    const room = new URL(location.href).searchParams.get('sala')
    const fragment = new URLSearchParams(location.hash.slice(1))
    const token = fragment.get('invite')
    if (token) history.replaceState(null, '', location.pathname + location.search)
    if (!room || (!token && !location.search)) return
    guestPending = true
    showStatus()
    try {
      const response = await fetch(`${token ? '/guest/redeem' : '/guest/session'}?sala=${encodeURIComponent(room)}`,
        token ? { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }), cache: 'no-store' } : { cache: 'no-store' })
      if (!response.ok) {
        if (token) throw new Error('Convite inválido, vencido ou sala vazia.')
        return
      }
      guestRoom = (await response.json()).room
      error = ''
    } catch (e) { error = e.message }
    finally { guestPending = false; showStatus() }
  }

  const isGuest = room => !!guestRoom && guestRoom === room && !tokens
  const member = () => !!tokens
  const guestInvite = () => tokens ? null : guestRoom
  const account = () => profile ??= tokens ? loadProfile() : Promise.resolve(null)

  const ready = callback().then(restore).then(guestBootstrap)
  window.disgalmAuth = { ready, login, logout, accessToken, currentToken, isGuest, member, guestInvite, account }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('auth-login').addEventListener('click', login)
    showStatus()
    ready.then(showStatus)
  })
})()
