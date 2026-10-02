import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const script = html.split('<script>')[1].split('</script>')[0]

class PC {
  constructor() {
    Object.assign(this, { connectionState: 'new', iceConnectionState: 'new', signalingState: 'stable',
                          localDescription: null, reinicios: 0, remotas: [] })
  }
  createDataChannel() { return { readyState: 'connecting' } }
  addTrack() {}
  getSenders() { return [] }
  close() { this.connectionState = 'closed' }
  restartIce() { this.reinicios++ }
  async setRemoteDescription(d) { this.remotas.push(d); this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable' }
  async createOffer() { return { type: 'offer', sdp: '' } }
  async createAnswer() { return { type: 'answer', sdp: '' } }
  async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable' }
}

function fixture() {
  const elements = new Map()
  const $ = id => {
    if (!elements.has(id))
      elements.set(id, { textContent: '', value: '', hidden: true, innerHTML: '', classList: { toggle() {} }, remove() {} })
    return elements.get(id)
  }
  const sockets = [], timers = []
  class WS {
    constructor(url) { this.url = new URL(url); this.readyState = 0; this.enviadas = []; sockets.push(this) }
    send(m) { this.enviadas.push(JSON.parse(m)) }
    close(code, reason) { this.fechadoCom = [code, reason]; this.readyState = 3 }
  }
  const sessao = new Map()
  let uuid = 0
  const state = {
    document: { getElementById: $, querySelector: () => null, addEventListener() {} },
    addEventListener() {}, setInterval() {}, clearInterval() {},
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length }, clearTimeout() {},
    WebSocket: WS, RTCPeerConnection: PC, MediaStream: class { getVideoTracks() { return [] } getTracks() { return [] } },
    location: { protocol: 'https:', host: 'disgalm.test' }, URLSearchParams, URL,
    sessionStorage: { getItem: k => sessao.get(k) ?? null, setItem: (k, v) => sessao.set(k, v) },
    crypto: { randomUUID: () => `aba-${++uuid}` }, alert() {},
  }
  runInNewContext(script, state)
  for (const f of ['desenharTile', 'focar', 'classificar', 'classificarVideo', 'atualizarParticipantes', 'aplicarQualidade'])
    state[f] = () => {}
  const run = code => runInNewContext(code, state)
  run("sala = { cod: 'galm', nome: 'Eu' }")
  const ws = () => sockets.at(-1)
  const abrir = () => { ws().readyState = 1; ws().onopen?.() }
  const chega = obj => ws().onmessage({ data: JSON.stringify(obj) })
  const entrar = (id, peers = []) => { run('conectar()'); abrir(); chega({ t: 'welcome', id, peers }) }
  const sinais = (para, s = ws()) => s.enviadas.filter(m => m.t === 'signal' && m.to === para).map(m => m.data)
  return { state, run, $, sockets, timers, ws, abrir, chega, entrar, sinais }
}

test('reconexão pede o mesmo id e a mesma aba; retomada mantém a conexão e reenvia oferta pendente', async () => {
  const f = fixture()
  f.entrar('aaaa0001', [{ id: 'bbbb0002', name: 'B' }])
  const primeira = f.ws()
  assert.equal(primeira.url.searchParams.get('aba'), 'aba-1')
  assert.equal(primeira.url.searchParams.has('id'), false)
  await f.run("pares.get('bbbb0002').pc.onnegotiationneeded()")
  const par = f.run("pares.get('bbbb0002')")
  assert.equal(par.pc.signalingState, 'have-local-offer')

  primeira.readyState = 3
  primeira.onclose({ code: 1006, reason: '', wasClean: false })
  assert.equal(f.timers.at(-1).ms, 1000)
  f.timers.at(-1).f()
  assert.equal(f.ws().url.searchParams.get('id'), 'aaaa0001')
  assert.equal(f.ws().url.searchParams.get('aba'), 'aba-1')
  f.abrir()
  f.chega({ t: 'welcome', id: 'aaaa0001', retomada: true, peers: [{ id: 'bbbb0002', name: 'B' }] })

  assert.equal(f.run("pares.get('bbbb0002')"), par)
  const reenviada = f.sinais('bbbb0002').find(d => d.description)
  assert.equal(reenviada.description.type, 'offer')
  assert.equal(reenviada.de, par.conexao)
  assert.ok(f.sinais('bbbb0002').some(d => d.estado))
  assert.equal(f.$('connection-alert').hidden, true)
})

test('retomada não derruba quem ainda não voltou mas tem mídia viva', () => {
  const f = fixture()
  f.entrar('aaaa0001', [{ id: 'bbbb0002', name: 'B' }, { id: 'cccc0003', name: 'C' }])
  f.run("pares.get('bbbb0002').pc.connectionState = 'connected'")
  f.run("pares.get('cccc0003').pc.connectionState = 'failed'")
  // Depois de um reinício do Durable Object, quem volta primeiro vê a sala vazia.
  f.entrar('aaaa0001', [])
  assert.equal(f.run("pares.has('bbbb0002')"), true)
  f.run('limparAusentes()')
  assert.equal(f.run("pares.has('bbbb0002')"), true)
  assert.equal(f.run("pares.has('cccc0003')"), false)
})

test('id novo refaz todas as conexões', () => {
  const f = fixture()
  f.entrar('aaaa0001', [{ id: 'bbbb0002', name: 'B' }])
  const velho = f.run("pares.get('bbbb0002')")
  f.entrar('ffff0009', [{ id: 'bbbb0002', name: 'B' }])
  assert.equal(velho.pc.connectionState, 'closed')
  assert.notEqual(f.run("pares.get('bbbb0002')"), velho)
  assert.equal(f.run("pares.get('bbbb0002').polite"), false)   // 'ffff0009' > 'bbbb0002'
})

