// Prova da captura Linux (pipewire.js) sem o app: três tons ao mesmo tempo.
//   1000 Hz — programa comum: tem de aparecer.
//   440 Hz  — tocado por um "Discord" (cópia do bash com esse nome): fora.
//   700 Hz  — tocado dentro da árvore do "app" (pidApp): fora.
// Grava 6 s da entrada que o app usaria e salva em teste/saida/pipewire.wav.
//
//   node teste/pipewire.mjs && python3 teste/analisar.py teste/saida/pipewire.wav
import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { abrir } = createRequire(import.meta.url)('../pipewire.js')
const tmp = join(tmpdir(), 'disgalm-pw')
mkdirSync(tmp, { recursive: true })
const saida = join(import.meta.dirname, 'saida')
mkdirSync(saida, { recursive: true })

function tom(hz) {
  const taxa = 48000, n = taxa * 2, b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(taxa, 24); b.writeUInt32LE(taxa * 2, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * hz * i / taxa)), 44 + i * 2)
  const f = join(tmp, `tom${hz}.wav`)
  writeFileSync(f, b)
  return f
}

const tocar = f => `while :; do pw-play '${f}'; done`
const filhos = []
const iniciar = (cmd, args) => { const p = spawn(cmd, args, { stdio: 'ignore', detached: true }); filhos.push(p); return p }

// O "app": um bash cuja árvore toca 700 Hz.
const app = iniciar('bash', ['-c', tocar(tom(700))])
// O "Discord": cópia do bash com esse nome, tocando 440 Hz num filho.
const discord = join(tmp, 'Discord')
copyFileSync('/bin/bash', discord)
execFileSync('chmod', ['+x', discord])
iniciar(discord, ['-c', tocar(tom(440))])
iniciar('bash', ['-c', tocar(tom(1000))])

const avisos = []
// O Disgalm de verdade, se estiver aberto numa sala, toca o som dos outros (que
// ouvem estes tons pelos microfones): fica de fora também para não sujar a medida.
const captura = await abrir({ pidApp: app.pid, padrao: /^(discord|disgalm)/i, aoAviso: a => avisos.push(a) })
await new Promise(r => setTimeout(r, 3000))
const wav = join(saida, 'pipewire.wav')
try {
  execFileSync('timeout', ['6', 'parecord', '--device=disgalm_captura_fonte', '--rate=48000', '--channels=2',
    '--format=s16le', '--file-format=wav', wav])
} catch {}  // o timeout encerra com código 124
await captura.fechar()
for (const p of filhos) try { process.kill(-p.pid, 'SIGTERM') } catch {}
console.log(avisos.join('\n'))
console.log(wav)
process.exit(0)
