// No Linux, o menu de aplicativos e a barra de tarefas do KDE tiram o nome e
// o ícone do .desktop do usuário, não da janela nem de dentro do AppImage.
// Escritos uma vez à mão, eles ficavam com o ícone antigo (o do Electron) para
// sempre. O AppImage os reescreve a cada abertura: o caminho do arquivo e o
// ícone acompanham cada versão, inclusive as trocadas pelo atualizador.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const NOME = 'disgalm'
const TAMANHOS = [256, 512]

// Exec com espaço ou aspas vai entre aspas, como pede a especificação.
function argumento(s) {
  return /[\s"'\\$`]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s
}

function entradaDesktop(appimage) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Disgalm',
    'GenericName=Compartilhamento de tela',
    'Comment=Salas de voz e tela da GALM, com o áudio do sistema sem o Discord',
    `Exec=${argumento(appimage)} %U`,
    `Icon=${NOME}`,
    'Terminal=false',
    'Categories=Network;',
    // A janela se apresenta como "Disgalm" (productName): é assim que o KDE
    // liga a janela a este arquivo.
    'StartupWMClass=Disgalm',
    'X-AppImage-Integrate=false',
    '',
  ].join('\n')
}

// Grava só o que mudou, para não acordar o cache de ícones à toa.
function gravar(arquivo, conteudo) {
  try {
    if (fs.readFileSync(arquivo).equals(Buffer.from(conteudo))) return false
  } catch {}
  fs.mkdirSync(path.dirname(arquivo), { recursive: true })
  fs.writeFileSync(arquivo, conteudo)
  return true
}

function integrarLinux({ nativeImage, icone, appimage = process.env.APPIMAGE, env = process.env }) {
  if (process.platform !== 'linux' || !appimage) return
  const dados = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  try {
    const imagem = nativeImage.createFromPath(icone)
    const hicolor = path.join(dados, 'icons', 'hicolor')
    let mudou = false
    for (const px of TAMANHOS) {
      const png = imagem.resize({ width: px, height: px, quality: 'best' }).toPNG()
      mudou = gravar(path.join(hicolor, `${px}x${px}`, 'apps', `${NOME}.png`), png) || mudou
    }
    // O mtime da raiz do tema é o que invalida o cache de ícones.
    if (mudou) fs.utimesSync(hicolor, new Date(), new Date())
    gravar(path.join(dados, 'applications', `${NOME}.desktop`), entradaDesktop(appimage))
  } catch (e) {
    console.error('integração com o desktop Linux falhou:', e.message)
  }
}

module.exports = { entradaDesktop, integrarLinux }
