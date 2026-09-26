import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const script = html.split('<script>')[1].split('</script>')[0]
const stream = id => {
  const tracks = id ? [{ id }] : []
  return { getVideoTracks: () => tracks }
}

function fixture() {
  const elements = new Map()
  const $ = id => {
    if (!elements.has(id))
      elements.set(id, { id, textContent: '', value: '', hidden: true, innerHTML: '', classList: { toggle() {} } })
    return elements.get(id)
  }
  let stats = new Map()
  const enviados = []
  const pc = {
    getStats: async () => stats, connectionState: 'connected', iceConnectionState: 'connected',
    signalingState: 'stable', getSenders: () => [],
  }
  const canal = { readyState: 'open', send: m => enviados.push(JSON.parse(m)) }
  const p = { pc, nome: 'A', tela: stream('remote-screen'), cam: stream(), amostras: [], canal, estado: {} }
  const state = {
    document: { getElementById: $, querySelector: () => $('env') },
    navigator: { userAgent: 'teste' },
    addEventListener() {}, setInterval() {}, clearInterval() {},
  }
  runInNewContext(script, state)
  Object.assign(state, { pc, p, screen: stream('screen') })
  runInNewContext("pares.set('peer', p); telaStream = screen; foco = 'peer'", state)
  const previous = new Map()
  return {
    state, p, pc, $, enviados,
    run: code => runInNewContext(code, state),
    async tick(rows) {
      stats = new Map(rows.map(r => [r.id, r]))
      await state.atualizarVideo('peer', pc, previous)
    },
  }
}

