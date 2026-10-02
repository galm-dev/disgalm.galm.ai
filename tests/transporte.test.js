import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { lerPublico } from './cliente.js'

// Objetos do contexto da página têm outros protótipos; comparar só os dados.
const simples = x => JSON.parse(JSON.stringify(x))
const track = (id, kind = 'audio') => ({ id, kind })
const stream = id => ({ id })

class Sender {
  constructor(track, stream) { Object.assign(this, { track, stream, trocas: [], params: { encodings: [{}] } }) }
  async replaceTrack(t) { this.trocas.push(t); this.track = t }
  getParameters() { return structuredClone(this.params) }
  async setParameters(p) { this.params = p }
}

class PC {
  constructor(cfg) {
    Object.assign(this, { cfg, senders: [], connectionState: 'new', iceConnectionState: 'new',
                          signalingState: 'stable', localDescription: null, remoteDescription: null })
    PC.criadas.push(this)
  }
  createDataChannel(nome, opcoes) { this.canal = { nome, opcoes }; return { readyState: 'connecting' } }
  addTrack(t, s) { const sd = new Sender(t, s); this.senders.push(sd); return sd }
  removeTrack(sd) { sd.track = null }
  getSenders() { return this.senders }
  async getStats() { return new Map([['r', { id: 'r', type: 'transport' }]]) }
  close() { this.connectionState = 'closed' }
  restartIce() {}
  async createOffer() { return { type: 'offer', sdp: 'a=rtpmap:111 opus/48000/2' } }
  async createAnswer() { return { type: 'answer', sdp: '' } }
  async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable' }
  async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable' }
}

function fixture({ eu = 'aaaa0001' } = {}) {
  PC.criadas = []
  const ctx = { RTCPeerConnection: PC, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, structuredClone }
  for (const nome of ['transporte.js', 'fontes.js', 'transporte-mesh.js']) runInNewContext(lerPublico(nome), ctx)
  const fontes = runInNewContext('disgalmFontes.criarRegistro()', ctx)
  const chamadas = [], sinais = [], logs = [], eventos = []
  const nomes = new Map()
  const registrar = nome => (...a) => chamadas.push([nome, ...a])
  const app = {
    meuId: () => eu, nome: id => nomes.get(id), ice: () => [], soRelay: () => false,
    sinalizar: (para, data) => sinais.push({ para, data }), sinalizacaoAberta: () => true,
    fontes, log: (...a) => logs.push(a.join(' ')), telemetria: (evento, campos) => eventos.push({ evento, ...campos }),
    pessoaConectando: (id, nome) => { nomes.set(id, nome); chamadas.push(['conectando', id, nome]) },
    pessoaDesconectando: registrar('desconectando'), pessoaDesconectada: registrar('desconectada'),
    pessoaReconectada: registrar('reconectada'), trackRecebida: registrar('track'),
    conexaoMudou: registrar('conexaoMudou'), amostrar: async () => {}, relayUsado: registrar('relay'),
  }
  const t = ctx.criarTransporteMesh(app)
  return { ctx, t, app, fontes, chamadas, sinais, logs, eventos }
}

test('contrato lista os métodos e recusa transporte incompleto', () => {
  const { ctx, t } = fixture()
  const { METODOS, validar } = ctx.disgalmTransporte
  for (const m of ['entrar', 'sair', 'publicar', 'substituir', 'parar', 'assinar', 'stats'])
    assert.ok(METODOS.includes(m), m)
  for (const m of METODOS) assert.equal(typeof t[m], 'function', m)
  assert.equal(validar(t), t)
  const sfuPelaMetade = { nome: 'sfu', entrar() {}, sair() {}, publicar() {} }
  assert.throws(() => validar(sfuPelaMetade), /transporte sfu sem pessoaEntrou, .*substituir.*stats/)
})

test('transporte recusa sala sem os ganchos', () => {
  const { ctx, app } = fixture()
  const { fontes, trackRecebida, ...semAlguns } = app
  assert.throws(() => ctx.criarTransporteMesh(semAlguns), /sala sem os ganchos trackRecebida, fontes/)
})

