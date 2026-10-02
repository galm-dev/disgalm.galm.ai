import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { lerPublico } from './cliente.js'
import { carregarWorker } from './worker.js'

// O adaptador do navegador contra o gateway de verdade (worker/src/sfu.js),
// com a API do SFU simulada. Cada cliente roda num contexto próprio, como uma
// aba; os pedidos passam por JSON, como pela rede.
const { pasta } = await carregarWorker()
const { operar, novoEstado, catalogo } = await import(join(pasta, 'sfu.mjs'))

const estado = c => JSON.parse(JSON.stringify(c.t.estado()))
const pelaRede = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x))
const mids = sdp => [...String(sdp).matchAll(/^a=mid:(\d+) (audio|video)$/gm)].map(m => [m[1], m[2]])

// ---------- API do SFU simulada ----------
// Responde como https://developers.cloudflare.com/realtime/sfu/api/: publicar
// devolve answer; assinar devolve offer com requiresImmediateRenegotiation e os
// mids da sessão que assina; fechar devolve answer quando houve oferta.
function criarCloudflare() {
  const cf = { chamadas: [], sessoes: new Map(), seq: 0, emVoo: new Map(), maxEmVoo: 0, vazias: new Set() }
  cf.chamar = async (metodo, caminho, corpo) => {
    cf.chamadas.push({ metodo, caminho, corpo })
    // Criar sessão não é mutação de uma sessão existente.
    const sid = caminho === '/sessions/new' ? `nova-${cf.chamadas.length}` : caminho.split('/')[2]
    // A mesma sessão nunca recebe duas mutações ao mesmo tempo.
    const n = (cf.emVoo.get(sid) ?? 0) + 1
    cf.emVoo.set(sid, n)
    cf.maxEmVoo = Math.max(cf.maxEmVoo, n)
    await new Promise(r => setImmediate(r))
    cf.emVoo.set(sid, n - 1)
    const ok = json => ({ status: 200, ok: true, json })
    if (caminho === '/sessions/new') {
      const id = `sessao${String(++cf.seq).padStart(26, '0')}`
      cf.sessoes.set(id, { proximoMid: 50, pubs: new Map() })
      return { status: 201, ok: true, json: { sessionId: id } }
    }
    const s = cf.sessoes.get(sid)
    if (caminho.endsWith('/tracks/new') && corpo.sessionDescription) {
      for (const t of corpo.tracks) s.pubs.set(t.trackName, t.mid)
      return ok({ requiresImmediateRenegotiation: false, sessionDescription: { type: 'answer', sdp: 'a=rtpmap:111 opus/48000/2' },
        tracks: corpo.tracks.map(t => ({ trackName: t.trackName, mid: t.mid })) })
    }
    if (caminho.endsWith('/tracks/new')) {
      const tracks = corpo.tracks.map(t => {
        if (!cf.sessoes.get(t.sessionId)?.pubs.has(t.trackName)) return { ...t, errorCode: 'not_found_track_error' }
        if (cf.vazias.delete(t.trackName)) return { ...t, errorCode: 'empty_track_error' }
        return { ...t, mid: String(s.proximoMid++) }
      })
      const tipo = nome => /mic|audio/.test(nome) ? 'audio' : 'video'
      const novos = tracks.filter(t => t.mid).map(t => `a=mid:${t.mid} ${tipo(t.trackName)}`).join('\n')
      return ok({ requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: `a=rtpmap:111 opus/48000/2\n${novos}` }, tracks })
    }
    if (caminho.endsWith('/renegotiate')) return ok({})
    if (caminho.endsWith('/tracks/close')) {
      for (const [nome, mid] of s.pubs) if (corpo.tracks.some(t => t.mid === mid)) s.pubs.delete(nome)
      return ok({ requiresImmediateRenegotiation: false, tracks: corpo.tracks.map(t => ({ mid: t.mid })),
        ...(corpo.sessionDescription && { sessionDescription: { type: 'answer', sdp: 'v=0' } }) })
    }
    return { status: 404, ok: false, json: { errorCode: 'not_found' } }
  }
  return cf
}

