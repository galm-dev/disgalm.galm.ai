// Supressão de ruído com DeepFilterNet3 na thread de áudio. Mesmo esquema do
// rnnoise-worklet.js: quadros de 480 amostras (10 ms a 48 kHz), blocos de 128
// e fila de saída iniciada com 480 zeros. O modelo atrasa mais 30 ms por conta
// própria (janela STFT e lookahead), então a voz sai 40 ms depois.
// As amostras ficam em [-1, 1]; ao contrário do RNNoise, sem escala de int16.
const QUADRO = 480
const ATENUACAO_MAX_DB = 100

class DeepFilterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.port.onmessage = ev => { if (ev.data === 'fechar') this.fechar() }
    try {
      this.iniciar(options.processorOptions.modulo)
      this.port.postMessage({ pronto: true })
    } catch (e) {
      this.wasm = null
      this.port.postMessage({ erro: String(e?.message || e) })
    }
  }

  // Equivalente às quatro importações da cola do wasm-bindgen. Os nomes trazem
  // o hash do build vendorizado em vendor/deepfilternet.
  iniciar(modulo) {
    let e
    const bytes = (p, n) => new Uint8Array(e.memory.buffer, p >>> 0, n)
    const texto = (p, n) => typeof TextDecoder === 'function'
      ? new TextDecoder().decode(bytes(p, n).slice())
      : String.fromCharCode(...bytes(p, n))
    const guardarErro = erro => {
      const i = e.__externref_table_alloc_command_export()
      e.__wbindgen_externrefs.set(i, erro)
      e.__wbindgen_exn_store_command_export(i)
    }
    e = new WebAssembly.Instance(modulo, {
      './df_bg.js': {
        __wbg_new_from_slice_b6858b485924da4e: (p, n) => new Float32Array(e.memory.buffer, p >>> 0, n).slice(),
        // O modelo padrão não sorteia nada; se sortear, o erro volta ao Rust
        // em vez de cair num gerador fraco.
        __wbg_getRandomValues_cc7f052a444bb2ce: (p, n) => {
          try { globalThis.crypto.getRandomValues(bytes(p, n)) } catch (erro) { guardarErro(erro) }
        },
        __wbg___wbindgen_throw_6b64449b9b9ed33c: (p, n) => { throw new Error(texto(p, n)) },
        __wbindgen_init_externref_table: () => {
          const t = e.__wbindgen_externrefs
          const o = t.grow(4)
          t.set(0, undefined)
          t.set(o, undefined)
          t.set(o + 1, null)
          t.set(o + 2, true)
          t.set(o + 3, false)
        },
      },
    }).exports
    e.__wbindgen_start()
    this.wasm = e
    this.estado = e.df_create_default(ATENUACAO_MAX_DB) >>> 0
    if (e.df_get_frame_length(this.estado) !== QUADRO) throw new Error('quadro do modelo diferente de 480')
    this.entrada = new Float32Array(QUADRO)
    this.preenchido = 0
    this.fila = new Float32Array(QUADRO * 4)
    this.ler = 0
    this.escrever = QUADRO
  }

  fechar() {
    if (!this.wasm) return
    this.wasm.df_free(this.estado)
    this.wasm = null
  }

  process(inputs, outputs) {
    if (!this.wasm) return false
    const entrada = inputs[0][0]
    const saida = outputs[0][0]
    const n = saida.length
    const tam = this.fila.length
    const e = this.wasm
    for (let i = 0; i < n; i++) {
      this.entrada[this.preenchido++] = entrada ? entrada[i] : 0
      if (this.preenchido < QUADRO) continue
      this.preenchido = 0
      // df_process_frame assume o buffer alocado aqui e devolve uma cópia.
      const ptr = e.__wbindgen_malloc_command_export(QUADRO * 4, 4) >>> 0
      new Float32Array(e.memory.buffer, ptr, QUADRO).set(this.entrada)
      const limpo = e.df_process_frame(this.estado, ptr, QUADRO)
      for (let k = 0; k < QUADRO; k++) this.fila[(this.escrever + k) % tam] = limpo[k]
      this.escrever = (this.escrever + QUADRO) % tam
    }
    for (let i = 0; i < n; i++) saida[i] = this.fila[(this.ler + i) % tam]
    this.ler = (this.ler + n) % tam
    return true
  }
}

registerProcessor('deepfilter', DeepFilterProcessor)
