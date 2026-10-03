import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { objetosParaExcluir } = require('../desktop/alvo.js')
const { Reamostrador } = require('../desktop/reamostrar.js')

const p = (pid, ppid, nome) => ({ pid, ppid, nome })
const procs = [
  p(1, 0, 'launchd'),
  p(500, 1, 'Disgalm'), p(501, 500, 'Disgalm Helper'),            // o app e o serviço de áudio dele
  p(600, 1, 'Discord'), p(601, 600, 'Discord Helper (Renderer)'),  // Discord e filhos
  p(700, 1, 'Spotify'), p(800, 1, 'Google Chrome Helper'),
]
const audio = [
  { pid: 501, objeto: 41 }, { pid: 601, objeto: 42 }, { pid: 700, objeto: 43 }, { pid: 800, objeto: 44 }, { pid: 600, objeto: 45 },
]

test('Mac exclui o app (e descendentes) e qualquer árvore do Discord', () => {
  assert.deepEqual(objetosParaExcluir(procs, audio, { pidApp: 500 }), [41, 42, 45])
})

test('processo de áudio sem entrada na lista de processos não é excluído', () => {
  assert.deepEqual(objetosParaExcluir(procs, [{ pid: 999, objeto: 50 }], { pidApp: 500 }), [])
})

// Seno de 1 kHz a 44,1 kHz em pacotes de 512 quadros → 48 kHz.
function seno(hz, taxa, n, desde = 0) {
  const a = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) a[i * 2] = a[i * 2 + 1] = Math.sin(2 * Math.PI * hz * (desde + i) / taxa)
  return a
}

test('44,1 kHz vira 48 kHz com a quantidade certa de quadros', () => {
  const r = new Reamostrador(48000)
  let saida = 0
  for (let k = 0; k < 100; k++) saida += r.processar(seno(1000, 44100, 512, k * 512), 44100).length / 2
  const esperado = 100 * 512 * 48000 / 44100
  assert.ok(Math.abs(saida - esperado) < 3, `${saida} vs ${esperado}`)
})

test('a emenda entre pacotes não estala: a saída segue o seno', () => {
  const r = new Reamostrador(48000)
  const tudo = []
  for (let k = 0; k < 20; k++) tudo.push(...r.processar(seno(1000, 44100, 441, k * 441), 44100))
  // Maior salto entre amostras consecutivas de um seno de 1 kHz a 48 kHz ≈ 2π·1000/48000 ≈ 0,13.
  let pior = 0
  for (let i = 2; i < tudo.length; i += 2) pior = Math.max(pior, Math.abs(tudo[i] - tudo[i - 2]))
  assert.ok(pior < 0.14, `salto de ${pior}`)
})

test('mesma taxa passa direto', () => {
  const a = seno(440, 48000, 480)
  assert.equal(new Reamostrador(48000).processar(a, 48000), a)
})