test('conexão nova recebe as fontes publicadas, voz primeiro, e o canal de telemetria id 0', () => {
  const f = fixture()
  const tela = stream('tela'), id = f.fontes.novaTela()
  f.fontes.abrir('camera', track('cam', 'video'), stream('cam'))
  f.fontes.abrir('tela-video', track('tv', 'video'), tela, { tela: id })
  f.fontes.abrir('tela-audio', track('ta'), tela, { tela: id })
  f.fontes.abrir('mic', track('mic'), stream('voz'))
  f.t.entrar([{ id: 'bbbb0002', nome: 'B' }])
  const [pc] = PC.criadas
  assert.deepEqual(pc.senders.map(s => s.track.id), ['mic', 'tv', 'ta', 'cam'])
  assert.deepEqual(pc.senders.map(s => s.stream.id), ['voz', 'tela', 'tela', 'cam'])
  assert.deepEqual(simples(pc.canal), { nome: 'telemetria', opcoes: { negotiated: true, id: 0 } })
  assert.equal(pc.cfg.iceTransportPolicy, 'all')
  const criado = f.eventos.find(e => e.evento === 'par_criado')
  assert.deepEqual({ ...criado, evento: undefined }, { evento: undefined, par: 'bbbb0002', polite: true, soRelay: false,
    enviaCam: true, enviaTelas: 1, enviaMic: true })
  assert.deepEqual(f.chamadas[0], ['conectando', 'bbbb0002', 'B'])
})

test('publicar, substituir e parar mexem só na fonte pedida, em todas as conexões', async () => {
  const f = fixture()
  const mic = f.fontes.abrir('mic', track('mic'), stream('voz'))
  f.t.entrar([{ id: 'bbbb0002', nome: 'B' }, { id: 'cccc0003', nome: 'C' }])
  const cam = f.fontes.abrir('camera', track('cam', 'video'), stream('cam'))
  f.t.publicar(cam)
  for (const pc of PC.criadas) assert.deepEqual(pc.senders.map(s => s.track.id), ['mic', 'cam'])

  const nova = track('mic2')
  await f.t.substituir(mic, nova)
  f.fontes.substituir(mic, nova)
  for (const pc of PC.criadas) {
    assert.deepEqual(pc.senders[0].trocas, [nova])
    assert.deepEqual(pc.senders[1].trocas, [])
  }

  f.t.parar(cam)
  for (const pc of PC.criadas) assert.deepEqual(pc.senders.map(s => s.track?.id ?? null), ['mic2', null])
})

test('orçamento de malha divide por cópia e por tela; limites vão por tipo de fonte', async () => {
  const f = fixture()
  assert.deepEqual(simples(f.t.planejarEnvio({ kbpsTela: 4000, telas: 1 })), { copias: 1, kbpsPorCopia: 4000, kbpsPorTela: 4000 })
  f.t.entrar([{ id: 'bbbb0002', nome: 'B' }, { id: 'cccc0003', nome: 'C' }, { id: 'dddd0004', nome: 'D' }])
  assert.deepEqual(simples(f.t.planejarEnvio({ kbpsTela: 4000, orcamentoKbps: 6000, telas: 2 })),
    { copias: 3, kbpsPorCopia: 2000, kbpsPorTela: 1000 })
  assert.equal(f.t.planejarEnvio({ kbpsTela: 1500, orcamentoKbps: 60000, telas: 1 }).kbpsPorCopia, 1500)

  const id = f.fontes.novaTela()
  f.t.publicar(f.fontes.abrir('tela-video', track('tv', 'video'), stream('t'), { tela: id }))
  f.t.publicar(f.fontes.abrir('camera', track('cam', 'video'), stream('c')))
  f.t.publicar(f.fontes.abrir('tela-audio', track('ta'), stream('t'), { tela: id }))
  await f.t.aplicarEnvio(fonte => fonte.tipo === 'camera' ? { maxBitrate: 800000, maxFramerate: 30 }
    : { maxBitrate: 1000000, maxFramerate: 60, degradacao: 'maintain-resolution' })
  const [tv, cam, ta] = PC.criadas[0].senders
  assert.deepEqual(tv.params, { encodings: [{ maxBitrate: 1000000, maxFramerate: 60 }], degradationPreference: 'maintain-resolution' })
  assert.deepEqual(cam.params, { encodings: [{ maxBitrate: 800000, maxFramerate: 30 }] })
  assert.deepEqual(ta.params, { encodings: [{}] })      // áudio não passa pelos limites de vídeo
})

