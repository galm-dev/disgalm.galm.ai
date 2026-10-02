// Carrega o Worker fora do runtime: troca 'cloudflare:workers' por uma base
// mínima e copia os módulos de worker/src como .mjs, com os imports ajustados.
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function carregarWorker() {
  const pasta = mkdtempSync(join(tmpdir(), 'disgalm-worker-'))
  const src = new URL('../worker/src/', import.meta.url)
  for (const nome of readdirSync(src).filter(n => n.endsWith('.js'))) {
    const fonte = readFileSync(new URL(nome, src), 'utf8')
      .replace("import { DurableObject } from 'cloudflare:workers'",
        'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }')
      .replace(/from '\.\/([\w-]+)\.js'/g, "from './$1.mjs'")
    writeFileSync(join(pasta, nome.replace(/\.js$/, '.mjs')), fonte)
  }
  return { pasta, ...await import(join(pasta, 'index.mjs')) }
}

// Storage que clona na escrita e na leitura, como o do runtime.
export function criarStorage() {
  const saved = new Map()
  return { saved, alarmAt: null,
    async get(k) { return structuredClone(saved.get(k)) }, async put(k, v) { saved.set(k, structuredClone(v)) },
    async delete(k) { return saved.delete(k) },
    async setAlarm(v) { this.alarmAt = v }, async deleteAlarm() { this.alarmAt = null } }
}

// Retrato de consumo recém-coletado, do mês corrente.
export const retrato = (campos = {}) => {
  const agora = Date.now()
  const hora = new Date(agora); hora.setUTCMinutes(0, 0, 0)
  return { mes: new Date(agora).toISOString().slice(0, 7), coletado_em: agora, medido_ate: +hora - 3600_000,
    completo: true, turn_bytes: 0, turn_bytes_sfu: 0, sfu_bytes: 0, sfu_fonte: 'graphql', ...campos }
}

// Binding ORCAMENTO com o objeto de verdade e storage em memória. A chamada
// RPC vira chamada direta ao método.
export function criarOrcamento(Orcamento, { snapshot = retrato(), env = {} } = {}) {
  const storage = criarStorage()
  if (snapshot) storage.saved.set('snapshot', structuredClone(snapshot))
  const tarefas = []
  const objeto = new Orcamento({ storage, waitUntil: p => tarefas.push(p) }, env)
  return { objeto, storage, tarefas, binding: { idFromName: n => n, get: () => objeto } }
}
