import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { rodarCliente } from './cliente.js'

// Na malha, parar a tela faz removeTrack no emissor: aqui a track só fica muda,
// sem 'ended'. Quem diz que o áudio da tela acabou é o anúncio.

class PC {
  constructor() { Object.assign(this, { connectionState: 'new', signalingState: 'stable', localDescription: null }) }
  createDataChannel() { return { readyState: 'connecting' } }
  addTrack() {}
  getSenders() { return [] }
  close() { this.connectionState = 'closed' }
}

function fixture() {
  const elements = new Map()
  const $ = id => {
    if (!elements.has(id))
      elements.set(id, { textContent: '', value: '', hidden: true, innerHTML: '', classList: { toggle() {} }, remove() {} })
    return elements.get(id)
  }
  const audios = []
  const createElement = tag => {
    const el = { tag, removido: false, volume: 1, remove() { this.removido = true }, play: async () => {} }
    if (tag === 'audio') audios.push(el)
    return el
  }
  const sockets = []
  class WS {
    constructor(url) { this.url = new URL(url); this.readyState = 0; this.enviadas = []; sockets.push(this) }
    send(m) { this.enviadas.push(JSON.parse(m)) }
    close() { this.readyState = 3 }
  }
  let uuid = 0
  const state = {
    document: { getElementById: $, querySelector: () => null, addEventListener() {}, createElement },
    addEventListener() {}, setInterval() {}, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    WebSocket: WS, RTCPeerConnection: PC,
    MediaStream: class { constructor(t = []) { this.t = t } getVideoTracks() { return [] } getAudioTracks() { return this.t } getTracks() { return this.t } },
    disgalmAuth: { currentToken: () => 'teste', accessToken: async () => 'teste', isGuest: () => false,
                   member: () => true, guestInvite: () => null },
    location: { protocol: 'https:', host: 'disgalm.test' }, URLSearchParams, URL,
    sessionStorage: { getItem: () => null, setItem() {} },
    crypto: { randomUUID: () => `aba-${++uuid}` }, alert() {},
  }
  rodarCliente(state)
  for (const f of ['desenharTile', 'focar', 'classificarVideo', 'atualizarParticipantes', 'aplicarQualidade', 'medirFala'])
    state[f] = () => {}
  const run = code => runInNewContext(code, state)
  run("sala = { cod: 'galm', nome: 'Eu' }")
  run('conectar()')
  const ws = sockets.at(-1)
  ws.readyState = 1; ws.onopen?.()
  ws.onmessage({ data: JSON.stringify({ t: 'welcome', id: 'aaaa0001', peers: [{ id: 'bbbb0002', name: 'B' }] }) })

  const par = 'bbbb0002'
  const track = () => {
    const ouvintes = {}
    return { kind: 'audio', muted: false, addEventListener: (t, f) => { ouvintes[t] = f }, encerrar: () => ouvintes.ended?.() }
  }
  state.__track = null
  const receber = (t, streamId) => { state.__track = t; run(`receberTrack('${par}', __track, { id: '${streamId}' })`) }
  const anunciar = estado => run(`receberSinal('${par}', ${JSON.stringify({ de: 'x', estado })})`)
  const tipos = () => run(`[...pessoas.get('${par}').audios].map(([sid, a]) => sid + ':' + a.tipo).join(',')`)
  const tamanho = () => run(`pessoas.get('${par}').audios.size`)
  const vivos = () => audios.filter(a => !a.removido)
  return { run, receber, anunciar, tipos, tamanho, vivos, audios, track }
}

test('parar a tela sem ended remove o áudio dela e mantém a voz', async () => {
  const f = fixture()
  await f.anunciar({ compartilhando: true, idsTelas: ['tela-1'] })
  f.receber(f.track(), 'voz')
  f.receber(f.track(), 'tela-1')
  assert.equal(f.tipos(), 'voz:voz,tela-1:tela')
  const elTela = f.audios[1]

  await f.anunciar({ compartilhando: false, idsTelas: [] })
  assert.equal(f.tipos(), 'voz:voz')
  assert.equal(elTela.removido, true)
  assert.equal(f.vivos().length, 1)
  assert.equal(f.audios[0].removido, false)
})

test('20 ciclos de liga e desliga a tela não acumulam áudio', async () => {
  const f = fixture()
  await f.anunciar({ compartilhando: false, idsTelas: [] })
  f.receber(f.track(), 'voz')
  for (let i = 1; i <= 20; i++) {
    await f.anunciar({ compartilhando: true, idsTelas: [`tela-${i}`] })
    f.receber(f.track(), `tela-${i}`)
    assert.equal(f.tamanho(), 2)
    await f.anunciar({ compartilhando: false, idsTelas: [] })
    assert.equal(f.tamanho(), 1)
  }
  assert.equal(f.tipos(), 'voz:voz')
  assert.equal(f.vivos().length, 1)
  assert.equal(f.audios.length, 21)
})

test('sem anúncio, ou com anúncio antigo sem a tela, a voz fica', async () => {
  const f = fixture()
  f.receber(f.track(), 'voz')
  f.receber(f.track(), 'outro')
  assert.equal(f.tipos(), 'voz:voz,outro:voz')
  await f.anunciar({ compartilhando: false })        // cliente antigo: sem idsTelas
  assert.equal(f.tipos(), 'voz:voz,outro:voz')
  assert.equal(f.vivos().length, 2)
})

test('track nova no mesmo stream substitui a velha sem deixar elemento órfão', async () => {
  const f = fixture()
  await f.anunciar({ compartilhando: true, idsTelas: ['tela-1'] })
  const velha = f.track()
  f.receber(velha, 'tela-1')
  f.receber(f.track(), 'tela-1')
  assert.equal(f.tamanho(), 1)
  assert.equal(f.audios[0].removido, true)
  assert.equal(f.vivos().length, 1)
  // O 'ended' tardio da velha não apaga a nova.
  velha.encerrar()
  assert.equal(f.tipos(), 'tela-1:tela')
  assert.equal(f.vivos().length, 1)
})

test('ended ainda remove o áudio', async () => {
  const f = fixture()
  const t = f.track()
  f.receber(t, 'voz')
  t.encerrar()
  assert.equal(f.tamanho(), 0)
  assert.equal(f.vivos().length, 0)
})
