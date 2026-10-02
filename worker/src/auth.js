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
