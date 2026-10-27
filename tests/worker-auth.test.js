import { test } from 'node:test'
import { carregarWorker } from './worker.js'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

globalThis.crypto ||= webcrypto
const { default: worker } = await carregarWorker()

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
    // Adultera um caractere do meio da assinatura. Trocar os dois últimos por
    // "aa" falhava ~1 vez em 256: em base64url o último caractere carrega só
    // 2 bits, e às vezes a assinatura "adulterada" era a mesma.
    const i = valid.length - 20
    const adulterado = valid.slice(0, i) + (valid[i] === 'A' ? 'B' : 'A') + valid.slice(i + 1)
    assert.equal((await ice({ authorization: `Bearer ${adulterado}` })).status, 401)

    const ws = (origin, protocol) => worker.fetch(new Request('https://disgalm.galm.ai/ws?sala=galm', {
      headers: { Upgrade: 'websocket', ...(origin && { Origin: origin }),
        ...(protocol && { 'Sec-WebSocket-Protocol': protocol }) },
    }), env)
    assert.equal((await ws(null, `disgalm, auth.${valid}`)).status, 403)
    assert.equal((await ws('https://evil.example', `disgalm, auth.${valid}`)).status, 403)
    assert.equal((await ws('https://disgalm.galm.ai', null)).status, 401)
    assert.equal((await ws('https://disgalm.galm.ai', `disgalm, auth.${valid}`)).status, 200)
    assert.equal(delegated.length, 1)
    // O exp do próprio token: now() + 600 aqui erra 1 s se o segundo virou no meio.
    const expValido = JSON.parse(Buffer.from(valid.split('.')[1], 'base64url')).exp
    assert.equal(delegated[0].headers.get('x-disgalm-exp'), String(expValido))
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

test('os consumidores JSON normalizam o media type e preservam as recusas e seus efeitos', async t => {
  const root = 'https://disgalm.galm.ai'
  const originalFetch = globalThis.fetch
  const cases = [
    { name: 'canônico' },
    { name: 'parâmetro', mime: 'application/json; charset=utf-8' },
    { name: 'caixa mista', mime: 'Application/JSON' },
    { name: 'maiúsculas', mime: 'APPLICATION/JSON' },
    { name: 'espaço antes do parâmetro', mime: 'application/json ; charset=utf-8' },
    { name: 'tab e parâmetros', mime: 'Application/Json\t; charset=UTF-8; profile="fixture"' },
    ...[null, '', 'text/plain', 'application/problem+json', 'application/jsonp',
      'application/json, text/plain', 'application/ json'].map(mime => ({ name: `tipo recusado ${mime}`, mime, status: 415 })),
    { name: 'JSON truncado', body: '{', status: 400, guestStatus: 401 },
    { name: 'JSON null', body: 'null', status: 400, guestStatus: 401 },
    { name: 'campos ausentes', body: '{}', status: 400, guestStatus: 401 },
    { name: 'campos de tipo errado', body: '{"code":1,"code_verifier":2,"token":true}', status: 400, guestStatus: 401 },
    { name: 'origem diferente', origin: 'https://evil.example', status: 403 },
    { name: 'sem origem', origin: null, status: 403 },
    { name: 'método diferente', method: 'PUT', status: 405 },
    { name: 'recusa remota', remoteStatus: 400, status: 401, calls: 1 },
    { name: 'rate limit remoto', remoteStatus: 429, status: 401, calls: 1 },
    { name: 'erro remoto', remoteStatus: 500, status: 502, guestStatus: 401, calls: 1 },
    { name: 'sala diferente', room: 'other', status: 200, guestStatus: 401, calls: 1 },
    { name: 'sala inválida', room: '', status: 200, guestStatus: 400, calls: 1, guestCalls: 0 },
    { name: 'sem escopo', scope: '', status: 403, guestStatus: 200, calls: 2, guestCalls: 1 },
  ]
  try {
    for (const path of ['/auth/code', '/guest/redeem']) {
      const guest = path === '/guest/redeem'
      for (const c of cases) await t.test(`${path}: ${c.name}`, async () => {
        const calls = [], delegated = []
        globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(init.body)) })
          return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh-token',
            scope: c.scope ?? 'disgalm:use', error_description: 'fixture refusal' }, { status: c.remoteStatus ?? 200 })
        }
        const env = { SALA: { idFromName: name => name, get: room => ({ fetch: request => {
          delegated.push({ room, path: new URL(request.url).pathname, method: request.method,
            token: request.headers.get('x-disgalm-guest-token') })
          return room === 'galm' && !c.remoteStatus
            ? Response.json({ exp: 2000000000 }) : new Response('fixture refusal', { status: c.remoteStatus ?? 401 })
        } }) } }
        const origin = c.origin === undefined ? root : c.origin
        const mime = c.mime === undefined ? 'application/json' : c.mime
        const request = new Request(`${root}${path}?sala=${c.room ?? 'galm'}`, {
          method: c.method ?? 'POST', headers: { ...(origin && { Origin: origin }) },
          body: c.body ?? JSON.stringify(guest ? { token: 'a'.repeat(64) } : { code: 'fixture-code', code_verifier: 'v'.repeat(43) }),
        })
        if (mime === null) request.headers.delete('content-type')
        else request.headers.set('content-type', mime)
        const response = await worker.fetch(request, env)
        const status = (guest ? c.guestStatus : undefined) ?? c.status ?? 200
        const count = (guest ? c.guestCalls : undefined) ?? c.calls ?? (status === 200 ? 1 : 0)
        t.diagnostic(JSON.stringify({ path, case: c.name, status: response.status,
          cookie: response.headers.get('set-cookie'), body: await response.text(), calls, delegated }))
        assert.equal(response.status, status)
        assert.equal(calls.length, guest ? 0 : count)
        assert.equal(delegated.length, guest ? count : 0)
        if (!count) assert.equal(response.headers.get('set-cookie'), null)
        if (status === 200) {
          assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=/)
          if (guest) assert.deepEqual(delegated, [{ room: 'galm', path: '/guest/check', method: 'POST', token: 'a'.repeat(64) }])
          else assert.deepEqual(calls[0], { url: 'https://auth.galm.ai/token', form: {
            grant_type: 'authorization_code', client_id: 'disgalm', code: 'fixture-code',
            code_verifier: 'v'.repeat(43), redirect_uri: `${root}/auth/callback`,
          } })
        }
      })
    }
  } finally { globalThis.fetch = originalFetch }
})

