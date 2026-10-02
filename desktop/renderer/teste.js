// Prova do caminho inteiro, sem servidor: getDisplayMedia (vídeo) + track do
// loopback nativo → RTCPeerConnection A → B. Grava a track local e a recebida
// em WAV e sai. A análise de frequência fica fora do app (desktop/teste/).
import { abrirAudioSemDiscord } from '/_desktop/audio-nativo.js'

const q = new URLSearchParams(location.search)
const SEGUNDOS = Number(q.get('s') || 10)
const AQUECER = Number(q.get('aquecer') || 2)
const el = id => document.getElementById(id)
const log = (...a) => { el('log').textContent += a.join(' ') + '\n'; console.log(...a) }
const d = window.disgalmDesktop

function wav(canais, taxa) {
  const n = canais[0].length, c = canais.length
  const b = new DataView(new ArrayBuffer(44 + n * c * 2))
  const s = (o, t) => [...t].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)))
  s(0, 'RIFF'); b.setUint32(4, 36 + n * c * 2, true); s(8, 'WAVEfmt ')
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, c, true)
  b.setUint32(24, taxa, true); b.setUint32(28, taxa * c * 2, true); b.setUint16(32, c * 2, true)
  b.setUint16(34, 16, true); s(36, 'data'); b.setUint32(40, n * c * 2, true)
  for (let i = 0, o = 44; i < n; i++)
    for (let k = 0; k < c; k++, o += 2) b.setInt16(o, Math.max(-1, Math.min(1, canais[k][i])) * 32767, true)
  return b.buffer
}

async function gravar(ctx, track, segundos) {
  const fonte = ctx.createMediaStreamSource(new MediaStream([track]))
  const g = new AudioWorkletNode(ctx, 'disgalm-gravador', { numberOfOutputs: 1, outputChannelCount: [2] })
  const mudo = ctx.createGain()
  mudo.gain.value = 0
  fonte.connect(g).connect(mudo).connect(ctx.destination)
  const pedacos = [[], []]
  g.port.onmessage = e => { pedacos[0].push(e.data[0]); pedacos[1].push(e.data[1] || e.data[0]) }
  await new Promise(r => setTimeout(r, segundos * 1000))
  g.disconnect(); fonte.disconnect()
  const juntar = ps => { const out = new Float32Array(ps.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of ps) { out.set(p, o); o += p.length } return out }
  return [juntar(pedacos[0]), juntar(pedacos[1])]
}

async function principal() {
  // ?proprio=1: o próprio app toca 700 Hz nas caixas, como o Disgalm tocando a
  // voz de quem assiste. Esse som não pode entrar na captura.
  if (q.get('proprio')) {
    const ctx = new AudioContext()
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.frequency.value = 700; g.gain.value = 0.25
    o.connect(g).connect(ctx.destination); o.start()
    log('o próprio app tocando 700 Hz')
  }
  const tela = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false })
  log('tela:', tela.getVideoTracks()[0].label)
  const audio = await abrirAudioSemDiscord(log)
  log('track nativa:', audio.label, audio.readyState)

  const a = new RTCPeerConnection(), b = new RTCPeerConnection()
  a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate)
  b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate)
  const recebida = new Promise(r => { b.ontrack = e => { if (e.track.kind === 'audio') r(e.streams[0]) } })
  const local = new MediaStream([tela.getVideoTracks()[0], audio])
  for (const t of local.getTracks()) a.addTrack(t, local)
  await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription)
  await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription)
  const remoto = await recebida
  // Chromium só decodifica áudio WebRTC remoto se houver um elemento tocando.
  el('a').srcObject = remoto
  el('v').srcObject = remoto
  log('WebRTC conectado; aquecendo', AQUECER, 's')
  await new Promise(r => setTimeout(r, AQUECER * 1000))

  const ctx = new AudioContext({ sampleRate: 48000 })
  await ctx.audioWorklet.addModule('/_desktop/teste-worklet.js')
  log('gravando', SEGUNDOS, 's')
  const [gLocal, gRemoto] = await Promise.all([
    gravar(ctx, audio, SEGUNDOS),
    gravar(ctx, remoto.getAudioTracks()[0], SEGUNDOS),
  ])
  const st = [...(await b.getStats()).values()]
  const video = st.find(s => s.type === 'inbound-rtp' && s.kind === 'video')
  const aud = st.find(s => s.type === 'inbound-rtp' && s.kind === 'audio')
  const resumo = {
    tela: tela.getVideoTracks()[0].label,
    videoRecebido: { quadros: video?.framesDecoded, largura: video?.frameWidth, altura: video?.frameHeight },
    audioRecebido: { pacotes: aud?.packetsReceived, perdidos: aud?.packetsLost, jitterMs: aud?.jitter * 1000, atrasoJitterBufferMs: aud && aud.jitterBufferEmittedCount ? aud.jitterBufferDelay / aud.jitterBufferEmittedCount * 1000 : null },
  }
  log(JSON.stringify(resumo))
  resumo.log = el('log').textContent.trim().split('\n')
  log('local:', await d.teste.salvar('local.wav', wav(gLocal, ctx.sampleRate)))
  log('recebida:', await d.teste.salvar('recebida.wav', wav(gRemoto, ctx.sampleRate)))
  await d.teste.salvar('resumo.json', new TextEncoder().encode(JSON.stringify(resumo, null, 2)))
  audio.stop()
  for (const t of tela.getTracks()) t.stop()
  d.teste.fim(0)
}

principal().catch(async e => {
  log('ERRO', e.stack || e)
  await d.teste.salvar('erro.txt', new TextEncoder().encode(String(e.stack || e) + '\n' + el('log').textContent))
  d.teste.fim(1)
})