// ---------- sala: o estado que o DO guardaria, e a difusão do catálogo ----------
function criarSala() {
  const cf = criarCloudflare()
  const sala = { cf, clientes: new Map(), est: novoEstado('sfu', 'chamada-1'), eventos: [] }
  sala.contexto = id => ({
    autor: { id, exp: Math.floor(Date.now() / 1000) + 600 },
    presentes: new Set(sala.clientes.keys()),
    carregar: async () => structuredClone(sala.est),
    salvar: async e => { sala.est = structuredClone(e) },
    api: cf.chamar,
    registrar: (evento, campos) => sala.eventos.push({ evento, ...campos }),
    difundir: e => { for (const c of sala.clientes.values()) c.t.atualizarCatalogo(pelaRede({ versao: e.versao, fontes: catalogo(e) })) },
    agora: () => Date.now(),
    orcamento: { autorizar: async p => ({ ok: true, refs: (p.reservas ?? []).map(r => r.ref) }), liberar: async () => 0 },
  })
  sala.ocioso = async () => {
    for (let i = 0; i < 5; i++) await Promise.all([...sala.clientes.values()].map(c => c.t.ocioso()))
  }
  return sala
}

// ---------- navegador simulado ----------
let seqTrack = 0
const track = (kind, nome = kind) => ({ id: `${nome}-${++seqTrack}`, kind, eventos: [],
  dispatchEvent(e) { this.eventos.push(e.type) } })

class Transceiver {
  constructor(track, direction, streams) {
    Object.assign(this, { mid: null, direction, streams, stopped: false })
    this.sender = { track, trocas: 0, params: { encodings: [{}] },
      async replaceTrack(t) { this.track = t; this.trocas++ },
      getParameters() { return structuredClone(this.params) }, async setParameters(p) { this.params = p } }
    this.receiver = { track: direction === 'recvonly' ? track : null }
  }
  stop() { this.stopped = true; this.direction = 'stopped' }
}

function criarPC(registro) {
  return class PC {
    constructor(cfg) {
      Object.assign(this, { cfg, trs: [], proximoMid: 0, signalingState: 'stable', iceGatheringState: 'complete',
        connectionState: 'new', iceConnectionState: 'new', localDescription: null, remoteDescription: null })
      registro.push(this)
    }
    addTransceiver(t, { direction, streams }) { const tr = new Transceiver(t, direction, streams); this.trs.push(tr); return tr }
    getTransceivers() { return this.trs }
    async createOffer() { return { type: 'offer', sdp: 'a=rtpmap:111 opus/48000/2' } }
    async createAnswer() { return { type: 'answer', sdp: 'a=rtpmap:111 opus/48000/2' } }
    async setLocalDescription(d) {
      if (d.type === 'rollback') { this.signalingState = 'stable'; return }
      if (d.type === 'offer') {
        for (const t of this.trs) if (t.mid === null && !t.stopped) t.mid = String(this.proximoMid++)
        this.signalingState = 'have-local-offer'
      } else this.signalingState = 'stable'
      this.localDescription = { type: d.type, sdp: d.sdp }
    }
    async setRemoteDescription(d) {
      this.remoteDescription = d
      if (d.type === 'answer') { this.signalingState = 'stable'; this.connectionState = 'connected'; return }
      this.signalingState = 'have-remote-offer'
      for (const [mid, kind] of mids(d.sdp)) {
        if (this.trs.some(t => t.mid === mid)) continue
        const tr = new Transceiver(track(kind, `recebida-${mid}`), 'recvonly', [])
        tr.mid = mid
        this.trs.push(tr)
        this.ontrack?.({ track: tr.receiver.track, transceiver: tr, streams: [{ id: 'id-que-o-sfu-inventou' }] })
      }
    }
    async getStats() {
      const st = new Map()
      for (const t of this.trs) if (t.mid !== null && !t.stopped)
        st.set(t.mid, t.direction === 'sendonly' ? { type: 'outbound-rtp', mid: t.mid, bytesSent: 1000 * (+t.mid + 1) }
          : { type: 'inbound-rtp', mid: t.mid, bytesReceived: 500 })
      return st
    }
    close() { this.connectionState = 'closed' }
  }
}

