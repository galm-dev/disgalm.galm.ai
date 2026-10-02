import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { lerPublico, rodarCliente } from './cliente.js'

const simples = x => JSON.parse(JSON.stringify(x))

function registro() {
  const ctx = {}
  runInNewContext(lerPublico('fontes.js'), ctx)
  return { ctx, r: runInNewContext('disgalmFontes.criarRegistro()', ctx) }
}

test('fonte tem id lógico, tipo, dono e geração; trocar a track mantém o id', () => {
  const { ctx, r } = registro()
  assert.deepEqual(simples(ctx.disgalmFontes.TIPOS), ['mic', 'camera', 'tela-video', 'tela-audio'])
  const voz = { id: 'voz' }, t1 = { id: 't1' }, t2 = { id: 't2' }
  const mic = r.abrir('mic', t1, voz)
  assert.deepEqual(simples(mic), { id: 'mic-1', tipo: 'mic', dono: null, geracao: 1, track: t1, stream: voz })

  r.definirDono('aaaa0001')
  assert.equal(mic.dono, 'aaaa0001')
  assert.equal(r.abrir('camera', { id: 'c' }, { id: 'cs' }).dono, 'aaaa0001')

  const outroStream = { id: 'voz2' }
  assert.equal(r.substituir(mic, t2, outroStream), mic)
  assert.equal(mic.id, 'mic-1')
  assert.equal(mic.geracao, 2)
  assert.equal(mic.stream, outroStream)
  assert.equal(r.porTrack(t2), mic)
  assert.equal(r.porTrack(t1), null)

  // Fechada, a fonte não volta: abrir de novo é outra fonte.
  assert.equal(r.fechar(mic), true)
  assert.equal(r.fechar(mic), false)
  assert.equal(r.substituir(mic, t1), null)
  assert.notEqual(r.abrir('mic', t1, voz).id, 'mic-1')
})

test('vídeo e áudio da mesma tela ficam associados pelo id da tela', () => {
  const { r } = registro()
  const s1 = { id: 's1' }, s2 = { id: 's2' }
  const tela1 = r.novaTela(), tela2 = r.novaTela()
  assert.notEqual(tela1, tela2)
  const v1 = r.abrir('tela-video', { id: 'v1' }, s1, { tela: tela1 })
  const a1 = r.abrir('tela-audio', { id: 'a1' }, s1, { tela: tela1 })
  const v2 = r.abrir('tela-video', { id: 'v2' }, s2, { tela: tela2 })
  assert.equal(v1.tela, tela1)
  assert.equal(a1.tela, tela1)
  assert.equal(r.associada(v1), a1)
  assert.equal(r.associada(a1), v1)
  assert.equal(r.associada(v2), null)              // tela sem áudio
  assert.deepEqual(simples(r.daTela(tela1)), simples({ video: v1, audio: a1 }))
  assert.deepEqual(simples(r.doStream(s1).map(f => f.id)), [v1.id, a1.id])
  assert.equal(r.associada(r.abrir('mic', { id: 'm' }, { id: 'ms' })), null)
})

test('lista põe voz, telas e câmera nessa ordem; catálogo não leva track nem dono', () => {
  const { r } = registro()
  r.definirDono('eu')
  const tela = r.novaTela()
  r.abrir('camera', { id: 'c' }, { id: 'cs' })
  r.abrir('tela-video', { id: 'v' }, { id: 'ts' }, { tela })
  r.abrir('mic', { id: 'm' }, { id: 'ms' })
  r.abrir('tela-audio', { id: 'a' }, { id: 'ts' }, { tela })
  assert.deepEqual(simples(r.lista().map(f => f.tipo)), ['mic', 'tela-video', 'tela-audio', 'camera'])
  assert.deepEqual(simples(r.catalogo()), [
    { id: 'mic-3', tipo: 'mic', geracao: 1, stream: 'ms' },
    { id: `${tela}/video`, tipo: 'tela-video', geracao: 1, stream: 'ts', tela },
    { id: `${tela}/audio`, tipo: 'tela-audio', geracao: 1, stream: 'ts', tela },
    { id: 'camera-2', tipo: 'camera', geracao: 1, stream: 'cs' },
  ])
})

test('registro recusa tipo desconhecido, fonte sem track e tela sem id', () => {
  const { r } = registro()
  assert.throws(() => r.abrir('tela', { id: 't' }, {}), /tipo de fonte desconhecido: tela/)
  assert.throws(() => r.abrir('mic', null, {}), /fonte mic sem track/)
  assert.throws(() => r.abrir('tela-video', { id: 't' }, {}), /tela-video sem id de tela/)
  assert.throws(() => r.abrir('camera', { id: 't' }, {}, { tela: 'tela-1' }), /camera não pertence a uma tela/)
  r.abrir('tela-video', { id: 't' }, {}, { tela: 'tela-9' })
  assert.throws(() => r.abrir('tela-video', { id: 'u' }, {}, { tela: 'tela-9' }), /fonte repetida: tela-9\/video/)
})

// ---------- na página: captura → registro → transporte → anúncio ----------

let n = 0
const faixa = kind => ({ id: `${kind}-${++n}`, kind, stop() { this.parada = true },
  getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }), applyConstraints: async () => {} })
