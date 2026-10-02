import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// O Worker importa 'cloudflare:workers', que só existe no runtime. Troca por
// uma base mínima e carrega o resto do arquivo como está.
const fonte = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers'",
           'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }')
  .replace("from './auth.js'", "from './auth.mjs'")
const pasta = mkdtempSync(join(tmpdir(), 'disgalm-'))
const arquivo = join(pasta, 'worker.mjs')
writeFileSync(arquivo, fonte)
writeFileSync(join(pasta, 'auth.mjs'), readFileSync(new URL('../worker/src/auth.js', import.meta.url)))

class Socket {
  constructor() { this.msgs = []; this.att = null }
  serializeAttachment(a) { this.att = structuredClone(a) }
  deserializeAttachment() { return this.att }
  send(m) { this.msgs.push(JSON.parse(m)) }
  close(code, reason) { this.fechado = [code, reason] }
  ultima(t) { return this.msgs.filter(m => m.t === t).at(-1) }
}
globalThis.WebSocketPair = class { constructor() { this[0] = new Socket(); this[1] = new Socket() } }
globalThis.WebSocketRequestResponsePair = class { constructor(req, res) { Object.assign(this, { req, res }) } }
globalThis.Response = class {
  constructor(corpo, init) { this.body = corpo; this.status = 200; Object.assign(this, init) }
  static json(body, init) { const response = new this(JSON.stringify(body), init); response.json = async () => body; return response }
}
const { Sala } = await import(arquivo)

function sala(sockets = []) {
  const saved = new Map()
  const ctx = {
    auto: null,
    storage: { alarmAt: null, saved, async get(key) { return saved.get(key) },
      async put(key, value) { saved.set(key, value) },
      async setAlarm(value) { this.alarmAt = value }, async deleteAlarm() { this.alarmAt = null } },
    setWebSocketAutoResponse(par) { this.auto = par },
    acceptWebSocket(ws) { sockets.push(ws) },
    getWebSockets: () => sockets.filter(ws => !ws.fechado),
    getWebSocketAutoResponseTimestamp: ws => ws.pingEm ? new Date(ws.pingEm) : null,
  }
  const s = new Sala(ctx, {})
  s.sockets = sockets
  s.entra = async (params) => {
    const q = new URLSearchParams({ sala: 'galm', ...params })
    const r = await s.fetch({ url: `https://x/ws?${q}`,
      headers: new Headers({ 'x-disgalm-exp': String(Math.floor(Date.now() / 1000) + 600),
        'x-disgalm-role': 'member', 'x-disgalm-sub': params.sub || 'person-1' }) })
    return r.webSocket === undefined ? null : sockets.at(-1)
  }
  return { s, ctx }
}

test('batimento responde sem acordar o objeto', () => {
  const { ctx } = sala()
  assert.equal(ctx.auto.req, '{"t":"ping"}')
  assert.equal(ctx.auto.res, '{"t":"pong"}')
})

test('entrada comum: welcome para quem chega, peer-join para quem estava', async () => {
  const { s } = sala()
  const a = await s.entra({ nome: 'A', aba: 'aba-a' })
  const b = await s.entra({ nome: 'B', aba: 'aba-b' })
  const idA = a.ultima('welcome').id
  assert.deepEqual(b.ultima('welcome').peers, [{ id: idA, name: 'A' }])
  assert.equal(b.ultima('welcome').retomada, false)
  assert.equal(a.ultima('peer-join').name, 'B')
})

test('reconexão da mesma aba com o id retoma: sem saída, com peer-back', async () => {
  const { s } = sala()
  const a = await s.entra({ nome: 'A', aba: 'aba-a' })
  const b = await s.entra({ nome: 'B', aba: 'aba-b' })
  const idB = b.ultima('welcome').id
  const b2 = await s.entra({ nome: 'B', aba: 'aba-b', id: idB })
  assert.deepEqual(b.fechado, [1000, 'substituída'])
  assert.equal(b2.ultima('welcome').id, idB)
  assert.equal(b2.ultima('welcome').retomada, true)
  assert.equal(a.ultima('peer-left'), undefined)
  assert.equal(a.ultima('peer-back').id, idB)
  // O socket substituído fechando depois não gera saída.
  await s.webSocketClose(b, 1006)
  assert.equal(a.ultima('peer-left'), undefined)
})