function cliente(sala, id, { relay = false } = {}) {
  const pcs = [], timers = []
  const ctx = { RTCPeerConnection: criarPC(pcs), setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, Event: class { constructor(type) { this.type = type } }, structuredClone }
  for (const nome of ['transporte.js', 'fontes.js', 'transporte-mesh.js', 'transporte-cloudflare.js'])
    runInNewContext(lerPublico(nome), ctx)
  const fontes = runInNewContext('disgalmFontes.criarRegistro()', ctx)
  fontes.definirDono(id)
  const c = { id, pcs, timers, fontes, recebidas: [], saidas: [], eventos: [], pedidos: [], logs: [], pessoas: new Set() }
  const app = {
    meuId: () => id, nome: () => null, ice: () => [{ urls: 'stun:stun.cloudflare.com:3478' }], soRelay: () => relay,
    sinalizar() {}, sinalizacaoAberta: () => true, fontes,
    log: (...a) => c.logs.push(a.join(' ')), telemetria: (evento, campos) => c.eventos.push({ evento, ...campos }),
    pessoaConectando: pid => c.pessoas.add(pid), pessoaDesconectando: (pid, conexao) => c.saidas.push([pid, conexao.pc.connectionState]),
    pessoaDesconectada: pid => c.pessoas.delete(pid), pessoaReconectada() {},
    trackRecebida: (dono, t, stream) => c.recebidas.push({ dono, kind: t.kind, stream: stream.id, track: t }),
    conexaoMudou() {}, amostrar: async () => {}, relayUsado() {},
  }
  const api = async (op, corpo) => {
    c.pedidos.push({ op, ...pelaRede(corpo) })
    const r = await operar(sala.contexto(id), op, pelaRede(corpo))
    if (r.status >= 400) throw Object.assign(new Error(r.corpo.erro), { status: r.status })
    return pelaRede(r.corpo)
  }
  c.t = ctx.criarTransporteCloudflare(app, { api })
  c.pc = () => pcs.at(-1)
  // Captura no formato da sala: mic, tela com som, câmera.
  c.mic = () => fontes.abrir('mic', track('audio', 'mic'), { id: `voz-${id}` })
  c.tela = () => {
    const stream = { id: `tela-${id}-${seqTrack}` }, tela = fontes.novaTela()
    return [fontes.abrir('tela-video', track('video', 'tela'), stream, { tela }), fontes.abrir('tela-audio', track('audio', 'som'), stream, { tela })]
  }
  c.camera = () => fontes.abrir('camera', track('video', 'cam'), { id: `cam-${id}-${seqTrack}` })
  // Entra como o welcome manda: quem já está, e o catálogo.
  c.entrar = () => {
    const presentes = [...sala.clientes.keys()].map(p => ({ id: p, nome: p }))
    for (const outro of sala.clientes.values()) outro.t.pessoaEntrou(id, id)
    sala.clientes.set(id, c)
    c.t.entrar(presentes)
    c.t.atualizarCatalogo(pelaRede({ versao: sala.est.versao, fontes: catalogo(sala.est) }))
  }
  return c
}

const publicacoes = cf => cf.chamadas.filter(c => c.caminho.endsWith('/tracks/new') && c.corpo.sessionDescription)

test('o adaptador cumpre o contrato e exige a api do gateway', () => {
  const sala = criarSala()
  cliente(sala, 'aaaa0001').entrar()
  const { t } = sala.clientes.get('aaaa0001')
  assert.equal(t.nome, 'sfu')
  assert.equal(t.pares.size, 0)
  const ctx = {}
  for (const nome of ['transporte.js', 'fontes.js', 'transporte-mesh.js', 'transporte-cloudflare.js']) runInNewContext(lerPublico(nome), ctx)
  assert.throws(() => runInNewContext('criarTransporteCloudflare({})', ctx), /sala sem os ganchos/)
})

