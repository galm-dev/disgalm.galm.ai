// Fila entre o loopback nativo (pacotes de ~10 ms, relógio do WASAPI) e o
// AudioContext (blocos de 128 quadros, relógio dele). Começa a tocar com
// ALVO de folga; se a fila passa de MAX (relógios divergindo, rajada depois de
// um engasgo), descarta o excesso de uma vez em vez de acumular atraso.
const ALVO_MS = 40
const MAX_MS = 200

class Pcm extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super()
    const { taxa, canais } = processorOptions
    this.canais = canais
    this.alvo = Math.round(taxa * ALVO_MS / 1000)
    this.max = Math.round(taxa * MAX_MS / 1000)
    this.cap = taxa // 1 s
    this.buf = Array.from({ length: canais }, () => new Float32Array(this.cap))
    this.ler = 0
    this.n = 0
    this.tocando = false
    this.engasgos = 0
    this.blocos = 0
    this.taxa = taxa
    this.port.onmessage = e => {
      e.data.porta.onmessage = ev => this.empurrar(ev.data)
    }
  }

  empurrar(pcm) {
    const c = this.canais
    const quadros = pcm.length / c
    for (let i = 0; i < quadros; i++) {
      if (this.n === this.cap) { this.ler = (this.ler + 1) % this.cap; this.n-- }
      const j = (this.ler + this.n) % this.cap
      for (let k = 0; k < c; k++) this.buf[k][j] = pcm[i * c + k]
      this.n++
    }
    if (this.n > this.max) {
      const sobra = this.n - this.alvo
      this.ler = (this.ler + sobra) % this.cap
      this.n -= sobra
    }
  }

  process(_entradas, saidas) {
    const saida = saidas[0]
    const quadros = saida[0].length
    if (!this.tocando && this.n >= this.alvo) this.tocando = true
    if (this.tocando) {
      for (let i = 0; i < quadros; i++) {
        if (this.n === 0) {
          this.tocando = false
          this.engasgos++
          this.port.postMessage({ engasgo: currentTime, alvoMs: Math.round(this.alvo * 1000 / this.taxa) })
          break
        }
        for (let k = 0; k < saida.length; k++) saida[k][i] = this.buf[Math.min(k, this.canais - 1)][this.ler]
        this.ler = (this.ler + 1) % this.cap
        this.n--
      }
    }
    // Resumo a cada ~10 s, só se houve engasgo.
    if (++this.blocos % Math.round(this.taxa * 10 / quadros) === 0 && this.engasgos) {
      this.port.postMessage({ engasgos: this.engasgos, filaMs: Math.round(this.n * 1000 / this.taxa) })
      this.engasgos = 0
    }
    return true
  }
}

registerProcessor('disgalm-pcm', Pcm)
