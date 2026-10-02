// Access tokens do auth.galm.ai são conferidos no Worker, antes de entregar
// credenciais TURN ou abrir a sinalização. Nenhum segredo do auth mora aqui.
const ISSUER = 'https://auth.galm.ai'
const AUDIENCE = 'disgalm'
const SCOPE = 'disgalm:use'
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`
const encoder = new TextEncoder()

let cachedKeys = null
let cachedUntil = 0

function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('base64url inválido')
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), c => c.charCodeAt(0))
}

async function keys(force = false) {
  if (!force && cachedKeys && Date.now() < cachedUntil) return cachedKeys
  const response = await fetch(JWKS_URL, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error('JWKS indisponível')
  const body = await response.json()
  if (!Array.isArray(body.keys)) throw new Error('JWKS inválido')
  cachedKeys = body.keys
  cachedUntil = Date.now() + 5 * 60_000
  return cachedKeys
}

export async function verifyAccess(token) {
  if (typeof token !== 'string' || token.length > 8192) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])))
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])))
    if (header.alg !== 'ES256' || header.typ !== 'at+jwt' || typeof header.kid !== 'string') return null
    const now = Math.floor(Date.now() / 1000)
    if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.client_id !== AUDIENCE ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.iat) || claims.iat > now + 60 ||
        (claims.nbf != null && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60)) ||
        typeof claims.sub !== 'string' || !claims.sub ||
        !Array.isArray(claims.amr) || !claims.amr.includes('passkey') ||
        !String(claims.scope || '').split(' ').includes(SCOPE)) return null

    let jwk = (await keys()).find(k => k.kid === header.kid && k.kty === 'EC' && k.crv === 'P-256')
    if (!jwk) jwk = (await keys(true)).find(k => k.kid === header.kid && k.kty === 'EC' && k.crv === 'P-256')
    if (!jwk) return null
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, decode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`))
    return valid ? claims : null
  } catch {
    return null
  }
}

export function bearer(request) {
  return /^Bearer ([A-Za-z0-9._-]+)$/.exec(request.headers.get('authorization') || '')?.[1] || null
}

export function websocketToken(request) {
  const protocols = (request.headers.get('sec-websocket-protocol') || '').split(',').map(p => p.trim())
  if (protocols[0] !== 'disgalm' || protocols.length !== 2) return null
  return /^auth\.([A-Za-z0-9._-]+)$/.exec(protocols[1])?.[1] || null
}

// Sessão persistente: o refresh token mora num cookie HttpOnly host-only deste
// domínio e só o Worker o lê. O navegador recebe apenas o access token, que
// continua só na memória da aba. Refresh é rotativo no auth: reapresentar um
// já trocado derruba a família, por isso o cliente serializa as chamadas.
const REFRESH_COOKIE = '__Host-disgalm_refresh'
const REFRESH_SECONDS = 30 * 24 * 60 * 60
const OPAQUE = /^[A-Za-z0-9_-]{16,512}$/
const noStore = { 'cache-control': 'no-store' }

const refreshCookie = (value, maxAge) =>
  `${REFRESH_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`

function readRefresh(request) {
  const value = (request.headers.get('cookie') || '').split(';').map(s => s.trim())
    .find(s => s.startsWith(`${REFRESH_COOKIE}=`))?.slice(REFRESH_COOKIE.length + 1) || ''
  return OPAQUE.test(value) ? value : null
}

const issuerPost = (path, fields) => fetch(`${ISSUER}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: AUDIENCE, ...fields }),
})

function fail(status, description, clear = false) {
  const headers = new Headers(noStore)
  if (clear) headers.append('set-cookie', refreshCookie('', 0))
  return Response.json({ error_description: description }, { status, headers })
}

export const sessionPaths = ['/auth/code', '/auth/refresh', '/auth/logout']

export async function session(request, url) {
  if (request.method !== 'POST') return new Response('método inválido', { status: 405 })
  if (request.headers.get('Origin') !== url.origin) return new Response('origem inválida', { status: 403 })

  if (url.pathname === '/auth/logout') {
    const refresh = readRefresh(request)
    if (refresh) await issuerPost('/revoke', { token: refresh }).catch(() => {})
    const headers = new Headers(noStore)
    headers.append('set-cookie', refreshCookie('', 0))
    return new Response(null, { status: 204, headers })
  }

  let fields
  if (url.pathname === '/auth/code') {
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
      return new Response('conteúdo inválido', { status: 415 })
    const body = await request.json().catch(() => null)
    if (typeof body?.code !== 'string' || typeof body?.code_verifier !== 'string')
      return fail(400, 'Resposta do login inválida. Tente novamente.')
    fields = { grant_type: 'authorization_code', code: body.code, code_verifier: body.code_verifier,
      redirect_uri: `${url.origin}/auth/callback` }
  } else {
    const refresh = readRefresh(request)
    if (!refresh) return fail(401, 'Entre com GALM para usar o Disgalm.')
    fields = { grant_type: 'refresh_token', refresh_token: refresh }
  }

  let response, body
  try {
    response = await issuerPost('/token', fields)
    body = await response.json()
  } catch {
    return fail(502, 'O login GALM não respondeu. Tente novamente.')
  }
  // Recusa do auth (code ruim, refresh vencido ou revogado): o cookie morreu.
  if (!response.ok) return fail(response.status >= 500 ? 502 : 401,
    body?.error_description || 'Sessão expirada. Entre com GALM novamente.', response.status < 500)
  if (typeof body?.access_token !== 'string' || !OPAQUE.test(body?.refresh_token || ''))
    return fail(502, 'Resposta inesperada do login GALM.')
  if (!String(body.scope || '').split(' ').includes(SCOPE)) {
    await issuerPost('/revoke', { token: body.refresh_token }).catch(() => {})
    return fail(403, 'Sua conta ainda não tem acesso ao Disgalm.', true)
  }

  const headers = new Headers(noStore)
  headers.append('set-cookie', refreshCookie(body.refresh_token, REFRESH_SECONDS))
  return Response.json({ access_token: body.access_token, token_type: body.token_type,
    expires_in: body.expires_in, scope: body.scope }, { headers })
}
