// "Remover da lista" na barra de salas (3cea9fa): Chromium headless contra o
// wrangler dev de desktop/teste/e2e (Sala de produção, login de membro fixo).
// Convidado: a mesma origem, com /auth.js trocado só nesta aba por um stub de
// convite. Fora do `node --test`, como tests/e2e/malha.mjs.
//
//   node worker/node_modules/wrangler/bin/wrangler.js dev -c desktop/teste/e2e/wrangler.toml \
//     --ip 127.0.0.1 --port 8787 --persist-to /tmp/disgalm-e2e-persist
//   PLAYWRIGHT_CORE=/caminho/com/node_modules node tests/e2e/remover-lista.mjs [origem] [saida.json]
import { createRequire } from 'module'
import { readdirSync, writeFileSync } from 'fs'
const require = createRequire((process.env.PLAYWRIGHT_CORE || process.cwd()).replace(/\/?$/, '/'))
const { chromium } = require('playwright-core')

const ORIGEM = process.argv[2] || 'http://127.0.0.1:8787'
const SAIDA = process.argv[3] || '/tmp/disgalm-remover-lista.json'
const sufixo = Date.now().toString(36)
const ALFA = 'alfa-' + sufixo, BETA = 'beta-' + sufixo
const cache = process.env.HOME + '/Library/Caches/ms-playwright/'
const exe = process.env.CHROME || cache + readdirSync(cache).filter(d => d.startsWith('chromium-')).sort().pop() +
  '/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const resultado = { origem: ORIGEM, salas: [ALFA, BETA], passos: [] }
const passo = (nome, ok, dados) => { resultado.passos.push({ nome, ok, dados }); console.log(ok ? 'OK ' : 'FALHOU', nome, JSON.stringify(dados ?? '')) }

// Mesma interface de public/auth.js para um convidado já com sessão na sala.
const AUTH_CONVIDADO = sala => `window.disgalmAuth = {
  ready: Promise.resolve(), login() {}, logout: async () => {}, accessToken: async () => null,
  currentToken: () => null, isGuest: r => r === ${JSON.stringify(sala)}, member: () => false,
  guestInvite: () => ${JSON.stringify(sala)}, account: async () => null,
}
// Como o showStatus de auth.js: convite aceito mostra o formulário de nome.
document.addEventListener('DOMContentLoaded', () => { document.getElementById('guest-entry').hidden = false })`

// Semeia a lista só na primeira carga do contexto: o recarregar tem de ler o
// que a página gravou, não a semente.
const semear = ([salas, ultima]) => {
  localStorage.setItem('disgalm.ruido', 'navegador')
  if (localStorage.getItem('e2e.semeado')) return
  localStorage.setItem('e2e.semeado', '1')
  localStorage.setItem('disgalm.salas', JSON.stringify(salas))
  localStorage.setItem('disgalm.ultima', ultima)
}

const LER = `(() => ({
  ativa: sala?.cod ?? null,
  conectado: !!meuId,
  salas: JSON.parse(localStorage.getItem('disgalm.salas') || 'null'),
  ultima: localStorage.getItem('disgalm.ultima'),
  canais: [...document.querySelectorAll('#channels > *')].filter(e => !e.matches('.people')).map(e => ({
    sala: e.matches('.ativa') ? e.querySelector('strong').textContent : e.querySelector('[data-sala]')?.dataset.sala,
    ativa: e.matches('.ativa'),
    remover: !!e.querySelector('.channel-remove'),
  })),
  botoesRemover: document.querySelectorAll('.channel-remove').length,
}))()`

const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })

async function aba(semente, authStub) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] })
  await ctx.addInitScript(semear, semente)
  if (authStub) await ctx.route('**/auth.js', r => r.fulfill({ contentType: 'text/javascript', body: authStub }))
  const page = await ctx.newPage()
  // Todo request HTTP e todo quadro WebSocket enviado, para o critério de rede.
  const rede = []
  page.on('request', r => rede.push({ t: Date.now(), metodo: r.method(), url: r.url() }))
  page.on('websocket', ws => ws.on('framesent', f => rede.push({ t: Date.now(), metodo: 'WS', url: ws.url(), dado: String(f.payload).slice(0, 200) })))
  const erros = []
  page.on('pageerror', e => erros.push(e.message))
  return { ctx, page, rede, erros, ler: () => page.evaluate(LER) }
}

const naSala = (X, cod) => X.page.waitForFunction(c => sala?.cod === c && meuId, cod, { timeout: 30000 })

// Clica em remover e devolve o que saiu pela rede entre o clique e 1,5 s depois.
async function remover(X, cod) {
  const t0 = Date.now()
  await X.page.click(`[data-esquecer="${cod}"]`)
  await X.page.waitForTimeout(1500)
  return X.rede.filter(r => r.t >= t0)
}
// Telemetria e as idas e voltas da sinalização não apagam nada; o resto conta.
const suspeitos = rs => rs.filter(r => r.metodo === 'DELETE' || /remov|esquec|delet|forget/i.test(r.url + (r.dado || '')))