test('2 → 4 clientes: cada fonte é publicada uma vez e todos recebem, com o stream de quem publicou', async () => {
  const sala = criarSala()
  const a = cliente(sala, 'aaaa0001')
  const mic = a.mic()
  const [video, som] = a.tela()
  a.entrar()
  await sala.ocioso()
  // Uma chamada de publicação para as três fontes, oferta com Opus estéreo.
  assert.equal(publicacoes(sala.cf).length, 1)
  assert.deepEqual(publicacoes(sala.cf)[0].corpo.tracks.map(t => t.trackName), ['aaaa0001_mic-1', 'aaaa0001_tela-2_video', 'aaaa0001_tela-2_audio'])
  assert.match(publicacoes(sala.cf)[0].corpo.sessionDescription.sdp, /stereo=1;sprop-stereo=1;maxaveragebitrate=128000/)
  assert.match(a.pc().remoteDescription.sdp, /stereo=1/)
  assert.deepEqual(a.pc().trs.map(t => [t.direction, t.mid]), [['sendonly', '0'], ['sendonly', '1'], ['sendonly', '2']])

  for (const id of ['bbbb0002', 'cccc0003', 'dddd0004']) { cliente(sala, id).entrar(); await sala.ocioso() }
  // Mais gente não publica de novo: a subida de A não cresce com a sala.
  assert.equal(publicacoes(sala.cf).length, 1)
  assert.equal(a.pcs.length, 1)
  for (const id of ['bbbb0002', 'cccc0003', 'dddd0004']) {
    const c = sala.clientes.get(id)
    assert.equal(c.pcs.length, 1, id)
    assert.deepEqual(c.recebidas.map(r => [r.dono, r.kind, r.stream]).sort(), [
      ['aaaa0001', 'audio', mic.stream.id], ['aaaa0001', 'audio', som.stream.id], ['aaaa0001', 'video', video.stream.id]].sort(), id)
    assert.deepEqual([...c.pessoas].sort(), [...sala.clientes.keys()].filter(p => p !== id).sort())
    // O SFU oferece e o cliente responde por /renegotiate, com estéreo na resposta.
    const reneg = c.pedidos.filter(p => p.op === 'renegociar')
    assert.equal(reneg.length, 1)
    assert.match(reneg[0].sdp.sdp, /stereo=1/)
  }
  // Ninguém assina a si mesmo nem pede locator do SFU.
  for (const c of sala.clientes.values())
    for (const p of c.pedidos) {
      assert.ok(!p.alvos?.some(x => x.dono === c.id))
      if (p.op !== 'sessao') assert.equal(p.sessao, estado(c).sessao)
    }
  assert.equal(sala.cf.maxEmVoo, 1)
})

test('publicar, parar e substituir 20 vezes não deixa publicação, assinatura nem track sobrando', async () => {
  const sala = criarSala()
  const a = cliente(sala, 'aaaa0001'), b = cliente(sala, 'bbbb0002')
  a.mic()
  a.entrar(); b.entrar()
  await sala.ocioso()
  for (let i = 0; i < 20; i++) {
    const cam = a.camera()
    a.t.publicar(cam)
    await sala.ocioso()
    const nova = track('video', 'cam-nova')
    await a.t.substituir(cam, nova)
    a.fontes.substituir(cam, nova)
    a.t.parar(cam)
    a.fontes.fechar(cam)
    await sala.ocioso()
  }
  assert.deepEqual(estado(a).publicadas, ['mic-1'])
  assert.deepEqual(estado(b).assinadas.map(s => s.fonte), ['mic-1'])
  assert.deepEqual(catalogo(sala.est).map(f => f.fonte), ['mic-1'])
  // Uma conexão só, e nenhum transceiver de câmera vivo dos dois lados.
  assert.equal(a.pcs.length, 1)
  assert.equal(b.pcs.length, 1)
  assert.equal(a.pc().trs.filter(t => !t.stopped).length, 1)
  assert.equal(b.pc().trs.filter(t => !t.stopped).length, 1)
  // Cada câmera recebida foi encerrada para a sala (sem quadro fantasma).
  const cams = b.recebidas.filter(r => r.kind === 'video')
  assert.equal(cams.length, 20)
  assert.ok(cams.every(r => r.track.eventos.includes('ended')))
  // substituir não renegocia.
  assert.equal(a.pedidos.filter(p => p.op === 'publicar').length, 21)
  assert.equal(a.pc().trs.filter(t => t.sender.trocas === 1).length, 20)
  // Toda câmera publicada foi fechada no SFU dos dois lados.
  assert.equal(sala.cf.chamadas.filter(c => c.caminho.endsWith('/tracks/close')).length, 40)
  assert.deepEqual(Object.values(sala.est.sessoes).map(s => Object.keys(s.mids).length).sort(), [1, 1])
  assert.equal(sala.cf.maxEmVoo, 1)
})