test('F5: a mesma aba sem o id tira o fantasma e entra como pessoa nova', async () => {
  const { s } = sala()
  const a = await s.entra({ nome: 'A', aba: 'aba-a' })
  const b = await s.entra({ nome: 'B', aba: 'aba-b' })
  const idB = b.ultima('welcome').id
  const b2 = await s.entra({ nome: 'B', aba: 'aba-b' })
  assert.deepEqual(a.msgs.filter(m => m.t === 'peer-left'), [{ t: 'peer-left', id: idB, volta: false }])
  assert.notEqual(b2.ultima('welcome').id, idB)
  assert.equal(b2.ultima('welcome').peers.length, 1)
  assert.equal(a.ultima('peer-join').id, b2.ultima('welcome').id)
})

test('depois de reinício do objeto, o id volta mesmo sem ninguém na sala', async () => {
  const { s } = sala()
  const a = await s.entra({ nome: 'A', aba: 'aba-a', id: 'abcd1234' })
  assert.equal(a.ultima('welcome').id, 'abcd1234')
  assert.equal(a.ultima('welcome').retomada, true)
})

test('id em uso por outra aba não é tomado', async () => {
  const { s } = sala()
  const a = await s.entra({ nome: 'A', aba: 'aba-a' })
  const idA = a.ultima('welcome').id
  const intruso = await s.entra({ nome: 'X', aba: 'aba-x', id: idA })
  assert.notEqual(intruso.ultima('welcome').id, idA)
  assert.equal(a.fechado, undefined)
})

test('fantasma sem batimento sai com volta=true; cliente antigo sem aba não é julgado', async () => {
  const { s } = sala()
  const velho = await s.entra({ nome: 'Antigo' })
  const vivo = await s.entra({ nome: 'Vivo', aba: 'aba-v' })
  const fantasma = await s.entra({ nome: 'F', aba: 'aba-f' })
  for (const ws of [velho, vivo, fantasma]) ws.att.desde -= 120_000
  vivo.pingEm = Date.now() - 10_000
  const idF = fantasma.ultima('welcome').id

  const novo = await s.entra({ nome: 'N', aba: 'aba-n' })
  assert.deepEqual(fantasma.fechado, [1000, 'sem batimento'])
  assert.equal(velho.fechado, undefined)
  assert.equal(vivo.fechado, undefined)
  assert.deepEqual(vivo.ultima('peer-left'), { t: 'peer-left', id: idF, volta: true })
  assert.deepEqual(novo.ultima('welcome').peers.map(p => p.name), ['Antigo', 'Vivo'])
})

test('sala cheia aceita o subprotocolo, avisa e fecha com 1013', async () => {
  const { s } = sala()
  for (const n of ['A', 'B', 'C', 'D']) await s.entra({ nome: n, aba: `aba-${n}` })
  const r = await s.fetch({ url: 'https://x/ws?sala=galm&nome=E&aba=aba-e',
    headers: new Headers({ 'x-disgalm-exp': String(Math.floor(Date.now() / 1000) + 600),
      'x-disgalm-role': 'member', 'x-disgalm-sub': 'person-1' }) })
  // Sem o subprotocolo de volta, o navegador recusa o upgrade e o 'cheia' se perde.
  assert.equal(r.status, 101)
  assert.equal(r.headers['sec-websocket-protocol'], 'disgalm')
  const e = s.sockets.at(-1)
  assert.deepEqual(e.ultima('cheia'), { t: 'cheia' })
  assert.deepEqual(e.fechado, [1013, 'sala cheia'])
})

test('fantasma não ocupa vaga de sala cheia', async () => {
  const { s } = sala()
  const quatro = []
  for (const n of ['A', 'B', 'C', 'D']) quatro.push(await s.entra({ nome: n, aba: `aba-${n}` }))
  quatro[3].att.desde -= 120_000
  const e = await s.entra({ nome: 'E', aba: 'aba-e' })
  assert.equal(e.ultima('cheia'), undefined)
  assert.equal(e.ultima('welcome').peers.length, 3)
})

