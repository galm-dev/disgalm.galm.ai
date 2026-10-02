import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'

globalThis.crypto ||= webcrypto
const dir = mkdtempSync(join(tmpdir(), 'disgalm-auth-'))
const source = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers'",
    'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }')
  .replace("from './auth.js'", "from './auth.mjs'")
writeFileSync(join(dir, 'worker.mjs'), source)
writeFileSync(join(dir, 'auth.mjs'), readFileSync(new URL('../worker/src/auth.js', import.meta.url)))
const { default: worker } = await import(join(dir, 'worker.mjs'))

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test-key', alg: 'ES256', use: 'sig' }
const b64 = value => Buffer.from(typeof value === 'string' ? value : new Uint8Array(value)).toString('base64url')
const now = () => Math.floor(Date.now() / 1000)
async function token(overrides = {}) {
  const head = b64(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: 'test-key' }))
  const body = b64(JSON.stringify({ iss: 'https://auth.galm.ai', sub: 'person-1', aud: 'disgalm',
    client_id: 'disgalm', scope: 'disgalm:use', amr: ['google', 'passkey'],
    iat: now(), exp: now() + 600, ...overrides }))
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
    new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${b64(signature)}`
}

test('TURN e WebSocket exigem token correto e origem da própria página', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ keys: [jwk] })
  try {
    const delegated = []
    const env = { SALA: { idFromName: name => name, get: () => ({ fetch: request => {
      delegated.push(request)
      return new Response('delegado')
    } }) } }
    const valid = await token()
    const ice = headers => worker.fetch(new Request('https://disgalm.galm.ai/ice', { headers }), env)
    assert.equal((await ice()).status, 401)
    assert.equal((await ice({ authorization: `Bearer ${valid}` })).status, 200)
    assert.equal((await ice({ authorization: `Bearer ${await token({ scope: '' })}` })).status, 401)
    assert.equal((await ice({ authorization: `Bearer ${await token({ aud: 'other' })}` })).status, 401)
    assert.equal((await ice({ authorization: `Bearer ${await token({ amr: ['google'] })}` })).status, 401)
    assert.equal((await ice({ authorization: `Bearer ${await token({ exp: now() - 1 })}` })).status, 401)
    assert.equal((await ice({ authorization: `Bearer ${valid.slice(0, -2)}aa` })).status, 401)

    const ws = (origin, protocol) => worker.fetch(new Request('https://disgalm.galm.ai/ws?sala=galm', {
      headers: { Upgrade: 'websocket', ...(origin && { Origin: origin }),
        ...(protocol && { 'Sec-WebSocket-Protocol': protocol }) },
    }), env)
    assert.equal((await ws(null, `disgalm, auth.${valid}`)).status, 403)
    assert.equal((await ws('https://evil.example', `disgalm, auth.${valid}`)).status, 403)
    assert.equal((await ws('https://disgalm.galm.ai', null)).status, 401)
    assert.equal((await ws('https://disgalm.galm.ai', `disgalm, auth.${valid}`)).status, 200)
    assert.equal(delegated.length, 1)
    assert.equal(delegated[0].headers.get('x-disgalm-exp'), String(now() + 600))
  } finally { globalThis.fetch = originalFetch }
})

test('convite fica limitado à sala, exige membro GALM para emissão e dá acesso sem login', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ keys: [jwk] })
  try {
    const issued = 'a'.repeat(64)
    const delegated = []
    const env = { SALA: { idFromName: name => name, get: room => ({ fetch: request => {
      delegated.push({ room, request })
      if (new URL(request.url).pathname === '/invite') return Response.json({ token: issued, expiresAt: now() + 86400 })
      if (new URL(request.url).pathname === '/guest/check')
        return request.headers.get('x-disgalm-guest-token') === issued && room === 'galm'
          ? Response.json({ exp: now() + 86400 }) : new Response('inválido', { status: 401 })
      return new Response('websocket delegado')
    } }) } }
    const root = 'https://disgalm.galm.ai'
    const valid = await token()
    const invite = (headers = {}) => worker.fetch(new Request(`${root}/invite?sala=galm`,
      { method: 'POST', headers }), env)
    assert.equal((await invite({ Origin: root })).status, 401)
    assert.equal((await invite({ Origin: 'https://evil.example', authorization: `Bearer ${valid}` })).status, 403)
    assert.equal((await invite({ Origin: root, authorization: `Bearer ${valid}` })).status, 200)
    assert.equal(delegated.at(-1).request.headers.get('x-disgalm-sub'), 'person-1')
    const redeem = (room, tokenValue) => worker.fetch(new Request(`${root}/guest/redeem?sala=${room}`, {
      method: 'POST', headers: { Origin: root, 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokenValue }),
    }), env)
    assert.equal((await redeem('other', issued)).status, 401)
    const accepted = await redeem('galm', issued)
    assert.equal(accepted.status, 200)
    const cookie = accepted.headers.get('set-cookie')
    assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/)
    assert.equal((await worker.fetch(new Request(`${root}/guest/session?sala=galm`,
      { headers: { cookie } }), env)).status, 200)
    assert.equal((await worker.fetch(new Request(`${root}/guest/session?sala=other`,
      { headers: { cookie } }), env)).status, 401)
    assert.equal((await worker.fetch(new Request(`${root}/ice?sala=galm`,
      { headers: { cookie } }), env)).status, 200)
    assert.equal((await worker.fetch(new Request(`${root}/ice?sala=other`,
      { headers: { cookie } }), env)).status, 401)
    const ws = origin => worker.fetch(new Request(`${root}/ws?sala=galm`, {
      headers: { Upgrade: 'websocket', Origin: origin, cookie,
        'Sec-WebSocket-Protocol': 'disgalm', 'x-disgalm-role': 'member' },
    }), env)
    assert.equal((await ws('https://evil.example')).status, 403)
    assert.equal((await ws(root)).status, 200)
    assert.equal(delegated.at(-1).request.headers.get('x-disgalm-role'), 'guest')
    assert.equal((await invite({ Origin: root, cookie })).status, 401)
  } finally { globalThis.fetch = originalFetch }
})

test('sessão persistente guarda o refresh só em cookie HttpOnly e o logout revoga', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  let refreshes = 0
  globalThis.fetch = async (url, init) => {
    const form = new URLSearchParams(init.body)
    calls.push({ url: String(url), form })
    if (String(url).endsWith('/revoke')) return new Response(null, { status: 200 })
    if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'gasto-gasto-gasto-1')
      return Response.json({ error: 'invalid_grant', error_description: 'Refresh token revogado' }, { status: 400 })
    refreshes++
    return Response.json({ access_token: 'a.b.c', token_type: 'Bearer', expires_in: 600,
      scope: 'disgalm:use', refresh_token: `refresh-novo-${refreshes}-xxxx` })
  }
  try {
    const origin = 'https://disgalm.galm.ai'
    const post = (path, { cookie, json, from = origin } = {}) => worker.fetch(new Request(origin + path, {
      method: 'POST', headers: { ...(from && { Origin: from }), ...(cookie && { cookie }),
        ...(json && { 'content-type': 'application/json' }) }, body: json && JSON.stringify(json) }), {})

    assert.equal((await post('/auth/refresh', { from: 'https://evil.example',
      cookie: '__Host-disgalm_refresh=refresh-novo-0-xxxx' })).status, 403)
    assert.equal((await post('/auth/refresh')).status, 401)
    assert.equal(calls.length, 0)

    const code = await post('/auth/code', { json: { code: 'c0de', code_verifier: 'v'.repeat(43) } })
    assert.equal(code.status, 200)
    const body = await code.json()
    assert.equal(body.access_token, 'a.b.c')
    assert.equal(body.refresh_token, undefined)
    const cookie = code.headers.get('set-cookie')
    assert.match(cookie, /^__Host-disgalm_refresh=refresh-novo-1-xxxx; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/)
    assert.equal(calls[0].form.get('redirect_uri'), `${origin}/auth/callback`)
    assert.equal(calls[0].form.get('client_id'), 'disgalm')

    const refreshed = await post('/auth/refresh', { cookie: '__Host-disgalm_refresh=refresh-novo-1-xxxx' })
    assert.equal(refreshed.status, 200)
    assert.equal(calls[1].form.get('refresh_token'), 'refresh-novo-1-xxxx')
    assert.match(refreshed.headers.get('set-cookie'), /refresh-novo-2-xxxx/)

    const dead = await post('/auth/refresh', { cookie: '__Host-disgalm_refresh=gasto-gasto-gasto-1' })
    assert.equal(dead.status, 401)
    assert.match(dead.headers.get('set-cookie'), /^__Host-disgalm_refresh=; Path=\/; Max-Age=0;/)

    const out = await post('/auth/logout', { cookie: '__Host-disgalm_refresh=refresh-novo-2-xxxx' })
    assert.equal(out.status, 204)
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/)
    assert.ok(calls.at(-1).url.endsWith('/revoke'))
    assert.equal(calls.at(-1).form.get('token'), 'refresh-novo-2-xxxx')
  } finally {
    globalThis.fetch = originalFetch
  }
})
