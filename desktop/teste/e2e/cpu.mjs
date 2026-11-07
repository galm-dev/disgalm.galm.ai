// Mede a CPU de uma chamada sintética numa sala local, por processo e por
// thread, variando uma coisa por vez. Só Linux (lê /proc).
//
//   wrangler dev (Sala de produção, login trocado por membro fixo: sala.js)
//   + dois navegadores headless com mídia falsa (mic, câmera e tela),
//     cada um com perfil próprio e sem som (--mute-audio)
//
//   node desktop/teste/e2e/cpu.mjs [--segundos=60] [--aquecer=15]
//        [--cenarios=base,sem-filtro,...] [--navegador=/usr/bin/google-chrome-stable]
//        [--saida=arquivo.json]
//
// WRANGLER aponta o bin do wrangler (padrão: worker/node_modules/.bin/wrangler).
// Nada toca a tela, o áudio ou o clipboard de quem está na máquina: headless,
// sem som e com dispositivos falsos.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const opt = (n, d) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d
const SEGUNDOS = Number(opt('segundos', 60))
const AQUECER = Number(opt('aquecer', 15))
const NAVEGADOR = opt('navegador', '/usr/bin/google-chrome-stable')
const SAIDA = opt('saida', '')
// Com um compositor (WAYLAND_DISPLAY), a janela é de verdade: a composição e a
// GPU entram na conta como numa chamada. Sem ele, headless.
const JANELA = opt('janela', process.env.WAYLAND_DISPLAY ? '1' : '0') === '1'
const REPO = resolve(import.meta.dirname, '..', '..', '..')
const WRANGLER = process.env.WRANGLER || join(REPO, 'worker', 'node_modules', '.bin', 'wrangler')
const PORTA = Number(opt('porta', 8799))
const ORIGEM = `http://127.0.0.1:${PORTA}`
const SALA = `cpu-${Date.now().toString(36)}`
const TICK = 100 // CLK_TCK do Linux
const esperar = ms => new Promise(r => setTimeout(r, ms))
const filhos = []
const tmp = mkdtempSync(join(tmpdir(), 'disgalm-cpu-'))

function log(...a) { console.error(new Date().toISOString().slice(11, 19), ...a) }

// Cada cenário parte do mesmo estado: filtro RNNoise, sem tela, sem câmera.
// `a` roda em quem transmite (A); B só assiste.
const CENARIOS = {
  'base':            { ruido: 'rnnoise' },
  'sem-filtro':      { ruido: 'desligado' },
  'filtro-navegador':{ ruido: 'navegador' },
  'deepfilter':      { ruido: 'deepfilter' },
  'tela-equil':      { ruido: 'rnnoise', tela: 'equil' },
  'tela-codigo':     { ruido: 'rnnoise', tela: 'codigo' },
  'tela-fluido':     { ruido: 'rnnoise', tela: 'fluido' },
  'tela-jogo':       { ruido: 'rnnoise', tela: 'jogo' },
  'camera':          { ruido: 'rnnoise', camera: true },
  // Experimentos: `js` roda nas duas páginas e não se desfaz, então vão por último.
  'sem-stats':       { ruido: 'rnnoise', js: 'for (const p of pares.values()) clearInterval(p.timer)' },
  'sem-raf':         { ruido: 'rnnoise', js: 'window.requestAnimationFrame = () => 0' },
}
const NOMES = opt('cenarios', Object.keys(CENARIOS).join(',')).split(',')

function iniciar(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true, ...opts })
  p.stderr?.on('data', () => {})
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

function navegador(nome, porta) {
  return iniciar(NAVEGADOR, [
    ...(JANELA ? ['--ozone-platform=wayland'] : ['--headless=new']), '--disable-extensions', '--password-store=basic', `--user-data-dir=${join(tmp, nome)}`, `--remote-debugging-port=${porta}`,
    '--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--auto-accept-this-tab-capture', '--mute-audio', '--window-size=1600,900',
    `${ORIGEM}/?sala=${SALA}&nome=${nome}`])
}

// ---------- /proc ----------

function ler(caminho) { try { return readFileSync(caminho, 'utf8') } catch { return null } }

