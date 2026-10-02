// Casca Electron do Disgalm. A UI é a mesma da web; o que o app acrescenta é
// o áudio do sistema sem o Discord, que o navegador não sabe capturar.
//
// A janela carrega https://disgalm.galm.ai (login, /ice e /ws são os de
// produção), mas os arquivos estáticos saem de ../public deste checkout: assim
// a UI do app é a do branch, sem precisar publicar nada. /_desktop/* sai de
// ./renderer e só existe no app.
const { app, BrowserWindow, MessageChannelMain, desktopCapturer, ipcMain, net, protocol, session, shell,
  utilityProcess, webContents } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { raizesDe } = require('./alvo.js')
const { criarRetorno, urlDeLoginValida } = require('./login.js')
const { criarBandeja, lerUltima, gravarUltima, acharUltima } = require('./bandeja.js')

const ORIGEM = new URL(process.env.DISGALM_URL || 'https://disgalm.galm.ai').origin
// Argumento livre na linha de comando: uma URL do Disgalm (link de convite,
// sala) para abrir direto.
const urlInicial = process.argv.slice(1).find(a => a.startsWith(ORIGEM)) || ORIGEM + '/'
const UI_LOCAL = process.env.DISGALM_UI_LOCAL !== '0'
const PUBLIC = path.join(__dirname, '..', 'public')
const RENDERER = path.join(__dirname, 'renderer')
// Modo de teste: abre a página de gravação em vez da sala e sai ao terminar.
const TESTE = process.argv.find(a => a.startsWith('--teste='))?.slice(8)
// Executáveis a excluir (Discord estável, PTB e Canary). DISGALM_EXCLUIR troca
// a lista, separada por vírgula; os testes põem um substituto.
const EXCLUIR = (process.env.DISGALM_EXCLUIR || 'Discord.exe,DiscordPTB.exe,DiscordCanary.exe')
  .split(',').map(n => n.trim()).filter(Boolean)

let nativo = null
let erroNativo = null
if (process.platform === 'win32') {
  try {
    nativo = require('./native/build/Release/loopback.node')
  } catch (e) {
    erroNativo = e.message
  }
} else erroNativo = process.platform === 'linux' ? 'PipeWire indisponível (pw-dump, pactl)' : 'só existe no Windows e no Linux por enquanto'

// ---------- arquivos locais por cima da origem de produção ----------

