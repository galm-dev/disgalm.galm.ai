// Câmera + tela da mesma pessoa: a tela fica no tile e no palco, e a câmera na
// miniatura. Roda desenharTile, focar, classificarVideo e os handlers reais do
// cliente sobre um DOM mínimo. Não há layout, pixels nem WebRTC aqui.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { rodarCliente } from './cliente.js'

let seq = 0
class Stream {
  constructor(tracks = []) { this.id = 'gerado-' + ++seq; this.tracks = [...tracks] }
  getTracks() { return [...this.tracks] }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video') }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio') }
  addTrack(t) { this.tracks.push(t) }
  removeTrack(t) { this.tracks = this.tracks.filter(x => x !== t) }
}

function track(id) {
  return {
    id, kind: 'video', readyState: 'live', enabled: true, muted: false,
    stop() { this.readyState = 'ended' },
    getSettings: () => ({ width: 640, height: 360 }),
    addEventListener() {},
  }
}

function sala() {
  const elementos = new Map()
  class Elemento {
    constructor() {
      this.textContent = ''; this.value = ''; this.hidden = false; this.dataset = {}
      this.options = []; this.filhos = new Map(); this.entradas = []
      const classes = new Set()
      this.classList = {
        contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c),
        replace(a, b) { if (!classes.has(a)) return false; classes.delete(a); classes.add(b); return true },
        toggle(c, on = !classes.has(c)) { on ? classes.add(c) : classes.delete(c); return on },
      }
      this.style = { setProperty() {} }
    }
    set innerHTML(html) {
      this.html = html; this.filhos.clear(); this.entradas = []
      for (const m of html.matchAll(/<video class="([^"]+)"/g)) {
        const v = new Elemento()
        for (const c of m[1].split(' ')) this.filhos.set('.' + c, v)
      }
      for (const m of html.matchAll(/data-tipo="([^"]+)"/g)) {
        const i = new Elemento(); i.dataset.tipo = m[1]; this.entradas.push(i)
      }
    }
    get innerHTML() { return this.html || '' }
    querySelector(s) { return this.filhos.get(s) || null }
    querySelectorAll(s) { return s === '.vols input' ? this.entradas : [] }
    insertAdjacentHTML(_, html) { this.html = (this.html || '') + html }
    setAttribute() {}
    addEventListener() {}
    append(el) { if (el.id) elementos.set(el.id, el) }
    remove() { elementos.delete(this.id) }
  }
  const $ = id => {
    if (!elementos.has(id) && !id.startsWith('t-')) elementos.set(id, new Elemento())
    return elementos.get(id) || null
  }
  const state = {
    document: {
      getElementById: $, createElement: () => new Elemento(), querySelector: () => null,
      querySelectorAll: s => s === '.tile' ? [...elementos.values()].filter(e => e.id?.startsWith('t-')) : [],
      addEventListener() {},
    },
    addEventListener() {}, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    MediaStream: Stream,
    navigator: {
      mediaDevices: {
        enumerateDevices: async () => [],
        getUserMedia: async () => new Stream([track('cam-local')]),
        getDisplayMedia: async () => new Stream([track('tela-local-' + ++seq)]),
      },
    },
  }
  rodarCliente(state)
  for (const f of ['atualizarParticipantes', 'aplicarQualidade', 'avisarBandeja', 'classificar']) state[f] = () => {}
  const run = code => runInNewContext(code, state)
  run("transporte = { publicar() {}, parar() {}, planejarEnvio() { return { copias: 0, kbpsPorCopia: 0 } } }; perfil.nome = 'Eu'")

  const primeira = s => s?.getVideoTracks()[0]?.id ?? null
  const quadro = id => {
    const tile = $('t-' + id)
    return {
      tileTela: primeira(tile?.querySelector('.v-tela')?.srcObject),
      tileCam: primeira(tile?.querySelector('.v-cam')?.srcObject),
      tileMini: !!tile?.querySelector('.mini'),
      palco: primeira($('v-palco').srcObject),
      palcoMini: primeira($('v-palco-mini').srcObject),
      miniOculta: $('v-palco-mini').hidden,
    }
  }
  const receber = sid => state.receberTrack('b', track(sid), { id: sid })
  const anunciar = (telas, cam = null) =>
    state.receberSinal('b', { estado: { compartilhando: telas.length > 0, idsTelas: telas, idCam: cam, camera: !!cam } })
  return { $, state, run, quadro, receber, anunciar }
}

test('câmera ligada e depois tela: tela no tile e no palco, câmera nas duas miniaturas', async () => {
  const s = sala()
  await s.run('alternarCam()'); await s.run('adicionarTela()')
  const q = s.quadro('local')
  assert.equal(q.tileMini, true)
  assert.equal(q.tileCam, 'cam-local')
  assert.equal(q.palco, q.tileTela)
  assert.equal(q.palcoMini, 'cam-local')
  assert.equal(q.miniOculta, false)
})

test('tela e depois câmera: a câmera entra na miniatura do palco sem refocar', async () => {
  const s = sala()
  await s.run('adicionarTela()'); await s.run('alternarCam()')
  const q = s.quadro('local')
  assert.equal(q.tileMini, true)
  assert.equal(q.palco, q.tileTela)
  assert.equal(q.palcoMini, 'cam-local')
  assert.equal(q.miniOculta, false)
})