class Stream {
  constructor(tracks = []) { this.id = `stream-${++n}`; this.tracks = [...tracks] }
  getTracks() { return [...this.tracks] }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video') }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio') }
  addTrack(t) { this.tracks.push(t) }
  removeTrack(t) { this.tracks = this.tracks.filter(x => x !== t) }
}
class Sender {
  constructor(track) { this.track = track }
  async replaceTrack(t) { this.track = t }
}
class PC {
  constructor() { Object.assign(this, { senders: [], connectionState: 'new', signalingState: 'stable' }) }
  createDataChannel() { return { readyState: 'connecting' } }
  addTrack(t) { this.senders.push(new Sender(t)) }
  removeTrack(s) { s.track = null }
  getSenders() { return this.senders }
  close() { this.connectionState = 'closed' }
}

function pagina() {
  const elements = new Map()
  const $ = id => {
    if (!elements.has(id))
      elements.set(id, { textContent: '', value: '', hidden: true, innerHTML: '', classList: { toggle() {} }, remove() {} })
    return elements.get(id)
  }
  const enviadas = []
  let captura
  const state = {
    document: { getElementById: $, querySelector: () => null, addEventListener() {} },
    addEventListener() {}, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    RTCPeerConnection: PC, MediaStream: Stream,
    navigator: { mediaDevices: { getDisplayMedia: async () => captura() } },
  }
  rodarCliente(state)
  for (const f of ['desenharTile', 'focar', 'atualizarBotoesTela', 'aplicarQualidade', 'atualizarParticipantes', 'classificar', 'classificarVideo'])
    state[f] = () => {}
  const run = code => runInNewContext(code, state)
  state.wsFalso = { readyState: 1, send: m => enviadas.push(JSON.parse(m)) }
  run("ws = wsFalso; meuId = 'aaaa0001'; fontes.definirDono(meuId)")
  run("transporte.entrar([{ id: 'bbbb0002', nome: 'B' }])")
  const anuncios = () => enviadas.filter(m => m.data.estado).map(m => m.data.estado)
  return { state, run, anuncios, pc: () => run("pares.get('bbbb0002').pc"), capturar: f => { captura = f } }
}

test('tela compartilhada vira fontes de vídeo e áudio da mesma tela, anunciadas com os campos antigos', async () => {
  const p = pagina()
  const v = faixa('video'), a = faixa('audio')
  p.capturar(() => new Stream([v, a]))
  await p.run('adicionarTela()')
  const [fv, fa] = p.run('fontes.lista()')
  assert.equal(fv.tipo, 'tela-video')
  assert.equal(fa.tipo, 'tela-audio')
  assert.equal(fv.tela, fa.tela)
  assert.equal(fv.dono, 'aaaa0001')
  assert.deepEqual(p.pc().senders.map(s => s.track), [v, a])

  const est = p.anuncios().at(-1)
  const tela = p.run('telas[0]')
  assert.deepEqual(est.idsTelas, [tela.id])
  assert.equal(est.streamId, tela.id)
  assert.equal(est.temAudio, true)
  assert.deepEqual(est.fontes.map(f => [f.id, f.tipo, f.geracao, f.stream, f.tela]),
    [[fv.id, 'tela-video', 1, tela.id, fv.tela], [fa.id, 'tela-audio', 1, tela.id, fv.tela]])
})

test('recapturar troca as tracks sem mudar o id da fonte e sobe a geração', async () => {
  const p = pagina()
  const v = faixa('video'), a = faixa('audio')
  p.capturar(() => new Stream([v, a]))
  await p.run('adicionarTela()')
  const ids = p.run('fontes.lista()').map(f => f.id)
  const v2 = faixa('video'), a2 = faixa('audio')
  p.capturar(() => new Stream([v2, a2]))
  await p.run('recapturar()')
  const depois = p.run('fontes.lista()')
  assert.deepEqual(simples(depois.map(f => f.id)), simples(ids))
  assert.deepEqual(simples(depois.map(f => f.geracao)), [2, 2])
  assert.deepEqual([...depois.map(f => f.track)], [v2, a2])
  assert.deepEqual(p.pc().senders.map(s => s.track), [v2, a2])
  assert.equal(v.parada, true)
  assert.equal(a.parada, true)
  assert.deepEqual(p.anuncios().at(-1).fontes.map(f => f.geracao), [2, 2])
})

test('parar a tela tira as duas fontes do transporte e do anúncio', async () => {
  const p = pagina()
  p.capturar(() => new Stream([faixa('video'), faixa('audio')]))
  await p.run('adicionarTela()')
  p.capturar(() => new Stream([faixa('video')]))
  await p.run('adicionarTela()')
  assert.equal(p.run('fontes.lista()').length, 3)
  p.run('pararTela(telas[0])')
  const restante = p.run('fontes.lista()')
  assert.deepEqual(simples(restante.map(f => f.tipo)), ['tela-video'])
  assert.deepEqual(p.pc().senders.map(s => s.track?.id ?? null).filter(Boolean), [restante[0].track.id])
  const est = p.anuncios().at(-1)
  assert.deepEqual(est.fontes.map(f => f.id), [restante[0].id])
  assert.deepEqual(est.idsTelas, [p.run('telas[0].id')])
})
