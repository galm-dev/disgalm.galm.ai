import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { registrarAbertura, LIMITE } = createRequire(import.meta.url)('../desktop/saude.js')

// Abre a versão n vezes a partir de um estado, sem nunca ficar saudável.
const abrir = (estado, versao, n = 1) => {
  let r = { estado }
  for (let i = 0; i < n; i++) r = registrarAbertura(r.estado, versao)
  return r
}

test('primeira instalação: sem versão saudável anterior, nunca pede rollback', () => {
  const r = abrir(null, '0.5.0', LIMITE + 5)
  assert.equal(r.crashLoop, false)
  assert.equal(r.estado.ultimaSaudavel, null)
})

test('versão nova que não fica saudável pede rollback depois do limite', () => {
  const saudavel = { versao: '0.5.0', saudavel: true, tentativas: 0, ultimaSaudavel: '0.5.0', bloqueadas: [] }
  assert.equal(abrir(saudavel, '0.6.0', LIMITE).crashLoop, false)
  const r = abrir(saudavel, '0.6.0', LIMITE + 1)
  assert.equal(r.crashLoop, true)
  assert.equal(r.estado.ultimaSaudavel, '0.5.0')
})

test('trocar de versão zera as tentativas e guarda a última saudável', () => {
  const ruim = abrir({ versao: '0.5.0', saudavel: true, ultimaSaudavel: '0.5.0', bloqueadas: [] }, '0.6.0', 2).estado
  const r = registrarAbertura({ ...ruim, saudavel: false }, '0.6.1')
  assert.equal(r.estado.tentativas, 1)
  assert.equal(r.estado.ultimaSaudavel, '0.5.0')
})

test('versão saudável abrindo de novo não pede rollback', () => {
  const r = abrir({ versao: '0.5.0', saudavel: true, tentativas: 0, ultimaSaudavel: '0.5.0', bloqueadas: [] }, '0.5.0', 10)
  assert.equal(r.crashLoop, false)
})

test('voltar para a versão bloqueada a desbloqueia; a lista guarda no máximo 10', () => {
  const bloqueadas = Array.from({ length: 12 }, (_, i) => `0.${i}.0`)
  const r = registrarAbertura({ versao: '0.9.0', saudavel: true, ultimaSaudavel: '0.9.0', bloqueadas }, '0.3.0')
  assert.ok(!r.estado.bloqueadas.includes('0.3.0'))
  assert.ok(r.estado.bloqueadas.length <= 10)
})
