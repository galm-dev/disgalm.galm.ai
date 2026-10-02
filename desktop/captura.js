// Processo utilitário só da captura. No processo principal, que também cuida
// da janela, do IPC e dos arquivos da UI, os pacotes de 10 ms chegavam ao JS
// com buracos de até ~100 ms e a fila do worklet secava. Aqui o laço de
// eventos não tem mais nada a fazer.
//
// Mensagens do principal:
//   { abrir: id, excluir: [...], pidApp } + MessagePort do PCM
//   { fechar: id }
// Para o principal: { id, tipo: 'alvo' | 'inicio' | 'erro', valor }
const nativo = require('./native/build/Release/loopback.node')
const { raizesDe } = require('./alvo.js')

const capturas = new Map()
const avisar = (id, tipo, valor) => process.parentPort.postMessage({ id, tipo, valor })

// Sem Discord aberto, exclui o próprio Disgalm (a árvore do processo
// principal, que inclui este): o áudio que o app toca não volta para quem
// está assistindo.
function escolherAlvo(excluir, pidApp) {
  const raizes = raizesDe(nativo.listarProcessos(), excluir, nativo.criadoEm)
  if (raizes.length) return { pid: raizes[0].pid, nome: raizes[0].nome, raizes: raizes.length }
  return { pid: pidApp, nome: 'o próprio Disgalm', raizes: 0 }
}

function abrir(id, excluir, pidApp, porta) {
  const c = { porta, alvo: null, nativa: null, relogio: null, fechada: false }
  capturas.set(id, c)
  const ligar = () => {
    if (c.fechada) return
    c.alvo = escolherAlvo(excluir, pidApp)
    avisar(id, 'alvo', c.alvo)
    c.nativa = new nativo.Captura(c.alvo.pid, false, (tipo, valor) => {
      if (tipo === 'dados') porta.postMessage(valor)
      else if (tipo === 'erro') {
        avisar(id, 'erro', valor)
        // Dispositivo trocou: reabre em 1 s.
        setTimeout(religar, 1000)
      } else if (tipo !== 'fim') avisar(id, tipo, valor)
    })
  }
  const religar = () => {
    c.nativa?.parar()
    c.nativa = null
    ligar()
  }
  // O Discord abre, fecha e se atualiza (PID novo) durante a chamada; o alvo
  // da exclusão é fixado na ativação, então reabre quando a raiz muda.
  c.relogio = setInterval(() => {
    if (escolherAlvo(excluir, pidApp).pid !== c.alvo?.pid) religar()
  }, 2000)
  porta.start()
  ligar()
}

function fechar(id) {
  const c = capturas.get(id)
  if (!c) return
  c.fechada = true
  clearInterval(c.relogio)
  c.nativa?.parar()
  c.porta.close()
  capturas.delete(id)
}

process.parentPort.on('message', e => {
  const m = e.data
  if (m.abrir) abrir(m.abrir, m.excluir, m.pidApp, e.ports[0])
  else if (m.fechar) fechar(m.fechar)
})