function stat(caminho) {
  const s = ler(caminho)
  if (!s) return null
  const fim = s.lastIndexOf(')')
  const comm = s.slice(s.indexOf('(') + 1, fim)
  const f = s.slice(fim + 2).split(' ')
  return { comm, ppid: +f[1], ticks: +f[11] + +f[12] }
}

function descendentes(raiz) {
  const filhosDe = new Map()
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    const s = stat(`/proc/${d}/stat`)
    if (!s) continue
    if (!filhosDe.has(s.ppid)) filhosDe.set(s.ppid, [])
    filhosDe.get(s.ppid).push(+d)
  }
  const todos = [], fila = [raiz]
  while (fila.length) { const p = fila.shift(); todos.push(p); fila.push(...(filhosDe.get(p) || [])) }
  return todos
}

function tipo(pid) {
  // O zygote reescreve a cmdline dos filhos com espaços em vez de NUL.
  const cmd = (ler(`/proc/${pid}/cmdline`) || '').split(/[\0 ]/)
  const t = cmd.find(a => a.startsWith('--type='))?.slice(7)
  if (!t) return 'browser'
  if (t === 'utility') return 'utility:' + (cmd.find(a => a.startsWith('--utility-sub-type='))?.slice(19).split('.')[0] || '?')
  if (t === 'renderer' && cmd.includes('--extension-process')) return 'renderer:extensao'
  return t
}

// Threads com número no fim (ThreadPoolForegroundWorker, WebRTC_W_1…) somam juntas.
function amostra(raiz) {
  const r = { processos: {}, threads: {} }
  for (const pid of descendentes(raiz)) {
    const t = tipo(pid)
    let tarefas
    try { tarefas = readdirSync(`/proc/${pid}/task`) } catch { continue }
    for (const tid of tarefas) {
      const s = stat(`/proc/${pid}/task/${tid}/stat`)
      if (!s) continue
      const chave = `${t} · ${s.comm.replace(/[\d_]+$/, '')}`
      r.threads[chave] = (r.threads[chave] || 0) + s.ticks
      r.processos[t] = (r.processos[t] || 0) + s.ticks
    }
  }
  return r
}

// % de um núcleo no intervalo (100 = um núcleo inteiro).
function diferenca(a, b, segundos) {
  const pct = (x, y) => {
    const o = {}
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const v = ((y[k] || 0) - (x[k] || 0)) / TICK / segundos * 100
      if (v > 0.05) o[k] = +v.toFixed(1)
    }
    return Object.fromEntries(Object.entries(o).sort((p, q) => q[1] - p[1]))
  }
  const processos = pct(a.processos, b.processos)
  return { total: +Object.values(processos).reduce((s, v) => s + v, 0).toFixed(1), processos,
           threads: Object.fromEntries(Object.entries(pct(a.threads, b.threads)).slice(0, 25)) }
}

// ---------- cenário na página ----------

const PREPARAR = c => `(async () => {
  pararTelas?.()
  if (camStream) pararCam()
  if (disgalmRuido.modo() !== ${JSON.stringify(c.ruido)}) await trocarFiltroMic(${JSON.stringify(c.ruido)})
  ${c.tela ? `$('preset').value = ${JSON.stringify(c.tela)}; $('preset').onchange(); await adicionarTela()` : ''}
  ${c.camera ? 'await alternarCam()' : ''}
  await new Promise(r => setTimeout(r, 1000))
  const v = telas[0]?.getVideoTracks()[0]?.getSettings()
  return { ruido: disgalmRuido.modo(), telas: telas.length, camera: !!camStream,
           tela: v && \`\${v.width}x\${v.height}@\${Math.round(v.frameRate)}\`, log: eventos.slice(-4) }
})()`