const source = { id: 'source', type: 'media-source', trackIdentifier: 'screen', width: 1920, height: 1080, framesPerSecond: 30 }
const out = (extra = {}) => ({
  id: 'out', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'source', transportId: 'transport',
  timestamp: 1000, bytesSent: 1000, framesEncoded: 30, frameWidth: 1920, frameHeight: 1080,
  qualityLimitationReason: 'none', targetBitrate: 3000000, encoderImplementation: 'libvpx', ...extra,
})
const incoming = (extra = {}) => ({
  id: 'in', type: 'inbound-rtp', kind: 'video', trackIdentifier: 'remote-screen', transportId: 'transport',
  timestamp: 1000, bytesReceived: 1000, framesDecoded: 30, packetsLost: 0, packetsReceived: 100,
  framesDropped: 0, frameWidth: 1920, frameHeight: 1080, ...extra,
})
const transporte = [
  { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
  { id: 'pair', localCandidateId: 'l', remoteCandidateId: 'r', availableOutgoingBitrate: 140000, currentRoundTripTime: 0.08 },
  { id: 'l', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp', url: 'turn:turn.example:443?transport=tcp' },
  { id: 'r', candidateType: 'srflx', protocol: 'udp' },
]
const relato = (envio, extra = {}) => ({
  envio: { res: '1920x1080', limite: 'none', alvoKbps: 3000, ...envio },
  transporte: { caminho: 'srflx/udp → srflx', bweKbps: 5000 },
  config: { maxKbps: 4000 }, recebidoEm: Date.now(), ...extra,
})

test('receptor mostra a causa relatada pelo emissor: banda via TURN/tcp', async () => {
  const f = fixture()
  f.p.relato = relato({ limite: 'bandwidth', alvoKbps: 140 },
    { transporte: { caminho: 'relay/tcp → srflx', bweKbps: 140 } })
  await f.tick([incoming()])
  assert.match(f.$('palco-stats').textContent, /banda de A: estimativa 140kbps via TURN\/tcp/)
  assert.equal(f.p.amostras.length, 1)
  assert.equal(f.p.amostras[0].relato.envio.limite, 'bandwidth')
  assert.match(f.$('log').textContent, /vídeo de A: banda de A/)
})

test('causas na ordem em que uma esconde a outra', () => {
  const { state } = fixture()
  const d = (recebe, r) => state.diagnosticar({ perda: 0, ...recebe }, r, 'A')
  assert.equal(d({}, relato({ limite: 'cpu', encoder: 'libvpx' })), 'CPU de A (encoder libvpx)')
  assert.equal(d({ perda: 0.12 }, relato({ limite: 'bandwidth' })), 'perda de 12% entre A e você')
  assert.equal(d({}, relato({ perda: 0.2 })), 'perda de 20% entre A e você')
  assert.equal(d({}, relato({ limite: 'bandwidth', alvoKbps: 3900 })), 'teto de 4000kbps configurado por A')
  assert.equal(d({}, relato({ limite: 'bandwidth', alvoKbps: 900 })), 'banda de A: estimativa 5000kbps')
  // maintain-resolution: Chrome diz 'none', mas o encoder manda 2 de 30 quadros.
  assert.equal(d({}, relato({ fps: 2, fpsCaptura: 30, alvoKbps: 140 })), 'banda de A: estimativa 5000kbps · 2 de 30fps')
  assert.equal(d({}, relato({ fps: 5, fpsCaptura: 5 })), '')
  assert.equal(d({ descartadosPorS: 5, decoder: 'libvpx' }, relato()), 'seu navegador descarta quadros (decoder libvpx)')
  assert.equal(d({}, undefined), 'sem relato do emissor')
  assert.equal(d({}, relato()), '')
  assert.equal(state.diagnosticar(null, relato({ limite: 'cpu' }), 'A'), '')
})

test('relato velho não vale como causa', async () => {
  const f = fixture()
  f.p.relato = relato({ limite: 'cpu' }, { recebidoEm: Date.now() - 10000 })
  await f.tick([incoming()])
  assert.match(f.$('palco-stats').textContent, /sem relato do emissor/)
})

test('emissor manda ao par o próprio envio, transporte e o que o encoder aplicou', async () => {
  const f = fixture()
  const track = f.state.screen.getVideoTracks()[0]
  track.contentHint = 'motion'
  f.pc.getSenders = () => [{ track, getParameters: () => ({
    degradationPreference: 'maintain-resolution', encodings: [{ maxBitrate: 4000000, maxFramerate: 30 }] }) }]
  await f.tick([source, out(), { id: 'rin', type: 'remote-inbound-rtp', localId: 'out', fractionLost: 0.01, roundTripTime: 0.05 }, ...transporte])
  await f.tick([source, out({ timestamp: 3000, bytesSent: 251000, framesEncoded: 90, qualityLimitationReason: 'bandwidth' }), ...transporte])
  const [, segundo] = f.enviados
  assert.deepEqual(
    { ...segundo.envio, tempoLimitado: undefined },
    { res: '1920x1080', fps: 30, kbps: 1000, alvoKbps: 3000, captura: '1920x1080', fpsCaptura: 30, limite: 'bandwidth',
      encoder: 'libvpx', tempoLimitado: undefined })
  assert.equal(f.enviados[0].envio.perda, 0.01)
  assert.equal(f.enviados[0].envio.rttMs, 50)
  assert.deepEqual(segundo.transporte,
    { caminho: 'relay/tcp → srflx', relay: 'turn:turn.example:443?transport=tcp', bweKbps: 140, rttMs: 80 })
  assert.equal(segundo.config.degradacao, 'maintain-resolution')
  assert.equal(segundo.config.maxKbps, 4000)
  assert.match(f.$('log').textContent, /caminho com A: relay\/tcp → srflx/)
  assert.match(f.$('log').textContent, /envio para A: limitado por bandwidth em 1920x1080 30fps, estimativa 140kbps/)
})

test('transições entram no log uma vez; amostras param em 5 minutos', async () => {
  const f = fixture()
  for (let i = 0; i < 160; i++) await f.tick([source, out({ timestamp: 1000 + i * 2000 }), ...transporte])
  assert.equal(f.p.amostras.length, 150)
  assert.equal(f.$('log').textContent.match(/caminho com A/g).length, 1)
  assert.doesNotMatch(f.$('log').textContent, /envio para A/)
})

test('tela pede maintain-resolution; câmera fica com a dica dela', async () => {
  const f = fixture()
  const tela = { id: 'screen', kind: 'video', applyConstraints: async () => {}, getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }) }
  const cam = { id: 'camera', kind: 'video' }
  const aplicados = new Map()
  const sender = (track, ignora) => ({
    track,
    getParameters: () => ({ encodings: [{}], ...(ignora ? {} : aplicados.get(track)) }),
    setParameters: async par => { aplicados.set(track, par) },
  })
  f.pc.getSenders = () => [sender(tela), sender(cam)]
  Object.assign(f.state, { tela, cam })
  f.run('telaStream = { getVideoTracks: () => [tela] }; camStream = { getVideoTracks: () => [cam] }')
  await f.run('aplicarQualidade()')
  assert.equal(aplicados.get(tela).degradationPreference, 'maintain-resolution')
  assert.equal(aplicados.get(cam).degradationPreference, undefined)
  assert.doesNotMatch(f.$('log').textContent, /não aplicou/)

  f.pc.getSenders = () => [sender(tela, true)]
  await f.run('aplicarQualidade()')
  assert.match(f.$('log').textContent, /navegador não aplicou maintain-resolution na tela \(ficou sem valor\)/)
})

test('relatório junta pares, quem saiu e eventos com hora', async () => {
  const f = fixture()
  await f.tick([source, out(), ...transporte])
  f.run("log('evento qualquer'); saidos.push({ id: 'velho', nome: 'B', amostras: [] })")
  const r = JSON.parse(f.run('relatorio()'))
  assert.equal(r.navegador, 'teste')
  assert.equal(r.pares[0].nome, 'A')
  assert.equal(r.pares[0].canal, 'open')
  assert.equal(r.pares[0].amostras.length, 1)
  assert.equal(r.saidos[0].nome, 'B')
  assert.match(r.eventos.at(-1), /^\d\d:\d\d:\d\d\.\d{3} evento qualquer$/)
})
