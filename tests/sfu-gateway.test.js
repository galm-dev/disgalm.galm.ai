import { test, beforeEach, afterEach } from 'node:test'
import { carregarWorker, criarOrcamento, retrato } from './worker.js'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

globalThis.crypto ||= webcrypto


class Socket {
  constructor() { this.msgs = []; this.att = null }
  serializeAttachment(a) { this.att = structuredClone(a) }
  deserializeAttachment() { return structuredClone(this.att) }
  send(m) { this.msgs.push(JSON.parse(m)) }
  close(code, reason) { this.fechado = [code, reason] }
  ultima(t) { return this.msgs.filter(m => m.t === t).at(-1) }
}
globalThis.WebSocketPair = class { constructor() { this[0] = new Socket(); this[1] = new Socket() } }
globalThis.WebSocketRequestResponsePair = class { constructor(req, res) { Object.assign(this, { req, res }) } }
globalThis.Response = class {
  constructor(corpo, init) { this.body = corpo; this.status = 200; Object.assign(this, init) }
  get ok() { return this.status >= 200 && this.status < 300 }
  static json(body, init) { const r = new this(JSON.stringify(body), init); r.json = async () => body; return r }
}
const { Sala, Orcamento, default: worker } = await carregarWorker()

// Orçamento de verdade, com um retrato recém-coletado e zerado: libera tudo.
let orcamento = criarOrcamento(Orcamento)
const ENV = { SFU_APP_ID: 'app-ensaio', SFU_APP_SECRET: 'segredo-do-app', SFU_SALAS: 'ensaio, outra',
  get ORCAMENTO() { return orcamento.binding } }
const agoraS = () => Math.floor(Date.now() / 1000)

// API simulada do SFU: registra cada chamada e responde como a documentação
// (https://developers.cloudflare.com/realtime/sfu/api/).
let api, logs, logOriginal
beforeEach(() => {
  orcamento = criarOrcamento(Orcamento)
  logs = []
  logOriginal = console.log
  console.log = l => logs.push(String(l))
  api = { chamadas: [], seq: 0, falhar: null }
  globalThis.fetch = async (url, init) => {
    const u = new URL(url)
    const corpo = init.body ? JSON.parse(init.body) : undefined
    api.chamadas.push({ metodo: init.method, caminho: u.pathname, corpo, auth: init.headers.authorization })
    const json = obj => ({ status: 200, ok: true, json: async () => obj })
    if (api.falhar?.(u.pathname, corpo)) return { status: 406, ok: false, json: async () => ({ errorCode: 'invalid_session_description', errorDescription: 'x' }) }
    if (u.pathname.endsWith('/sessions/new')) return { status: 201, ok: true, json: async () => ({ sessionId: `sessao${String(++api.seq).padStart(26, '0')}` }) }
    if (u.pathname.endsWith('/tracks/new')) {
      if (corpo.sessionDescription) return json({ requiresImmediateRenegotiation: false,
        sessionDescription: { type: 'answer', sdp: 'v=0 answer' },
        tracks: corpo.tracks.map(t => ({ trackName: t.trackName, mid: t.mid })) })
      return json({ requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'v=0 offer' },
        tracks: corpo.tracks.map((t, i) => ({ sessionId: t.sessionId, trackName: t.trackName, mid: String(10 + i) })) })
    }
    if (u.pathname.endsWith('/renegotiate')) return json({})
    if (u.pathname.endsWith('/tracks/close')) return json({ requiresImmediateRenegotiation: false,
      ...(corpo.sessionDescription && { sessionDescription: { type: 'answer', sdp: 'v=0 answer' } }),
      tracks: corpo.tracks.map(t => ({ mid: t.mid })) })
    return { status: 404, ok: false, json: async () => ({ errorCode: 'not_found' }) }
  }
})
afterEach(() => { console.log = logOriginal })

// Storage que clona na escrita e na leitura, como o do runtime: nada de
// referência compartilhada entre a sala e o que ficou gravado.
function criarStorage() {
  const saved = new Map()
  return { saved, alarmAt: null,
    async get(k) { return structuredClone(saved.get(k)) }, async put(k, v) { saved.set(k, structuredClone(v)) },
    async setAlarm(v) { this.alarmAt = v }, async deleteAlarm() { this.alarmAt = null } }
}