try {
  // ---------- membro ----------
  const M = await aba([['galm', ALFA, BETA], ALFA])
  await M.page.goto(`${ORIGEM}/?sala=${ALFA}&nome=Ana`)
  await naSala(M, ALFA)
  let l = await M.ler()
  passo('1. membro: botão só nas salas não ativas', await M.page.evaluate('disgalmAuth.member()') &&
    l.canais.length >= 3 && l.canais.every(c => c.remover === !c.ativa) && l.canais.filter(c => c.ativa).length === 1, l)

  const r1 = await remover(M, BETA)
  l = await M.ler()
  passo('3a. remover sala não ativa tira da lista; ponteiro (outra sala) fica', !l.salas.includes(BETA) &&
    !l.canais.some(c => c.sala === BETA) && l.ultima === ALFA && l.ativa === ALFA, l)

  // Fora da sala, a última sala volta a ser um item comum, com botão.
  await M.page.click('#b-sair')
  await M.page.waitForFunction(() => !sala)
  l = await M.ler()
  passo('1b. fora da sala: a última sala ganha o botão', l.ativa === null && l.ultima === ALFA &&
    l.canais.find(c => c.sala === ALFA)?.remover === true, l)
  const r2 = await remover(M, ALFA)
  l = await M.ler()
  passo('3b. remover a última sala limpa o ponteiro', !l.salas.includes(ALFA) && l.ultima === null &&
    !l.canais.some(c => c.sala === ALFA), l)

  const antesReload = M.rede.length
  await M.page.goto(`${ORIGEM}/?nome=Ana`)
  await naSala(M, 'galm')
  l = await M.ler()
  passo('3c. depois de recarregar a remoção persiste (entra na padrão, sem alfa/beta)',
    JSON.stringify(l.salas) === '["galm"]' && l.ultima === 'galm' &&
    !l.canais.some(c => c.sala === ALFA || c.sala === BETA), l)

  // Entrar de novo pelo nome, pela UI de "Nova sala".
  await M.page.click('#b-new-room')
  await M.page.fill('#new-room-name', BETA)
  await M.page.press('#new-room-name', 'Enter')
  await naSala(M, BETA)
  l = await M.ler()
  passo('4a. entrar pelo nome da sala removida funciona e ela volta à lista', l.conectado &&
    l.salas.includes(BETA) && l.ultima === BETA && l.canais.find(c => c.sala === BETA)?.ativa === true, l)
  await M.page.goto(`${ORIGEM}/?sala=${ALFA}&nome=Ana`)
  await naSala(M, ALFA)
  l = await M.ler()
  passo('4b. entrar por ?sala= na outra sala removida também funciona e ela volta', l.conectado &&
    l.salas.includes(ALFA) && l.salas.includes(BETA) && l.canais.find(c => c.sala === BETA)?.remover === true, l)

  const janelas = [...r1, ...r2]
  const todos = M.rede.slice(0, antesReload)
  passo('5. nenhuma chamada de exclusão no servidor', janelas.length === 0 && suspeitos(M.rede).length === 0, {
    duranteRemocao: janelas, suspeitosNaSessao: suspeitos(M.rede),
    metodosNaSessao: [...new Set(M.rede.map(r => r.metodo))], requestsAteReload: todos.length,
    caminhosHttp: [...new Set(M.rede.filter(r => r.metodo !== 'WS').map(r => r.metodo + ' ' + new URL(r.url).pathname))] })
  passo('membro: sem erro de página', !M.erros.length, M.erros)

  // ---------- convidado ----------
  const C = await aba([['galm', BETA, ALFA], 'galm'], AUTH_CONVIDADO(ALFA))
  await C.page.goto(`${ORIGEM}/?sala=${ALFA}`)
  await C.page.fill('#nome', 'Bia')
  await C.page.click('#entrar')
  await naSala(C, ALFA)
  const dentro = await C.ler()
  await C.page.click('#b-sair')
  await C.page.waitForFunction(() => !sala)
  const fora = await C.ler()
  passo('2. convidado não vê o botão (na sala e fora dela)', !(await C.page.evaluate('disgalmAuth.member()')) &&
    dentro.botoesRemover === 0 && fora.botoesRemover === 0 &&
    fora.canais.length === 1 && fora.canais[0].sala === ALFA && !fora.canais[0].ativa, { dentro, fora })
  passo('convidado: sem erro de página', !C.erros.length, C.erros)
} catch (e) {
  passo('roteiro', false, e.stack)
} finally {
  writeFileSync(SAIDA, JSON.stringify(resultado, null, 1))
  await browser.close()
  process.exitCode = resultado.passos.every(p => p.ok) ? 0 : 1
}
