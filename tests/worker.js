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
