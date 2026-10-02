// Copia cada bloco de entrada para a página (só no teste).
registerProcessor('disgalm-gravador', class extends AudioWorkletProcessor {
  process([entrada]) {
    if (entrada.length) this.port.postMessage(entrada.map(c => c.slice()))
    return true
  }
})
