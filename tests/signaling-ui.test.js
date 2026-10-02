import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { rodarCliente } from './cliente.js'

function fixture(storage = new Map()) {
  const elements = new Map()
  const get = id => {
    if (!elements.has(id)) {
      const classes = new Set()
      elements.set(id, { textContent: '', hidden: true, classes,
        classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name) } } })
    }
    return elements.get(id)
  }
  const localStorage = {
    getItem(key) { return storage.get(key) ?? null },
    setItem(key, value) { storage.set(key, String(value)) },
  }
  const state = { document: {getElementById:get}, addEventListener() {}, setInterval() {}, localStorage, URL }
  rodarCliente(state)
  return { get, state, execute: code => runInNewContext(code, state) }
}

test('nome salvo volta disponível em uma nova carga', () => {
  const storage = new Map()
  fixture(storage).execute("salvarNome('Marcus')")
  assert.equal(fixture(storage).execute('nomeSalvo()'), 'Marcus')
})

test('armazenamento bloqueado não impede a entrada', () => {
  const {state,execute} = fixture()
  state.localStorage.getItem = state.localStorage.setItem = () => { throw Error('bloqueado') }
  assert.equal(execute('nomeSalvo()'), '')
  assert.doesNotThrow(() => execute("salvarNome('Marcus')"))
})

test('fechamento anormal marca desconexão e registra o que o navegador informou', () => {
  const {get,state} = fixture()
  state.sinalizacaoFechada({code:1006,reason:'',wasClean:false})
  assert.equal(get('connection-alert').hidden, false)
  assert.equal(get('connection-label').textContent, 'Sinalização desconectada')
  assert.equal(get('my-status').textContent, 'Desconectado')
  assert.equal(get('sala').classes.has('desconectada'), true)
  assert.match(get('log').textContent, /código=1006; motivo=\(não informado\); fechamento completo=false/)
})

test('fechamento normal também desconecta; mensagem comum não remove o alerta', () => {
  const {get,state} = fixture()
  state.sinalizacaoFechada({code:1000,reason:'servidor fechou',wasClean:true})
  get('ui-notice').textContent = 'Link copiado'
  assert.equal(get('connection-alert').hidden, false)
  assert.match(get('log').textContent, /código=1000; motivo=servidor fechou/)
})

test('novo welcome limpa o estado de desconexão', () => {
  const {get,state} = fixture()
  state.atualizarSinalizacao(false)
  state.atualizarSinalizacao(true)
  assert.equal(get('connection-alert').hidden, true)
  assert.equal(get('sala').classes.has('desconectada'), false)
  assert.equal(get('my-status').textContent, 'Na sala')
})

test('perda da sinalização não encerra mídia que ainda possa estar funcionando', () => {
  const {get,state} = fixture()
  state.peer = {nome:'Teste',pc:{connectionState:'connected',iceConnectionState:'connected',close(){throw Error('mídia encerrada')}}}
  runInNewContext("pares.set('p', peer); pessoas.set('p', peer)",state)
  state.sinalizacaoFechada({code:1006,reason:'',wasClean:false})
  assert.match(get('log').textContent, /conexão com Teste: connected; ICE=connected/)
})
