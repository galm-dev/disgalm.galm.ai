// Regressão da malha (tests/transporte.md): 3 a 4 abas Chromium headless numa
// sala local, com a Sala de produção e login de membro fixo. Fora do
// `node --test`: precisa do wrangler dev de desktop/teste/e2e no ar e de um
// playwright-core instalado fora do repo (o projeto não tem dependências).
//
//   node worker/node_modules/wrangler/bin/wrangler.js dev -c desktop/teste/e2e/wrangler.toml \
//     --ip 127.0.0.1 --port 8787 --persist-to /tmp/disgalm-e2e-persist
//   PLAYWRIGHT_CORE=/caminho/com/node_modules node tests/e2e/malha.mjs [origem] [saida.json]
import { createRequire } from 'module'
import { readdirSync, writeFileSync } from 'fs'
const require = createRequire((process.env.PLAYWRIGHT_CORE || process.cwd()).replace(/\/?$/, '/'))
const { chromium } = require('playwright-core')

const ORIGEM = process.argv[2] || 'http://127.0.0.1:8787'
const SAIDA = process.argv[3] || '/tmp/disgalm-malha.json'
const SALA = 'fase0-' + Date.now().toString(36)
// O Chromium baixado pelo Playwright no Mac; CHROME troca por outro.
const cache = process.env.HOME + '/Library/Caches/ms-playwright/'
const exe = process.env.CHROME || cache + readdirSync(cache).filter(d => d.startsWith('chromium-')).sort().pop() +
  '/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const espera = ms => new Promise(r => setTimeout(r, ms))
const resultado = { origem: ORIGEM, sala: SALA, passos: [] }
const passo = (nome, ok, dados) => { resultado.passos.push({ nome, ok, dados }); console.log(ok ? 'OK ' : 'FALHOU', nome, JSON.stringify(dados ?? '')) }

// Tela falsa: canvas animado; áudio do sistema estéreo com tons distintos L/R.
const falsos = () => {
  // Headless sem gesto: o worklet de ruído não é o que está em teste.
  localStorage.setItem('disgalm.ruido', 'navegador')
  navigator.mediaDevices.getDisplayMedia = async c => {
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360
    const g = cv.getContext('2d'); let n = 0
    setInterval(() => { g.fillStyle = `hsl(${n++ % 360},80%,50%)`; g.fillRect(0, 0, 640, 360) }, 33)
    const s = cv.captureStream(30)
    if (c?.audio) {
      const ac = new AudioContext(), d = ac.createMediaStreamDestination(), m = ac.createChannelMerger(2)
      const l = ac.createOscillator(), r = ac.createOscillator(); l.frequency.value = 440; r.frequency.value = 660
      l.connect(m, 0, 0); r.connect(m, 0, 1); m.connect(d); l.start(); r.start()
      s.addTrack(d.stream.getAudioTracks()[0])
    }
    return s
  }
}

// Leituras que funcionam no código novo (pessoas) e no da base (pares).
const LER = `(() => {
  const gente = typeof pessoas !== 'undefined' ? pessoas : pares
  return {
    eu: meuId,
    pares: [...pares].map(([id, p]) => ({ id, conexao: p.pc.connectionState, polite: p.polite, canal: p.canal?.readyState })),
    pessoas: [...gente].map(([id, p]) => ({ id, nome: p.nome,
      telas: p.telas.size, telasVivas: [...p.telas.values()].filter(s => s.getVideoTracks().some(t => t.readyState === 'live')).length,
      cam: p.cam.getVideoTracks().length,
      audios: [...p.audios.values()].map(a => a.tipo).sort(),
      volumes: [...p.audios.values()].map(a => [a.tipo, a.el.volume]),
      fontes: (p.estado?.fontes || []).map(f => [f.tipo, f.geracao, f.tela || null]),
      compartilhando: !!p.estado?.compartilhando })),
    telas: telas.length, cam: !!camStream, mic: !!micStream,
    fontesLocais: typeof fontes !== 'undefined' ? fontes.lista().map(f => [f.id, f.tipo, f.geracao, f.dono]) : null,
    eventos: filaTelemetria.map(e => e.evento),
  }
})()`

