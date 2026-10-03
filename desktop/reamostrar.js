// Reamostragem linear de PCM estéreo intercalado para a taxa do pipeline
// (48 kHz). O tap do Mac sai na taxa da saída de áudio, que costuma ser 44,1
// ou 48 kHz. Guarda a fase e a última amostra entre os pacotes, para não
// estalar na emenda. Linear basta: é o áudio da tela, e o Opus corta acima de
// 20 kHz de qualquer jeito.
class Reamostrador {
  constructor(destino = 48000) {
    this.destino = destino
    this.fase = 0          // posição do próximo quadro de saída, em quadros da entrada
    this.ultimo = [0, 0]   // último quadro do pacote anterior (índice -1)
  }

  processar(pcm, origem) {
    if (origem === this.destino) return pcm
    const passo = origem / this.destino
    const quadros = pcm.length / 2
    const saida = []
    const amostra = (i, c) => (i < 0 ? this.ultimo[c] : pcm[i * 2 + c])
    let t = this.fase
    while (t < quadros - 1) {
      const i = Math.floor(t), f = t - i
      saida.push(amostra(i, 0) + (amostra(i + 1, 0) - amostra(i, 0)) * f)
      saida.push(amostra(i, 1) + (amostra(i + 1, 1) - amostra(i, 1)) * f)
      t += passo
    }
    // O próximo pacote continua de onde este parou; o último quadro vira o -1.
    this.fase = t - quadros
    if (quadros) this.ultimo = [pcm[(quadros - 1) * 2], pcm[(quadros - 1) * 2 + 1]]
    return Float32Array.from(saida)
  }
}

module.exports = { Reamostrador }
