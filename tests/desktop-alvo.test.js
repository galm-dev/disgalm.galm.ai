import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { raizesDe } = createRequire(import.meta.url)('../desktop/alvo.js')
const NOMES = ['Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe']
const p = (pid, ppid, nome = 'Discord.exe') => ({ pid, ppid, nome })
const semData = () => null

// Árvore medida na VM: Update.exe (já saiu) → Discord.exe → 5 filhos.
const discord = [p(5016, 7092), p(10600, 5016), p(564, 5016), p(4372, 5016), p(7640, 5016), p(1452, 5016)]

test('a raiz é o Discord.exe cujo pai não é Discord, e conta a árvore inteira', () => {
  assert.deepEqual(raizesDe([...discord, p(1, 0, 'explorer.exe')], NOMES, semData),
    [{ pid: 5016, nome: 'Discord.exe', descendentes: 5 }])
})

test('nome sem diferenciar maiúsculas, e PTB/Canary entram', () => {
  const r = raizesDe([p(10, 1, 'discordptb.EXE'), p(11, 10, 'DiscordPTB.exe')], NOMES, semData)
  assert.deepEqual(r.map(x => [x.pid, x.descendentes]), [[10, 1]])
})

test('com duas raízes, a de mais descendentes vem primeiro', () => {
  const r = raizesDe([p(900, 1), ...discord], NOMES, semData)
  assert.deepEqual(r.map(x => x.pid), [5016, 900])
})

test('pai com PID reusado, nascido depois do filho, não conta como pai', () => {
  const nasc = { 20: 2000, 30: 1000, 31: 1500 }
  const procs = [p(20, 1), p(30, 20), p(31, 30)]
  assert.deepEqual(raizesDe(procs, NOMES, pid => nasc[pid] ?? null).map(x => [x.pid, x.descendentes]),
    [[30, 1], [20, 0]])
})

test('ciclo de ppid por PID reusado não trava a contagem', () => {
  const nasc = { 40: 1000, 41: 500 }
  const procs = [p(40, 41), p(41, 40), p(42, 40)]
  // 41 nasceu antes de 40: é o pai de verdade, e a volta 41 → 40 → 41 para.
  assert.deepEqual(raizesDe(procs, NOMES, pid => nasc[pid] ?? null).map(x => [x.pid, x.descendentes]), [[41, 2]])
})

test('sem Discord, lista vazia', () => {
  assert.deepEqual(raizesDe([p(1, 0, 'explorer.exe')], NOMES, semData), [])
})

const { planejarInclusoes } = createRequire(import.meta.url)('../desktop/alvo.js')
const sessao = pid => ({ pid, ativa: true })
const arvore = [
  p(1, 0, 'System'), p(100, 1, 'explorer.exe'),
  p(200, 100, 'Disgalm.exe'), p(201, 200, 'Disgalm.exe'),        // o app e o serviço de áudio dele
  ...discord,                                                     // Discord 5016 e filhos
  p(300, 100, 'chrome.exe'), p(301, 300, 'chrome.exe'),           // navegador e o processo de áudio
  p(400, 100, 'spotify.exe'),
]

test('inclui quem toca, menos as árvores do Disgalm e do Discord', () => {
  const sessoes = [sessao(201), sessao(1452), sessao(301), sessao(400), sessao(0)]
  assert.deepEqual(planejarInclusoes(arvore, sessoes, { pidApp: 200, nomes: NOMES }), [301, 400])
})

test('com pai e filho tocando, a captura do pai basta', () => {
  const sessoes = [sessao(300), sessao(301)]
  assert.deepEqual(planejarInclusoes(arvore, sessoes, { pidApp: 200, nomes: NOMES }), [300])
})

test('PID de sessão que já morreu fica de fora', () => {
  assert.deepEqual(planejarInclusoes(arvore, [sessao(999)], { pidApp: 200, nomes: NOMES }), [])
})