test('mensagens do transporte levam o id da conexão; sem caminho, assinar diz não', async () => {
  const f = fixture({ eu: 'zzzz0009' })                  // impolite com B: oferece primeiro
  f.t.entrar([{ id: 'bbbb0002', nome: 'B' }])
  const [pc] = PC.criadas
  await pc.onnegotiationneeded()
  const oferta = f.sinais.find(s => s.data.description)
  assert.equal(oferta.para, 'bbbb0002')
  assert.equal(oferta.data.de, f.t.pares.get('bbbb0002').conexao)
  assert.match(oferta.data.description.sdp, /stereo=1;sprop-stereo=1;maxaveragebitrate=128000;useinbandfec=1/)
  assert.equal(f.t.assinar('bbbb0002', 'tela-1/video'), true)
  assert.equal(f.t.assinar('cccc0003', 'mic-1'), false)
})

test('ciclo da sala: saída por queda mantém mídia viva, sair encerra tudo e avisa antes e depois', async () => {
  const f = fixture()
  f.t.entrar([{ id: 'bbbb0002', nome: 'B' }, { id: 'cccc0003', nome: 'C' }])
  f.t.pares.get('bbbb0002').pc.connectionState = 'connected'
  assert.equal(f.t.pessoaSaiu('bbbb0002', { volta: true }), false)
  assert.equal(f.t.pessoaSaiu('cccc0003', { volta: true }), true)
  assert.deepEqual(f.chamadas.filter(c => c[0] !== 'conectando').map(c => c.slice(0, 2)),
    [['desconectando', 'cccc0003'], ['desconectada', 'cccc0003']])

  f.t.relatarUso()
  assert.deepEqual(f.chamadas.filter(c => c[0] === 'relay').map(c => c[1]), ['bbbb0002'])
  const stats = await f.t.stats()
  assert.deepEqual(simples(stats.map(s => s.pessoa)), ['bbbb0002'])
  assert.equal(stats[0].relatorio.get('r').type, 'transport')

  const pc = f.t.pares.get('bbbb0002').pc
  f.t.sair()
  assert.equal(pc.connectionState, 'closed')
  assert.equal(f.t.pares.size, 0)
})

test('pessoaVoltou só recria quando a mídia morreu', () => {
  const f = fixture()
  f.t.entrar([{ id: 'bbbb0002', nome: 'B' }])
  const vivo = f.t.pares.get('bbbb0002')
  assert.equal(f.t.pessoaVoltou('bbbb0002', 'B'), false)
  assert.equal(f.t.pares.get('bbbb0002'), vivo)
  vivo.pc.connectionState = 'failed'
  assert.equal(f.t.pessoaVoltou('bbbb0002', 'B'), true)
  assert.notEqual(f.t.pares.get('bbbb0002'), vivo)
})

test('oferta de instância nova do outro lado recria a conexão e avisa a sala', async () => {
  const f = fixture()
  f.t.entrar([{ id: 'bbbb0002', nome: 'B' }])
  await f.t.receberSinal('bbbb0002', { de: 'velha', description: { type: 'answer', sdp: '' } })
  await f.t.receberSinal('bbbb0002', { de: 'nova', description: { type: 'offer', sdp: '' } })
  assert.equal(f.t.pares.get('bbbb0002').remota, 'nova')
  assert.ok(f.chamadas.some(c => c[0] === 'reconectada' && c[1] === 'bbbb0002'))
  assert.equal(f.sinais.at(-1).data.description.type, 'answer')
})

test('credencial TURN renovada: troca a configuração em todas, refaz o ICE só de quem está no relay', async () => {
  const f = fixture()
  f.t.entrar([{ id: 'bbbb0002', nome: 'B' }, { id: 'cccc0003', nome: 'C' }])
  const [relay, direto] = PC.criadas
  for (const [pc, tipo] of [[relay, 'relay'], [direto, 'srflx']]) {
    pc.reinicios = 0
    pc.restartIce = () => pc.reinicios++
    pc.getConfiguration = () => ({ ...pc.cfg })
    pc.setConfiguration = c => { pc.cfg = c }
    pc.getStats = async () => new Map([
      ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }],
      ['p', { id: 'p', type: 'candidate-pair', localCandidateId: 'l' }],
      ['l', { id: 'l', type: 'local-candidate', candidateType: tipo }]])
  }
  const novo = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u2', credential: 'c2' }]
  assert.equal(await f.t.atualizarIce(novo), 1)
  for (const pc of [relay, direto]) assert.equal(pc.cfg.iceServers[0].username, 'u2')
  assert.deepEqual([relay.reinicios, direto.reinicios], [1, 0])
  // Orçamento negou o relay: troca a lista, mas refazer o ICE não acharia relay.
  assert.equal(await f.t.atualizarIce([{ urls: 'stun:stun.cloudflare.com:3478' }]), 0)
  assert.equal(relay.reinicios, 1)
})
