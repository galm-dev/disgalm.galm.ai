// Ensaio real do SFU (tests/sfu.md), local: Chromium headless com mídia falsa,
// a Sala e o Orcamento de verdade no wrangler dev de tests/e2e/sfu e o app SFU
// de verdade. Fora do `node --test`: precisa do wrangler dev no ar, com um
// .dev.vars (SFU_APP_ID, SFU_APP_SECRET, SFU_SALAS) gerado na hora, e de um
// playwright-core instalado fora do repo.
//
//   node worker/node_modules/wrangler/bin/wrangler.js dev -c tests/e2e/sfu/wrangler.toml \
//     --ip 127.0.0.1 --port 8788 --persist-to /tmp/disgalm-sfu-persist
//   SFU_ENV=~/.config/disgalm/sfu.env PLAYWRIGHT_CORE=/caminho/com/node_modules \
//     node tests/e2e/sfu.mjs <sala-do-ensaio> [origem] [saida.json]
//
// SFU_ENV só serve para, no fim, perguntar à API se sobrou sessão com track
// ativa. Os valores ficam na memória do processo e nunca vão para a saída.
import { createRequire } from 'module'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
const require = createRequire((process.env.PLAYWRIGHT_CORE || process.cwd()).replace(/\/?$/, '/'))
const { chromium } = require('playwright-core')

const SALA = process.argv[2]
const ORIGEM = process.argv[3] || 'http://127.0.0.1:8788'
const SAIDA = process.argv[4] || '/tmp/disgalm-sfu.json'
if (!SALA) throw new Error('falta a sala do ensaio (a mesma de SFU_SALAS)')
const FORA = 'fora-' + Date.now().toString(36)
const cache = process.env.HOME + '/Library/Caches/ms-playwright/'
const exe = process.env.CHROME || cache + readdirSync(cache).filter(d => d.startsWith('chromium-')).sort().pop() +
  '/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const espera = ms => new Promise(r => setTimeout(r, ms))
const resultado = { sala: SALA, passos: [], eventos: {} }
const abas = []
const passo = (nome, ok, dados) => {
  resultado.passos.push({ nome, ok, dados })
  console.log(ok ? 'OK    ' : 'FALHOU', nome, JSON.stringify(dados ?? '').slice(0, 600))
}

// Tela falsa (canvas animado) com áudio do sistema estéreo: 440 Hz só à
// esquerda e 660 Hz só à direita.
const falsos = () => {
  localStorage.setItem('disgalm.ruido', 'navegador')
  navigator.mediaDevices.getDisplayMedia = async c => {
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360
    const g = cv.getContext('2d'); let n = 0
    setInterval(() => { g.fillStyle = `hsl(${n++ % 360},80%,50%)`; g.fillRect(0, 0, 640, 360) }, 33)
    const s = cv.captureStream(30)
    if (c?.audio) {
      const ac = new AudioContext(), d = ac.createMediaStreamDestination(), m = ac.createChannelMerger(2)
      d.channelCount = 2
      const l = ac.createOscillator(), r = ac.createOscillator(); l.frequency.value = 440; r.frequency.value = 660
      l.connect(m, 0, 0); r.connect(m, 0, 1); m.connect(d); l.start(); r.start()
      s.addTrack(d.stream.getAudioTracks()[0])
    }
    return s
  }
}

const LER = `(() => ({
  eu: meuId, transporte: transporte.nome, pares: pares.size,
  sfu: transporte.estado ? transporte.estado() : null,
  pessoas: [...pessoas].map(([id, p]) => ({ id, nome: p.nome,
    telasVivas: [...p.telas.values()].filter(s => s.getVideoTracks().some(t => t.readyState === 'live')).length,
    cam: p.cam.getVideoTracks().filter(t => t.readyState === 'live').length,
    audios: [...p.audios.values()].map(a => a.tipo).sort() })),
  notice: document.getElementById('ui-notice')?.textContent ?? '',
}))()`