function montar({ env = ENV, sockets = [], storage = criarStorage() } = {}) {
  const tarefas = []
  const ctx = {
    storage, auto: null,
    setWebSocketAutoResponse(par) { this.auto = par },
    acceptWebSocket(ws) { sockets.push(ws) },
    getWebSockets: () => sockets.filter(ws => !ws.fechado),
    getWebSocketAutoResponseTimestamp: () => null,
    waitUntil: p => tarefas.push(p),
  }
  const s = new Sala(ctx, env)
  Object.assign(s, { sockets, storage, ctx, tarefas, esperar: () => Promise.all(tarefas) })
  s.entra = async ({ cap = 'sfu1', sala = 'ensaio', sub = 'pessoa-1', papel = 'member', convite, ...q } = {}) => {
    const params = new URLSearchParams({ sala, aba: `aba-${Math.random()}`, ...q, ...(cap && { cap }) })
    const headers = new Headers({ 'x-disgalm-exp': String(agoraS() + 600), 'x-disgalm-role': papel })
    if (papel === 'member') headers.set('x-disgalm-sub', sub)
    else headers.set('x-disgalm-guest-token', convite)
    const r = await s.fetch({ url: `https://x/ws?${params}`, headers })
    const ws = sockets.at(-1)
    return Object.assign(ws, { resposta: r, id: ws.ultima('welcome')?.id, chave: ws.ultima('welcome')?.sfu?.chave, sub, papel, convite })
  }
  // Pedido ao gateway como o Worker repassa: papel, sub ou convite, exp e a chave.
  s.pede = async (ws, op, corpo = {}, { chave = ws.chave, sub = ws.sub, exp = agoraS() + 600, id = ws.id } = {}) => {
    const headers = new Headers({ 'x-disgalm-sfu': chave ?? '', 'x-disgalm-role': ws.papel, 'x-disgalm-exp': String(exp) })
    if (ws.papel === 'member') headers.set('x-disgalm-sub', sub)
    else headers.set('x-disgalm-guest-token', ws.convite)
    const r = await s.fetch({ url: 'https://x/sfu?sala=ensaio', method: 'POST', headers, json: async () => ({ op, id, ...corpo }) })
    return { status: r.status, corpo: await r.json() }
  }
  return s
}

const oferta = { type: 'offer', sdp: 'v=0 offer' }
const resposta = { type: 'answer', sdp: 'v=0 answer' }
const micDe = (stream = 's1') => ({ fonte: 'mic-1', mid: '0', stream, geracao: 1 })

async function publicarMic(s, ws) {
  const { corpo: { sessao } } = await s.pede(ws, 'sessao')
  const r = await s.pede(ws, 'publicar', { sessao, sdp: oferta, fontes: [micDe()] })
  assert.equal(r.status, 200, JSON.stringify(r.corpo))
  return sessao
}

test('modo de ensaio: SFU só em sala da lista, com cliente capaz e app configurado', async () => {
  const s = montar()
  const a = await s.entra()
  const w = a.ultima('welcome')
  assert.equal(w.modo, 'sfu')
  assert.equal(w.protocolo, 1)
  assert.match(w.sfu.chave, /^[0-9a-f]{64}$/)
  assert.deepEqual(w.sfu.fontes, [])
  // O attachment guarda só o hash da chave.
  assert.notEqual(a.att.chaveSfu, w.sfu.chave)

  assert.equal((await montar().entra({ sala: 'galm' })).ultima('welcome').modo, 'mesh')
  assert.equal((await montar().entra({ cap: '' })).ultima('welcome').modo, 'mesh')
  assert.equal((await montar({ env: { ...ENV, SFU_APP_SECRET: '' } }).entra()).ultima('welcome').modo, 'mesh')
  assert.equal((await montar({ env: { SFU_APP_ID: 'a', SFU_APP_SECRET: 'b' } }).entra()).ultima('welcome').modo, 'mesh')
  assert.equal((await montar().entra({ sala: 'galm' })).ultima('welcome').sfu, undefined)
})

