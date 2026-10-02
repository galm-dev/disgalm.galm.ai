// Processo utilitário só da captura. No processo principal, que também cuida
// da janela, do IPC e dos arquivos da UI, os pacotes de 10 ms chegavam ao JS
// com buracos de até ~100 ms e a fila do worklet secava. Aqui o laço de
// eventos não tem mais nada a fazer.
//
// O WASAPI exclui só UMA árvore por captura: excluir o Discord deixava o som
// que o próprio Disgalm toca (a voz de quem assiste) entrar na tela, e a
// pessoa se ouvia. Então a captura é ao contrário: uma INCLUDE por programa
// com sessão de áudio na saída padrão, menos o Disgalm e o Discord, somadas
// aqui num relógio de 10 ms. A cada segundo a lista é refeita.
//
// Mensagens do principal:
//   { abrir: id, excluir: [...], pidApp } + MessagePort do PCM
//   { fechar: id }
// Para o principal: { id, tipo: 'alvo' | 'inicio' | 'erro', valor }
const nativo = require('./native/build/Release/loopback.node')
const { planejarInclusoes } = require('./alvo.js')

const TAXA = 48000
const CANAIS = 2
const MAX_FILA = TAXA / 5          // 200 ms por fonte; acima disso, descarta o mais velho
const MAX_FONTES = 16

const capturas = new Map()
const avisar = (id, tipo, valor) => process.parentPort.postMessage({ id, tipo, valor })

// Fila de quadros intercalados de uma fonte.
class Fila {
  constructor() { this.pedacos = []; this.n = 0 }
  empurrar(f32) {
    this.pedacos.push({ dados: f32, ini: 0 })
    this.n += f32.length / CANAIS
    while (this.n > MAX_FILA) this.tirar(this.n - MAX_FILA, null, 0)
  }
  // Soma até `quadros` quadros em `saida` a partir de `pos` (descarta se saida é null).
  tirar(quadros, saida, pos) {
    let falta = quadros
    while (falta > 0 && this.pedacos.length) {
      const p = this.pedacos[0]
      const disp = (p.dados.length - p.ini) / CANAIS
      const usar = Math.min(disp, falta)
      if (saida) for (let i = 0; i < usar * CANAIS; i++) saida[(pos + quadros - falta) * CANAIS + i] += p.dados[p.ini + i]
      p.ini += usar * CANAIS
      falta -= usar
      this.n -= usar
      if (p.ini >= p.dados.length) this.pedacos.shift()
    }
  }
}

function abrir(id, excluir, pidApp, porta) {
  const c = { porta, fontes: new Map(), relogios: [], fechada: false, resumo: '' }
  capturas.set(id, c)

  const abrirFonte = pid => {
    const fila = new Fila()
    const f = { fila, nativa: null }
    f.nativa = new nativo.Captura(pid, true, (tipo, valor) => {
      if (tipo === 'dados') fila.empurrar(valor)
      else if (tipo === 'erro') {
        // Processo saiu ou dispositivo trocou: a próxima conferência reabre se preciso.
        f.nativa?.parar()
        c.fontes.delete(pid)
      }
    })
    c.fontes.set(pid, f)
  }

  const conferir = () => {
    if (c.fechada) return
    const procs = nativo.listarProcessos()
    const nomes = new Map(procs.map(p => [p.pid, p.nome]))
    const querido = planejarInclusoes(procs, nativo.sessoesDeAudio(), { pidApp, nomes: excluir }).slice(0, MAX_FONTES)
    for (const [pid, f] of c.fontes) if (!querido.includes(pid)) { f.nativa.parar(); c.fontes.delete(pid) }
    for (const pid of querido) if (!c.fontes.has(pid)) abrirFonte(pid)
    const resumo = querido.map(pid => nomes.get(pid) || pid).join(', ')
    if (resumo !== c.resumo) {
      c.resumo = resumo
      avisar(id, 'alvo', { nome: excluir.concat('o próprio Disgalm').join(', '), pid: pidApp,
        incluidos: resumo || 'nenhum programa tocando' })
    }
  }

  // Relógio da mistura: entrega o que o tempo de parede pede, em blocos de
  // ~10 ms. Começa 40 ms atrás para cada fonte ter folga contra a variação de
  // entrega dos pacotes; fonte sem dados vira silêncio.
  const FOLGA_MS = 40
  let t0 = performance.now() + FOLGA_MS
  let entregues = 0
  const misturar = () => {
    if (c.fechada) return
    const devidos = Math.round((performance.now() - t0) * TAXA / 1000) - entregues
    if (devidos <= 0) return
    // Depois de um engasgo longo do laço, recomeça em vez de despejar segundos.
    const quadros = Math.min(devidos, TAXA / 10)
    if (devidos > TAXA / 10) { t0 = performance.now() + FOLGA_MS; entregues = 0; return }
    entregues += quadros
    const saida = new Float32Array(quadros * CANAIS)
    for (const f of c.fontes.values()) f.fila.tirar(quadros, saida, 0)
    porta.postMessage(saida)
  }

  porta.start()
  conferir()
  avisar(id, 'inicio', 'mistura de programas')
  c.relogios.push(setInterval(conferir, 1000), setInterval(misturar, 10))
}

function fechar(id) {
  const c = capturas.get(id)
  if (!c) return
  c.fechada = true
  for (const r of c.relogios) clearInterval(r)
  for (const f of c.fontes.values()) f.nativa.parar()
  c.porta.close()
  capturas.delete(id)
}

process.parentPort.on('message', e => {
  const m = e.data
  if (m.abrir) abrir(m.abrir, m.excluir, m.pidApp, e.ports[0])
  else if (m.fechar) fechar(m.fechar)
})
