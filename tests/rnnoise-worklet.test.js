import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const codigo = readFileSync(new URL('../public/rnnoise-worklet.js', import.meta.url), 'utf8')
const wasm = readFileSync(new URL('../public/vendor/rnnoise/rnnoise.wasm', import.meta.url))

function processador() {
  let Classe
  runInNewContext(codigo, {
    WebAssembly, Float32Array, Uint8Array,
    AudioWorkletProcessor: class { constructor() { this.port = {} } },
    registerProcessor: (_, c) => { Classe = c },
  })
  return new Classe({ processorOptions: { wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) } })
}

function rodar(p, gerar, blocos) {
  const saida = []
  for (let b = 0; b < blocos; b++) {
    const entrada = Float32Array.from({ length: 128 }, (_, i) => gerar(b * 128 + i))
    const out = new Float32Array(128)
    assert.equal(p.process([[entrada]], [[out]]), true)
    saida.push(...out)
  }
  return saida
}

const energia = a => a.reduce((s, v) => s + v * v, 0) / a.length

test('atraso fixo de 10 ms e saída contínua em blocos de 128', () => {
  const p = processador()
  const saida = rodar(p, () => 0.1, 60)
  assert.ok(saida.slice(0, 480).every(v => v === 0))
  assert.ok(saida.every(Number.isFinite))
})

// O RNNoise estima o ruído de fundo aos poucos: a atenuação passa de 20 dB
// depois de alguns segundos de ruído contínuo.
test('ruído branco cai mais de 20 dB depois que o modelo assenta', () => {
  const p = processador()
  // Semente fixa: com Math.random a convergência varia e o teste oscila.
  let semente = 12345
  const ruido = () => {
    semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0
    return (semente / 2 ** 32 * 2 - 1) * 0.1
  }
  const saida = rodar(p, ruido, 3000)
  const entrada = energia(Array.from({ length: 1000 }, ruido))
  const reducao = 10 * Math.log10(energia(saida.slice(-24000)) / entrada)
  assert.ok(reducao < -20, `redução de ${reducao.toFixed(1)} dB`)
})

test('fechar libera o estado e encerra o processador', () => {
  const p = processador()
  p.fechar()
  assert.equal(p.process([[new Float32Array(128)]], [[new Float32Array(128)]]), false)
})