const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })

async function aba(nome) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] })
  await ctx.addInitScript(falsos)
  const page = await ctx.newPage()
  const erros = []
  const enviados = []
  page.on('request', r => { if (r.url().includes('/telemetria')) try { enviados.push(...JSON.parse(r.postData()).eventos.map(e => e.evento)) } catch {} })
  page.on('pageerror', e => erros.push(e.message))
  await page.goto(`${ORIGEM}/?sala=${SALA}&nome=${nome}`)
  await page.waitForFunction(() => typeof meuId !== 'undefined' && meuId, null, { timeout: 30000 })
  return { nome, ctx, page, erros, enviados, ler: () => page.evaluate(LER), run: code => page.evaluate(code) }
}

async function ate(fn, ms = 20000, passoMs = 300) {
  const fim = Date.now() + ms
  let ultimo
  while (Date.now() < fim) { ultimo = await fn(); if (ultimo?.ok) return ultimo; await espera(passoMs) }
  return ultimo
}

const conectados = async (abas, n) => ate(async () => {
  const ls = await Promise.all(abas.map(a => a.ler()))
  return { ok: ls.every(l => l.pares.length === n && l.pares.every(p => p.conexao === 'connected')), estados: ls.map(l => l.pares.map(p => p.conexao)) }
})

// Do lado de quem envia: cada transceiver com mid (null = nunca negociado).
const transceivers = (X, para) => X.run(`(() => { const p = pares.get('${para}'); return { polite: p.polite, remota: !!p.pc.remoteDescription,
  sinal: p.pc.signalingState, t: p.pc.getTransceivers().map(t => [t.mid, t.sender.track?.kind ?? null, t.currentDirection]) } })()`)

// A renegociação presa deixava quem compartilha em have-local-offer com o
// vídeo sem mid: a tela nunca chegava a quem entrou tarde ou recarregou.
const negociado = t => t.sinal === 'stable' && t.t.every(([mid, kind]) => kind !== 'video' || mid !== null)
// Com a tela já viva no receptor, a renegociação ainda pode estar em curso.
const negociadoCom = (X, para) => ate(async () => { const t = await transceivers(X, para); return { ok: negociado(t), t } })
const quadros = (X, de) => X.run(`(async () => [...(await pares.get('${de}').pc.getStats()).values()]
  .filter(s => s.type === 'inbound-rtp' && s.kind === 'video').reduce((n, s) => n + (s.framesDecoded || 0), 0))()`)
const quadrosCrescem = async (X, de) => { const q0 = await quadros(X, de); await espera(1500); const q1 = await quadros(X, de); return { ok: q1 > q0, q0, q1 } }

const visto = async (quem, de, cond, ms) => ate(async () => {
  const l = await quem.ler()
  const p = l.pessoas.find(p => p.id === de)
  return { ok: !!p && cond(p), p }
})

