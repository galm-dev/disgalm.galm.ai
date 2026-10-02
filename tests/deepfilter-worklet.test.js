import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { runInNewContext } from 'node:vm'

const codigo = readFileSync(new URL('../public/deepfilter-worklet.js', import.meta.url), 'utf8')
const modulo = new WebAssembly.Module(gunzipSync(readFileSync(new URL('../public/vendor/deepfilternet/df_bg.wasm.gz', import.meta.url))))

// O AudioWorkletGlobalScope não tem TextDecoder nem crypto; o contexto do
// teste também não, para pegar dependência acidental da cola.
function processador() {
  let Classe
  const mensagens = []
  runInNewContext(codigo, {
    WebAssembly, Float32Array, Uint8Array, String, Error,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => mensagens.push(m) } } },
    registerProcessor: (_, c) => { Classe = c },
  })
  return { p: new Classe({ processorOptions: { modulo } }), mensagens }
}

function rodar(p, gerar, blocos) {
  const saida = new Float32Array(blocos * 128)
  for (let b = 0; b < blocos; b++) {
    const entrada = Float32Array.from({ length: 128 }, (_, i) => gerar(b * 128 + i))
    const out = new Float32Array(128)
    assert.equal(p.process([[entrada]], [[out]]), true)
    saida.set(out, b * 128)
  }
  return saida
}

const energia = a => a.reduce((s, v) => s + v * v, 0) / a.length

test('avisa que está pronto sem TextDecoder nem crypto no escopo', () => {
  const { mensagens } = processador()
  assert.equal(mensagens.length, 1)
  assert.equal(mensagens[0].pronto, true)
})

test('módulo inválido vira mensagem de erro, não exceção', () => {
  let Classe
  const mensagens = []
  runInNewContext(codigo, {
    WebAssembly, Float32Array, Uint8Array, String, Error,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => mensagens.push(m) } } },
    registerProcessor: (_, c) => { Classe = c },
  })
  const p = new Classe({ processorOptions: { modulo: null } })
  assert.ok(mensagens[0].erro)
  assert.equal(p.process([[new Float32Array(128)]], [[new Float32Array(128)]]), false)
})

test('ruído sem fala vira silêncio e a memória do WASM não cresce', () => {
  const { p } = processador()
  let semente = 12345
  const ruido = () => {
    semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0
    return (semente / 2 ** 32 * 2 - 1) * 0.05
  }
  const saida = rodar(p, ruido, 1500)
  assert.ok(saida.slice(0, 480).every(v => v === 0))
  assert.ok(saida.every(Number.isFinite))
  const memoria = p.wasm.memory.buffer.byteLength
  rodar(p, ruido, 3000)
  assert.equal(p.wasm.memory.buffer.byteLength, memoria)
  assert.ok(energia(saida.slice(-24000)) < 1e-8)
})

test('fechar libera o estado e encerra o processador', () => {
  const { p } = processador()
  p.fechar()
  assert.equal(p.process([[new Float32Array(128)]], [[new Float32Array(128)]]), false)
})
