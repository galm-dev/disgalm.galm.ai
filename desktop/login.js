// Volta do login feito no navegador do sistema (RFC 8252, redirecionamento
// por loopback). O app escuta em 127.0.0.1 numa porta livre; a página
// /auth/callback da web, ao ver um state "desktop.<porta>.…", repassa para cá
// a query que recebeu do auth. O code só serve com o verificador PKCE, que
// ficou no app.
const http = require('node:http')

const PAGINA = `<!doctype html><meta charset="utf-8"><title>Disgalm</title>
<style>body{font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0}</style>
<p>Login feito. Pode fechar esta aba e voltar ao Disgalm.</p>`

// aoVoltar(query) recebe a query inteira (code, state, iss ou error) quando o
// state é o esperado. Um login pendente por vez; o servidor fica de pé
// enquanto o app vive e só responde a /callback.
function criarRetorno(aoVoltar) {
  let esperado = null
  let porta = null
  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== '/callback') return res.writeHead(404).end()
    const state = url.searchParams.get('state')
    if (!esperado || state !== esperado) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Este login não foi pedido por este app. Tente entrar de novo pelo Disgalm.')
    }
    esperado = null
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGINA)
    aoVoltar(url.searchParams)
  })

  return {
    // Sobe o servidor (uma vez) e devolve a porta.
    async preparar() {
      if (porta) return porta
      await new Promise((ok, erro) => {
        servidor.once('error', erro)
        servidor.listen(0, '127.0.0.1', ok)
      })
      porta = servidor.address().port
      return porta
    },
    esperar(state) { esperado = state },
    fechar() { servidor.close() },
  }
}

// O app só abre no navegador o /authorize do auth, com a volta para a
// origem do app e o state que acabou de registrar.
function urlDeLoginValida(href, state, origem, issuer = 'https://auth.galm.ai') {
  let u
  try { u = new URL(href) } catch { return false }
  return u.origin === issuer && u.pathname === '/authorize' &&
    u.searchParams.get('state') === state && /^desktop\.\d{4,5}\.[A-Za-z0-9_-]{16,}$/.test(state) &&
    u.searchParams.get('redirect_uri') === `${origem}/auth/callback`
}

module.exports = { criarRetorno, urlDeLoginValida }
