// Ponte entre a página (sem Node, contextIsolation ligado) e o processo
// principal. A página só vê window.disgalmDesktop; o PCM chega num MessagePort,
// que não atravessa o contextBridge e por isso vai por window.postMessage.
const { contextBridge, ipcRenderer } = require('electron')

const info = ipcRenderer.sendSync('audio-disponivel')

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
  audioSemDiscord: { disponivel: info.disponivel, motivo: info.motivo, excluir: info.excluir },
  abrirAudio: () => ipcRenderer.invoke('audio-abrir'),
  fecharAudio: id => ipcRenderer.send('audio-fechar', id),
  aoEventoAudio: f => {
    ouvintes.add(f)
    return () => ouvintes.delete(f)
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
