// Fila entre o loopback nativo (pacotes de ~10 ms, relógio do WASAPI) e o
// AudioContext (blocos de 128 quadros, relógio dele).
//
// Os dois relógios divergem um pouco: com leitura a 1:1, a fila secava ~1 vez
// por minuto no soak, mesmo com pacotes nunca mais de 64 ms atrasados. Por
// isso a leitura anda num passo ajustável (até ±0,3%, com interpolação
// linear) que puxa a fila média de volta ao ALVO. Atrasos de entrega maiores
// que a folga ainda secam a fila; cada vez que seca, o alvo sobe PASSO, até
// TETO. Rajada acima de ALVO + FOLGA é descartada de uma vez.
// Na VM, partindo de 40 ms, a fila ainda secou 3 vezes nos primeiros 5 min e
// assentou em 100 ms; por isso parte de 80.
const ALVO_MS = 80
const PASSO_MS = 20
const TETO_MS = 160
const FOLGA_MS = 160
const AJUSTE_MAX = 0.003
// Ajuste por erro relativo da fila: com 0,1% de deriva, a fila assenta a 10%
// abaixo do alvo (com ganho 0,003 assentava a 33%).
const GANHO = 0.01
// Média móvel da fila por bloco de 128 (~0,7 s de constante de tempo).
const SUAVE = 0.004

class Pcm extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super()
    const { taxa, canais } = processorOptions
    this.canais = canais
    this.taxa = taxa
    this.ms = n => Math.round(taxa * n / 1000)
    this.alvo = this.ms(ALVO_MS)
    this.cap = taxa // 1 s
    this.buf = Array.from({ length: canais }, () => new Float32Array(this.cap))
    this.ler = 0
    this.frac = 0
    this.passo = 1
    this.n = 0
    this.media = this.alvo
    this.tocando = false
    this.engasgos = 0
    this.blocos = 0
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
    if (this.n > this.alvo + this.ms(FOLGA_MS)) {
      const sobra = this.n - this.alvo
      this.ler = (this.ler + sobra) % this.cap
      this.n -= sobra
      this.media = this.alvo
    }
  }

  process(_entradas, saidas) {
    const saida = saidas[0]
    const quadros = saida[0].length
    if (!this.tocando && this.n >= this.alvo) this.tocando = true
    if (this.tocando) {
      this.media += (this.n - this.media) * SUAVE
      const erro = (this.media - this.alvo) / this.alvo
      this.passo = 1 + Math.max(-AJUSTE_MAX, Math.min(AJUSTE_MAX, erro * GANHO))
      for (let i = 0; i < quadros; i++) {
        // A interpolação lê a amostra atual e a seguinte.
        if (this.n < 2) {
          this.tocando = false
          this.engasgos++
          this.alvo = Math.min(this.alvo + this.ms(PASSO_MS), this.ms(TETO_MS))
          this.media = this.alvo
          this.port.postMessage({ engasgo: currentTime, alvoMs: Math.round(this.alvo * 1000 / this.taxa) })
          break
        }
        const j = (this.ler + 1) % this.cap
        for (let k = 0; k < saida.length; k++) {
          const b = this.buf[Math.min(k, this.canais - 1)]
          saida[k][i] = b[this.ler] + (b[j] - b[this.ler]) * this.frac
        }
        this.frac += this.passo
        while (this.frac >= 1) {
          this.frac -= 1
          this.ler = (this.ler + 1) % this.cap
          this.n--
        }
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
