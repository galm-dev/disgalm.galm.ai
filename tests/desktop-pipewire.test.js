import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { planejar, SAIDA } = createRequire(import.meta.url)('../desktop/pipewire.js')
const DISCORD = /^discord/i

// pw-dump mínimo: a saída virtual (portas FL/FR), três fluxos e um link velho.
const no = (id, props) => ({ id, type: 'PipeWire:Interface:Node', info: { props } })
const porta = (id, node, dir, canal) => ({ id, type: 'PipeWire:Interface:Port',
  info: { props: { 'node.id': node, 'port.direction': dir, 'audio.channel': canal } } })
const cliente = (id, pid) => ({ id, type: 'PipeWire:Interface:Client', info: { props: { 'pipewire.sec.pid': pid } } })
const link = (id, saida, entrada) => ({ id, type: 'PipeWire:Interface:Link', info: { 'output-port-id': saida, 'input-port-id': entrada } })
const fluxo = props => ({ 'media.class': 'Stream/Output/Audio', ...props })

const dump = [
  no(10, { 'node.name': SAIDA, 'media.class': 'Audio/Sink' }), porta(11, 10, 'in', 'FL'), porta(12, 10, 'in', 'FR'),
  // Navegador comum, estéreo: entra.
  no(20, fluxo({ 'application.process.id': '500', 'application.process.binary': 'firefox' })),
  porta(21, 20, 'out', 'FL'), porta(22, 20, 'out', 'FR'),
  // O próprio Disgalm (PID na árvore excluída): fora.
  no(30, fluxo({ 'application.process.id': '900', 'application.process.binary': 'disgalm' })),
  porta(31, 30, 'out', 'FL'), porta(32, 30, 'out', 'FR'),
  // pw-play sem PID no nó, filho do Discord pelo cliente: fora.
  no(40, fluxo({ 'client.id': 41 })), cliente(41, 777), porta(42, 40, 'out', 'MONO'),
  // Mono comum, PID só no cliente: entra nos dois lados.
  no(50, fluxo({ 'client.id': 51 })), cliente(51, 600), porta(52, 50, 'out', 'MONO'),
  // Discord pelo nome do binário: fora.
  no(60, fluxo({ 'application.process.id': '800', 'application.process.binary': 'Discord' })), porta(61, 60, 'out', 'FL'),
  // Link que sobrou de quando o Disgalm não era excluído.
  link(70, 31, 11),
]

test('liga a cópia de todo fluxo que não é do Disgalm nem do Discord, mono nos dois lados', () => {
  const plano = planejar(dump, new Set([900, 777]), DISCORD)
  assert.deepEqual(plano.querido.sort(), [[21, 11], [22, 12], [52, 11], [52, 12]].sort())
})

test('lista os links atuais da saída virtual, para desfazer os que sobraram', () => {
  assert.deepEqual(planejar(dump, new Set([900, 777]), DISCORD).atuais, [[31, 11]])
})

test('sem a saída virtual não há plano', () => {
  assert.equal(planejar(dump.filter(o => o.id !== 10), new Set(), DISCORD), null)
})
