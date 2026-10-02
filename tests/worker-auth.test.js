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
