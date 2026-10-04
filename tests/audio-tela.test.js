import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { rodarCliente } from './cliente.js'

// Na malha, parar a tela faz removeTrack no emissor: aqui a track só fica muda,
// sem 'ended'. Quem diz que o áudio da tela acabou é o anúncio. Os <audio>
// recebidos não entram no DOM, então o stub só solta a mídia com pause() e
// srcObject = null; remove() fora do DOM não faz nada, como no navegador.

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
    if (!elements.has(id)) {
      const classes = new Set()
      elements.set(id, { textContent: '', value: '', hidden: true, innerHTML: '', remove() {},
        classList: { classes, toggle: (c, on) => on ? classes.add(c) : classes.delete(c), remove: c => classes.delete(c) } })
    }
    return elements.get(id)
  }
  const audios = []
  const createElement = tag => {
    let src = null
    const el = { tag, paused: true, volume: 1, remove() {}, track: null,
                 get srcObject() { return src },
                 set srcObject(s) { src = s; if (s) this.track = s.getAudioTracks()[0] },   // de qual track ele nasceu
                 pause() { this.paused = true }, play() { this.paused = false; return Promise.resolve() } }
    if (tag === 'audio') audios.push(el)
    return el
  }
  // Medidor: o nível de cada amostra vem da track que alimenta o contexto.
  const contextos = []
  class AudioContext {
    constructor() { this.closed = false; contextos.push(this) }
    resume() {}
    close() { this.closed = true }
    createAnalyser() {
      return { fftSize: 0, getFloatTimeDomainData: buf => buf.fill(this.fonte.stream.getAudioTracks()[0]?.nivel ?? 0) }
    }
    createMediaStreamSource(stream) {
      this.fonte = { stream, desconectada: false, connect() {}, disconnect() { this.desconectada = true } }
      return this.fonte
    }
  }
  let frames = new Map(), proximo = 0
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
    requestAnimationFrame: f => { frames.set(++proximo, f); return proximo },
    cancelAnimationFrame: n => frames.delete(n),
    AudioContext, WebSocket: WS, RTCPeerConnection: PC,
    MediaStream: class { constructor(t = []) { this.t = t } getVideoTracks() { return [] } getAudioTracks() { return this.t } getTracks() { return this.t } },
    disgalmAuth: { currentToken: () => 'teste', accessToken: async () => 'teste', isGuest: () => false,
                   member: () => true, guestInvite: () => null },
    location: { protocol: 'https:', host: 'disgalm.test' }, URLSearchParams, URL,
    sessionStorage: { getItem: () => null, setItem() {} },
    crypto: { randomUUID: () => `aba-${++uuid}` }, alert() {},
  }
  rodarCliente(state)
  for (const f of ['desenharTile', 'focar', 'classificarVideo', 'atualizarParticipantes', 'aplicarQualidade', 'redividir'])
    state[f] = () => {}
  const run = code => runInNewContext(code, state)
  run("sala = { cod: 'galm', nome: 'Eu' }")
  run('conectar()')
  const ws = sockets.at(-1)
  ws.readyState = 1; ws.onopen?.()
  ws.onmessage({ data: JSON.stringify({ t: 'welcome', id: 'aaaa0001', peers: [{ id: 'bbbb0002', name: 'B' }] }) })

  const par = 'bbbb0002'
  const track = (nivel = 0) => {
    const ouvintes = {}
    const t = { kind: 'audio', muted: false, readyState: 'live', nivel, stops: 0, stop() { t.stops++ },
                addEventListener: (tipo, f) => { (ouvintes[tipo] ??= []).push(f) },
                encerrar: () => { for (const f of ouvintes.ended ?? []) f() },
                ouvintesFim: () => (ouvintes.ended ?? []).length }
    return t
  }
  const receber = (t, streamId) => {
    state.__track = t
    run(`receberTrack('${par}', __track, { id: '${streamId}' })`)
  }
  const doStream = t => audios.findLast(el => el.track === t)   // o <audio> mais novo da track
  const anunciar = estado => run(`receberSinal('${par}', ${JSON.stringify({ de: 'x', estado })})`)
  const tipos = () => run(`[...pessoas.get('${par}').audios].map(([sid, a]) => sid + ':' + a.tipo).join(',')`)
  const tamanho = () => run(`pessoas.get('${par}').audios.size`)
  const ligado = el => !!el.srcObject && !el.paused
  const vivos = () => audios.filter(ligado)
  const quadro = () => { const fs = [...frames.values()]; frames = new Map(); for (const f of fs) f() }
  const pendentes = () => [...frames.keys()]
  const rodarQuadro = n => { const f = frames.get(n); frames.delete(n); f() }
  const falando = () => $('t-' + par).classList.classes.has('falando')
  const abertos = () => contextos.filter(c => !c.closed)
  const recriar = () => run(`removerPessoa('${par}'); novaPessoa('${par}', 'B')`)
  // Onde a track está associada, tocando ou retirada.
  const associacoes = t => {
    state.__alvo = t
    return JSON.parse(run(`JSON.stringify((p => [...[...p.audios].filter(([, a]) => a.track === __alvo).map(([sid]) => sid),
                       ...[...p.retirados].filter(([, x]) => x === __alvo).map(([sid]) => 'retirado:' + sid)])(pessoas.get('${par}')))`))
  }
  const vivosDe = t => audios.filter(el => el.track === t && ligado(el)).length
  return { run, receber, anunciar, tipos, tamanho, vivos, ligado, doStream, audios, track,
           quadro, pendentes, rodarQuadro, frames: () => frames.size, falando, contextos, abertos, recriar, associacoes, vivosDe }
}

