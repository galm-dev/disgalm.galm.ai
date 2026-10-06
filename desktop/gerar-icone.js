// Gera build/icon.png (1024 px) com o mesmo desenho do ícone da bandeja. O
// electron-builder tira dele o .icns, o .ico e o ícone do AppImage.
// Uso: npm run icone (e commitar o PNG).
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { desenho } = require('./bandeja.js')
const { completo } = require('./marca.js')

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await w.loadURL('data:text/html,<meta charset="utf-8"><body></body>')
  // Quadrado de 824 px em 1024, como os ícones do macOS: 824 * 64 / 56 ≈ 942.
  const url = await w.webContents.executeJavaScript(
    `(${desenho})(${JSON.stringify({ mic: false, tela: false, px: 1024, margem: 41, simbolo: completo, diametro: 34, brilho: true })})`)
  const destino = path.join(__dirname, 'build', 'icon.png')
  fs.writeFileSync(destino, nativeImage.createFromDataURL(url).toPNG())
  console.log(destino)
  app.quit()
})