// Separação L/R no receptor: espectro de cada canal do <audio> da tela.
const ESTEREO = de => `(async () => {
  const p = pessoas.get('${de}')
  const a = [...p.audios.values()].find(a => a.tipo === 'tela')
  if (!a) return null
  const ac = new AudioContext(); await ac.resume()
  const src = ac.createMediaStreamSource(new MediaStream([a.track]))
  const sp = ac.createChannelSplitter(2); src.connect(sp)
  const an = [0, 1].map(i => { const n = ac.createAnalyser(); n.fftSize = 8192; n.smoothingTimeConstant = 0.8; sp.connect(n, i); return n })
  await new Promise(r => setTimeout(r, 2000))
  const nivel = (n, f) => { const d = new Float32Array(n.frequencyBinCount); n.getFloatFrequencyData(d)
    const b = Math.round(f / (ac.sampleRate / 8192)); return Math.round(Math.max(d[b - 1], d[b], d[b + 1])) }
  const r = { canais: src.channelCount, L440: nivel(an[0], 440), L660: nivel(an[0], 660), R440: nivel(an[1], 440), R660: nivel(an[1], 660) }
  ac.close()
  // O que o transporte diz da mesma track: chegam pacotes? com nível?
  for (const { relatorio } of await transporte.stats()) relatorio.forEach(x => {
    if (x.type === 'inbound-rtp' && x.kind === 'audio' && x.trackIdentifier === a.track.id)
      Object.assign(r, { bytes: x.bytesReceived, nivel: x.audioLevel, energia: x.totalAudioEnergy, codec: relatorio.get(x.codecId)?.sdpFmtpLine })
  })
  r.elemento = { pausado: a.el.paused, volume: a.el.volume, mudo: a.el.muted }
  return r
})()`

const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })

const sessoes = new Set()
async function aba(nome, sala = SALA) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] })
  await ctx.addInitScript(falsos)
  const page = await ctx.newPage()
  const erros = [], eventos = []
  page.on('request', r => { if (r.url().includes('/telemetria')) try { eventos.push(...JSON.parse(r.postData()).eventos) } catch {} })
  page.on('pageerror', e => erros.push(e.message))
  await page.goto(`${ORIGEM}/?sala=${sala}&nome=${nome}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof meuId !== 'undefined' && meuId, null, { timeout: 30000 })
  const X = { nome, ctx, page, erros, eventos, run: code => page.evaluate(code) }
  abas.push(X)
  X.ler = async () => { const l = await page.evaluate(LER); if (l.sfu?.sessao) sessoes.add(l.sfu.sessao); return l }
  // A fila de telemetria ainda na página, mais o que já foi enviado.
  X.todos = async () => [...eventos, ...await page.evaluate('filaTelemetria')]
  return X
}

async function ate(fn, ms = 25000, passoMs = 400) {
  const fim = Date.now() + ms
  let ultimo
  while (Date.now() < fim) { ultimo = await fn(); if (ultimo?.ok) return ultimo; await espera(passoMs) }
  return ultimo
}
const visto = (quem, de, cond, ms) => ate(async () => {
  const l = await quem.ler()
  const p = l.pessoas.find(p => p.id === de)
  return { ok: !!p && cond(p), p }
}, ms)
const contar = (evs, nome, filtro = () => true) => evs.filter(e => e.evento === nome && filtro(e)).length

try {
  const prep = await fetch(`${ORIGEM}/_e2e/orcamento`).then(r => r.json())
  passo('orçamento local com retrato zerado libera', prep.ok, { uso: prep.uso_protegido_pct })

  // 1. 2 clientes
  const A = await aba('Ana'), B = await aba('Bia')
  const idA = (await A.ler()).eu, idB = (await B.ler()).eu
  let r = await ate(async () => {
    const ls = await Promise.all([A, B].map(x => x.ler()))
    return { ok: ls.every(l => l.transporte === 'sfu' && l.pares === 0 && l.sfu?.conexao === 'connected'), ls: ls.map(l => [l.transporte, l.sfu?.conexao]) }
  })
  passo('2 clientes em SFU, uma conexão cada, conectada', r.ok, r.ls)
  r = await visto(B, idA, p => p.audios.includes('voz'))
  passo('B ouve a voz de A pelo SFU', r.ok, r.p)

  // 2. câmera + tela ao mesmo tempo
  await Promise.all([A.run('adicionarTela()'), A.run('alternarCam()')])
  r = await visto(B, idA, p => p.telasVivas === 1 && p.cam === 1 && p.audios.includes('tela') && p.audios.includes('voz'))
  passo('câmera e tela juntas: B vê tela, câmera, voz e som de tela separados', r.ok, r.p)
  const evA = await A.todos()
  passo('sem 409 nem erro do SFU em A', !evA.some(e => e.evento === 'sfu_erro'), evA.filter(e => e.evento === 'sfu_erro'))

  // 3. estéreo L/R
  await espera(2000)
  const est = await B.run(ESTEREO(idA))
  const separacao = est && { L: est.L440 - est.L660, R: est.R660 - est.R440 }
  passo('estéreo: 440 Hz só em L e 660 Hz só em R no receptor (separação ≥ 20 dB)',
    !!est && separacao.L >= 20 && separacao.R >= 20, { ...est, separacao })

  // 4. entrada tardia: 2 → 4
  const C = await aba('Caio'), D = await aba('Duda')
  for (const X of [C, D]) {
    r = await visto(X, idA, p => p.telasVivas === 1 && p.cam === 1 && p.audios.includes('tela') && p.audios.includes('voz'), 30000)
    passo(`${X.nome} entra tarde e recebe tela, câmera, voz e som de A`, r.ok, r.p)
  }
  const pubA = contar(await A.todos(), 'sfu_publicou', e => e.ok)
  passo('A publicou cada fonte uma vez só (mic, tela vídeo, tela áudio, câmera), com 4 na sala', pubA === 4, { pubA, estado: (await A.ler()).sfu })
  const lsTodos = await Promise.all([A, B, C, D].map(x => x.ler()))
  passo('4 clientes, uma conexão cada', lsTodos.every(l => l.transporte === 'sfu' && l.pares === 0 && l.sfu.conexao === 'connected'),
    lsTodos.map(l => [l.eu, l.sfu.conexao, l.sfu.assinadas.length, l.sfu.transceivers]))

  // 5. publicar, substituir e parar 20 vezes (câmera) e recapturar a tela 20 vezes
  await A.run('pararCam()')
  r = await visto(B, idA, p => p.cam === 0)
  let falhas = 0
  for (let i = 0; i < 20; i++) {
    await A.run('alternarCam()')
    const on = await visto(B, idA, p => p.cam === 1, 15000)
    await A.run('recapturar()')
    await A.run('pararCam()')
    const off = await visto(B, idA, p => p.cam === 0, 15000)
    if (!on?.ok || !off?.ok) falhas++
  }
  await espera(3000)
  const fim = await Promise.all([A, B, C, D].map(x => x.ler()))
  const telaViva = await visto(B, idA, p => p.telasVivas === 1 && p.audios.includes('tela'))
  passo('20 ciclos de câmera e 20 recapturas: todos os ciclos vistos por B, tela segue viva', falhas === 0 && telaViva.ok, { falhas, p: telaViva.p })
  // Transceiver vivo = fonte publicada ou assinatura; os parados saem da conexão.
  // O SFU às vezes repete numa oferta a seção de uma track fechada, que o
  // navegador guarda como 'inactive', sem mídia: conta à parte, e não pode crescer.
  const sobras = await Promise.all([A, B, C, D].map(async (X, i) => {
    const d = await X.run('transporte.estado().detalhe()')
    const ativos = d.filter(t => t[2] !== 'inactive')
    const esperado = fim[i].sfu.publicadas.length + fim[i].sfu.assinadas.length
    return { nome: X.nome, ativos: ativos.length, inativos: d.length - ativos.length, esperado, ...(ativos.length !== esperado && { d }) }
  }))
  passo('sem transceiver sobrando depois dos ciclos (ativos = publicadas + assinadas; inativos ≤ 2)',
    sobras.every(x => x.ativos === x.esperado && x.inativos <= 2), sobras)
  passo('assinaturas de B, C e D voltam ao conjunto sem câmera', fim.slice(1).every(l => l.sfu.assinadas.filter(s => s.dono === idA).length === 3),
    fim.slice(1).map(l => l.sfu.assinadas.map(s => s.fonte)))
  const erros = (await Promise.all([A, B, C, D].map(x => x.todos()))).flat().filter(e => e.evento === 'sfu_erro')
  passo('nenhum sfu_erro nos 4 clientes durante os ciclos', erros.length === 0, erros.slice(0, 5))

  // 6. relay forçado: precisa de credencial TURN, que o ensaio local não tem.
  passo('relay forçado (não testável aqui: sem credencial TURN local)', null)

  // 7. sala fora da lista continua em malha
  const E = await aba('Eva', FORA), F = await aba('Fabi', FORA)
  r = await ate(async () => {
    const ls = await Promise.all([E, F].map(x => x.ler()))
    return { ok: ls.every(l => l.transporte === 'mesh' && l.pares === 1 && !l.sfu), ls: ls.map(l => [l.transporte, l.pares]) }
  })
  passo('sala fora da lista: malha, sem SFU', r.ok, r.ls)
  const idE = (await E.ler()).eu
  r = await visto(F, idE, p => p.audios.includes('voz'))
  passo('na malha, F ouve E', r.ok, r.p)
  await E.run('adicionarTela()')
  await visto(F, idE, p => p.audios.includes('tela'))
  await espera(2000)
  const estMalha = await F.run(ESTEREO(idE))
  passo('referência: o mesmo estéreo pela malha', !!estMalha && estMalha.L440 - estMalha.L660 >= 20 && estMalha.R660 - estMalha.R440 >= 20, estMalha)

  // 8. todos saem: nada sobra no SFU
  for (const X of [A, B, C, D, E, F]) await X.ler()
  for (const X of [A, B, C, D]) await X.run('sairDaSala()')
  await espera(5000)
  const env = process.env.SFU_ENV && Object.fromEntries(readFileSync(process.env.SFU_ENV, 'utf8').split('\n')
    .map(l => l.match(/^\s*(\w+)\s*=\s*"?([^"\n]*)"?\s*$/)).filter(Boolean).map(m => [m[1], m[2]]))
  if (env?.SFU_APP_ID && env?.SFU_APP_SECRET) {
    const ativas = []
    for (const s of sessoes) {
      const j = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${env.SFU_APP_ID}/sessions/${s}`,
        { headers: { authorization: `Bearer ${env.SFU_APP_SECRET}` } }).then(r => r.json()).catch(e => ({ erro: e.message }))
      const vivas = (j.tracks || []).filter(t => t.status === 'active')
      if (vivas.length) ativas.push({ sessao: s.slice(0, 8), vivas: vivas.map(t => [t.location, t.trackName ?? null]) })
    }
    passo(`fim: nenhuma das ${sessoes.size} sessões tem track ativa no SFU`, ativas.length === 0, ativas)
  } else passo('fim: conferência na API (sem SFU_ENV)', null)

  // 9. orçamento acima de 90%: a sala de ensaio abre na malha, com o aviso.
  await fetch(`${ORIGEM}/_e2e/orcamento?turn_gb=900`)
  const G = await aba('Gil'), H = await aba('Hugo')
  r = await ate(async () => {
    const ls = await Promise.all([G, H].map(x => x.ler()))
    return { ok: ls.every(l => l.transporte === 'mesh' && l.pares === 1 && /SFU indisponível/.test(l.notice)), ls: ls.map(l => [l.transporte, l.pares, l.notice]) }
  })
  passo('orçamento em 90%: sala de ensaio abre na malha e avisa', r.ok, r.ls)
  await fetch(`${ORIGEM}/_e2e/orcamento`)

  const errosPagina = [A, B, C, D, E, F, G, H].flatMap(x => x.erros.map(m => `${x.nome}: ${m}`))
  passo('sem erro de página', errosPagina.length === 0, errosPagina.slice(0, 5))
} catch (e) {
  passo('roteiro interrompido', false, e.stack)
} finally {
  for (const X of abas) try {
    resultado.eventos[X.nome] = (await X.todos()).filter(e => /^(sfu_|ice|aviso)/.test(e.evento))
  } catch {}
  writeFileSync(SAIDA, JSON.stringify(resultado, null, 1))
  await browser.close()
}