test('parar a tela sem ended desliga o áudio dela e mantém a voz', async () => {
  const f = fixture()
  await f.anunciar({ compartilhando: true, idsTelas: ['tela-1'] })
  const voz = f.track(), tela = f.track()
  f.receber(voz, 'voz')
  f.receber(tela, 'tela-1')
  assert.equal(f.tipos(), 'voz:voz,tela-1:tela')
  const elTela = f.doStream(tela), elVoz = f.doStream(voz)

  await f.anunciar({ compartilhando: false, idsTelas: [] })
  assert.equal(f.tipos(), 'voz:voz')
  assert.equal(elTela.paused, true)
  assert.equal(elTela.srcObject, null)
  assert.equal(f.ligado(elVoz), true)
  assert.deepEqual(f.vivos(), [elVoz])
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
    assert.equal(f.vivos().length, 1)
  }
  assert.equal(f.tipos(), 'voz:voz')
  assert.equal(f.audios.length, 21)
  assert.equal(f.abertos().length, 1)
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

test('track nova no mesmo stream desliga a velha; surdo zera todo áudio ligado', async () => {
  const f = fixture()
  const velha = f.track()
  f.receber(velha, 'voz')
  const elVelho = f.doStream(velha)
  const nova = f.track()
  f.receber(nova, 'voz')
  assert.equal(f.tamanho(), 1)
  assert.equal(elVelho.srcObject, null)
  assert.equal(elVelho.paused, true)
  assert.deepEqual(f.vivos(), [f.doStream(nova)])
  f.run("surdo = true; aplicarVolumes('bbbb0002')")
  assert.deepEqual(f.vivos().filter(el => el.volume !== 0), [])
  // O 'ended' tardio da velha não apaga a nova.
  velha.encerrar()
  assert.equal(f.tipos(), 'voz:voz')
  assert.equal(f.ligado(f.doStream(nova)), true)
})

test('ended desliga o áudio', () => {
  const f = fixture()
  const t = f.track()
  f.receber(t, 'voz')
  t.encerrar()
  assert.equal(f.tamanho(), 0)
  assert.equal(f.doStream(t).paused, true)
  assert.equal(f.doStream(t).srcObject, null)
  assert.equal(f.abertos().length, 0)
})

test('remover a pessoa desliga todo áudio dela', async () => {
  const f = fixture()
  await f.anunciar({ compartilhando: true, idsTelas: ['tela-1'] })
  f.receber(f.track(), 'voz')
  f.receber(f.track(), 'tela-1')
  f.recriar()
  assert.equal(f.tamanho(), 0)
  assert.equal(f.audios.length, 2)
  for (const el of f.audios) {
    assert.equal(el.paused, true)
    assert.equal(el.srcObject, null)
  }
  assert.equal(f.abertos().length, 0)
})

test('pessoa recriada sem a tela no anúncio esquece o stream que foi tela', async () => {
  const f = fixture()
  await f.anunciar({ compartilhando: true, idsTelas: ['S'] })
  await f.anunciar({ compartilhando: false, idsTelas: [] })
  f.recriar()
  const voz = f.track()
  f.receber(voz, 'S')                                // geração nova: S agora é só um stream
  assert.equal(f.tipos(), 'S:voz')
  assert.equal(f.ligado(f.doStream(voz)), true)
})

test('medidor da pessoa antiga para sozinho quando outra assume o id', () => {
  const f = fixture()
  f.receber(f.track(0), 'voz')
  const [antigo] = f.pendentes()
  const ctxAntigo = f.contextos[0]
  // Troca a pessoa sem passar por removerPessoa: ninguém chama o cancelador.
  f.run("pessoas.delete('bbbb0002'); novaPessoa('bbbb0002', 'B')")
  f.receber(f.track(1), 'voz')
  assert.equal(f.falando(), true)
  f.rodarQuadro(antigo)
  assert.equal(ctxAntigo.closed, true)
  assert.equal(ctxAntigo.fonte.desconectada, true)
  assert.equal(f.frames(), 1)
  assert.equal(f.abertos().length, 1)
  assert.equal(f.falando(), true)                    // o antigo não apaga o anel do novo
})

test('áudio de tela que chega depois de sair do anúncio é descartado; readmitida volta', async () => {
  const f = fixture()
  await f.anunciar({ compartilhando: true, idsTelas: ['S'] })
  f.receber(f.track(), 'voz')
  await f.anunciar({ compartilhando: false, idsTelas: [] })
  const tardia = f.track()
  f.receber(tardia, 'S')                             // primeira chegada de S, já fora do anúncio
  assert.equal(f.tipos(), 'voz:voz')
  assert.equal(f.doStream(tardia), undefined)        // nem chega a tocar

  await f.anunciar({ compartilhando: true, idsTelas: ['S'] })
  const nova = f.track()
  f.receber(nova, 'S')
  assert.equal(f.tipos(), 'voz:voz,S:tela')
  tardia.encerrar()                                  // ended da velha não apaga a readmitida
  assert.equal(f.tipos(), 'voz:voz,S:tela')
  assert.equal(f.vivos().length, 2)
})

test('anúncio antigo (streamId, idTela2): tela parada não volta como voz', async () => {
  const f = fixture()
  await f.anunciar({ compartilhando: true, streamId: 's1', idTela2: 's2' })
  f.receber(f.track(), 'voz')
  f.receber(f.track(), 's1')
  f.receber(f.track(), 's2')
  assert.equal(f.tipos(), 'voz:voz,s1:tela,s2:tela')
  await f.anunciar({ compartilhando: true, streamId: 's2' })   // a segunda vira a primeira
  assert.equal(f.tipos(), 'voz:voz,s2:tela')
  f.receber(f.track(), 's1')
  assert.equal(f.tipos(), 'voz:voz,s2:tela')
  assert.equal(f.vivos().length, 2)
})

test('pessoa recriada conhece as telas do anúncio atual', async () => {
  const f = fixture()
  await f.anunciar({ compartilhando: true, idsTelas: ['S'] })
  f.recriar()
  f.receber(f.track(), 'voz')
  await f.anunciar({ compartilhando: false, idsTelas: [] })
  f.receber(f.track(), 'S')
  assert.equal(f.tipos(), 'voz:voz')
  assert.equal(f.vivos().length, 1)
})

test('o anel segue a voz mesmo quando a tela chega antes', async () => {
  const f = fixture()
  const tela = f.track(1), voz = f.track(0)          // tela alta, voz calada
  f.receber(tela, 'S')                               // sem anúncio ainda: parece voz
  f.receber(voz, 'voz')
  await f.anunciar({ compartilhando: true, idsTelas: ['S'] })
  assert.equal(f.abertos().length, 1)
  assert.equal(f.contextos[0].closed, true)
  assert.equal(f.contextos[0].fonte.desconectada, true)
  assert.equal(f.abertos()[0].fonte.stream.t[0], voz)
  f.quadro()
  assert.equal(f.falando(), false)
  voz.nivel = 1
  f.quadro()
  assert.equal(f.falando(), true)
  assert.equal(f.frames(), 1)

  await f.anunciar({ compartilhando: false, idsTelas: [] })
  assert.equal(f.abertos().length, 1)
  assert.equal(f.frames(), 1)
})

test('trocar a voz ou recriar a pessoa não deixa medidor velho', async () => {
  const f = fixture()
  f.receber(f.track(1), 'voz')
  f.quadro()
  assert.equal(f.falando(), true)
  f.receber(f.track(0), 'voz')                       // substitui no mesmo stream
  assert.equal(f.abertos().length, 1)
  assert.equal(f.frames(), 1)
  f.quadro()
  assert.equal(f.falando(), false)

  f.recriar()                                        // mesmo id, antes do próximo quadro
  assert.equal(f.abertos().length, 0)
  assert.equal(f.frames(), 0)
  f.receber(f.track(1), 'voz')
  f.quadro()
  assert.equal(f.abertos().length, 1)
  assert.equal(f.frames(), 1)
  assert.equal(f.falando(), true)
})

// Retirada e readmissão do mesmo stream com a mesma track: o emissor atual não
// faz isso (cada tela é um getDisplayMedia novo), mas a ordem dos eventos não
// pode decidir se o som volta.
async function retirada(f) {
  await f.anunciar({ compartilhando: true, idsTelas: ['S'] })
  const voz = f.track(), tela = f.track()
  f.receber(voz, 'voz')
  f.receber(tela, 'S')
  await f.anunciar({ compartilhando: false, idsTelas: [] })
  assert.ok(!f.tipos().split(',').includes('S:tela'))
  assert.equal(f.ligado(f.doStream(tela)), false)
  return { voz, tela }
}

const readmitida = (f, { voz, tela }) => {
  assert.equal(f.tipos(), 'voz:voz,S:tela')
  assert.equal(f.ligado(f.doStream(tela)), true)
  assert.equal(f.ligado(f.doStream(voz)), true)
  assert.equal(f.vivos().length, 2)
  assert.equal(tela.stops + voz.stops, 0)
}

test('readmissão: anúncio e depois a mesma track', async () => {
  const f = fixture()
  const t = await retirada(f)
  await f.anunciar({ compartilhando: true, idsTelas: ['S'] })
  readmitida(f, t)
  f.receber(t.tela, 'S')
  readmitida(f, t)
})

test('readmissão: a mesma track e depois o anúncio', async () => {
  const f = fixture()
  const t = await retirada(f)
  f.receber(t.tela, 'S')
  assert.equal(f.tipos(), 'voz:voz')
  assert.equal(f.vivos().length, 1)
  await f.anunciar({ compartilhando: true, idsTelas: ['S'] })
  readmitida(f, t)
})

test('áudio retirado some com ended e com a recriação da pessoa', async () => {
  const f = fixture()
  const t = await retirada(f)
  t.tela.encerrar()
  await f.anunciar({ compartilhando: true, idsTelas: ['S'] })
  assert.equal(f.tipos(), 'voz:voz')

  const g = fixture()
  const u = await retirada(g)
  g.recriar()
  await g.anunciar({ compartilhando: true, idsTelas: ['S'] })
  assert.equal(g.tamanho(), 0)
  assert.equal(g.vivos().length, 0)
  assert.equal(u.tela.stops + u.voz.stops, 0)
})

// Uma associação vigente por track. A mesma track retirada de S e entregue
// com outro stream passa a valer só no novo: readmitir S não a toca de novo.
for (const destino of ['S2', 'mic2'])
  for (const ordem of ['anúncio antes', 'evento antes']) {
    test(`track de S retirada que volta como ${destino} (${ordem}) não reaparece em S`, async () => {
      const f = fixture()
      const outra = f.track()                        // outro microfone, que não pode mudar
      f.receber(outra, 'outra')
      const ids = destino === 'S2' ? ['S2'] : []
      let t
      if (ordem === 'anúncio antes') {
        t = await retirada(f)
        f.receber(t.tela, destino)
        await f.anunciar({ compartilhando: ids.length > 0, idsTelas: ids })
      } else {
        await f.anunciar({ compartilhando: true, idsTelas: ['S'] })
        t = { voz: f.track(), tela: f.track() }
        f.receber(t.voz, 'voz')
        f.receber(t.tela, 'S')
        f.receber(t.tela, destino)                   // antes do anúncio que tira S
        await f.anunciar({ compartilhando: ids.length > 0, idsTelas: ids })
      }
      await f.anunciar({ compartilhando: true, idsTelas: ['S', ...ids] })   // S readmitida
      const tipo = destino === 'S2' ? 'tela' : 'voz'
      assert.deepEqual(f.associacoes(t.tela), [destino])
      assert.equal(f.vivosDe(t.tela), 1)
      assert.equal(f.tipos().split(',').sort().join(), ['outra:voz', 'voz:voz', `${destino}:${tipo}`].sort().join())
      assert.equal(f.vivosDe(outra), 1)
      assert.equal(f.vivosDe(t.voz), 1)
      assert.equal(t.tela.stops + t.voz.stops + outra.stops, 0)
    })
  }

test('a mesma track em 100 streams de tela fica com uma associação só', async () => {
  const f = fixture()
  const voz = f.track(), t = f.track()
  f.receber(voz, 'voz')
  const ids = []
  for (let i = 0; i < 100; i++) {
    ids.push(`S${i}`)
    await f.anunciar({ compartilhando: true, idsTelas: [`S${i}`] })
    f.receber(t, `S${i}`)
    await f.anunciar({ compartilhando: false, idsTelas: [] })
    assert.ok(f.associacoes(t).length <= 1)
  }
  assert.deepEqual(f.associacoes(t), ['retirado:S99'])
  await f.anunciar({ compartilhando: true, idsTelas: ids })   // todas de volta
  assert.deepEqual(f.associacoes(t), ['S99'])
  assert.equal(f.vivosDe(t), 1)
  assert.equal(f.vivosDe(voz), 1)
  assert.equal(t.stops, 0)
})

test('100 entregas da mesma track registram um listener de ended', () => {
  const f = fixture()
  const t = f.track()
  for (let i = 0; i < 100; i++) f.receber(t, 'voz')
  assert.equal(t.ouvintesFim(), 1)
  assert.equal(f.tipos(), 'voz:voz')
  assert.equal(f.vivosDe(t), 1)
  t.encerrar()
  assert.equal(f.tamanho(), 0)
  assert.equal(f.vivosDe(t), 0)
})
