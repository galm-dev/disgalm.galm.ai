// Ponte entre a página (sem Node, contextIsolation ligado) e o processo
// principal. A página só vê window.disgalmDesktop; o PCM chega num MessagePort,
// que não atravessa o contextBridge e por isso vai por window.postMessage.
const { contextBridge, ipcRenderer } = require('electron')

const info = ipcRenderer.sendSync('audio-disponivel')

// O CSS do app (sem barra de título) só vale com estas classes; na web elas
// não existem.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-app', `desktop-${process.platform}`)
  // Seletor de tela com miniaturas (renderer/seletor.js), só no app.
  const s = document.createElement('script')
  s.type = 'module'
  s.src = '/_desktop/seletor.js'
  document.head.append(s)
})

const escolher = new Set()
const atualizar = new Set()
ipcRenderer.on('tela-escolher', (_e, m) => { for (const f of escolher) f(m) })
ipcRenderer.on('tela-atualizar', (_e, m) => { for (const f of atualizar) f(m) })

ipcRenderer.on('audio-porta', (e, msg) => {
  window.postMessage({ disgalmAudioPorta: msg }, location.origin, e.ports)
})

const ouvintes = new Set()
ipcRenderer.on('audio-evento', (_e, ev) => {
  for (const f of ouvintes) f(ev)
})

contextBridge.exposeInMainWorld('disgalmDesktop', {
  plataforma: process.platform,
  // Áudio do sistema sem o Discord (WASAPI process loopback, Windows).
  audioSemDiscord: { disponivel: info.disponivel, motivo: info.motivo, excluir: info.excluir, modo: info.modo },
  abrirAudio: () => ipcRenderer.invoke('audio-abrir'),
  // Linux: devolve { id, rotulo } da entrada de áudio criada no PipeWire.
  abrirAudioLinux: () => ipcRenderer.invoke('audio-linux-abrir'),
  fecharAudio: id => ipcRenderer.send('audio-fechar', id),
  aoEventoAudio: f => {
    ouvintes.add(f)
    return () => ouvintes.delete(f)
  },
  // Seletor de tela do app: o principal manda as fontes e espera a escolha.
  tela: {
    aoEscolher: f => { escolher.add(f) },
    aoAtualizar: f => { atualizar.add(f) },
    escolher: (pedido, id) => ipcRenderer.send('tela-escolhida', pedido, id),
  },
  // Login GALM no navegador do sistema, com volta para o app.
  login: {
    preparar: () => ipcRenderer.invoke('login-preparar'),
    abrir: (url, state) => ipcRenderer.invoke('login-abrir', url, state),
  },
  ...(info.teste
    ? {
        teste: {
          salvar: (nome, dados) => ipcRenderer.invoke('teste-salvar', nome, dados),
          fim: codigo => ipcRenderer.send('teste-fim', codigo),
        },
      }
    : {}),
})
