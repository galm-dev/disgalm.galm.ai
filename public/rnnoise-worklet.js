// Supressão de ruído do microfone na thread de áudio. O RNNoise processa
// quadros de 480 amostras (10 ms a 48 kHz), mas o worklet recebe blocos de 128.
// A fila de saída começa com 480 zeros: esse atraso fixo de 10 ms garante que
// sempre exista um bloco pronto, porque 480·⌊128n/480⌋ + 480 ≥ 128n.
const QUADRO = 480
const ESCALA = 32768   // o RNNoise espera amostras na escala de int16

class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    let memoria
    const { exports: e } = new WebAssembly.Instance(new WebAssembly.Module(options.processorOptions.wasm), {
      a: {
        a: tamanho => {
          try { memoria.grow((tamanho - memoria.buffer.byteLength + 65535) >>> 16); return 1 } catch { return 0 }
        },
        b: (destino, origem, n) => new Uint8Array(memoria.buffer).copyWithin(destino, origem, origem + n),
      },
    })
    memoria = e.c
    e.d()
    this.wasm = e
    this.estado = e.f(0)          // 0 = modelo embutido
    this.ptr = e.g(QUADRO * 4)
    this.entrada = new Float32Array(QUADRO)
    this.preenchido = 0
    this.fila = new Float32Array(QUADRO * 4)
    this.ler = 0
    this.escrever = QUADRO
    this.port.onmessage = ev => { if (ev.data === 'fechar') this.fechar() }
  }

  fechar() {
    if (!this.wasm) return
    this.wasm.h(this.estado)
    this.wasm.i(this.ptr)
    this.wasm = null
  }

  process(inputs, outputs) {
    if (!this.wasm) return false
    const entrada = inputs[0][0]
    const saida = outputs[0][0]
    const n = saida.length
    const tam = this.fila.length
    // Sem entrada (track parada ou ainda conectando) conta como silêncio,
    // para a fila não esvaziar.
    for (let i = 0; i < n; i++) {
      this.entrada[this.preenchido++] = entrada ? entrada[i] * ESCALA : 0
      if (this.preenchido < QUADRO) continue
      this.preenchido = 0
      // A memória pode ter crescido desde o último quadro; a view é refeita.
      const heap = new Float32Array(this.wasm.c.buffer, this.ptr, QUADRO)
      heap.set(this.entrada)
      this.wasm.j(this.estado, this.ptr, this.ptr)
      for (let k = 0; k < QUADRO; k++) this.fila[(this.escrever + k) % tam] = heap[k] / ESCALA
      this.escrever = (this.escrever + QUADRO) % tam
    }
    for (let i = 0; i < n; i++) saida[i] = this.fila[(this.ler + i) % tam]
    this.ler = (this.ler + n) % tam
    return true
  }
}

registerProcessor('rnnoise', RnnoiseProcessor)
