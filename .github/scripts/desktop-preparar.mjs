// Decide o que o desktop-release.yml publica (modelo do t3code, ver
// desktop/docs/estudo-t3code-distribuicao.md §2):
//   nightly  — agenda de hora em hora, mas só publica se há commit novo desde
//              o último nightly e já passaram 6 h; dispatch manual pula as 6 h.
//              Versão <base>-nightly.<AAAAMMDD>.<run>, release prerelease.
//   stable   — dispatch manual: reconstrói o commit do último nightly com a
//              versão de desktop/package.json. Tag v<versão> empurrada: usa o
//              commit da tag, que tem de bater com package.json.
// Escreve publicar, canal, versao e sha em $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const env = process.env
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const repo = env.GITHUB_REPOSITORY
const HORAS = 6

async function releases() {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, {
    headers: { accept: 'application/vnd.github+json', ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) },
  })
  if (!r.ok) throw new Error(`releases: HTTP ${r.status}`)
  return r.json()
}
const shaDaTag = tag => { try { return git('rev-list', '-n', '1', tag) } catch { return null } }

function saida(o) {
  for (const [k, v] of Object.entries(o)) {
    console.log(`${k}=${v}`)
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`)
  }
}

const base = JSON.parse(readFileSync('desktop/package.json', 'utf8')).version
const evento = env.GITHUB_EVENT_NAME
const canal = evento === 'push' ? 'stable' : evento === 'schedule' ? 'nightly' : env.CANAL || 'nightly'
const head = git('rev-parse', 'HEAD')
const todas = await releases()
const nightlies = todas.filter(r => r.prerelease && /-nightly\./.test(r.tag_name))
const ultimoNightly = nightlies.sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0]

if (canal === 'nightly') {
  if (evento === 'schedule' && ultimoNightly) {
    const shaUltimo = shaDaTag(ultimoNightly.tag_name)
    const horas = (Date.now() - new Date(ultimoNightly.published_at)) / 36e5
    if (shaUltimo === head) { console.log('nada novo desde', ultimoNightly.tag_name); saida({ publicar: false }); process.exit(0) }
    if (horas < HORAS) { console.log(`último nightly há ${horas.toFixed(1)} h`); saida({ publicar: false }); process.exit(0) }
  }
  const data = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  saida({ publicar: true, canal, versao: `${base}-nightly.${data}.${env.GITHUB_RUN_NUMBER}`, sha: head })
} else {
  if (todas.some(r => r.tag_name === `v${base}`)) throw new Error(`a release v${base} já existe: suba a versão em desktop/package.json`)
  let sha = head
  if (evento === 'push') {
    const tag = env.GITHUB_REF_NAME
    if (tag !== `v${base}`) throw new Error(`a tag ${tag} não bate com desktop/package.json (${base})`)
  } else if (ultimoNightly) {
    // Promove o que já rodou como nightly, não o HEAD de agora.
    sha = shaDaTag(ultimoNightly.tag_name) || head
    console.log('promovendo', ultimoNightly.tag_name)
  }
  saida({ publicar: true, canal, versao: base, sha })
}