try {
  const A = await aba('Ana'), B = await aba('Bia'), C = await aba('Caio')
  const idA = (await A.ler()).eu
  passo('3 abas conectadas em malha', ...Object.values(await conectados([A, B, C], 2)).slice(0, 1), (await conectados([A, B, C], 2)).estados)
  const lB = await B.ler()
  passo('canal de telemetria aberto e papéis simétricos', lB.pares.every(p => p.canal === 'open'), lB.pares)

  // tela + câmera + voz + som
  await A.run('adicionarTela()')
  await A.run('alternarCam()')
  for (const X of [B, C]) {
    const r = await visto(X, idA, p => p.telasVivas === 1 && p.cam === 1 && p.audios.includes('tela') && p.audios.includes('voz'))
    passo(`${X.nome} recebe tela, câmera, voz e som de Ana`, r.ok, r.p)
  }
  // Na base não há registro de fontes: o passo só vale para a malha nova.
  const locais = (await A.ler()).fontesLocais
  const telaDe = tipo => locais?.find(f => f[1] === tipo)?.[0].split('/')[0]
  passo('Ana: fontes com tipo, dono e a mesma tela no vídeo e no áudio', !locais ||
    (telaDe('tela-video') === telaDe('tela-audio') && locais.every(f => f[3] === idA)), locais)

  // volumes separados
  await B.run(`(() => { const g = typeof pessoas !== 'undefined' ? pessoas : pares; const p = g.get('${idA}'); p.volumes.tela = 0.25; aplicarVolumes('${idA}') })()`)
  const vol = (await B.ler()).pessoas.find(p => p.id === idA).volumes
  passo('volume de tela separado do de voz', vol.some(([t, v]) => t === 'tela' && v === 0.25) && vol.some(([t, v]) => t === 'voz' && v === 1), vol)

  // ensurdecer: cala a voz, a tela segue no volume dela, mesmo ajustado no meio
  const ouvir = () => B.run(`(() => { const p = pessoas.get('${idA}'); return { surdo, mic: micStream?.getAudioTracks()[0]?.enabled,
    audios: [...p.audios.values()].map(a => [a.tipo, a.el.volume, a.el.muted, a.el.paused, !!a.el.srcObject]) } })()`)
  const tocando = o => o.audios.every(([, , muted, paused, src]) => !muted && !paused && src)
  await B.page.locator('#b-surdo').click()
  let o = await ouvir()
  passo('surdo cala a voz e mantém a tela no volume dela', o.surdo && o.mic === false && tocando(o) &&
    o.audios.some(([t, v]) => t === 'voz' && v === 0) && o.audios.some(([t, v]) => t === 'tela' && v === 0.25), o)
  await B.run(`(() => { const p = pessoas.get('${idA}'); p.volumes.tela = 0.4; aplicarVolumes('${idA}') })()`)
  o = await ouvir()
  passo('volume de tela mudado no surdo vale na hora', o.audios.some(([t, v]) => t === 'tela' && v === 0.4) &&
    o.audios.some(([t, v]) => t === 'voz' && v === 0), o)
  await B.page.locator('#b-surdo').click()
  o = await ouvir()
  passo('sair do surdo devolve a voz e o mic', !o.surdo && o.mic === true && tocando(o) &&
    o.audios.some(([t, v]) => t === 'voz' && v === 1) && o.audios.some(([t, v]) => t === 'tela' && v === 0.4), o)

  // várias telas
  await A.run('adicionarTela()')
  let r = await visto(B, idA, p => p.telasVivas === 2)
  passo('segunda tela chega como outra tela', r.ok, r.p)

  // recaptura (primeira tela)
  await espera(2000)
  const medir = () => B.run(`(async () => { const p = pares.get('${idA}'); return { transceivers: p.pc.getTransceivers().length, sdp: p.pc.remoteDescription?.sdp.length,
    quadros: [...(await p.pc.getStats()).values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'video').map(s => s.framesDecoded) } })()`)
  const antes = await medir()
  await A.run('recapturar()')
  await espera(2500)
  const depois = await medir()
  r = await visto(B, idA, p => p.telasVivas === 2 && p.audios.includes('tela'))
  passo('recaptura mantém as duas telas e o som, sem renegociar', r.ok && depois.transceivers === antes.transceivers &&
    depois.sdp === antes.sdp && depois.quadros.every((q, i) => q > antes.quadros[i]), { antes, depois, p: r.p })

  // parar fonte
  await A.run('pararTela(telas[0])')
  // Só a primeira tela leva som: parado, o <audio> dela sai em vez de virar voz.
  r = await visto(B, idA, p => p.telasVivas === 1 && p.audios.join() === 'voz')
  passo('parar a primeira tela deixa uma, e o som dela sai', r.ok, r.p)
  await A.run('pararCam()')
  r = await visto(B, idA, p => p.cam === 0)
  passo('parar câmera tira a câmera', r.ok, r.p)
  const ciclos = []
  for (let i = 0; i < 3; i++) {
    await A.run('adicionarTela()')
    const liga = await visto(B, idA, p => p.telasVivas === 2 && p.audios.join() === 'tela,voz')
    await A.run('pararTela(telas.at(-1))')
    const desliga = await visto(B, idA, p => p.telasVivas === 1 && p.audios.join() === 'voz')
    ciclos.push([liga.ok, desliga.ok, desliga.p?.audios])
  }
  passo('ligar e parar a tela com som 3 vezes não acumula áudio', ciclos.every(([l, d]) => l && d), ciclos)

  // entrar tarde
  const D = await aba('Davi')
  passo('4 abas conectadas', (await conectados([A, B, C, D], 3)).ok, (await conectados([A, B, C, D], 3)).estados)
  r = await visto(D, idA, p => p.telasVivas === 1 && p.audios.includes('voz'))
  const idD = (await D.ler()).eu
  let n = await negociadoCom(A, idD), q = await quadrosCrescem(D, idA)
  passo('quem entra tarde recebe a tela e a voz de quem já compartilhava', r.ok && n.ok && q.ok, { p: r.p, AparaD: n.t, quadros: q })

  // colisão de oferta: B e C ligam a câmera ao mesmo tempo
  await Promise.all([B.run('alternarCam()'), C.run('alternarCam()')])
  const idB = (await B.ler()).eu, idC = (await C.ler()).eu
  const rb = await visto(C, idB, p => p.cam === 1), rc = await visto(B, idC, p => p.cam === 1)
  passo('câmeras ligadas ao mesmo tempo chegam dos dois lados', rb.ok && rc.ok, { CvêB: rb.p, BvêC: rc.p })
  const conflitos = (await Promise.all([B, C].map(X => X.run("filaTelemetria.filter(e => ['oferta_ignorada', 'sinal_erro', 'negociacao_erro'].includes(e.evento)).map(e => e.evento)"))))
  passo('eventos de colisão (informativo)', true, conflitos)

  // queda do WebSocket: retomada com o mesmo id e mídia preservada
  const pcAntes = await C.run(`pares.get('${idA}').pc.connectionState`)
  await C.run('ws.close()')
  const ret = await ate(async () => {
    const l = await C.ler()
    return { ok: l.eu === (await C.run('meuId')) && (await C.run("ws?.readyState")) === 1, eu: l.eu }
  })
  const idCdepois = await C.run('meuId')
  r = await visto(C, idA, p => p.telasVivas === 1)
  passo('queda do WS: volta com o mesmo id e mantém a mídia', ret.ok && idCdepois === idC && r.ok && pcAntes === 'connected', { idC, idCdepois, p: r.p })

  // F5 de B: id novo, os outros recriam a conexão
  await B.page.reload()
  await B.page.waitForFunction(() => typeof meuId !== 'undefined' && meuId, null, { timeout: 30000 })
  passo('depois do F5 todos voltam a se conectar', (await conectados([A, B, C, D], 3)).ok, (await conectados([A, B, C, D], 3)).estados)
  r = await visto(B, idA, p => p.telasVivas === 1 && p.audios.includes('voz'))
  n = await negociadoCom(A, (await B.ler()).eu); q = await quadrosCrescem(B, idA)
  passo('quem recarregou recebe a tela de Ana de novo', r.ok && n.ok && q.ok, { p: r.p, AparaB: n.t, quadros: q })

  // saída
  await D.page.close()
  const saiu = await ate(async () => { const l = await A.ler(); return { ok: l.pares.length === 2 && l.pessoas.length === 2, n: l.pares.length } })
  passo('quem fecha a aba sai dos outros', saiu.ok, saiu)

  await espera(11000)                         // o lote sai a cada 10 s
  const ev = [...A.enviados, ...await A.run('filaTelemetria.map(e => e.evento)')]
  passo('telemetria registrou os eventos da malha', ['par_criado', 'ice', 'conexao', 'track', 'video_classificado'].every(e => ev.includes(e)), [...new Set(ev)])
  resultado.erros = Object.fromEntries([A, B, C].map(X => [X.nome, X.erros]))
  passo('sem erro de página', [A, B, C].every(X => !X.erros.length), resultado.erros)
} catch (e) {
  passo('roteiro', false, e.stack)
} finally {
  writeFileSync(SAIDA, JSON.stringify(resultado, null, 1))
  await browser.close()
}