test('câmera e tela ao mesmo tempo passam pela fila, sem mutação simultânea na sessão', async () => {
  const sala = criarSala()
  const a = cliente(sala, 'aaaa0001'), b = cliente(sala, 'bbbb0002')
  a.mic(); a.entrar(); b.entrar()
  const cam = a.camera(), [video, som] = a.tela()
  a.t.publicar(cam); a.t.publicar(video); a.t.publicar(som)
  // B liga a câmera no mesmo instante.
  const camB = b.camera()
  b.t.publicar(camB)
  await sala.ocioso()
  assert.equal(sala.cf.maxEmVoo, 1)
  assert.deepEqual(estado(a).publicadas.sort(), ['camera-2', 'mic-1', 'tela-3/audio', 'tela-3/video'])
  assert.deepEqual(estado(b).assinadas.map(s => s.fonte).sort(), ['camera-2', 'mic-1', 'tela-3/audio', 'tela-3/video'])
  assert.deepEqual(estado(a).assinadas.map(s => s.fonte), ['camera-1'])
  assert.equal(new Set(estado(b).assinadas.map(s => s.mid)).size, 4)
})

test('entrada tardia recebe o que já estava publicado; saída limpa as assinaturas', async () => {
  const sala = criarSala()
  const a = cliente(sala, 'aaaa0001'), b = cliente(sala, 'bbbb0002')
  a.mic(); a.tela()
  a.entrar(); b.entrar()
  await sala.ocioso()
  const d = cliente(sala, 'dddd0004')
  d.entrar()
  await sala.ocioso()
  assert.equal(d.recebidas.length, 3)
  assert.equal(publicacoes(sala.cf).length, 1)
  // A sai de vez: quem fica perde a pessoa e as assinaturas dela.
  sala.clientes.delete('aaaa0001')
  for (const c of sala.clientes.values()) c.t.pessoaSaiu('aaaa0001', { volta: false })
  const est = structuredClone(sala.est)
  for (const [k, p] of Object.entries(est.pubs)) if (p.dono === 'aaaa0001') delete est.pubs[k]
  est.versao++
  sala.est = est
  for (const c of sala.clientes.values()) c.t.atualizarCatalogo(pelaRede({ versao: est.versao, fontes: catalogo(est) }))
  await sala.ocioso()
  for (const c of [b, d]) {
    assert.deepEqual(estado(c).assinadas, [])
    assert.ok(c.recebidas.every(r => r.track.eventos.includes('ended')))
    assert.deepEqual(c.saidas.map(s => s[0]), ['aaaa0001'])
  }
})

test('queda com volta não desmonta nada; catálogo antigo é ignorado', async () => {
  const sala = criarSala()
  const a = cliente(sala, 'aaaa0001'), b = cliente(sala, 'bbbb0002')
  a.mic(); a.entrar(); b.entrar()
  await sala.ocioso()
  assert.equal(b.t.pessoaSaiu('aaaa0001', { volta: true }), false)
  assert.equal(b.t.pessoaVoltou('aaaa0001', 'aaaa0001'), false)
  b.t.atualizarCatalogo({ versao: 1, fontes: [] })
  await sala.ocioso()
  assert.deepEqual(estado(b).assinadas.map(s => s.fonte), ['mic-1'])
})

