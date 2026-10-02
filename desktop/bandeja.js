// Ícone na bandeja (Windows, Linux) ou na barra de menus (Mac). Fechar a
// janela não fecha o app: ele continua na sala, e o ícone diz o que está
// aberto. Bolinha vermelha: microfone aberto. Selo verde: tela compartilhada.
// O menu compartilha a última tela escolhida sem abrir a janela.
const { app, Menu, Tray, nativeImage, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// Desenha o ícone num canvas de 64 px numa janela escondida: sem arquivo de
// imagem no repo, e o "G" sai na mesma família da marca.
function desenho({ mic, tela }) {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  g.fillStyle = '#7c8295'
  g.beginPath(); g.roundRect(4, 4, 56, 56, 14); g.fill()
  g.fillStyle = '#ffffff'
  g.font = '900 42px "Archivo Black", "Arial Black", "Helvetica Neue", sans-serif'
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText('G', 32, 35)
  const selo = (x, y, cor, forma) => {
    g.fillStyle = '#07080b'
    g.beginPath(); forma === 'circulo' ? g.arc(x, y, 15, 0, 7) : g.roundRect(x - 15, y - 12, 30, 24, 6); g.fill()
    g.fillStyle = cor
    g.beginPath(); forma === 'circulo' ? g.arc(x, y, 11, 0, 7) : g.roundRect(x - 11, y - 8, 22, 16, 4); g.fill()
  }
  if (mic) selo(49, 15, '#f04444', 'circulo')
  if (tela) selo(48, 50, '#3ddc84', 'retangulo')
  return c.toDataURL('image/png')
}

async function desenharIcones() {
  const w = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } })
  await w.loadURL('data:text/html,<meta charset="utf-8"><body></body>')
  const icones = {}
  for (const mic of [false, true]) for (const tela of [false, true]) {
    const url = await w.webContents.executeJavaScript(`(${desenho})(${JSON.stringify({ mic, tela })})`)
    const grande = nativeImage.createFromDataURL(url)
    // Tamanho da área de notificação: 16 no Windows, 18 pt no Mac, 22–24 no KDE.
    const base = process.platform === 'win32' ? 16 : process.platform === 'darwin' ? 18 : 24
    const img = nativeImage.createEmpty()
    img.addRepresentation({ scaleFactor: 1, width: base, height: base, dataURL: grande.resize({ width: base }).toDataURL() })
    img.addRepresentation({ scaleFactor: 2, width: base * 2, height: base * 2,
      dataURL: grande.resize({ width: base * 2 }).toDataURL() })
    icones[`${+mic}${+tela}`] = img
  }
  w.destroy()
  return icones
}

// Última fonte escolhida no seletor, para o menu da bandeja.
const arquivo = () => path.join(app.getPath('userData'), 'ultima-tela.json')
function lerUltima() {
  try { return JSON.parse(fs.readFileSync(arquivo(), 'utf8')) } catch { return null }
}
function gravarUltima(fonte) {
  try { fs.writeFileSync(arquivo(), JSON.stringify({ id: fonte.id, nome: fonte.nome, tipo: fonte.tipo })) } catch {}
}

// Telas mantêm o id entre sessões; janelas ganham id novo a cada abertura, e
// aí vale o nome (título da janela).
function acharUltima(fontes, ultima) {
  if (!ultima) return null
  return fontes.find(f => f.id === ultima.id) ||
    (ultima.tipo === 'janela' ? fontes.find(f => f.tipo === 'janela' && f.nome === ultima.nome) : null)
}

async function criarBandeja({ janela, comando, sair }) {
  const icones = await desenharIcones()
  const tray = new Tray(icones['00'])
  let estado = { sala: null, mic: false, telas: 0 }

  const rotuloUltima = () => {
    const u = lerUltima()
    if (process.platform === 'linux') return 'Compartilhar tela…'
    if (!u) return 'Compartilhar tela…'
    return `Compartilhar a última: ${u.tipo === 'tela' ? 'tela inteira' : u.nome}`.slice(0, 60)
  }

  function atualizar() {
    tray.setImage(icones[`${+estado.mic}${+(estado.telas > 0)}`])
    const partes = ['Disgalm']
    if (estado.sala) partes.push(`sala ${estado.sala}`)
    if (estado.mic) partes.push('microfone aberto')
    if (estado.telas) partes.push(estado.telas > 1 ? `${estado.telas} telas compartilhadas` : 'tela compartilhada')
    tray.setToolTip(partes.join(' · '))
    const naSala = !!estado.sala
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: estado.sala ? `Na sala ${estado.sala}` : 'Fora da sala', enabled: false },
      { type: 'separator' },
      { label: rotuloUltima(), enabled: naSala, click: () => comando('tela') },
      { label: 'Parar de compartilhar', enabled: naSala && estado.telas > 0, click: () => comando('parar') },
      { label: estado.mic ? 'Silenciar microfone' : 'Ativar microfone', enabled: naSala, click: () => comando('mic') },
      { type: 'separator' },
      { label: 'Abrir Disgalm', click: () => mostrar() },
      { label: 'Sair', click: () => sair() },
    ]))
  }

  function mostrar() {
    const w = janela()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }

  // Clique simples abre a janela no Windows e no Linux; no Mac o clique abre o
  // menu, como os outros ícones da barra.
  if (process.platform !== 'darwin') tray.on('click', mostrar)
  atualizar()

  return {
    estado(novo) { estado = { ...estado, ...novo }; atualizar() },
    mostrar,
    destruir() { tray.destroy() },
  }
}

module.exports = { criarBandeja, lerUltima, gravarUltima, acharUltima }
