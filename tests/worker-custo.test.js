// Custo de pedido hostil (R14 e R15 da revisão de arquitetura): um token com
// kid desconhecido não pode buscar o JWKS a cada pedido, e um corpo grande não
// pode ser lido inteiro antes do teto.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { carregarWorker } from './worker.js'

globalThis.crypto ||= webcrypto

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const publica = await crypto.subtle.exportKey('jwk', pair.publicKey)
const b64 = v => Buffer.from(typeof v === 'string' ? v : new Uint8Array(v)).toString('base64url')
const agora = () => Math.floor(Date.now() / 1000)
async function token(kid) {
  const head = b64(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid }))
  const body = b64(JSON.stringify({ iss: 'https://auth.galm.ai', sub: 'p-1', aud: 'disgalm', client_id: 'disgalm',
    scope: 'disgalm:use', amr: ['passkey'], iat: agora(), exp: agora() + 600 }))
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
    new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${b64(sig)}`
}

// Cada carga é um módulo novo, com o cache do JWKS vazio.
async function comJwks(fn) {
  const { default: worker } = await carregarWorker()
  const jwks = { kids: ['k1'], buscas: 0 }
  const fetchOriginal = globalThis.fetch, nowOriginal = Date.now
  let deslocamento = 0
  globalThis.fetch = async () => {
    jwks.buscas++
    return Response.json({ keys: jwks.kids.map(kid => ({ ...publica, kid })) })
  }
  Date.now = () => nowOriginal() + deslocamento
  const ice = async kid => (await worker.fetch(new Request('https://disgalm.galm.ai/ice',
    { headers: { authorization: `Bearer ${await token(kid)}` } }), {})).status
  try { await fn({ worker, jwks, ice, avancar: ms => { deslocamento += ms } }) }
  finally { globalThis.fetch = fetchOriginal; Date.now = nowOriginal }
}

// Resposta do Worker ou, se ele ficar lendo o corpo sem fim, 'sem resposta'.
const comPrazo = promessa => Promise.race([promessa,
  new Promise(ok => setTimeout(() => ok({ status: 'sem resposta' }), 2000))])

test('JWKS: kid conhecido usa o cache; só renova quando o cache vence', () => comJwks(async ({ jwks, ice, avancar }) => {
  for (let i = 0; i < 10; i++) assert.equal(await ice('k1'), 200)
  assert.equal(jwks.buscas, 1)
  avancar(6 * 60_000)
  assert.equal(await ice('k1'), 200)
  assert.equal(jwks.buscas, 2)
}))

test('JWKS: kid desconhecido repetido não busca o JWKS a cada pedido', () => comJwks(async ({ jwks, ice }) => {
  assert.equal(await ice('k1'), 200)
  for (let i = 0; i < 50; i++) assert.equal(await ice('forjado'), 401)
  // Uma busca do cache inicial e no máximo uma renovação pelo kid novo.
  assert.ok(jwks.buscas <= 2, `buscou o JWKS ${jwks.buscas} vezes`)
}))

test('JWKS: kid desconhecido simultâneo divide uma só busca', () => comJwks(async ({ jwks, ice }) => {
  const r = await Promise.all(Array.from({ length: 20 }, () => ice('forjado')))
  assert.ok(r.every(s => s === 401))
  assert.ok(jwks.buscas <= 2, `buscou o JWKS ${jwks.buscas} vezes`)
}))

test('JWKS: chave nova do auth entra pela renovação do kid desconhecido', () => comJwks(async ({ jwks, ice, avancar }) => {
  assert.equal(await ice('k1'), 200)
  avancar(60_000)
  jwks.kids = ['k1', 'k2']
  assert.equal(await ice('k2'), 200)
  assert.equal(jwks.buscas, 2)
}))

// Corpo de 64 MiB em pedaços de 16 KiB, contando quantos foram puxados.
function corpoSemFim() {
  const c = { puxados: 0 }
  c.stream = new ReadableStream({ pull(ctrl) {
    if (++c.puxados > 4096) return ctrl.close()
    ctrl.enqueue(new Uint8Array(16 * 1024).fill(120))
  } })
  return c
}
const ORIGEM = 'https://disgalm.galm.ai'

test('telemetria: corpo grande para no teto, sem ser lido inteiro', () => comJwks(async ({ worker }) => {
  const corpo = corpoSemFim()
  const pedido = new Request(`${ORIGEM}/telemetria?sala=galm`, { method: 'POST', duplex: 'half', body: corpo.stream,
    headers: { origin: ORIGEM, authorization: `Bearer ${await token('k1')}` } })
  const r = await comPrazo(worker.fetch(pedido, {}, { waitUntil() {} }))
  assert.equal(r.status, 413)
  assert.ok(corpo.puxados <= 8, `puxou ${corpo.puxados} pedaços`)
}))

test('telemetria: content-length acima do teto recusa sem ler o corpo', () => comJwks(async ({ worker }) => {
  const corpo = corpoSemFim()
  const pedido = new Request(`${ORIGEM}/telemetria?sala=galm`, { method: 'POST', duplex: 'half', body: corpo.stream,
    headers: { origin: ORIGEM, authorization: `Bearer ${await token('k1')}`, 'content-length': String(10 * 1024 * 1024) } })
  const r = await comPrazo(worker.fetch(pedido, {}, { waitUntil() {} }))
  assert.equal(r.status, 413)
  assert.ok(corpo.puxados <= 2, `puxou ${corpo.puxados} pedaços`)
}))

test('telemetria: lote dentro do teto continua aceito', () => comJwks(async ({ worker }) => {
  const tarefas = []
  const r = await worker.fetch(new Request(`${ORIGEM}/telemetria?sala=galm`, { method: 'POST',
    body: JSON.stringify({ eventos: [{ evento: 'teste', n: 1 }] }),
    headers: { origin: ORIGEM, authorization: `Bearer ${await token('k1')}` } }), {},
  { waitUntil: p => tarefas.push(p) })
  assert.equal(r.status, 204)
  await Promise.all(tarefas)
}))

test('/sfu: corpo grande para no teto, antes de autenticar', () => comJwks(async ({ worker, jwks }) => {
  const corpo = corpoSemFim()
  const repassados = []
  const env = { SFU_SALAS: 'ensaio', SFU_APP_ID: 'app', SFU_APP_SECRET: 'segredo',
    SALA: { idFromName: n => n, get: () => ({ fetch: async r => { repassados.push(r); return Response.json({}) } }) } }
  const pedido = new Request(`${ORIGEM}/sfu?sala=ensaio`, { method: 'POST', duplex: 'half', body: corpo.stream,
    headers: { origin: ORIGEM, 'content-type': 'application/json', 'x-disgalm-sfu': 'a'.repeat(64),
      authorization: `Bearer ${await token('k1')}` } })
  const r = await comPrazo(worker.fetch(pedido, env, {}))
  assert.equal(r.status, 413)
  assert.ok(corpo.puxados <= 12, `puxou ${corpo.puxados} pedaços`)
  assert.equal(jwks.buscas, 0)
  assert.equal(repassados.length, 0)
}))

test('/guest/redeem: corpo grande para no teto', () => comJwks(async ({ worker }) => {
  const corpo = corpoSemFim()
  const pedido = new Request(`${ORIGEM}/guest/redeem?sala=galm`, { method: 'POST', duplex: 'half', body: corpo.stream,
    headers: { origin: ORIGEM, 'content-type': 'application/json' } })
  const r = await comPrazo(worker.fetch(pedido, {}, {}))
  assert.equal(r.status, 413)
  assert.ok(corpo.puxados <= 2, `puxou ${corpo.puxados} pedaços`)
}))
