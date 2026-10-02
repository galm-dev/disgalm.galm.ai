import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const codigo = readFileSync(new URL('../desktop/renderer/pcm-worklet.js', import.meta.url), 'utf8')
const TAXA = 48000

// Monta o processador com a porta do PCM ligada a `empurrar(pcm)`.
function processador() {
  let Classe
  const avisos = []
  runInNewContext(codigo, {
    Float32Array, Math, currentTime: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => avisos.push(m) } } },
    registerProcessor: (_, c) => { Classe = c },
  })
  const p = new Classe({ processorOptions: { taxa: TAXA, canais: 2 } })
  const porta = {}
  p.port.onmessage({ data: { porta } })
  return { p, avisos, empurrar: quadros => porta.onmessage({ data: pacote(quadros) }) }
}

// Pacote estéreo intercalado com um valor constante por canal.
const pacote = quadros => Float32Array.from({ length: quadros * 2 }, (_, i) => (i % 2 ? -0.5 : 0.5))

function bloco(p) {
  const out = [new Float32Array(128), new Float32Array(128)]
  assert.equal(p.process([], [out]), true)
  return out
}

const silencioso = out => out[0].every(v => v === 0)

test('só começa a tocar com 80 ms na fila, e toca os dois canais', () => {
  const { p, empurrar } = processador()
  empurrar(480 * 7)                              // 70 ms
  assert.ok(silencioso(bloco(p)))
  empurrar(480)                                  // 80 ms
  const out = bloco(p)
  assert.ok(out[0].every(v => v === 0.5) && out[1].every(v => v === -0.5))
})

test('fila seca vira silêncio, aviso, e o alvo sobe 20 ms até o teto de 160', () => {
  const { p, avisos, empurrar } = processador()
  const engasgos = () => avisos.filter(a => a.engasgo !== undefined)
  // Entrega 10 ms e toca 4 blocos (~10,7 ms): a fila seca de tempos em tempos.
  while (engasgos().length < 5) {
    empurrar(480)
    for (let i = 0; i < 4; i++) bloco(p)
  }
  assert.deepEqual(engasgos().map(a => a.alvoMs), [100, 120, 140, 160, 160])
})

test('rajada acima de alvo + 160 ms descarta o excesso e volta ao alvo', () => {
  const { p, empurrar } = processador()
  empurrar(TAXA / 2)                             // 500 ms de uma vez
  assert.equal(p.n, Math.round(TAXA * 0.08))
})

test('com a fila em dia não há engasgo', () => {
  const { p, avisos, empurrar } = processador()
  empurrar(480 * 8)
  // 10 ms chegam a cada 3,75 blocos de 128: entrega 480 a cada 375 quadros tocados.
  let tocado = 0, entregue = 480 * 8
  for (let i = 0; i < 2000; i++) {
    bloco(p)
    tocado += 128
    while (entregue - tocado < 480 * 2) { empurrar(480); entregue += 480 }
  }
  assert.equal(avisos.filter(a => a.engasgo !== undefined).length, 0)
})

// Relógio do WASAPI 0,1% mais lento que o do AudioContext (medido na VM: a
// leitura a 1:1 secava a fila ~1 vez por minuto). O passo ajustável segura.
test('deriva de 0,1% entre os relógios não seca a fila em 2 minutos', () => {
  const { p, avisos, empurrar } = processador()
  const producao = 0.999
  let tocado = 0, entregue = 0
  empurrar(480 * 8); entregue = 480 * 8
  for (let i = 0; i < TAXA * 120 / 128; i++) {
    bloco(p)
    tocado += 128
    while (entregue < (tocado + 480 * 8) * producao) { empurrar(480); entregue += 480 }
  }
  assert.equal(avisos.filter(a => a.engasgo !== undefined).length, 0)
  const filaMs = p.n * 1000 / TAXA
  assert.ok(filaMs > 65 && filaMs < 100, `fila em ${filaMs} ms`)
})
