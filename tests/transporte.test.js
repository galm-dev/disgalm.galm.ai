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

test('Opus estéreo em toda seção de áudio, inclusive a do som da tela e o OPUS do SFU', () => {
  const { ctx } = fixture()
  const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:1', 'a=rtpmap:96 VP8/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:2', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:3', 'a=rtpmap:111 OPUS/48000/2'].join('\r\n')
  const saida = ctx.criarTransporteMesh.opusEstereo(sdp).split('\r\n')
  const fmtp = saida.filter(l => l.startsWith('a=fmtp:111'))
  assert.equal(fmtp.length, 3)
  assert.ok(fmtp.every(l => l.includes('stereo=1;sprop-stereo=1;maxaveragebitrate=128000')))
  // A seção sem fmtp ganhou o dela, logo depois do rtpmap e antes de qualquer outra seção.
  assert.equal(saida[saida.indexOf('a=rtpmap:111 OPUS/48000/2') + 1].startsWith('a=fmtp:111 '), true)
  assert.ok(!saida.filter((l, i) => i < saida.indexOf('a=mid:1')).join().includes('a=mid:3'))
  // Idempotente.
  assert.equal(ctx.criarTransporteMesh.opusEstereo(saida.join('\r\n')), saida.join('\r\n'))
})

// O navegador enfileira setRemoteDescription, setLocalDescription e
// addIceCandidate na mesma conexão; o stub sem fila escondia a corrida. Aqui a
// resposta só se aplica quando o teste libera.
function filaComRespostaPresa(pc) {
  let fila = Promise.resolve(), liberar
  const presa = new Promise(r => { liberar = r })
  const aplicadas = []
  for (const nome of ['setRemoteDescription', 'setLocalDescription']) {
    const original = pc[nome].bind(pc)
    pc[nome] = d => (fila = fila.then(async () => {
      if (nome === 'setRemoteDescription' && d.type === 'answer') await presa
      await original(d)
      if (nome === 'setRemoteDescription') aplicadas.push(d.type)
    }))
  }
  return { aplicadas, liberar }
}

for (const [papel, eu] of [['impolite', 'zzzz0009'], ['polite', 'aaaa0001']])
  test(`oferta que chega com a resposta ainda pendente é aceita (${papel})`, async () => {
    const f = fixture({ eu })
    f.t.entrar([{ id: 'bbbb0002', nome: 'B' }])
    const p = f.t.pares.get('bbbb0002'), { pc } = p
    assert.equal(p.polite, papel === 'polite')
    await pc.setLocalDescription(await pc.createOffer())
    const { aplicadas, liberar } = filaComRespostaPresa(pc)
    const resposta = f.t.receberSinal('bbbb0002', { de: 'b1', description: { type: 'answer', sdp: '' } })
    const oferta = f.t.receberSinal('bbbb0002', { de: 'b1', description: { type: 'offer', sdp: '' } })
    await new Promise(r => setTimeout(r))
    liberar()
    await Promise.all([resposta, oferta])
    assert.deepEqual(aplicadas, ['answer', 'offer'])
    assert.ok(!f.eventos.some(e => e.evento === 'oferta_ignorada'))
    assert.equal(f.sinais.at(-1).data.description.type, 'answer')
    assert.equal(pc.signalingState, 'stable')
    assert.equal(p.respostaPendente, false)
  })

test('colisão de verdade: impolite ignora a oferta, polite volta atrás e responde', async () => {
  for (const [eu, ignora] of [['zzzz0009', true], ['aaaa0001', false]]) {
    const f = fixture({ eu })
    f.t.entrar([{ id: 'bbbb0002', nome: 'B' }])
    const { pc } = f.t.pares.get('bbbb0002')
    await pc.setLocalDescription(await pc.createOffer())
    await f.t.receberSinal('bbbb0002', { de: 'b1', description: { type: 'offer', sdp: '' } })
    assert.equal(f.eventos.some(e => e.evento === 'oferta_ignorada'), ignora, eu)
    assert.equal(pc.signalingState, ignora ? 'have-local-offer' : 'stable', eu)
    assert.equal(f.sinais.some(s => s.data.description?.type === 'answer'), !ignora, eu)
  }
})