test('papéis vêm da ordem dos ids, dos dois lados', () => {
  const f = fixture()
  f.entrar('bbbb0002', [{ id: 'aaaa0001', name: 'A' }])
  f.chega({ t: 'peer-join', id: 'cccc0003', name: 'C' })
  assert.equal(f.run("pares.get('aaaa0001').polite"), false)
  assert.equal(f.run("pares.get('cccc0003').polite"), true)
})

test('saída por queda mantém mídia viva; saída de verdade remove; mídia morta de ausente sai', () => {
  const f = fixture()
  f.entrar('aaaa0001', [{ id: 'bbbb0002', name: 'B' }, { id: 'cccc0003', name: 'C' }])
  f.run("pares.get('bbbb0002').pc.connectionState = 'connected'")
  f.run("pares.get('cccc0003').pc.connectionState = 'connected'")
  f.chega({ t: 'peer-left', id: 'bbbb0002', volta: true })
  f.chega({ t: 'peer-left', id: 'cccc0003', volta: false })
  assert.equal(f.run("pares.has('bbbb0002')"), true)
  assert.equal(f.run("pares.has('cccc0003')"), false)

  f.run("pares.get('bbbb0002').pc.connectionState = 'disconnected'")
  f.run("pares.get('bbbb0002').pc.onconnectionstatechange()")
  assert.equal(f.run("pares.has('bbbb0002')"), false)
  assert.match(f.$('log').textContent, /B não está na sala e a conexão está disconnected/)
})

test('quem volta com o mesmo id recebe a oferta pendente de novo', async () => {
  const f = fixture()
  f.entrar('aaaa0001')
  f.chega({ t: 'peer-join', id: 'bbbb0002', name: 'B' })
  await f.run("pares.get('bbbb0002').pc.onnegotiationneeded()")
  const antes = f.sinais('bbbb0002').filter(d => d.description).length
  f.chega({ t: 'peer-back', id: 'bbbb0002', name: 'B' })
  assert.equal(f.sinais('bbbb0002').filter(d => d.description).length, antes + 1)
})

test('oferta de outra instância recria a conexão; resto da instância velha é ignorado', async () => {
  const f = fixture()
  f.entrar('aaaa0001', [{ id: 'bbbb0002', name: 'B' }])
  await f.run("receberSinal('bbbb0002', { de: 'velha', description: { type: 'answer', sdp: '' } })")
  const velho = f.run("pares.get('bbbb0002')")
  assert.equal(velho.remota, 'velha')

  await f.run("receberSinal('bbbb0002', { de: 'nova', description: { type: 'offer', sdp: '' } })")
  const novo = f.run("pares.get('bbbb0002')")
  assert.notEqual(novo, velho)
  assert.equal(velho.pc.connectionState, 'closed')
  assert.equal(novo.remota, 'nova')
  assert.equal(novo.nome, 'B')
  assert.equal(novo.pc.remotas[0].type, 'offer')

  await f.run("receberSinal('bbbb0002', { de: 'velha', candidate: { candidate: 'x' } })")
  assert.equal(f.run("pares.get('bbbb0002')"), novo)
})

test('estado vale mesmo vindo de instância nova antes da oferta', async () => {
  const f = fixture()
  f.entrar('aaaa0001', [{ id: 'bbbb0002', name: 'B' }])
  await f.run("receberSinal('bbbb0002', { de: 'velha', description: { type: 'answer', sdp: '' } })")
  await f.run("receberSinal('bbbb0002', { de: 'nova', estado: { compartilhando: true } })")
  assert.equal(f.run("pares.get('bbbb0002').estado.compartilhando"), true)
})

test('batimento pinga; 45 s de silêncio descartam o socket e religam na hora', () => {
  const f = fixture()
  f.entrar('aaaa0001')
  const s = f.ws()
  f.run('bater()')
  assert.deepEqual(s.enviadas.at(-1), { t: 'ping' })
  f.run('ultimoSinal = Date.now() - 46000')
  f.run('bater()')
  assert.deepEqual(s.fechadoCom, [4000, 'sem batimento'])
  assert.notEqual(f.ws(), s)
  assert.equal(f.ws().url.searchParams.get('id'), 'aaaa0001')
  // O onclose tardio do socket descartado não agenda outra reconexão.
  const timers = f.timers.length
  s.onclose({ code: 4000, reason: '', wasClean: false })
  assert.equal(f.timers.length, timers)
})

test('reconexão espera cada vez mais, até 15 s, e zera ao entrar; sala cheia para de tentar', () => {
  const f = fixture()
  f.entrar('aaaa0001')
  const esperas = []
  for (let i = 0; i < 6; i++) {
    f.ws().onclose({ code: 1006, reason: '', wasClean: false })
    esperas.push(f.timers.at(-1).ms)
    f.timers.at(-1).f()
  }
  assert.deepEqual(esperas, [1000, 2000, 4000, 8000, 15000, 15000])
  f.abrir()
  f.chega({ t: 'welcome', id: 'aaaa0001', peers: [] })
  f.ws().onclose({ code: 1006, reason: '', wasClean: false })
  assert.equal(f.timers.at(-1).ms, 1000)
  f.timers.at(-1).f()
  f.abrir()
  f.chega({ t: 'cheia' })
  const n = f.timers.length
  f.ws().onclose({ code: 1013, reason: 'sala cheia', wasClean: true })
  assert.equal(f.timers.length, n)
})

test('socket substituído por outra aba não religa sozinho', () => {
  const f = fixture()
  f.entrar('aaaa0001')
  const n = f.timers.length
  f.ws().onclose({ code: 1000, reason: 'substituída', wasClean: true })
  assert.equal(f.timers.length, n)
  assert.equal(f.$('connection-alert').hidden, false)
})
