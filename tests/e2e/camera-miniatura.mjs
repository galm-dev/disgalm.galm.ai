// Câmera + tela no DOM real: miniatura no tile e no palco, com vídeo decodificando,
// em quem envia, em quem recebe, em quem entra tarde e depois de F5 e queda do WS.
// Mesma preparação de tests/e2e/malha.mjs (wrangler dev de desktop/teste/e2e e
// playwright-core fora do repo). CHROME aponta o Chromium fora do Mac.
//
//   PLAYWRIGHT_CORE=/caminho/com/node_modules node tests/e2e/camera-miniatura.mjs [origem] [saida.json]
import { createRequire } from 'module'
import { readdirSync, writeFileSync } from 'fs'
const require = createRequire((process.env.PLAYWRIGHT_CORE || process.cwd()).replace(/\/?$/, '/'))
const { chromium } = require('playwright-core')

const ORIGEM = process.argv[2] || 'http://127.0.0.1:8787'
const SAIDA = process.argv[3] || '/tmp/disgalm-camera-miniatura.json'
const SALA = 'cammini-' + Date.now().toString(36)
const cache = process.env.HOME + '/Library/Caches/ms-playwright/'
const exe = process.env.CHROME || cache + readdirSync(cache).filter(d => d.startsWith('chromium-')).sort().pop() +
  '/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const espera = ms => new Promise(r => setTimeout(r, ms))
const resultado = { origem: ORIGEM, sala: SALA, passos: [] }
const passo = (nome, ok, dados) => { resultado.passos.push({ nome, ok, dados }); console.log(ok ? 'OK ' : 'FALHOU', nome, JSON.stringify(dados ?? '')) }

// Tela falsa: canvas animado. A câmera vem do --use-fake-device-for-media-stream.
const falsos = () => {
  localStorage.setItem('disgalm.ruido', 'navegador')
  navigator.mediaDevices.getDisplayMedia = async () => {
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360
    const g = cv.getContext('2d'); let n = 0
    setInterval(() => { g.fillStyle = `hsl(${n++ % 360},80%,50%)`; g.fillRect(0, 0, 640, 360) }, 33)
    return cv.captureStream(30)
  }
}

// O que a página mostra para uma pessoa: tile e, se ela está em foco, o palco.
// "vivo" = há track live e o elemento já decodificou imagem (videoWidth > 0).
const VER = id => `(() => {
  const v = el => el && { track: el.srcObject?.getVideoTracks()[0]?.readyState ?? null, largura: el.videoWidth,
    vivo: el.srcObject?.getVideoTracks()[0]?.readyState === 'live' && el.videoWidth > 0, oculto: el.hidden }
  const t = document.getElementById('t-${id}')
  return { foco, camNoCentro,
    tile: t && { tela: v(t.querySelector('.v-tela')), cam: v(t.querySelector('.v-cam')), mini: !!t.querySelector('.v-cam.mini') },
    palco: v(document.getElementById('v-palco')), palcoMini: v(document.getElementById('v-palco-mini')) }
})()`

const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })

async function aba(nome) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] })
  await ctx.addInitScript(falsos)
  const page = await ctx.newPage()
  const erros = []
  page.on('pageerror', e => erros.push(e.message))
  await page.goto(`${ORIGEM}/?sala=${SALA}&nome=${nome}`)
  await page.waitForFunction(() => typeof meuId !== 'undefined' && meuId, null, { timeout: 30000 })
  return { nome, page, erros, run: code => page.evaluate(code), ver: id => page.evaluate(VER(id)) }
}

async function ate(fn, ms = 20000, passoMs = 300) {
  const fim = Date.now() + ms
  let ultimo
  while (Date.now() < fim) { ultimo = await fn(); if (ultimo?.ok) return ultimo; await espera(passoMs) }
  return ultimo
}
const quando = (X, id, cond, ms) => ate(async () => { const v = await X.ver(id); return { ok: cond(v), v } }, ms)

// Tile com tela grande e câmera no canto; palco com a tela e a câmera na miniatura.
const tileComMini = v => v.tile?.mini && v.tile.tela?.vivo && v.tile.cam?.vivo
const palcoComMini = v => v.palco?.vivo && v.palcoMini?.vivo && !v.palcoMini.oculto

