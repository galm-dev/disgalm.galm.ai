// Rollback em crash loop. O t3code não tem isto (docs/estudo-t3code-
// distribuicao.md §6); o desenho é nosso.
//
// Cada abertura de uma versão conta uma tentativa, gravada antes de qualquer
// outra coisa. A versão só vira "saudável" depois de SAUDAVEL_MS com a janela
// carregada e sem o renderer cair. Se uma versão nova passa de LIMITE
// tentativas sem nunca ficar saudável, o main pede ao atualizador a última
// versão saudável (atualizacao.js), e a versão ruim fica bloqueada para o
// atualizador não trazê-la de volta. Sair pelo menu antes de ficar saudável
// não conta como falha, a não ser que o renderer tenha caído.
//
// Não pega crash dentro do próprio Electron antes de este arquivo rodar: para
// isso seria preciso um processo supervisor fora do app.
const fs = require('node:fs')
const path = require('node:path')

const LIMITE = 3
const SAUDAVEL_MS = 60_000

// Puro, para testar: estado gravado + versão atual → estado novo e decisão.
function registrarAbertura(gravado, versao) {
  let s = gravado && typeof gravado === 'object' ? { ...gravado } : {}
  if (s.versao !== versao) {
    s = {
      versao,
      tentativas: 0,
      saudavel: false,
      ultimaSaudavel: s.saudavel ? s.versao : s.ultimaSaudavel ?? null,
      bloqueadas: Array.isArray(s.bloqueadas) ? s.bloqueadas.filter(v => v !== versao).slice(-10) : [],
    }
  }
  s.tentativas = (s.tentativas || 0) + 1
  const crashLoop = !s.saudavel && s.tentativas > LIMITE && !!s.ultimaSaudavel && s.ultimaSaudavel !== versao
  return { estado: s, crashLoop }
}

function criarSaude(app) {
  const arquivo = path.join(app.getPath('userData'), 'saude.json')
  const ler = () => { try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')) } catch { return null } }
  const gravar = s => { try { fs.mkdirSync(path.dirname(arquivo), { recursive: true }); fs.writeFileSync(arquivo, JSON.stringify(s)) } catch {} }

  const { estado, crashLoop } = registrarAbertura(ler(), app.getVersion())
  gravar(estado)
  let rendererCaiu = false
  let relogio = null

  return {
    estado,
    crashLoop,
    // Começa a contar quando a janela termina de carregar.
    janelaCarregada() {
      if (estado.saudavel || relogio) return
      relogio = setTimeout(() => {
        if (rendererCaiu) return
        Object.assign(estado, { saudavel: true, tentativas: 0, ultimaSaudavel: estado.versao })
        gravar(estado)
      }, SAUDAVEL_MS)
    },
    rendererCaiu() {
      rendererCaiu = true
      clearTimeout(relogio)
      relogio = null
    },
    // Saída pelo usuário antes de ficar saudável não é falha da versão.
    saidaLimpa() {
      if (estado.saudavel || rendererCaiu) return
      estado.tentativas = Math.max(0, estado.tentativas - 1)
      gravar(estado)
    },
    bloquear(versao) {
      if (!estado.bloqueadas.includes(versao)) estado.bloqueadas.push(versao)
      gravar(estado)
    },
    bloqueada: versao => estado.bloqueadas.includes(versao),
  }
}

module.exports = { criarSaude, registrarAbertura, LIMITE }
