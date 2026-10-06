// Ícone na bandeja (Windows, Linux) ou na barra de menus (Mac). Fechar a
// janela não fecha o app: ele continua na sala, e o ícone diz o que está
// aberto. Bolinha vermelha: microfone aberto. Selo verde: tela compartilhada.
// O menu compartilha a última tela escolhida sem abrir a janela.
const { app, Menu, Tray, nativeImage, BrowserWindow } = require('electron')
const { simplificado } = require('./marca.js')
const fs = require('node:fs')
const path = require('node:path')

// Desenha o ícone num canvas numa janela escondida, no espaço de 64 px: o
// símbolo GALM em Névoa num quadrado Noite, como o ícone de app da marca. O
// quadrado escuro mantém o símbolo legível em bandeja clara e escura. O ícone
// do app (build/icon.png) sai do mesmo desenho, por gerar-icone.js; a margem é
// a grade dos ícones do Mac. A função roda serializada no renderer, então o
// símbolo (marca.js) chega como parâmetro.
function desenho({ mic, tela, px = 64, margem = 0, simbolo, diametro = 46, brilho = false }) {
  const c = document.createElement('canvas')
  c.width = c.height = px
  const g = c.getContext('2d')
  const s = (px - 2 * margem) / 64
  const espaco = ctx => { ctx.setTransform(s, 0, 0, s, margem, margem) }
  espaco(g)
  g.fillStyle = '#07080b'
  g.beginPath(); g.roundRect(4, 4, 56, 56, 14); g.fill()
  if (brilho) {
    const luz = g.createRadialGradient(20, 10, 0, 20, 10, 44)
    luz.addColorStop(0, 'rgba(180, 190, 203, 0.12)')
    luz.addColorStop(1, 'rgba(180, 190, 203, 0)')
    g.fillStyle = luz
    g.beginPath(); g.roundRect(4, 4, 56, 56, 14); g.fill()
  }
  // O recorte (destination-out) fura só o canvas do símbolo, não o quadrado.
  const m = document.createElement('canvas')
  m.width = m.height = px
  const h = m.getContext('2d')
  espaco(h)
  const k = diametro / (2 * simbolo.raio)
  h.transform(k, 0, 0, k, 32 - 50 * k, 32 - 50 * k)
  h.fillStyle = '#edeef2'
  h.beginPath(); h.arc(50, 50, simbolo.raio, 0, 7); h.fill()
  h.globalCompositeOperation = 'destination-out'
  h.lineCap = 'round'
  for (const [d, largura] of simbolo.ondas) { h.lineWidth = largura; h.stroke(new Path2D(d)) }
  for (const d of simbolo.estrelas) h.fill(new Path2D(d))
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.drawImage(m, 0, 0)
  espaco(g)
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
    const url = await w.webContents.executeJavaScript(`(${desenho})(${JSON.stringify({ mic, tela, simbolo: simplificado })})`)
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

async function criarBandeja({ janela, comando, sair, atualizacao }) {
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
      ...itensDeAtualizacao(),
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

  // Versão, canal e update. Sem suporte (dev, Linux fora do AppImage), só a versão.
  function itensDeAtualizacao() {
    const a = atualizacao?.estado
    const versao = { label: `Disgalm ${app.getVersion()}`, enabled: false }
    if (!a?.suportado) return [versao, { type: 'separator' }]
    const itens = [versao]
    if (a.situacao === 'pronta') {
      const emChamada = estado.sala && (estado.mic || estado.telas)
      itens.push({ label: `Reiniciar e atualizar para ${a.nova}${emChamada ? ' (sai da chamada)' : ''}`,
        click: () => atualizacao.instalar() })
    } else if (a.situacao === 'baixando') itens.push({ label: `Baixando ${a.nova}… ${a.progresso}%`, enabled: false })
    itens.push({
      label: 'Canal de atualização',
      submenu: [['stable', 'Stable'], ['nightly', 'Nightly']].map(([id, nome]) => ({
        label: nome, type: 'radio', checked: a.canal === id, click: () => atualizacao.trocarCanal(id),
      })),
    })
    itens.push({ label: a.situacao === 'procurando' ? 'Procurando atualizações…' : 'Procurar atualizações',
      enabled: a.situacao !== 'procurando' && a.situacao !== 'baixando', click: () => atualizacao.procurar() })
    if (a.situacao === 'erro') itens.push({ label: `Erro na atualização: ${a.erro}`.slice(0, 80), enabled: false })
    itens.push({ type: 'separator' })
    return itens
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
    redesenhar: () => atualizar(),
    mostrar,
    destruir() { tray.destroy() },
  }
}

module.exports = { desenho, criarBandeja, lerUltima, gravarUltima, acharUltima }
