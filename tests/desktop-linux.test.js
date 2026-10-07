import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const { entradaDesktop, integrarLinux } = createRequire(import.meta.url)('../desktop/linux.js')
const linux = { skip: process.platform !== 'linux' && 'só no Linux' }

// nativeImage de mentira: o PNG é o tamanho pedido em texto.
const nativeImage = {
  createFromPath: () => ({ resize: ({ width }) => ({ toPNG: () => Buffer.from(`png ${width}`) }) }),
}

function dados() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'disgalm-xdg-'))
}

test('o .desktop aponta para o AppImage, usa o ícone do tema e liga a janela pelo WM class', () => {
  const t = entradaDesktop('/home/x/Applications/Disgalm.AppImage')
  assert.match(t, /^Exec=\/home\/x\/Applications\/Disgalm\.AppImage %U$/m)
  assert.match(t, /^Icon=disgalm$/m)
  assert.match(t, /^StartupWMClass=Disgalm$/m)
})

test('caminho com espaço vai entre aspas no Exec', () => {
  assert.match(entradaDesktop('/home/x/Meus Apps/Disgalm.AppImage'), /^Exec="\/home\/x\/Meus Apps\/Disgalm\.AppImage" %U$/m)
})

test('o AppImage grava o .desktop e o ícone em 256 e 512 px', linux, () => {
  const d = dados()
  integrarLinux({ nativeImage, icone: 'icon.png', appimage: '/a/Disgalm.AppImage', env: { XDG_DATA_HOME: d } })
  assert.match(fs.readFileSync(path.join(d, 'applications', 'disgalm.desktop'), 'utf8'), /Exec=\/a\/Disgalm\.AppImage/)
  for (const px of [256, 512])
    assert.equal(fs.readFileSync(path.join(d, 'icons', 'hicolor', `${px}x${px}`, 'apps', 'disgalm.png'), 'utf8'), `png ${px}`)
})

test('troca o ícone antigo e não regrava o que já está igual', linux, () => {
  const d = dados()
  const png = path.join(d, 'icons', 'hicolor', '256x256', 'apps', 'disgalm.png')
  fs.mkdirSync(path.dirname(png), { recursive: true })
  fs.writeFileSync(png, 'ícone do Electron')
  const opcoes = { nativeImage, icone: 'icon.png', appimage: '/a/Disgalm.AppImage', env: { XDG_DATA_HOME: d } }
  integrarLinux(opcoes)
  assert.equal(fs.readFileSync(png, 'utf8'), 'png 256')
  const antes = fs.statSync(png).mtimeMs
  integrarLinux(opcoes)
  assert.equal(fs.statSync(png).mtimeMs, antes)
})

test('fora do AppImage (dev) não grava nada', linux, () => {
  const d = dados()
  integrarLinux({ nativeImage, icone: 'icon.png', appimage: '', env: { XDG_DATA_HOME: d } })
  assert.deepEqual(fs.readdirSync(d), [])
})