function arquivoLocal(pathname) {
  if (pathname.startsWith('/_desktop/')) {
    const f = path.join(RENDERER, path.normalize(pathname.slice('/_desktop/'.length)))
    return f.startsWith(RENDERER + path.sep) ? f : null
  }
  if (!UI_LOCAL) return null
  // O Worker serve o index em / e em /auth/callback.
  if (pathname === '/' || pathname === '/auth/callback') return path.join(PUBLIC, 'index.html')
  const f = path.join(PUBLIC, path.normalize(decodeURIComponent(pathname)))
  return f.startsWith(PUBLIC + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null
}

function servirLocal() {
  // O esquema da origem: https em produção, http no teste local
  // (DISGALM_URL=http://localhost:8787).
  protocol.handle(new URL(ORIGEM).protocol.slice(0, -1), async req => {
    const url = new URL(req.url)
    const f = url.origin === ORIGEM && req.method === 'GET' ? arquivoLocal(url.pathname) : null
    if (f) {
      const r = await net.fetch(pathToFileURL(f).href)
      const headers = new Headers(r.headers)
      headers.set('cache-control', 'no-store')
      if (f.endsWith('.js')) headers.set('content-type', 'text/javascript; charset=utf-8')
      if (f.endsWith('.wasm')) headers.set('content-type', 'application/wasm')
      return new Response(r.body, { status: r.status, headers })
    }
    // O handler recebe o pedido sem Origin, e o Worker recusa POST sem ele
    // (/auth/refresh, /guest/redeem). Só a janela do app carrega a origem,
    // então quem pede para ela é a própria página.
    if (url.origin === ORIGEM && req.method !== 'GET' && req.method !== 'HEAD') {
      const headers = new Headers(req.headers)
      headers.set('origin', ORIGEM)
      return net.fetch(req.url, {
        method: req.method,
        headers,
        body: await req.arrayBuffer(),
        credentials: 'include',
        bypassCustomProtocolHandlers: true,
      })
    }
    // Cookies (sessão GALM, convite) só para a própria origem: forçar
    // credenciais em terceiros quebra CORS com '*' (fontes do Google).
    const credentials = url.origin === ORIGEM ? 'include' : undefined
    return net.fetch(req, { bypassCustomProtocolHandlers: true, credentials }).catch(e => {
      console.error('falhou', req.method, req.url, e.message)
      throw e
    })
  })
}

// ---------- compartilhamento de tela ----------

// O getDisplayMedia do renderer cai aqui. Com uma tela só, compartilha direto;
// com mais fontes, pergunta qual. audio: 'loopback' é o sistema inteiro, igual
// ao Chrome no Windows — o caminho sem o Discord não pede áudio aqui.
// Fontes com miniatura para o seletor do app (preload.js). A janela do próprio
// Disgalm fica de fora: compartilhar a si mesmo faz o efeito de túnel.
async function fontesComMiniatura(wc) {
  const fontes = await desktopCapturer.getSources({
    types: ['screen', 'window'], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: true,
  })
  const propria = BrowserWindow.fromWebContents(wc)?.getMediaSourceId()
  return fontes.filter(f => f.id !== propria).map(f => ({
    id: f.id,
    nome: f.name,
    tipo: f.id.startsWith('screen:') ? 'tela' : 'janela',
    miniatura: f.thumbnail.isEmpty() ? null : `data:image/jpeg;base64,${f.thumbnail.toJPEG(72).toString('base64')}`,
    icone: f.appIcon && !f.appIcon.isEmpty() ? f.appIcon.toDataURL() : null,
  }))
}

// O menu da bandeja marca que o próximo getDisplayMedia é dele.
let pedidoDaBandeja = false
let bandeja = null
let saindo = false

// Um pedido de getDisplayMedia por vez espera a escolha no seletor.
const escolhas = new Map()
let proximoPedido = 1
ipcMain.on('tela-escolhida', (_e, pedido, id) => {
  escolhas.get(pedido)?.(id)
  escolhas.delete(pedido)
})

// O getDisplayMedia do renderer cai aqui. O app mostra o próprio seletor, com
// miniaturas que se atualizam, como o do Discord. No Linux com Wayland o
// portal do sistema já escolheu e só sobra uma fonte: vai direto.
function tratarGetDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(async (req, responder) => {
    const wc = webContents.fromFrame(req.frame)
    let relogio = null
    try {
      let fontes = await fontesComMiniatura(wc)
      let id = fontes[0]?.id
      // Pedido vindo do menu da bandeja: a última fonte, sem seletor. Se ela
      // não existe mais (janela fechada, monitor desligado), mostra o seletor.
      const daBandeja = pedidoDaBandeja
      pedidoDaBandeja = false
      const ultima = daBandeja ? acharUltima(fontes, lerUltima()) : null
      // DISGALM_TELA_AUTO=1 pula a pergunta (testes automatizados).
      if (TESTE || process.env.DISGALM_TELA_AUTO || fontes.length <= 1)
        id = (fontes.find(f => f.tipo === 'tela') || fontes[0])?.id
      else if (ultima) id = ultima.id
      else {
        if (daBandeja) bandeja?.mostrar()
        const pedido = proximoPedido++
        const escolha = new Promise(r => {
          escolhas.set(pedido, r)
          wc.once('destroyed', () => r(null))
        })
        wc.send('tela-escolher', { pedido, fontes })
        // Miniaturas vivas enquanto o seletor está aberto; janelas novas entram.
        relogio = setInterval(async () => {
          try {
            fontes = await fontesComMiniatura(wc)
            if (!wc.isDestroyed()) wc.send('tela-atualizar', { pedido, fontes })
          } catch {}
        }, 2000)
        id = await escolha
      }
      const fonte = fontes.find(f => f.id === id)
      if (!fonte) return responder({})
      if (fontes.length > 1) gravarUltima(fonte)
      // O Electron só tem áudio do sistema ('loopback') no Windows. No Linux a
      // UI cai no monitor do PipeWire (loopback.sh); no Mac a tela vai sem som.
      const audio = req.audioRequested && process.platform === 'win32' ? { audio: 'loopback' } : {}
      responder({ video: { id: fonte.id, name: fonte.nome }, ...audio })
    } catch (e) {
      console.error('getDisplayMedia:', e)
      responder({})
    } finally {
      clearInterval(relogio)
    }
  })
}

// ---------- áudio do sistema sem o Discord ----------

// A captura roda num processo utilitário (captura.js): no principal, os
// pacotes chegavam ao JS com buracos de até ~100 ms. O PCM vai de lá por um
// MessagePort direto até o AudioWorklet; o principal só repassa os eventos.
let utilitario = null
const capturas = new Map() // id → webContents
let proximoId = 1

