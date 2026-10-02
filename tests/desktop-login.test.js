import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'

const codigo = readFileSync(new URL('../public/auth.js', import.meta.url), 'utf8')
const { criarRetorno, urlDeLoginValida } = createRequire(import.meta.url)('../desktop/login.js')
const ISSUER = 'https://auth.galm.ai'
const STATE = 'desktop.51234.abcdefghijklmnopqrstuv'

// Roda o auth.js numa página falsa em `href`. Devolve o que ele fez com a
// navegação e com a rede.
function pagina(href, { pendente = null, desktop = null } = {}) {
  const url = new URL(href)
  const feito = { replace: null, assign: null, fetch: [] }
  const store = new Map(pendente ? [['disgalm.oauth', JSON.stringify(pendente)]] : [])
  const elementos = {}
  const el = id => (elementos[id] ??= { hidden: false, textContent: '', classList: { toggle() {} }, addEventListener() {} })
  const window = {}
  const ctx = {
    window, URL, URLSearchParams, TextEncoder, TextDecoder, crypto, btoa, atob, Uint8Array, Promise, JSON, Error,
    Object, Date, Math, Number, String, Event: class {}, dispatchEvent() {}, setTimeout() {}, addEventListener() {},
    location: {
      href, pathname: url.pathname, search: url.search, hash: url.hash, origin: url.origin,
      replace: u => { feito.replace = u }, assign: u => { feito.assign = u },
    },
    history: { replaceState() {} },
    sessionStorage: {
      getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k),
    },
    navigator: {},
    document: { getElementById: el, addEventListener() {} },
    fetch: async (u, o) => { feito.fetch.push([String(u), o]); return { status: 401, ok: false, json: async () => ({}) } },
  }
  if (desktop) window.disgalmDesktop = { login: desktop }
  runInNewContext(codigo, ctx)
  return { feito, store, auth: window.disgalmAuth, el }
}

const espera = () => new Promise(r => setTimeout(r, 20))

test('callback no navegador com state do app repassa a query inteira para o loopback', async () => {
  const q = `code=c0d3&state=${STATE}&iss=${encodeURIComponent(ISSUER)}`
  const { feito } = pagina(`https://disgalm.galm.ai/auth/callback?${q}`)
  await espera()
  assert.equal(feito.replace, `http://127.0.0.1:51234/callback?${q}`)
  assert.equal(feito.fetch.length, 0)          // não troca o code nem tenta refresh
})

test('erro do auth também volta para o app', async () => {
  const { feito } = pagina(`https://disgalm.galm.ai/auth/callback?error=access_denied&state=${STATE}`)
  await espera()
  assert.match(feito.replace, /^http:\/\/127\.0\.0\.1:51234\/callback\?error=access_denied/)
})

test('callback com login pendente desta aba segue o fluxo da web', async () => {
  const pendente = { verifier: 'v', state: STATE, returnTo: '/' }
  const q = `code=c0d3&state=${STATE}&iss=${encodeURIComponent(ISSUER)}`
  const { feito } = pagina(`https://disgalm.galm.ai/auth/callback?${q}`, { pendente })
  await espera()
  assert.equal(feito.replace, null)
  assert.equal(feito.fetch[0][0], '/auth/code')
  assert.equal(JSON.parse(feito.fetch[0][1].body).code_verifier, 'v')
})

test('state comum ou porta fora da faixa não sai da página', async () => {
  for (const state of ['abcdefghijklmnopqrstuv', 'desktop.80.abcdefghijklmnopqrstuv', 'desktop.70000.abcdefghijklmnopqrstuv']) {
    const { feito } = pagina(`https://disgalm.galm.ai/auth/callback?code=c&state=${state}`)
    await espera()
    assert.equal(feito.replace, null, state)
  }
})

test('na web, Entrar navega para o authorize como antes', async () => {
  const { feito, auth } = pagina('https://disgalm.galm.ai/')
  await auth.login()
  const u = new URL(feito.assign)
  assert.equal(u.origin + u.pathname, `${ISSUER}/authorize`)
  assert.doesNotMatch(u.searchParams.get('state'), /^desktop\./)
})

test('no app, Entrar abre o navegador com o state do loopback e guarda o verificador', async () => {
  const abertos = []
  const desktop = { preparar: async () => 51234, abrir: async (url, state) => abertos.push([url, state]) }
  const { feito, store, auth, el } = pagina('https://disgalm.galm.ai/', { desktop })
  await auth.login()
  assert.equal(feito.assign, null)
  const [[url, state]] = abertos
  assert.match(state, /^desktop\.51234\.[A-Za-z0-9_-]{16,}$/)
  assert.equal(new URL(url).searchParams.get('state'), state)
  assert.equal(JSON.parse(store.get('disgalm.oauth')).state, state)
  assert.ok(urlDeLoginValida(url, state, 'https://disgalm.galm.ai'))
  assert.match(el('auth-state').textContent, /navegador/)
})

test('o app só abre o authorize do auth, com a volta para a própria origem', () => {
  const ok = `${ISSUER}/authorize?state=${STATE}&redirect_uri=${encodeURIComponent('https://disgalm.galm.ai/auth/callback')}`
  assert.ok(urlDeLoginValida(ok, STATE, 'https://disgalm.galm.ai'))
  assert.ok(!urlDeLoginValida(ok.replace(ISSUER, 'https://evil.example'), STATE, 'https://disgalm.galm.ai'))
  assert.ok(!urlDeLoginValida(ok, 'desktop.51234.outrooutrooutrooutro', 'https://disgalm.galm.ai'))
  assert.ok(!urlDeLoginValida('file:///etc/passwd', STATE, 'https://disgalm.galm.ai'))
})

test('loopback aceita só o state esperado, uma vez', async () => {
  const voltas = []
  const r = criarRetorno(q => voltas.push(q.toString()))
  const porta = await r.preparar()
  assert.equal(await r.preparar(), porta)
  const base = `http://127.0.0.1:${porta}/callback`
  assert.equal((await fetch(`${base}?code=c&state=${STATE}`)).status, 400)  // ninguém esperando
  r.esperar(STATE)
  assert.equal((await fetch(`${base}?code=c&state=desktop.1.errado`)).status, 400)
  const ok = await fetch(`${base}?code=c&state=${STATE}`)
  assert.equal(ok.status, 200)
  assert.match(await ok.text(), /voltar ao Disgalm/)
  assert.equal((await fetch(`${base}?code=c&state=${STATE}`)).status, 400)  // não aceita de novo
  assert.equal((await fetch(`http://127.0.0.1:${porta}/outra`)).status, 404)
  assert.deepEqual(voltas, [`code=c&state=${STATE}`])
  r.fechar()
})