// O que a página enviou e recebeu de vídeo, para conferir que a mídia fluiu.
const VIDEO = `(async () => {
  const o = {}
  for (const [id, p] of pares) for (const s of (await p.pc.getStats()).values()) {
    if (s.kind !== 'video') continue
    if (s.type === 'outbound-rtp') { o.enviados = (o.enviados || 0) + (s.framesEncoded || 0); o.codificador = s.encoderImplementation; o.codec = s.codecId; o.limite = s.qualityLimitationReason; o.envio = s.frameWidth + 'x' + s.frameHeight }
    if (s.type === 'inbound-rtp') { o.recebidos = (o.recebidos || 0) + (s.framesDecoded || 0); o.decodificador = s.decoderImplementation }
  }
  return o
})()`

async function principal() {
  log('wrangler dev em', ORIGEM)
  iniciar(WRANGLER, ['dev', '-c', join(REPO, 'desktop', 'teste', 'e2e', 'wrangler.toml'),
    '--ip', '127.0.0.1', '--port', String(PORTA), '--persist-to', join(tmp, 'wrangler')],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } })
  await ate(async () => (await fetch(ORIGEM + '/')).ok, 60000, 'wrangler dev')

  const navA = navegador('A', 9301), navB = navegador('B', 9302)
  const a = await ate(() => pagina(9301), 60000, 'página A')
  const b = await ate(() => pagina(9302), 60000, 'página B')
  const conectado = 'typeof pares !== "undefined" && [...pares.values()].some(p => p.pc.connectionState === "connected")'
  try {
    await ate(() => a(conectado), 60000, 'A conectado')
    await ate(() => b(conectado), 60000, 'B conectado')
  } catch (e) {
    log('A:', JSON.stringify(await a('eventos.slice(-15)').catch(x => String(x))))
    log('B:', JSON.stringify(await b('eventos.slice(-15)').catch(x => String(x))))
    throw e
  }
  log('pareados na sala', SALA)

  const resultado = { sha: process.env.SHA || null, navegador: NAVEGADOR, janela: JANELA, segundos: SEGUNDOS,
                      aquecer: AQUECER, nucleos: (ler('/proc/cpuinfo').match(/^processor/gm) || []).length,
                      cenarios: [] }
  for (const nome of NOMES) {
    const c = CENARIOS[nome]
    if (!c) throw new Error(`cenário desconhecido: ${nome}`)
    if (c.js) { await a(c.js); await b(c.js) }
    const estado = await a(PREPARAR(c))
    log(nome, JSON.stringify(estado))
    await esperar(AQUECER * 1000)
    const inicio = new Date()
    const v0A = await a(VIDEO), v0B = await b(VIDEO)
    const a0 = amostra(navA.pid), b0 = amostra(navB.pid), t0 = performance.now()
    await esperar(SEGUNDOS * 1000)
    const a1 = amostra(navA.pid), b1 = amostra(navB.pid), dt = (performance.now() - t0) / 1000
    const v1A = await a(VIDEO), v1B = await b(VIDEO)
    const pressao = ler('/proc/pressure/cpu')?.split('\n')[0]
    const r = { nome, cenario: c, estado, inicio: inicio.toISOString(), segundos: +dt.toFixed(1),
      A: diferenca(a0, a1, dt), B: diferenca(b0, b1, dt),
      video: { A: { ...v1A, fpsEnviado: +(((v1A.enviados || 0) - (v0A.enviados || 0)) / dt).toFixed(1) },
               B: { ...v1B, fpsRecebido: +(((v1B.recebidos || 0) - (v0B.recebidos || 0)) / dt).toFixed(1) } },
      carga: ler('/proc/loadavg').trim(), pressaoCpu: pressao }
    log(nome, 'A', r.A.total, '% B', r.B.total, '%', JSON.stringify(r.video))
    resultado.cenarios.push(r)
  }
  return resultado
}

let saida
try {
  saida = await principal()
} catch (e) {
  console.error('FALHOU', e.stack || e)
  process.exitCode = 1
} finally {
  for (const p of filhos.reverse()) { try { process.kill(-p.pid, 'SIGTERM') } catch {} }
  await esperar(1500)
  for (const p of filhos) { try { process.kill(-p.pid, 'SIGKILL') } catch {} }
  rmSync(tmp, { recursive: true, force: true })
}
if (saida) {
  const json = JSON.stringify(saida, null, 2)
  if (SAIDA) writeFileSync(SAIDA, json)
  console.log(json)
}
