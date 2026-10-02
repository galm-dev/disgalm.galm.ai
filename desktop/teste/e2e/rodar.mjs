// Teste ponta a ponta numa sala de verdade, só que local:
//   wrangler dev (Sala de produção, login trocado por membro fixo)
//   + app Electron compartilhando a tela (quem transmite)
//   + Edge pelo CDP, assistindo e gravando o áudio da tela que recebe.
// Um tom de 1000 Hz toca num processo comum; o Discord, se estiver aberto e
// tocando, deve sumir no modo "sem o Discord" e aparecer no controle (áudio
// do sistema inteiro, o mesmo da web).
//
//   node teste\e2e\rodar.mjs [--segundos=10] [--soak=0]
//
// --soak=N deixa o compartilhamento nativo ligado N minutos e conta engasgos e
// CPU. Rode na sessão de desktop (precisa de áudio). Saída em
// teste\saida\e2e.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const arg = (n, d) => Number(process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? d)
const SEGUNDOS = arg('segundos', 10)
const SOAK = arg('soak', 0)
const DESKTOP = resolve(import.meta.dirname, '..', '..')
const REPO = resolve(DESKTOP, '..')
const SAIDA = join(DESKTOP, 'teste', 'saida', 'e2e')
const ORIGEM = 'http://127.0.0.1:8787'
// Sala nova a cada rodada: quem ficou de uma rodada anterior seria fantasma.
const SALA = `e2e-${Date.now().toString(36)}`
const esperar = ms => new Promise(r => setTimeout(r, ms))
const filhos = []
const resumo = {}

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a) }

function iniciar(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: 'ignore', ...opts })
  filhos.push(p)
  return p
}

async function ate(cond, ms, oque) {
  const fim = Date.now() + ms
  for (;;) {
    try { const v = await cond(); if (v) return v } catch {}
    if (Date.now() > fim) throw new Error(`tempo esgotado: ${oque}`)
    await esperar(500)
  }
}

// ---------- CDP ----------

async function pagina(porta) {
  const alvos = await (await fetch(`http://127.0.0.1:${porta}/json`)).json()
  const alvo = alvos.find(a => a.type === 'page' && a.url.startsWith(ORIGEM))
  if (!alvo) throw new Error('página ainda não abriu')
  const ws = new WebSocket(alvo.webSocketDebuggerUrl)
  await new Promise((ok, erro) => { ws.onopen = ok; ws.onerror = erro })
  let n = 0
  const pendentes = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    pendentes.get(m.id)?.(m)
    pendentes.delete(m.id)
  }
  return async expr => {
    const id = ++n
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }))
    const m = await new Promise(r => pendentes.set(id, r))
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'erro na página')
    return m.result?.result?.value
  }
}

// ---------- áudio ----------

function wav(pcm16, taxa, canais) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm16.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(canais, 22); h.writeUInt32LE(taxa, 24)
  h.writeUInt32LE(taxa * canais * 2, 28); h.writeUInt16LE(canais * 2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm16.length, 40)
  return Buffer.concat([h, pcm16])
}

function tom(hz, arquivo) {
  const taxa = 48000, n = taxa * 5, b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * hz * i / taxa)), i * 2)
  writeFileSync(arquivo, wav(b, taxa, 1))
}

// Grava, no Edge, o áudio da tela que chega de quem transmite.
const GRAVAR = segundos => `(async () => {
  const p = [...pessoas.values()].find(p => p.telas?.size)
  if (!p) return { erro: 'ninguém compartilhando' }
  const ids = idsTelas(p.estado || {})
  const a = [...p.audios.entries()].find(([sid]) => ids.includes(sid))?.[1]
  if (!a) return { erro: 'tela sem áudio', ids, audios: [...p.audios.keys()] }
  const ctx = new AudioContext({ sampleRate: 48000 })
  const url = URL.createObjectURL(new Blob(["registerProcessor('g', class extends AudioWorkletProcessor {" +
    " process([e]) { if (e.length) this.port.postMessage(e.map(c => c.slice())); return true } })"],
    { type: 'text/javascript' }))
  await ctx.audioWorklet.addModule(url)
  const src = ctx.createMediaStreamSource(new MediaStream([a.track]))
  const g = new AudioWorkletNode(ctx, 'g', { outputChannelCount: [2] })
  const mudo = ctx.createGain(); mudo.gain.value = 0
  src.connect(g).connect(mudo).connect(ctx.destination)
  const L = [], R = []
  g.port.onmessage = e => { L.push(e.data[0]); R.push(e.data[1] || e.data[0]) }
  await new Promise(r => setTimeout(r, ${segundos} * 1000))
  ctx.close()
  const n = L.reduce((s, x) => s + x.length, 0)
  const out = new Int16Array(n * 2)
  let o = 0
  for (let k = 0; k < L.length; k++)
    for (let i = 0; i < L[k].length; i++) {
      out[o++] = Math.max(-1, Math.min(1, L[k][i])) * 32767
      out[o++] = Math.max(-1, Math.min(1, R[k][i])) * 32767
    }
  const bytes = new Uint8Array(out.buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const st = [...(await p.pc.getStats()).values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'audio')
  return { b64: btoa(bin), quadros: n, label: a.track.label, inbound: st.map(s => ({
    pacotes: s.packetsReceived, perdidos: s.packetsLost, ocultadas: s.concealedSamples, amostras: s.totalSamplesReceived })) }
})()`

