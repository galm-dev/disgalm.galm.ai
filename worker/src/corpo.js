// Corpo de pedido do navegador, lido em stream até o teto. req.text() e
// req.json() leem tudo antes de qualquer conferência de tamanho; aqui o
// content-length declarado acima do teto recusa sem ler, e a leitura para no
// primeiro pedaço que passa dele. null: grande demais.
export async function lerCorpo(req, max) {
  if (Number(req.headers.get('content-length')) > max) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const partes = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      reader.cancel().catch(() => {})
      return null
    }
    partes.push(value)
  }
  const bytes = new Uint8Array(total)
  let pos = 0
  for (const p of partes) { bytes.set(p, pos); pos += p.byteLength }
  return new TextDecoder().decode(bytes)
}