test('telemetria exige membro e origem, limpa o lote e repassa ao Better Stack com a sala e o sub', async () => {
  const originalFetch = globalThis.fetch
  const enviados = [], pendentes = []
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://logs.example')) { enviados.push({ url: String(url), init }); return new Response(null, { status: 202 }) }
    return Response.json({ keys: [jwk] })
  }
  const originalLog = console.log
  console.log = () => {}
  try {
    const env = { BETTERSTACK_TOKEN: 'segredo', BETTERSTACK_HOST: 'logs.example',
      SALA: { idFromName: name => name, get: () => ({ fetch: () => new Response('não', { status: 401 }) }) } }
    const ctx = { waitUntil: p => pendentes.push(p) }
    const valid = await token()
    const root = 'https://disgalm.galm.ai'
    const post = (corpo, { origin = root, auth = valid, sala = 'galm' } = {}) =>
      worker.fetch(new Request(`${root}/telemetria?sala=${sala}`, { method: 'POST',
        headers: { Origin: origin, 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${auth}` }) },
        body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) }), env, ctx)
    const lote = { eventos: [{ evento: 'ice', par: 'bbbb0002', estado: 'failed', sala: 'outra', sub: 'falso',
      detalhe: { a: 1 } }, { sem: 'evento' }] }
    assert.equal((await post(lote, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await post(lote, { auth: null })).status, 401)
    assert.equal((await post('não é json')).status, 400)
    assert.equal((await post({ eventos: [] }, { sala: '' })).status, 400)
    assert.equal((await post('x'.repeat(70 * 1024))).status, 413)
    assert.equal((await post(lote)).status, 204)
    await Promise.all(pendentes)
    assert.equal(enviados.length, 1)
    assert.equal(enviados[0].url, 'https://logs.example')
    assert.equal(enviados[0].init.headers.authorization, 'Bearer segredo')
    const [linha, ...resto] = JSON.parse(enviados[0].init.body)
    assert.equal(resto.length, 0)
    assert.equal(linha.evento, 'ice')
    assert.equal(linha.message, 'ice')
    assert.equal(linha.origem, 'navegador')
    assert.equal(linha.sala, 'galm')
    assert.equal(linha.sub, 'person-1')
    assert.equal(linha.papel, 'member')
    assert.equal(linha.detalhe, '{"a":1}')
  } finally { globalThis.fetch = originalFetch; console.log = originalLog }
})