test('fechamento 1000/1001 é saída; 1006, 4000 e erro são queda', async () => {
  const { s } = sala()
  const a = await s.entra({ nome: 'A', aba: 'aba-a' })
  const casos = [[1001, false], [1000, false], [1006, true], [4000, true]]
  for (const [code, volta] of casos) {
    const b = await s.entra({ nome: 'B', aba: `aba-${code}` })
    await s.webSocketClose(b, code)
    assert.equal(a.ultima('peer-left').volta, volta, `código ${code}`)
  }
  const c = await s.entra({ nome: 'C', aba: 'aba-c' })
  await s.webSocketError(c)
  assert.equal(a.ultima('peer-left').volta, true)
})

test('passkey expirada fecha a sinalização e avisa a sala', async () => {
  const { s, ctx } = sala()
  const a = await s.entra({ nome: 'A', aba: 'aba-a' })
  const b = await s.entra({ nome: 'B', aba: 'aba-b' })
  assert.ok(ctx.storage.alarmAt > Date.now())
  b.att.exp = Math.floor(Date.now() / 1000) - 1
  await s.alarm()
  assert.deepEqual(b.fechado, [1000, 'acesso expirado'])
  assert.deepEqual(a.ultima('peer-left'), { t: 'peer-left', id: b.ultima('welcome').id, volta: false })
})

test('membro presente gera convite de 24 horas para vários convidados; convidado não gera outro', async () => {
  const { s } = sala()
  const invite = sub => s.fetch({ url: 'https://x/invite', method: 'POST',
    headers: new Headers({ 'x-disgalm-sub': sub }) })
  assert.equal((await invite('person-1')).status, 403)
  const member = await s.entra({ nome: 'Membro', aba: 'aba-m', sub: 'person-1' })
  const issued = await invite('person-1')
  const { token, expiresAt } = await issued.json()
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.ok(expiresAt > Math.floor(Date.now() / 1000) + 86000)
  assert.equal((await invite('other-person')).status, 403)
  const check = value => s.fetch({ url: 'https://x/guest/check', method: 'POST',
    headers: new Headers({ 'x-disgalm-guest-token': value }) })
  assert.equal((await check('bad')).status, 401)
  assert.equal((await check(token)).status, 200)
  const guest = async aba => {
    const response = await s.fetch({ url: `https://x/ws?nome=Convidado&aba=${aba}`, method: 'GET',
      headers: new Headers({ 'x-disgalm-role': 'guest', 'x-disgalm-guest-token': token }) })
    assert.equal(response.status, 101)
    return s.sockets.at(-1)
  }
  const a = await guest('aba-a')
  const b = await guest('aba-b')
  assert.equal(a.att.role, 'guest')
  assert.equal(b.att.role, 'guest')
  assert.equal((await invite('')).status, 403)
  assert.equal(member.att.role, 'member')
  s.ctx.storage.saved.set([...s.ctx.storage.saved.keys()][0], Math.floor(Date.now() / 1000) - 1)
  assert.equal((await check(token)).status, 401)
})

test('entrada registra se cada par divide o IP público, sem nome nem IP no log', async () => {
  const { s } = sala()
  const linhas = [], original = console.log
  console.log = l => linhas.push(l)
  try {
    const entra = (nome, aba, ip) => s.fetch({ url: `https://x/ws?sala=galm&nome=${nome}&aba=${aba}`,
      headers: new Headers({ 'x-disgalm-exp': String(Math.floor(Date.now() / 1000) + 600),
        'x-disgalm-role': 'member', 'x-disgalm-sub': 'person-1', 'cf-connecting-ip': ip }) })
    await entra('Fulana', 'aba-a', '203.0.113.7')
    await entra('Beltrana', 'aba-b', '203.0.113.7')
    await entra('Ciclana', 'aba-c', '198.51.100.9')
  } finally { console.log = original }
  const entradas = linhas.map(l => JSON.parse(l)).filter(l => l.evento === 'entrou')
  const [a, b, c] = entradas.map(e => e.id)
  assert.deepEqual(entradas[1].pares, [{ id: a, mesmoIpPublico: true }])
  assert.deepEqual(entradas[2].pares, [{ id: a, mesmoIpPublico: false }, { id: b, mesmoIpPublico: false }])
  assert.equal(entradas[0].sala, 'galm')
  const texto = linhas.join('\n')
  for (const proibido of ['Fulana', 'Beltrana', 'Ciclana', '203.0.113.7', '198.51.100.9'])
    assert.ok(!texto.includes(proibido), proibido)
  assert.ok(c)
})