test('o modo vale para a chamada toda: quem abre decide, cliente antigo não entra em chamada SFU', async () => {
  const s = montar()
  await s.entra()
  // Cliente antigo com aba: vê um "participante" com o recado e para de religar
  // pelo motivo 'substituída', que ele já conhece.
  const antigo = await s.entra({ cap: '' })
  assert.deepEqual(antigo.ultima('welcome').peers, [{ id: '00000000', name: 'Recarregue o Disgalm' }])
  assert.equal(antigo.ultima('cheia'), undefined)
  assert.deepEqual(antigo.fechado, [4001, 'substituída'])
  assert.equal(antigo.resposta.headers['sec-websocket-protocol'], 'disgalm')
  assert.equal(antigo.att, null)
  // Mais antigo ainda, sem aba: 'cheia', que também para o ciclo.
  const r = await s.fetch({ url: 'https://x/ws?sala=ensaio&nome=V', headers: new Headers({
    'x-disgalm-exp': String(agoraS() + 600), 'x-disgalm-role': 'member', 'x-disgalm-sub': 'v' }) })
  const velho = s.sockets.at(-1)
  assert.equal(r.status, 101)
  assert.deepEqual(velho.ultima('cheia'), { t: 'cheia', motivo: 'versao' })
  assert.deepEqual(velho.fechado, [1013, 'cliente sem SFU'])
  assert.equal(r.headers['sec-websocket-protocol'], 'disgalm')

  // Antigo abrindo a sala: malha para todos, inclusive quem sabe SFU.
  const m = montar()
  await m.entra({ cap: '' })
  const novo = await m.entra()
  assert.equal(novo.ultima('welcome').modo, 'mesh')
  assert.equal(novo.chave, undefined)
})

test('cada operação exige a conexão viva, a chave, a credencial e o prazo de quem pede', async () => {
  const s = montar()
  const a = await s.entra({ sub: 'pessoa-a' })
  const b = await s.entra({ sub: 'pessoa-b' })
  const ok = await s.pede(a, 'sessao')
  assert.equal(ok.status, 200)

  const casos = [
    ['chave de outra conexão', s.pede(a, 'sessao', {}, { chave: b.chave })],
    ['chave ausente', s.pede(a, 'sessao', {}, { chave: '' })],
    ['sub de outra pessoa', s.pede(a, 'sessao', {}, { sub: 'pessoa-b' })],
    ['token expirado', s.pede(a, 'sessao', {}, { exp: agoraS() - 1 })],
    ['id de outra pessoa com a própria chave', s.pede(a, 'sessao', {}, { id: b.id })],
    ['id inventado', s.pede(a, 'sessao', {}, { id: 'deadbeef' })],
  ]
  for (const [nome, p] of casos) assert.equal((await p).status, 403, nome)

  // Acesso da conexão vencido, mesmo com token novo.
  a.att.exp = agoraS() - 1
  assert.equal((await s.pede(a, 'sessao')).status, 403)

  // Saiu da sala: a chave não vale mais.
  await s.webSocketClose(b, 1000)
  assert.equal((await s.pede(b, 'sessao')).status, 403)
  assert.equal(api.chamadas.filter(c => c.caminho.endsWith('/sessions/new')).length, 1)
})

test('convidado precisa de convite ainda válido em cada operação', async () => {
  const s = montar()
  const m = await s.entra({ sub: 'membro' })
  assert.ok(m.id)
  const convite = 'c'.repeat(64)
  await s.storage.put(`invite:${Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(convite))).toString('hex')}`, agoraS() + 3600)
  const g = await s.entra({ papel: 'guest', convite })
  assert.equal(g.ultima('welcome').modo, 'sfu')
  assert.equal((await s.pede(g, 'sessao')).status, 200)
  // Convite revogado ou vencido no meio da chamada.
  for (const k of s.storage.saved.keys()) if (k.startsWith('invite:')) s.storage.saved.set(k, agoraS() - 1)
  assert.equal((await s.pede(g, 'sessao')).status, 403)
})

test('sessão alheia e sessão inexistente dão a mesma recusa, sem chamar a API', async () => {
  const s = montar()
  const a = await s.entra({ sub: 'pessoa-a' })
  const b = await s.entra({ sub: 'pessoa-b' })
  const sessaoA = await publicarMic(s, a)
  const antes = api.chamadas.length
  for (const op of ['publicar', 'assinar', 'renegociar', 'fechar', 'encerrar']) {
    const alheia = await s.pede(b, op, { sessao: sessaoA, sdp: oferta, fontes: [micDe()], alvos: [{ dono: a.id, fonte: 'mic-1' }], mids: ['0'] })
    const inexistente = await s.pede(b, op, { sessao: 'sessao-que-nao-existe', sdp: oferta, mids: ['0'] })
    assert.deepEqual([alheia.status, alheia.corpo], [403, { erro: 'sessão alheia' }], op)
    assert.deepEqual([inexistente.status, inexistente.corpo], [403, { erro: 'sessão alheia' }], op)
  }
  assert.equal(api.chamadas.length, antes)
  assert.equal((await s.pede(b, 'qualquer', { sessao: sessaoA })).status, 400)
})