test('desligar a câmera com tela tira a câmera parada do palco, mesmo se ela estava no centro', async () => {
  for (const trocada of [false, true]) {
    const s = sala()
    await s.run('alternarCam()'); await s.run('adicionarTela()')
    if (trocada) s.$('v-palco-mini').onclick()
    assert.equal(s.quadro('local').palco, trocada ? 'cam-local' : s.quadro('local').tileTela)
    s.run('pararCam()')
    const q = s.quadro('local')
    assert.equal(q.tileCam, null)
    assert.equal(q.tileMini, false)
    assert.equal(q.palco, q.tileTela, 'a tela volta ao centro')
    assert.equal(q.palcoMini, null)
    assert.equal(q.miniOculta, true)
    // Religar não devolve a câmera ao centro: a troca acabou junto com ela.
    await s.run('alternarCam()')
    assert.equal(s.quadro('local').palco, q.tileTela)
    assert.equal(s.quadro('local').palcoMini, 'cam-local')
  }
})

test('parar a última tela com câmera ligada põe a câmera no palco', async () => {
  const s = sala()
  await s.run('alternarCam()'); await s.run('adicionarTela()')
  s.run('pararTela(telas[0])')
  const q = s.quadro('local')
  assert.equal(q.palco, 'cam-local')
  assert.equal(q.palcoMini, null)
  assert.equal(q.tileMini, false)
})

test('câmera ligada sem palco local não rouba o foco', async () => {
  const s = sala()
  s.run("novaPessoa('b', 'B')"); s.anunciar(['S']); s.receber('S'); s.run("focar('b')")
  await s.run('adicionarTela()'); s.run("focar('b')")
  await s.run('alternarCam()')
  assert.equal(s.run('foco'), 'b')
  assert.equal(s.quadro('b').palco, 'S')
  assert.equal(s.quadro('local').tileMini, true)
})

test('falha ao listar câmeras não impede a câmera de aparecer e ser anunciada', async () => {
  const s = sala()
  await s.run('adicionarTela()')
  s.state.navigator.mediaDevices.enumerateDevices = async () => { throw Error('sem lista') }
  const anuncios = []
  s.state.anunciar = () => anuncios.push(true)
  await s.run('alternarCam()')
  assert.equal(s.quadro('local').tileCam, 'cam-local')
  assert.equal(s.quadro('local').palcoMini, 'cam-local')
  assert.equal(anuncios.length, 1)
})

test('remoto: câmera + tela em qualquer ordem forma a miniatura; retirar uma atualiza tile e palco', async () => {
  for (const camAntes of [false, true]) {
    const s = sala(); s.run("novaPessoa('b', 'B')")
    s.anunciar([], null)
    if (camAntes) { s.receber('C'); s.anunciar([], 'C'); s.receber('S') }
    else { s.anunciar(['S']); s.receber('S'); s.receber('C') }
    s.anunciar(['S'], 'C'); s.run("focar('b')")
    assert.deepEqual(s.quadro('b'),
      { tileTela: 'S', tileCam: 'C', tileMini: true, palco: 'S', palcoMini: 'C', miniOculta: false })
    s.$('v-palco-mini').onclick()
    assert.equal(s.quadro('b').palco, 'C')
    s.anunciar(['S'])
    assert.equal(s.quadro('b').palco, 'S'); assert.equal(s.quadro('b').palcoMini, null)
    assert.equal(s.quadro('b').tileMini, false)
    s.anunciar(['S'], 'C'); s.anunciar([], 'C')
    assert.equal(s.quadro('b').palco, 'C'); assert.equal(s.quadro('b').tileMini, false)
  }
})

test('remoto: quem entra depois e recebe tudo antes do anúncio vê a miniatura quando o anúncio chega', () => {
  const s = sala(); s.run("novaPessoa('b', 'B')")
  s.receber('C'); s.receber('S')
  assert.equal(s.quadro('b').tileMini, false)   // provisório: sem anúncio, tudo parece tela
  s.anunciar(['S'], 'C'); s.run("focar('b')")
  assert.equal(s.quadro('b').tileMini, true)
  assert.equal(s.quadro('b').palcoMini, 'C')
})

test('remoto: reconexão recria a pessoa e as tracks novas voltam a formar a miniatura', () => {
  const s = sala(); s.run("novaPessoa('b', 'B')")
  s.anunciar(['S'], 'C'); s.receber('S'); s.receber('C')
  s.run("novaPessoa('b', 'B')")
  s.state.receberTrack('b', track('S2'), { id: 'S' })
  s.state.receberTrack('b', track('C2'), { id: 'C' })
  s.run("focar('b')")
  assert.equal(s.quadro('b').tileMini, true)
  assert.equal(s.quadro('b').palco, 'S2')
  assert.equal(s.quadro('b').palcoMini, 'C2')
})

test('remoto: várias telas + câmera mantém uma câmera na miniatura da tela escolhida', () => {
  const s = sala(); s.run("novaPessoa('b', 'B')")
  s.anunciar(['S1', 'S2', 'S3'], 'C')
  for (const sid of ['S1', 'S2', 'S3', 'C']) s.receber(sid)
  s.run("focar('b'); verTela(pessoas.get('b').telas.get('S3').id)")
  assert.equal(s.quadro('b').palco, 'S3'); assert.equal(s.quadro('b').tileTela, 'S3')
  assert.equal(s.quadro('b').palcoMini, 'C'); assert.equal(s.quadro('b').tileCam, 'C')
  s.anunciar(['S1', 'S2'], 'C')
  assert.equal(s.quadro('b').palco, 'S1'); assert.equal(s.quadro('b').palcoMini, 'C')
})