test('assinatura de fonte ainda sem pacotes tenta de novo poucas vezes', async () => {
  const sala = criarSala()
  const a = cliente(sala, 'aaaa0001'), b = cliente(sala, 'bbbb0002')
  sala.cf.vazias.add('aaaa0001_mic-1')
  a.mic(); a.entrar(); b.entrar()
  await sala.ocioso()
  assert.deepEqual(estado(b).assinadas, [])
  const falha = b.eventos.find(e => e.evento === 'sfu_assinou')
  assert.deepEqual([falha.ok, falha.erro], [false, 'empty_track_error'])
  assert.equal(b.timers.length, 1)
  b.timers.shift().fn()
  await sala.ocioso()
  assert.deepEqual(estado(b).assinadas.map(s => s.fonte), ['mic-1'])
})

test('falha da API ao publicar desfaz a oferta e a fila segue', async () => {
  const sala = criarSala()
  const a = cliente(sala, 'aaaa0001')
  a.entrar()
  await sala.ocioso()
  const chamar = sala.cf.chamar
  sala.cf.chamar = async (m, caminho, corpo) => caminho.endsWith('/tracks/new')
    ? { status: 406, ok: false, json: { errorCode: 'invalid_session_description' } } : chamar(m, caminho, corpo)
  const cam = a.camera()
  a.t.publicar(cam)
  await sala.ocioso()
  assert.equal(a.pc().signalingState, 'stable')
  assert.ok(a.pc().trs.every(t => t.stopped))
  assert.ok(a.eventos.some(e => e.evento === 'sfu_erro' && e.op === 'publicar' && e.status === 502))
  sala.cf.chamar = chamar
  a.t.publicar(cam)
  await sala.ocioso()
  assert.deepEqual(estado(a).publicadas, ['camera-1'])
})

test('relay forçado vai para a conexão com o SFU; uso sai em bytes por fonte, sem nome', async () => {
  const sala = criarSala()
  const a = cliente(sala, 'aaaa0001', { relay: true }), b = cliente(sala, 'bbbb0002')
  a.mic(); a.tela()
  a.entrar(); b.entrar()
  await sala.ocioso()
  assert.equal(a.pc().cfg.iceTransportPolicy, 'relay')
  assert.equal(b.pc().cfg.iceTransportPolicy, 'all')
  assert.equal(a.pc().cfg.bundlePolicy, 'max-bundle')
  // Uma cópia só, por mais gente que assista.
  assert.deepEqual(JSON.parse(JSON.stringify(a.t.planejarEnvio({ kbpsTela: 4000, orcamentoKbps: 3000, telas: 2 }))),
    { copias: 1, kbpsPorCopia: 3000, kbpsPorTela: 1500 })
  // Amostra e relata.
  a.t.parar(a.fontes.porId('tela-2/video'))
  await sala.ocioso()
  a.t.relatarUso(); b.t.relatarUso()
  const envio = a.eventos.filter(e => e.evento === 'sfu_bytes')
  assert.deepEqual(envio.map(e => [e.fonte, e.direcao, e.bytes]),
    [['tela-2/video', 'envio', 2000], ['mic-1', 'envio', 1000], ['tela-2/audio', 'envio', 3000]])
  const recebe = b.eventos.filter(e => e.evento === 'sfu_bytes')
  assert.ok(recebe.length === 0 || recebe.every(e => e.direcao === 'recebe' && e.dono === 'aaaa0001'))
  for (const e of [...a.eventos, ...b.eventos]) assert.ok(!('nome' in e) && !JSON.stringify(e).includes('segredo'))
})

test('sair fecha a conexão e avisa a saída de cada pessoa', async () => {
  const sala = criarSala()
  const a = cliente(sala, 'aaaa0001'), b = cliente(sala, 'bbbb0002')
  a.mic(); a.entrar(); b.entrar()
  await sala.ocioso()
  b.t.sair()
  assert.equal(b.pc().connectionState, 'closed')
  assert.deepEqual(b.saidas.map(s => s[0]), ['aaaa0001'])
  assert.deepEqual(estado(b), { sessao: null, versao: 0, publicadas: [], assinadas: [] })
})
