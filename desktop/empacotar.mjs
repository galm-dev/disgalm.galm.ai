// Empacota o app para a plataforma em que roda, sem ferramenta de
// distribuição: copia o Electron pronto de node_modules/electron/dist, põe o
// app em resources/app e a UI em resources/public (o main.js procura ../public)
// e compacta. Sem assinatura nem instalador.
//
//   npm install && node empacotar.mjs      → dist/Disgalm-<plataforma>-<arch>.{zip,tar.gz}
//
// No Windows, rode antes `npm run build:native`: o .node vai junto. No Mac, o
// bundle é reassinado ad hoc (mexer no Electron.app quebra a assinatura dele).
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const AQUI = import.meta.dirname
const PUBLIC = resolve(AQUI, '..', 'public')
const ELECTRON = join(AQUI, 'node_modules', 'electron', 'dist')
const { version } = JSON.parse(readFileSync(join(AQUI, 'package.json'), 'utf8'))
const plataforma = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform]
const nome = `Disgalm-${plataforma}-${process.arch}`
const saida = join(AQUI, 'dist', nome)

if (!existsSync(ELECTRON)) throw new Error('falta o Electron: rode npm install (e node node_modules/electron/install.js)')
rmSync(saida, { recursive: true, force: true })
mkdirSync(saida, { recursive: true })

// Arquivos do app; o resto de desktop/ (testes, fontes C++, node_modules) fica.
const APP = ['main.js', 'preload.js', 'captura.js', 'alvo.js', 'login.js', 'renderer']
function copiarApp(destino) {
  mkdirSync(destino, { recursive: true })
  for (const f of APP) cpSync(join(AQUI, f), join(destino, f), { recursive: true })
  writeFileSync(join(destino, 'package.json'),
    JSON.stringify({ name: 'disgalm', productName: 'Disgalm', version, main: 'main.js' }, null, 2))
  const nativo = join(AQUI, 'native', 'build', 'Release', 'loopback.node')
  if (process.platform === 'win32') {
    if (!existsSync(nativo)) throw new Error('falta o módulo nativo: rode npm run build:native')
    mkdirSync(join(destino, 'native', 'build', 'Release'), { recursive: true })
    cpSync(nativo, join(destino, 'native', 'build', 'Release', 'loopback.node'))
  }
}

let recursos
if (process.platform === 'darwin') {
  const bundle = join(saida, 'Disgalm.app')
  cpSync(join(ELECTRON, 'Electron.app'), bundle, { recursive: true, verbatimSymlinks: true })
  recursos = join(bundle, 'Contents', 'Resources')
  // Nome na barra de menus e no Dock, e textos dos pedidos de permissão.
  const plist = join(bundle, 'Contents', 'Info.plist')
  const set = (chave, valor) => execFileSync('plutil', ['-replace', chave, '-string', valor, plist])
  set('CFBundleName', 'Disgalm')
  set('CFBundleDisplayName', 'Disgalm')
  set('CFBundleIdentifier', 'ai.galm.disgalm')
  set('NSMicrophoneUsageDescription', 'O Disgalm usa o microfone na chamada.')
  set('NSCameraUsageDescription', 'O Disgalm usa a câmera quando você liga o vídeo.')
} else {
  cpSync(ELECTRON, saida, { recursive: true, verbatimSymlinks: true })
  recursos = join(saida, 'resources')
  const exe = process.platform === 'win32' ? ['electron.exe', 'Disgalm.exe'] : ['electron', 'disgalm']
  renameSync(join(saida, exe[0]), join(saida, exe[1]))
}
rmSync(join(recursos, 'default_app.asar'), { force: true })
copiarApp(join(recursos, 'app'))
cpSync(PUBLIC, join(recursos, 'public'), { recursive: true })

if (process.platform === 'darwin')
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(saida, 'Disgalm.app')], { stdio: 'inherit' })

// Compacta com o que cada sistema já tem.
const dist = join(AQUI, 'dist')
let pacote
if (process.platform === 'win32') {
  pacote = join(dist, `${nome}.zip`)
  rmSync(pacote, { force: true })
  // O tar do Windows escreve zip; o Compress-Archive falha com datas antigas.
  execFileSync('tar', ['-a', '-cf', pacote, '-C', dist, nome])
} else if (process.platform === 'darwin') {
  pacote = join(dist, `${nome}.zip`)
  rmSync(pacote, { force: true })
  execFileSync('ditto', ['-c', '-k', '--keepParent', join(saida, 'Disgalm.app'), pacote])
} else {
  pacote = join(dist, `${nome}.tar.gz`)
  execFileSync('tar', ['-czf', pacote, '-C', dist, nome])
}
console.log(pacote)