const COMPARTILHAR = semDiscord => `(async () => {
  pararTelas()
  $('semdiscord').checked = ${semDiscord}
  await adicionarTela()
  await new Promise(r => setTimeout(r, 1500))
  const a = telas[0]?.getAudioTracks()[0]
  return { telas: telas.length, nativo: !!a?.disgalmNativo, audio: a?.label, log: eventos.slice(-6) }
})()`

async function gravar(edge, nome) {
  await esperar(3000)
  const r = await edge(GRAVAR(SEGUNDOS))
  if (r.erro) throw new Error(`${nome}: ${JSON.stringify(r)}`)
  writeFileSync(join(SAIDA, `${nome}.wav`), wav(Buffer.from(r.b64, 'base64'), 48000, 2))
  delete r.b64
  resumo[nome] = r
  log(nome, JSON.stringify(r))
}

function cpuSegundos(pid) {
  return Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CPU`]).toString().trim())
}

// ---------- roteiro ----------

async function principal() {
  mkdirSync(SAIDA, { recursive: true })
  const tmp = join(tmpdir(), 'disgalm-teste')
  mkdirSync(tmp, { recursive: true })
  const t1000 = join(tmp, 'tom1000.wav')
  if (!existsSync(t1000)) tom(1000, t1000)

  log('wrangler dev')
  iniciar(process.execPath, [join(REPO, 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev',
    '-c', join(DESKTOP, 'teste', 'e2e', 'wrangler.toml'), '--ip', '127.0.0.1', '--port', '8787',
    '--persist-to', join(tmp, `wrangler-${SALA}`)],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } })
  await ate(async () => (await fetch(ORIGEM + '/')).ok, 60000, 'wrangler dev')

  log('tom de 1000 Hz')
  iniciar('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
    `(New-Object Media.SoundPlayer '${t1000}').PlayLooping(); Start-Sleep 3600`])

  log('Electron (transmite)')
  const electron = iniciar(join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [DESKTOP, `${ORIGEM}/?sala=${SALA}&nome=Electron`, '--remote-debugging-port=9222'],
    { env: { ...process.env, DISGALM_URL: ORIGEM, DISGALM_UI_LOCAL: '0', DISGALM_TELA_AUTO: '1' } })

  log('Edge (assiste)')
  const edgeExe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync)
  iniciar(edgeExe, [`--user-data-dir=${join(tmp, 'edge-e2e')}`, '--remote-debugging-port=9223',
    '--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    // O Edge não toca nada nas caixas: senão o loopback do app pegaria o som de
    // volta (o Disgalm não se exclui quando o Discord está aberto).
    '--mute-audio', `${ORIGEM}/?sala=${SALA}&nome=Assiste`])

  const app = await ate(() => pagina(9222), 60000, 'página do Electron')
  const edge = await ate(() => pagina(9223), 60000, 'página do Edge')
  const conectado = 'typeof pares !== "undefined" && [...pares.values()].some(p => p.pc.connectionState === "connected")'
  await ate(() => app(conectado), 60000, 'Electron conectado')
  await ate(() => edge(conectado), 60000, 'Edge conectado')
  // O microfone falso do Edge apita; sem ele, a única fonte é a tela.
  await edge('micStream?.getAudioTracks().forEach(t => t.enabled = false); true')
  resumo.desktop = await app('JSON.stringify(window.disgalmDesktop?.audioSemDiscord)')
  log('pareados; desktop:', resumo.desktop)

  resumo.compartilhaNativo = await app(COMPARTILHAR(true))
  log('nativo:', JSON.stringify(resumo.compartilhaNativo))
  await gravar(edge, 'nativo')

  resumo.compartilhaSistema = await app(COMPARTILHAR(false))
  log('sistema inteiro:', JSON.stringify(resumo.compartilhaSistema))
  await gravar(edge, 'controle')

  if (SOAK > 0) {
    await app(COMPARTILHAR(true))
    const cpu0 = cpuSegundos(electron.pid), t0 = Date.now()
    const ocult0 = await edge(`(async () => { const p = [...pares.values()][0]; return [...(await p.pc.getStats()).values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').reduce((n, s) => n + s.concealedSamples, 0) })()`)
    log(`soak de ${SOAK} min`)
    await esperar(SOAK * 60000)
    const cpu1 = cpuSegundos(electron.pid)
    const ocult1 = await edge(`(async () => { const p = [...pares.values()][0]; return [...(await p.pc.getStats()).values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').reduce((n, s) => n + s.concealedSamples, 0) })()`)
    resumo.soak = {
      minutos: SOAK,
      cpuProcessoPrincipalPct: +(100 * (cpu1 - cpu0) / ((Date.now() - t0) / 1000)).toFixed(2),
      amostrasOcultadasNoReceptor: ocult1 - ocult0,
      logNativo: await app('eventos.filter(l => /loopback nativo|sem o Discord|sem Discord/.test(l))'),
    }
    await gravar(edge, 'soak-fim')
  }
  resumo.logApp = await app('eventos.slice(-40)')
}

try {
  await principal()
  writeFileSync(join(SAIDA, 'resumo.json'), JSON.stringify(resumo, null, 2))
  log('ok; saída em', SAIDA)
} catch (e) {
  console.error('FALHOU', e.stack || e)
  writeFileSync(join(SAIDA, 'resumo.json'), JSON.stringify({ ...resumo, erro: String(e.stack || e) }, null, 2))
  process.exitCode = 1
} finally {
  for (const p of filhos.reverse()) {
    try { execFileSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { stdio: 'ignore' }) } catch {}
  }
}