test('publicar: trackName é do servidor, fonte validada, catálogo difundido sem locators do SFU', async () => {
  const s = montar()
  const a = await s.entra({ sub: 'pessoa-a' })
  const b = await s.entra({ sub: 'pessoa-b' })
  const { corpo: { sessao } } = await s.pede(a, 'sessao')

  const invalidas = [
    { fonte: '../../x', mid: '0', stream: 's', geracao: 1 },
    { fonte: 'mic-1', mid: 'abc', stream: 's', geracao: 1 },
    { fonte: 'mic-1', mid: '0', stream: 'tem espaço', geracao: 1 },
    { fonte: 'tela-1/legenda', mid: '0', stream: 's', geracao: 1 },
    { fonte: 'mic-1', mid: '0', stream: 's', geracao: 0 },
  ]
  for (const f of invalidas) assert.equal((await s.pede(a, 'publicar', { sessao, sdp: oferta, fontes: [f] })).status, 400, f.fonte)
  assert.equal((await s.pede(a, 'publicar', { sessao, sdp: { type: 'answer', sdp: 'x' }, fontes: [micDe()] })).status, 400)

  const r = await s.pede(a, 'publicar', { sessao, sdp: oferta, fontes: [
    micDe('voz'), { fonte: 'tela-1/video', mid: '1', stream: 'tela', geracao: 2 }, { fonte: 'tela-1/audio', mid: '2', stream: 'tela', geracao: 2 }] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.corpo.sdp, resposta)
  const chamada = api.chamadas.at(-1)
  assert.equal(chamada.caminho, `/v1/apps/app-ensaio/sessions/${sessao}/tracks/new`)
  assert.equal(chamada.auth, 'Bearer segredo-do-app')
  assert.deepEqual(chamada.corpo.tracks.map(t => t.trackName), [`${a.id}_mic-1`, `${a.id}_tela-1_video`, `${a.id}_tela-1_audio`])

  const cat = b.ultima('sfu')
  assert.equal(cat.versao, 2)
  assert.deepEqual(cat.fontes, [
    { dono: a.id, fonte: 'mic-1', tipo: 'mic', stream: 'voz', geracao: 1 },
    { dono: a.id, fonte: 'tela-1/video', tipo: 'tela-video', stream: 'tela', geracao: 2, tela: 'tela-1' },
    { dono: a.id, fonte: 'tela-1/audio', tipo: 'tela-audio', stream: 'tela', geracao: 2, tela: 'tela-1' },
  ])
  assert.ok(!JSON.stringify(b.msgs).includes(sessao))

  // A mesma fonte de novo, ou o mesmo mid, não.
  assert.equal((await s.pede(a, 'publicar', { sessao, sdp: oferta, fontes: [{ ...micDe(), mid: '5' }] })).status, 409)
  assert.equal((await s.pede(a, 'publicar', { sessao, sdp: oferta, fontes: [{ fonte: 'camera-2', mid: '0', stream: 'c', geracao: 1 }] })).status, 409)
})

test('assinar: só fonte do catálogo de quem está na sala; resolve o locator no servidor', async () => {
  const s = montar()
  const a = await s.entra({ sub: 'pessoa-a' })
  const b = await s.entra({ sub: 'pessoa-b' })
  const sessaoA = await publicarMic(s, a)
  const { corpo: { sessao } } = await s.pede(b, 'sessao')

  assert.equal((await s.pede(b, 'assinar', { sessao, alvos: [{ dono: a.id, fonte: 'camera-9' }] })).status, 404)
  assert.equal((await s.pede(b, 'assinar', { sessao, alvos: [{ dono: 'deadbeef', fonte: 'mic-1' }] })).status, 404)
  assert.equal((await s.pede(b, 'assinar', { sessao, alvos: [{ dono: b.id, fonte: 'mic-1' }] })).status, 400)
  // Campos de locator mandados pelo cliente são ignorados: quem resolve é o catálogo.
  const r = await s.pede(b, 'assinar', { sessao, alvos: [{ dono: a.id, fonte: 'mic-1', sessionId: 'outra', trackName: 'x' }] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.corpo, { sdp: oferta, renegociar: true, alvos: [{ dono: a.id, fonte: 'mic-1', mid: '10' }] })
  assert.deepEqual(api.chamadas.at(-1).corpo, { tracks: [{ location: 'remote', sessionId: sessaoA, trackName: `${a.id}_mic-1` }] })

  // Oferta do SFU pendente: nenhuma outra mutação até a resposta.
  assert.deepEqual(await s.pede(b, 'fechar', { sessao, mids: ['10'] }), { status: 409, corpo: { erro: 'sessão ocupada' } })
  assert.equal((await s.pede(b, 'renegociar', { sessao, sdp: oferta })).status, 400)
  assert.equal((await s.pede(b, 'renegociar', { sessao, sdp: resposta })).status, 200)
  assert.equal(api.chamadas.at(-1).caminho, `/v1/apps/app-ensaio/sessions/${sessao}/renegotiate`)
  assert.equal((await s.pede(b, 'renegociar', { sessao, sdp: resposta })).status, 409)
  assert.equal((await s.pede(b, 'assinar', { sessao, alvos: [{ dono: a.id, fonte: 'mic-1' }] })).status, 409)

  // Quem saiu deixa de ser alvo.
  await s.webSocketClose(a, 1001)
  await s.esperar()
  const c = await s.entra({ sub: 'pessoa-c' })
  assert.deepEqual(c.ultima('welcome').sfu.fontes, [])
})

test('fechar: só mids da própria sessão; a publicação sai do catálogo antes do fechamento', async () => {
  const s = montar()
  const a = await s.entra({ sub: 'pessoa-a' })
  const b = await s.entra({ sub: 'pessoa-b' })
  const sessao = await publicarMic(s, a)
  assert.equal((await s.pede(a, 'fechar', { sessao, mids: ['7'] })).status, 403)
  assert.equal((await s.pede(a, 'fechar', { sessao, mids: ['0', '0'] })).status, 403)
  const r = await s.pede(a, 'fechar', { sessao, mids: ['0'], sdp: oferta })
  assert.equal(r.status, 200)
  assert.deepEqual(r.corpo, { sdp: resposta, mids: [{ mid: '0' }] })
  assert.deepEqual(api.chamadas.at(-1).corpo, { tracks: [{ mid: '0' }], force: false, sessionDescription: oferta })
  assert.deepEqual(b.ultima('sfu').fontes, [])
  assert.equal((await s.pede(a, 'fechar', { sessao, mids: ['0'] })).status, 403)
})

test('falha da API: item recusado não entra no catálogo e o erro vai à telemetria sem segredo', async () => {
  const s = montar()
  const a = await s.entra({ sub: 'pessoa-a' })
  const { corpo: { sessao } } = await s.pede(a, 'sessao')
  api.falhar = caminho => caminho.endsWith('/tracks/new')
  const r = await s.pede(a, 'publicar', { sessao, sdp: oferta, fontes: [micDe()] })
  assert.equal(r.status, 502)
  assert.equal(r.corpo.codigo, 'invalid_session_description')
  await s.esperar()
  const est = await s.storage.get('sfu')
  assert.deepEqual(est.pubs, {})
  assert.equal(est.sessoes[sessao].ocupada, null)
  const eventos = logs.map(l => JSON.parse(l))
  assert.ok(eventos.some(e => e.evento === 'sfu_api_erro' && e.op === 'publicar' && e.codigo === 'invalid_session_description'))
  const texto = logs.join('\n')
  for (const proibido of ['segredo-do-app', a.chave, sessao]) assert.ok(!texto.includes(proibido), proibido)
})

test('catálogo e sessões sobrevivem à hibernação; o ping continua automático', async () => {
  const storage = criarStorage(), sockets = []
  const s = montar({ storage, sockets })
  const a = await s.entra({ sub: 'pessoa-a' })
  const b = await s.entra({ sub: 'pessoa-b' })
  const sessaoA = await publicarMic(s, a)
  const { corpo: { sessao: sessaoB } } = await s.pede(b, 'sessao')

  // Objeto descarregado: nova instância com o mesmo storage e os mesmos sockets.
  const s2 = montar({ storage, sockets })
  assert.equal(s2.ctx.auto.req, '{"t":"ping"}')
  assert.equal(s2.ctx.auto.res, '{"t":"pong"}')
  const c = await s2.entra({ sub: 'pessoa-c' })
  assert.deepEqual(c.ultima('welcome').sfu.fontes.map(f => [f.dono, f.fonte]), [[a.id, 'mic-1']])
  const r = await s2.pede(b, 'assinar', { sessao: sessaoB, alvos: [{ dono: a.id, fonte: 'mic-1' }] })
  assert.equal(r.status, 200)
  assert.equal(api.chamadas.at(-1).corpo.tracks[0].sessionId, sessaoA)
  // A dona continua dona depois de acordar.
  assert.equal((await s2.pede(c, 'fechar', { sessao: sessaoA, mids: ['0'] })).status, 403)
  assert.equal((await s2.pede(a, 'fechar', { sessao: sessaoA, mids: ['0'] })).status, 200)
})

test('saída de vez limpa o catálogo e fecha à força; queda com volta mantém', async () => {
  const s = montar()
  const a = await s.entra({ sub: 'pessoa-a' })
  const b = await s.entra({ sub: 'pessoa-b' })
  const sessao = await publicarMic(s, a)

  await s.webSocketClose(a, 1006)          // queda: deve voltar com o mesmo id
  await s.esperar()
  assert.equal(b.ultima('sfu').fontes.length, 1)
  assert.ok(!api.chamadas.some(c => c.caminho.endsWith('/tracks/close')))

  const a2 = await s.entra({ sub: 'pessoa-a', id: a.id })
  assert.equal(a2.ultima('welcome').retomada, true)
  await s.webSocketClose(a2, 1000)         // saiu de vez
  await s.esperar()
  assert.deepEqual(b.ultima('sfu').fontes, [])
  const fecho = api.chamadas.find(c => c.caminho.endsWith('/tracks/close'))
  assert.deepEqual(fecho, { metodo: 'PUT', caminho: `/v1/apps/app-ensaio/sessions/${sessao}/tracks/close`,
    corpo: { tracks: [{ mid: '0' }], force: true }, auth: 'Bearer segredo-do-app' })
  const est = await s.storage.get('sfu')
  assert.deepEqual(est.sessoes, {})
})

test('sala que esvazia abre chamada nova e fecha o que sobrou da anterior', async () => {
  const s = montar()
  const a = await s.entra({ sub: 'pessoa-a' })
  const sessao = await publicarMic(s, a)
  const chamada = (await s.storage.get('sfu')).chamada
  a.fechado = [1006, 'rede']                // some sem webSocketClose
  const b = await s.entra({ sub: 'pessoa-b' })
  await s.esperar()
  const est = await s.storage.get('sfu')
  assert.notEqual(est.chamada, chamada)
  assert.deepEqual(est.pubs, {})
  assert.deepEqual(b.ultima('welcome').sfu.fontes, [])
  assert.ok(api.chamadas.some(c => c.caminho.endsWith(`${sessao}/tracks/close`) && c.corpo.force))
})

test('Worker: /sfu só em sala da lista, mesma origem, com chave e credencial', async () => {
  const delegados = []
  const convite = 'd'.repeat(64)
  const env = { ...ENV, SALA: { idFromName: n => n, get: () => ({ fetch: async req => {
    delegados.push(req)
    if (new URL(req.url).pathname === '/guest/check') return Response.json({ exp: agoraS() + 900 })
    return Response.json({ ok: true })
  } }) } }
  globalThis.Request = class { constructor(url, init = {}) { this.url = url; Object.assign(this, init); this.headers = new Headers(init.headers) }
    async text() { return this.body ?? '' } }
  const pede = ({ sala = 'ensaio', origem = 'https://disgalm.galm.ai', chave = 'a'.repeat(64), cookie = `__Host-disgalm_guest=${convite}`,
    tipo = 'application/json', metodo = 'POST', corpo = '{"op":"sessao","id":"abcd1234"}' } = {}) =>
    worker.fetch(new Request(`https://disgalm.galm.ai/sfu?sala=${sala}`, { method: metodo, body: corpo,
      headers: { origin: origem, 'content-type': tipo, ...(chave && { 'x-disgalm-sfu': chave }), ...(cookie && { cookie }) } }), env, {})
  assert.equal((await pede({ metodo: 'GET' })).status, 405)
  assert.equal((await pede({ origem: 'https://evil.example' })).status, 403)
  assert.equal((await pede({ sala: 'galm' })).status, 404)
  assert.equal((await pede({ tipo: 'text/plain' })).status, 415)
  assert.equal((await pede({ chave: '' })).status, 401)
  assert.equal((await pede({ corpo: 'x'.repeat(200 * 1024) })).status, 413)
  assert.equal(delegados.length, 0)
  assert.equal((await pede({ cookie: '' })).status, 401)
  const r = await pede()
  assert.equal(r.status, 200)
  const repassado = delegados.at(-1)
  assert.equal(new URL(repassado.url).pathname, '/sfu')
  assert.equal(repassado.headers.get('x-disgalm-role'), 'guest')
  assert.equal(repassado.headers.get('x-disgalm-guest-token'), convite)
  assert.equal(repassado.headers.get('x-disgalm-sfu'), 'a'.repeat(64))
  assert.ok(Number(repassado.headers.get('x-disgalm-exp')) > agoraS())
})

// ---------- orçamento ----------

test('orçamento negando na abertura: a sala de ensaio fica na malha e avisa', async () => {
  orcamento = criarOrcamento(Orcamento, { snapshot: retrato({ turn_bytes: 900e9 }) })
  const a = await montar().entra()
  const w = a.ultima('welcome')
  assert.deepEqual([w.modo, w.aviso, w.sfu], ['mesh', 'sfu_cota', undefined])
  orcamento = criarOrcamento(Orcamento, { snapshot: null })
  assert.equal((await montar().entra()).ultima('welcome').aviso, 'sfu_cota')
})

test('publicar e assinar acima de 90% são negados sem chamar a API, e a sessão não fica presa', async () => {
  const s = montar()
  const a = await s.entra({ sub: 'pessoa-a' })
  const b = await s.entra({ sub: 'pessoa-b' })
  await publicarMic(s, a)
  const { corpo: { sessao } } = await s.pede(b, 'sessao')
  // A cota estoura no meio da chamada.
  orcamento.storage.saved.set('snapshot', retrato({ turn_bytes: 900e9 }))
  const antes = api.chamadas.length
  const pub = await s.pede(a, 'publicar', { sessao: Object.keys((await s.storage.get('sfu')).sessoes)[0], sdp: oferta,
    fontes: [{ fonte: 'camera-2', mid: '1', stream: 'c', geracao: 1 }] })
  assert.deepEqual([pub.status, pub.corpo.erro, pub.corpo.motivo], [503, 'cota', 'limite'])
  const sub = await s.pede(b, 'assinar', { sessao, alvos: [{ dono: a.id, fonte: 'mic-1' }] })
  assert.deepEqual([sub.status, sub.corpo.motivo], [503, 'limite'])
  assert.equal(api.chamadas.length, antes)
  const est = await s.storage.get('sfu')
  assert.ok(Object.values(est.sessoes).every(x => x.ocupada === null && x.pend === null))
  // Fechar e encerrar continuam valendo: cortar gasto nunca é negado.
  assert.equal((await s.pede(b, 'encerrar', { sessao })).status, 200)
})

test('assinatura reserva o teto do tipo e libera ao fechar e ao sair', async () => {
  const s = montar()
  const a = await s.entra({ sub: 'pessoa-a' })
  const b = await s.entra({ sub: 'pessoa-b' })
  await publicarMic(s, a)
  const { corpo: { sessao } } = await s.pede(b, 'sessao')
  await s.pede(b, 'assinar', { sessao, alvos: [{ dono: a.id, fonte: 'mic-1' }] })
  await s.pede(b, 'renegociar', { sessao, sdp: resposta })
  const abertas = () => Object.values(orcamento.storage.saved.get('reservas') ?? {}).filter(r => r.fim === null)
  assert.equal(abertas().length, 1)
  assert.ok(abertas()[0].ref.startsWith(`sfu:${sessao}:${a.id}/mic-1#`))
  assert.equal(abertas()[0].bps, 0.5e6 / 8)
  await s.pede(b, 'fechar', { sessao, mids: ['10'] })
  assert.equal(abertas().length, 0)
  await s.pede(b, 'assinar', { sessao, alvos: [{ dono: a.id, fonte: 'mic-1' }] })
  await s.pede(b, 'renegociar', { sessao, sdp: resposta })
  assert.equal(abertas().length, 1)
  await s.webSocketClose(b, 1000)
  await s.esperar()
  assert.equal(abertas().length, 0)
  // As duas reservas fechadas continuam no mês: são a estimativa do SFU.
  assert.equal(Object.keys(orcamento.storage.saved.get('reservas')).length, 2)
})
