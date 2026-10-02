// Auto-update pelo GitHub Releases (electron-updater), com canal escolhido
// pela pessoa: Stable (feed "latest") ou Nightly (prereleases). Modelo do
// t3code: canal persistido, padrão derivado da versão instalada, downgrade
// liberado só na troca de canal. Diferente dele: baixa sozinho em segundo
// plano e instala ao sair, ou na hora pelo menu da bandeja; nunca reinicia
// sozinho no meio de uma chamada.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const REPO = { owner: 'galm-dev', repo: 'disgalm.galm.ai' }
const PRIMEIRA_CHECAGEM_MS = 15_000
const INTERVALO_MS = 30 * 60_000

const ehNightly = v => /-nightly\./.test(v)
const arquivo = () => path.join(app.getPath('userData'), 'atualizacao.json')
function lerCanal() {
  try {
    const c = JSON.parse(fs.readFileSync(arquivo(), 'utf8')).canal
    if (c === 'stable' || c === 'nightly') return c
  } catch {}
  return ehNightly(app.getVersion()) ? 'nightly' : 'stable'
}
function gravarCanal(canal) {
  try { fs.writeFileSync(arquivo(), JSON.stringify({ canal })) } catch {}
}

// Linux só atualiza o AppImage (o atualizador troca o arquivo); dev nunca.
function suportado() {
  if (!app.isPackaged || process.env.DISGALM_SEM_ATUALIZACAO) return false
  return process.platform !== 'linux' || !!process.env.APPIMAGE
}

function criarAtualizacao({ saude, aoMudar, antesDeInstalar }) {
  const estado = {
    suportado: suportado(),
    canal: lerCanal(),
    versao: app.getVersion(),
    situacao: 'parado',      // parado | procurando | baixando | pronta | instalando | erro | em-dia
    // Versão que acabou de ser instalada por update (badge "Atualizado para…").
    recemAtualizado: saude?.estado?.tentativas === 1 && saude.estado.ultimaSaudavel &&
      saude.estado.ultimaSaudavel !== app.getVersion() ? app.getVersion() : null,
    nova: null,
    progresso: 0,
    erro: null,
  }
  const mudou = () => aoMudar?.(estado)
  if (!estado.suportado) return { estado, procurar() {}, trocarCanal() {}, instalar() {}, voltarPara: async () => false }

  const { autoUpdater } = require('electron-updater')
  autoUpdater.logger = null
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const aplicarCanal = () => {
    autoUpdater.channel = estado.canal === 'nightly' ? 'nightly' : 'latest'
    autoUpdater.allowPrerelease = estado.canal === 'nightly'
    autoUpdater.allowDowngrade = false
  }
  aplicarCanal()

  let instalarAoBaixar = false
  autoUpdater.on('checking-for-update', () => { estado.situacao = 'procurando'; mudou() })
  autoUpdater.on('update-not-available', () => { estado.situacao = 'em-dia'; mudou() })
  autoUpdater.on('update-available', info => {
    // Versão que já entrou em crash loop aqui não volta.
    if (saude.bloqueada(info.version)) { estado.situacao = 'em-dia'; mudou(); return }
    estado.situacao = 'baixando'
    estado.nova = info.version
    estado.progresso = 0
    mudou()
    autoUpdater.downloadUpdate().catch(() => {})
  })
  autoUpdater.on('download-progress', p => { estado.progresso = Math.round(p.percent); mudou() })
  autoUpdater.on('update-downloaded', info => {
    estado.situacao = 'pronta'
    estado.nova = info.version
    mudou()
    if (instalarAoBaixar) instalar()
  })
  autoUpdater.on('error', e => {
    estado.situacao = 'erro'
    estado.erro = String(e?.message || e).split('\n')[0].slice(0, 200)
    mudou()
  })

  const procurar = () => autoUpdater.checkForUpdates().catch(() => {})

  function instalar() {
    antesDeInstalar?.()
    // Avisa antes de sumir: no Windows o instalador roda calado por ~10 s.
    estado.situacao = 'instalando'
    mudou()
    // isSilent no Windows (sem assistente do NSIS), e reabre depois.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 800)
  }

  // Troca de canal: grava, aplica e procura já, permitindo descer de versão
  // (de nightly para stable) só nesta checagem.
  async function trocarCanal(canal) {
    if (canal === estado.canal) return
    estado.canal = canal
    estado.nova = null
    gravarCanal(canal)
    aplicarCanal()
    autoUpdater.allowDowngrade = true
    try { await autoUpdater.checkForUpdates() } catch {} finally { autoUpdater.allowDowngrade = false }
  }

  // Rollback: aponta o atualizador para a release de uma versão específica e
  // instala assim que baixar. Devolve false se nem conseguiu procurar.
  async function voltarPara(versao) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `https://github.com/${REPO.owner}/${REPO.repo}/releases/download/v${versao}`,
      channel: ehNightly(versao) ? 'nightly' : 'latest',
    })
    autoUpdater.allowDowngrade = true
    instalarAoBaixar = true
    try {
      const r = await autoUpdater.checkForUpdates()
      return !!r
    } catch { return false }
  }

  setTimeout(procurar, PRIMEIRA_CHECAGEM_MS)
  setInterval(procurar, INTERVALO_MS)
  return { estado, procurar, trocarCanal, instalar, voltarPara }
}

module.exports = { criarAtualizacao, ehNightly }
