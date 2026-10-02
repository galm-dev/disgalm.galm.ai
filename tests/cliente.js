// O cliente é o index.html mais os scripts que ele carrega, sem bundler. Os
// testes rodam tudo no mesmo contexto, na ordem da página, como o navegador:
// scripts clássicos dividem o escopo global. auth.js e ruido.js ficam de fora;
// os testes trocam o que precisam deles por stubs.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const publico = nome => new URL(`../public/${nome}`, import.meta.url)
const FORA = new Set(['auth.js', 'ruido.js'])

const html = readFileSync(publico('index.html'), 'utf8')
export const externos = [...html.matchAll(/<script src="\/([\w-]+\.js)"><\/script>/g)].map(m => m[1])
export const inline = html.split('<script>')[1].split('</script>')[0]
export const scripts = [
  ...externos.filter(n => !FORA.has(n)).map(n => readFileSync(publico(n), 'utf8')),
  inline,
]

export function rodarCliente(state) {
  for (const s of scripts) runInNewContext(s, state)
  return state
}

export const lerPublico = nome => readFileSync(publico(nome), 'utf8')