try {
  const A = await aba('Ana'), B = await aba('Bia')
  const idA = await A.run('meuId')

  // Tela primeiro, câmera depois: era o caso em que o palco local ficava sem miniatura.
  await A.run('adicionarTela()')
  await A.run('alternarCam()')
  let r = await quando(A, 'local', v => v.foco === 'local' && tileComMini(v) && palcoComMini(v))
  passo('Ana (tela e depois câmera): tile e palco locais com a câmera na miniatura', r.ok, r.v)

  r = await quando(B, idA, tileComMini)
  passo('Bia vê o tile de Ana com a tela e a câmera no canto', r.ok, r.v)
  await B.run(`focar('${idA}')`)
  r = await quando(B, idA, palcoComMini)
  passo('Bia foca Ana: tela no palco e câmera na miniatura', r.ok, r.v)

  // Trocar no palco e voltar.
  await B.page.locator('#v-palco-mini').click()
  r = await quando(B, idA, v => v.camNoCentro && palcoComMini(v))
  passo('clique na miniatura troca câmera e tela no palco', r.ok, r.v)
  await B.page.locator('#v-palco-mini').click()

  // Câmera desligada durante a tela: nada de câmera parada no palco de quem envia.
  await A.page.locator('#v-palco-mini').click()          // câmera no centro antes de desligar
  await A.run('pararCam()')
  r = await quando(A, 'local', v => !v.tile?.mini && v.palco?.vivo && v.palcoMini?.oculto && !v.camNoCentro)
  passo('Ana desliga a câmera: a tela volta ao centro e a miniatura some', r.ok, r.v)
  r = await quando(B, idA, v => !v.tile?.mini && v.tile?.tela?.vivo && v.palco?.vivo && v.palcoMini?.oculto)
  passo('Bia: sem câmera de Ana, tile e palco só com a tela', r.ok, r.v)

  await A.run('alternarCam()')
  r = await quando(A, 'local', v => tileComMini(v) && palcoComMini(v) && !v.camNoCentro)
  passo('Ana religa a câmera: volta à miniatura, não ao centro', r.ok, r.v)
  r = await quando(B, idA, v => tileComMini(v) && palcoComMini(v))
  passo('Bia vê a câmera de Ana de volta na miniatura', r.ok, r.v)

  // Entrar tarde.
  const C = await aba('Caio')
  r = await quando(C, idA, tileComMini, 30000)
  passo('Caio entra tarde e vê a tela de Ana com a câmera no canto', r.ok, r.v)

  // Queda do WebSocket de quem envia: a mídia segue e a miniatura também.
  await A.run('ws.close()')
  await ate(async () => ({ ok: (await A.run('ws?.readyState')) === 1 }))
  await espera(2000)
  r = await quando(B, idA, v => tileComMini(v) && palcoComMini(v))
  passo('depois da queda do WS de Ana, Bia segue com a miniatura', r.ok, r.v)

  // F5 de quem recebe.
  await B.page.reload()
  await B.page.waitForFunction(() => typeof meuId !== 'undefined' && meuId, null, { timeout: 30000 })
  r = await quando(B, idA, tileComMini, 30000)
  passo('Bia recarrega e vê de novo a tela de Ana com a câmera no canto', r.ok, r.v)

  // Câmera sozinha depois de parar a tela.
  await A.run('pararTela(telas[0])')
  r = await quando(C, idA, v => !v.tile?.mini && v.tile?.cam?.vivo && !v.tile?.tela)
  passo('Ana para a tela: Caio vê só a câmera, sem miniatura', r.ok, r.v)

  resultado.erros = Object.fromEntries([A, B, C].map(X => [X.nome, X.erros]))
  passo('sem erro de página', [A, B, C].every(X => !X.erros.length), resultado.erros)
} catch (e) {
  passo('roteiro', false, e.stack)
} finally {
  writeFileSync(SAIDA, JSON.stringify(resultado, null, 1))
  await browser.close()
  process.exitCode = resultado.passos.every(p => p.ok) ? 0 : 1
}
