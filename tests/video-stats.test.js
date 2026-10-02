import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const script = html.split('<script>')[1].split('</script>')[0]
const stream = id => ({ getVideoTracks: () => id ? [{ id }] : [] })

function fixture() {
  const elements = new Map()
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', classList: { toggle() {} } })
    return elements.get(id)
  }
  let stats = new Map()
  const pc = { getStats: async () => stats }
  const p = { pc, telas: new Map([['tela', stream('remote-screen')]]), cam: stream('remote-camera'), amostras: [] }
  const state = {
    $, document: { getElementById: $, querySelector: () => $('env') },
    addEventListener() {}, Map, setInterval() {}, clearInterval() {},
  }
  runInNewContext(script, state)
  state.pc = pc
  state.p = p
  state.screen = stream('screen')
  state.camera = stream('camera')
  runInNewContext("pares.set('peer', p); telas.splice(0, telas.length, screen); camStream = camera; foco = 'peer'", state)
  const previous = new Map()
  return {
    state, p, $, previous,
    async tick(rows) {
      stats = new Map(rows.map(r => [r.id, r]))
      await state.atualizarVideo('peer', pc, previous)
    },
  }
}

const source = (track = 'screen') => ({ id: 'source', type: 'media-source', trackIdentifier: track })
const out = (extra = {}) => ({
  id: 'out', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'source',
  transportId: 'transport', timestamp: 1000, bytesSent: 1000, framesEncoded: 30,
  frameWidth: 1920, frameHeight: 1080, qualityLimitationReason: 'bandwidth', ...extra,
})
const incoming = (extra = {}) => ({
  id: 'in', type: 'inbound-rtp', kind: 'video', trackIdentifier: 'remote-screen',
  timestamp: 1000, bytesReceived: 1000, framesDecoded: 30, packetsLost: 0,
  frameWidth: 1280, frameHeight: 720, ...extra,
})

test('envio aparece sem receber vídeo e mede bytes entre duas amostras', async () => {
  const f = fixture()
  await f.tick([source(), out()])
  assert.match(f.$('env').textContent, /tela 1920x1080.*limitado: banda/)
  await f.tick([source(), out({ timestamp: 3000, bytesSent: 501000, framesEncoded: 90 })])
  assert.match(f.$('env').textContent, /30.0fps · 2000kbps/)
})

test('tela não herda resolução da câmera nem do último relatório', async () => {
  const f = fixture()
  await f.tick([
    source(), out(), incoming(),
    { ...source('camera'), id: 'camera-source' },
    out({ id: 'camera-out', mediaSourceId: 'camera-source', frameHeight: 320 }),
    incoming({ id: 'camera-in', trackIdentifier: 'remote-camera', frameHeight: 320 }),
  ])
  assert.match(f.$('env').textContent, /1920x1080/)
  assert.match(f.$('palco-stats').textContent, /1280x720/)
})

test('recebimento funciona sem envio e limpa indicador de envio anterior', async () => {
  const f = fixture()
  await f.tick([source(), out()])
  await f.tick([incoming()])
  assert.equal(f.$('env').textContent, '')
  assert.match(f.$('palco-stats').textContent, /1280x720/)
})

test('câmera é medida quando não há tela compartilhada', async () => {
  const f = fixture()
  runInNewContext('telas.length = 0', f.state)
  f.p.telas = new Map()
  await f.tick([source('camera'), out(), incoming({ trackIdentifier: 'remote-camera' })])
  assert.match(f.$('env').textContent, /câmera 1920x1080/)
  assert.match(f.$('palco-stats').textContent, /1280x720/)
})

test('troca de track não mistura contadores e ausência não mantém número antigo', async () => {
  const f = fixture()
  await f.tick([incoming()])
  await f.tick([incoming({ id: 'new-in', timestamp: 3000, bytesReceived: 900000 })])
  assert.match(f.$('palco-stats').textContent, /\?fps · \?kbps/)
  await f.tick([])
  assert.equal(f.$('palco-stats').textContent, '')
  assert.equal(f.previous.size, 0)
})

test('mede caminho selecionado e preserva estimativa zero de banda', async () => {
  const f = fixture()
  await f.tick([
    source(), out(),
    { id: 'transport', selectedCandidatePairId: 'selected' },
    { id: 'selected', localCandidateId: 'local', remoteCandidateId: 'remote', availableOutgoingBitrate: 0 },
    { id: 'local', candidateType: 'relay' }, { id: 'remote', candidateType: 'host' },
    { id: 'unused', type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 9000000 },
  ])
  assert.match(f.$('env').textContent, /banda estimada 0kbps · relay/)
})

test('campos ausentes, timestamp repetido e contadores reiniciados não inventam taxas', async () => {
  const f = fixture()
  await f.tick([source(), out({ frameWidth: undefined, qualityLimitationReason: undefined })])
  assert.doesNotMatch(f.$('env').textContent, /limitado:/)
  await f.tick([source(), out()])
  assert.match(f.$('env').textContent, /\?fps · \?kbps/)
  await f.tick([source(), out({ timestamp: 3000, bytesSent: 0, framesEncoded: 0 })])
  assert.doesNotMatch(f.$('env').textContent, /NaN|Infinity|-[0-9]/)
})

test('resultado atrasado de conexão removida não atualiza a tela', async () => {
  const f = fixture()
  runInNewContext('pares.clear()', f.state)
  await f.tick([source(), out()])
  assert.equal(f.$('env').textContent, '')
})
