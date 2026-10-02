// Client público OAuth: code + PKCE. Access/refresh ficam só na memória desta
// aba; nenhum token entra em URL de sala, localStorage ou cookie compartilhado.
(() => {
  const issuer = 'https://auth.galm.ai'
  const clientId = 'disgalm'
  const scope = 'disgalm:use'
  const redirectUri = `${location.origin}/auth/callback`
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

  function showStatus() {
    const state = document.getElementById('auth-state')
    const login = document.getElementById('auth-login')
    const enter = document.getElementById('entrar')
    if (!state || !login || !enter) return
    const authenticated = !!tokens
    state.textContent = authenticated ? 'Conectado com GALM' : guestRoom ?
      'Entrando como convidado · acesso válido por 24 horas' : guestPending ?
      'Verificando convite…' : error || 'Entre com GALM ou abra um convite para entrar como convidado.'
    state.classList.toggle('erro', !!error)
    login.hidden = authenticated || !!guestRoom || guestPending
    enter.disabled = !authenticated && !guestRoom
    const room = document.getElementById('sala-cod')
    if (room && guestRoom) { room.value = guestRoom; room.readOnly = true }
  }

  function accept(body) {
    if (!body?.access_token || !body?.refresh_token ||
        !String(body.scope || '').split(' ').includes(scope))
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

  async function postToken(fields) {
    const response = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...fields }),
      credentials: 'omit',
      cache: 'no-store',
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error_description || body.error || 'Falha no login GALM.')
    return body
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
      accept(await postToken({ grant_type: 'authorization_code', code: params.get('code'),
        redirect_uri: redirectUri, code_verifier: saved.verifier }))
      const room = new URL(returnTo, location.origin).searchParams.get('sala')
      if (room) document.getElementById('sala-cod').value = room
    } catch (e) {
      error = e.message
      showStatus()
    }
  }

  async function login() {
    const verifier = random(32)
    const state = random(16)
    const challenge = b64(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))
    const returnTo = location.pathname === '/auth/callback' ? '/' : location.pathname + location.search
    sessionStorage.setItem(pendingKey, JSON.stringify({ verifier, state, returnTo }))
    const url = new URL('/authorize', issuer)
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId,
      redirect_uri: redirectUri, scope, state, code_challenge: challenge,
      code_challenge_method: 'S256' })
    location.assign(url.href)
  }

  async function accessToken() {
    if (tokens && Date.now() < expiresAt - 45_000) return tokens.access_token
    if (!tokens?.refresh_token) throw new Error('Entre com GALM para usar o Disgalm.')
    if (!refreshing) refreshing = postToken({ grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token }).then(accept).then(() => tokens.access_token)
      .catch(e => { tokens = null; error = 'Sessão expirada. Entre com GALM novamente.'; showStatus(); throw e })
      .finally(() => { refreshing = null })
    return refreshing
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

  const ready = callback().then(guestBootstrap)
  window.disgalmAuth = { ready, login, accessToken, currentToken, isGuest }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('auth-login').addEventListener('click', login)
    showStatus()
    ready.then(showStatus)
  })
})()