function avisar(id, tipo, valor) {
  const wc = capturas.get(id)
  if (wc && !wc.isDestroyed()) wc.send('audio-evento', { id, tipo, valor })
}

function processoDeCaptura() {
  if (utilitario) return utilitario
  utilitario = utilityProcess.fork(path.join(__dirname, 'captura.js'), [], { serviceName: 'Disgalm: áudio' })
  utilitario.on('message', m => avisar(m.id, m.tipo, m.valor))
  // Se o processo cair, as tracks abertas ficam mudas; avisa a página. A
  // próxima captura sobe um processo novo.
  utilitario.on('exit', codigo => {
    utilitario = null
    for (const id of capturas.keys()) avisar(id, 'erro', `processo de captura saiu (${codigo})`)
  })
  return utilitario
}

function abrirCaptura(webContents) {
  const id = proximoId++
  const { port1, port2 } = new MessageChannelMain()
  capturas.set(id, webContents)
  processoDeCaptura().postMessage({ abrir: id, excluir: EXCLUIR, pidApp: process.pid }, [port1])
  webContents.postMessage('audio-porta', { id, taxa: 48000, canais: 2 }, [port2])
  webContents.once('destroyed', () => fecharCaptura(id))
  return id
}

function fecharCaptura(id) {
  const linux = capturasLinux.get(id)
  if (linux) { capturasLinux.delete(id); linux.fechar(); return }
  if (!capturas.delete(id)) return
  utilitario?.postMessage({ fechar: id })
}

// Linux: o mesmo recurso pelo PipeWire (pipewire.js); a track sai de uma
// entrada de áudio que o app cria, e não de um MessagePort.
const pipewire = process.platform === 'linux' ? require('./pipewire.js') : null
let pipewireOk = false
const capturasLinux = new Map()

ipcMain.on('audio-disponivel', e => {
  const disponivel = !!nativo || pipewireOk
  e.returnValue = { disponivel, motivo: disponivel ? null : erroNativo, excluir: EXCLUIR.join(', '),
    modo: nativo ? 'wasapi' : pipewireOk ? 'pipewire' : null, teste: TESTE || null }
})
app.on('will-quit', () => { for (const c of capturasLinux.values()) c.fecharJa() })
ipcMain.handle('audio-linux-abrir', async e => {
  if (!pipewireOk) throw new Error(erroNativo)
  // Uma por vez: a saída virtual tem nome fixo.
  for (const [id, c] of capturasLinux) { capturasLinux.delete(id); await c.fechar() }
  const id = proximoId++
  const wc = e.sender
  const aviso = valor => { if (!wc.isDestroyed()) wc.send('audio-evento', { id, tipo: 'aviso', valor }) }
  const c = await pipewire.abrir({ pidApp: process.pid, aoAviso: aviso })
  capturasLinux.set(id, c)
  wc.once('destroyed', () => fecharCaptura(id))
  return { id, rotulo: c.rotulo }
})
ipcMain.handle('audio-abrir', e => {
  if (!nativo) throw new Error(erroNativo)
  return abrirCaptura(e.sender)
})
ipcMain.on('audio-fechar', (_e, id) => fecharCaptura(id))

// Só no modo de teste: o renderer devolve as gravações e o resumo.
ipcMain.handle('teste-salvar', (_e, nome, dados) => {
  if (!TESTE) throw new Error('fora do modo de teste')
  const destino = path.resolve(TESTE)
  fs.mkdirSync(destino, { recursive: true })
  const f = path.join(destino, path.basename(nome))
  fs.writeFileSync(f, Buffer.from(dados))
  return f
})
// Com DISGALM_TESTE_INCLUIR=1, grava em paralelo SÓ a árvore excluída (modo
// INCLUDE) em incluido.wav: prova que o processo excluído estava tocando
// mesmo quando o som dele não é um tom conhecido (Discord de verdade).
let incluido = null
if (TESTE && process.env.DISGALM_TESTE_INCLUIR && nativo) {
  app.whenReady().then(() => {
    const raiz = raizesDe(nativo.listarProcessos(), EXCLUIR, nativo.criadoEm)[0]
    const alvo = raiz ? { pid: raiz.pid, nome: raiz.nome } : { pid: process.pid, nome: 'o próprio Disgalm' }
    const pedacos = []
    const captura = new nativo.Captura(alvo.pid, true, (tipo, valor) => {
      if (tipo === 'dados') pedacos.push(Buffer.from(valor.buffer, valor.byteOffset, valor.byteLength))
    })
    incluido = { alvo, pedacos, captura }
  })
}