test('conexão recriada no meio da negociação: a continuação da velha não sinaliza', async () => {
  const f = fixture()
  f.t.entrar([{ id: 'bbbb0002', nome: 'B' }])
  const velha = f.t.pares.get('bbbb0002')
  let liberar
  const presa = new Promise(r => { liberar = r })
  const srd = velha.pc.setRemoteDescription.bind(velha.pc)
  velha.pc.setRemoteDescription = async d => { await presa; return srd(d) }
  const antiga = f.t.receberSinal('bbbb0002', { de: 'velha', description: { type: 'offer', sdp: '' } })
  await new Promise(r => setTimeout(r))
  await f.t.receberSinal('bbbb0002', { de: 'nova', description: { type: 'offer', sdp: '' } })
  const nova = f.t.pares.get('bbbb0002')
  assert.notEqual(nova, velha)
  const enviados = f.sinais.length
  liberar()
  await antiga
  assert.equal(f.sinais.length, enviados)
  assert.equal(velha.pc.localDescription, null)
  assert.equal(nova.remota, 'nova')
})

test('resposta rejeitada libera a marca: a oferta seguinte em have-local-offer é colisão', async () => {
  const f = fixture({ eu: 'zzzz0009' })                  // impolite
  f.t.entrar([{ id: 'bbbb0002', nome: 'B' }])
  const p = f.t.pares.get('bbbb0002'), { pc } = p
  await pc.setLocalDescription(await pc.createOffer())
  pc.setRemoteDescription = async () => { throw new Error('resposta inválida') }
  await f.t.receberSinal('bbbb0002', { de: 'b1', description: { type: 'answer', sdp: '' } })
  assert.equal(p.respostaPendente, false)
  assert.ok(f.eventos.some(e => e.evento === 'sinal_erro'))
  await f.t.receberSinal('bbbb0002', { de: 'b1', description: { type: 'offer', sdp: '' } })
  assert.ok(f.eventos.some(e => e.evento === 'oferta_ignorada'))
  assert.equal(pc.signalingState, 'have-local-offer')
})

// Segura o setLocalDescription da conexão atual até o teste liberar.
function slPreso(pc) {
  let liberar
  const presa = new Promise(r => { liberar = r })
  const sld = pc.setLocalDescription.bind(pc)
  pc.setLocalDescription = async d => { await presa; return sld(d) }
  return () => liberar()
}

for (const [caso, preparar] of [
  ['a própria oferta', async (f, velha) => { velha.remota = 'velha'; return velha.pc.onnegotiationneeded() }],
  ['a resposta', async f => f.t.receberSinal('bbbb0002', { de: 'velha', description: { type: 'offer', sdp: '' } })],
])
  test(`conexão recriada enquanto aplicava ${caso}: a descrição velha não sai com o id novo`, async () => {
    const f = fixture({ eu: 'zzzz0009' })                // impolite: oferece sem esperar
    f.t.entrar([{ id: 'bbbb0002', nome: 'B' }])
    const velha = f.t.pares.get('bbbb0002')
    const liberar = slPreso(velha.pc)
    const pendente = preparar(f, velha)
    await new Promise(r => setTimeout(r))
    await f.t.receberSinal('bbbb0002', { de: 'nova', description: { type: 'offer', sdp: '' } })
    const nova = f.t.pares.get('bbbb0002')
    assert.notEqual(nova, velha)
    const enviados = f.sinais.length
    liberar()
    await pendente
    assert.ok(velha.pc.localDescription)                 // a velha terminou, mas calada
    assert.equal(f.sinais.length, enviados)
  })