function wavFloat(dados, taxa, canais) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + dados.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(canais, 22); h.writeUInt32LE(taxa, 24)
  h.writeUInt32LE(taxa * canais * 4, 28); h.writeUInt16LE(canais * 4, 32); h.writeUInt16LE(32, 34)
  h.write('data', 36); h.writeUInt32LE(dados.length, 40)
  return Buffer.concat([h, dados])
}

ipcMain.on('teste-fim', (_e, codigo) => {
  if (!TESTE) return
  if (incluido) {
    incluido.captura.parar()
    fs.writeFileSync(path.join(path.resolve(TESTE), 'incluido.wav'), wavFloat(Buffer.concat(incluido.pedacos), 48000, 2))
    console.log('incluido.wav: só', incluido.alvo.nome, 'PID', incluido.alvo.pid)
  }
  app.exit(codigo || 0)
})

// ---------- login pelo navegador do sistema ----------

// Login dentro do app obriga a digitar senha sem o gerenciador do navegador.
// A página (auth.js) gera o PKCE e guarda o verificador; o app só abre o
// /authorize no navegador e, quando a query volta pelo loopback, carrega
// /auth/callback com ela na janela, onde o auth.js termina a troca.
let janela = null
const retorno = criarRetorno(query => {
  if (!janela || janela.isDestroyed()) return
  janela.loadURL(`${ORIGEM}/auth/callback?${query}`)
  if (janela.isMinimized()) janela.restore()
  janela.show()
  app.focus({ steal: true })
})
app.on('will-quit', () => retorno.fechar())

ipcMain.handle('login-preparar', () => retorno.preparar())
ipcMain.handle('login-abrir', async (_e, href, state) => {
  if (!urlDeLoginValida(href, state, ORIGEM)) throw new Error('login inválido')
  retorno.esperar(state)
  await shell.openExternal(href)
})

// ---------- janela ----------

app.whenReady().then(async () => {
  if (pipewire) pipewireOk = await pipewire.disponivel()
  servirLocal()
  tratarGetDisplayMedia()
  // Microfone, câmera e tela: a UI pede, o app concede. Notificações e o resto
  // seguem negados.
  session.defaultSession.setPermissionRequestHandler((_wc, permissao, ok) =>
    ok(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permissao)))

  const win = janela = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Disgalm',
    autoHideMenuBar: true,
    backgroundColor: '#07080b',
    // Sem barra de título do sistema, como o Discord: a faixa de cima da UI
    // (40 px, .app-top) arrasta a janela. No Mac os semáforos ficam dentro
    // dela; no Windows e no Linux os botões do sistema são desenhados por cima
    // do canto direito, nas cores da UI.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#07080b', symbolColor: '#edeef2', height: 39 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // O AudioContext do áudio nativo nasce fora de um clique no teste.
      autoplayPolicy: 'no-user-gesture-required',
      // A chamada continua com a janela fechada na bandeja; sem isto o
      // Chromium desacelera timers e o worklet da página escondida.
      backgroundThrottling: false,
    },
  })
  // Fechar esconde: o app segue na sala, com o ícone na bandeja. Sair é pelo
  // menu da bandeja (ou ⌘Q no Mac).
  win.on('close', e => {
    if (saindo || TESTE) return
    e.preventDefault()
    win.hide()
  })
  if (!TESTE) {
    bandeja = await criarBandeja({
      janela: () => (win.isDestroyed() ? null : win),
      sair: () => { saindo = true; app.quit() },
      comando: c => {
        if (c === 'tela') pedidoDaBandeja = true
        // userGesture: o getDisplayMedia exige um gesto do usuário, e o clique
        // no menu da bandeja não chega à página como gesto.
        win.webContents.executeJavaScript(`globalThis.disgalmComando?.(${JSON.stringify(c)})`, true)
          .catch(e => console.error('bandeja:', e))
      },
    })
  }
  // Login e links externos: o que é da origem fica na janela; auth.galm.ai
  // também, porque o login volta para cá por redirect.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadURL(TESTE ? `${ORIGEM}/_desktop/teste.html?${process.env.DISGALM_TESTE_QUERY || ''}` : urlInicial)
})

app.on('before-quit', () => { saindo = true })
app.on('window-all-closed', () => app.quit())
// Mac: clicar no ícone do Dock traz a janela escondida de volta.
app.on('activate', () => bandeja?.mostrar())
ipcMain.on('estado', (_e, novo) => bandeja?.estado(novo))
