// Logs estruturados. Sempre no console do Worker; com BETTERSTACK_TOKEN e
// BETTERSTACK_HOST (secrets), também no Better Stack, num POST por lote. O plano
// gratuito do Workers não tem Logpush, por isso o envio sai daqui mesmo.
// Regra da Galm: nunca nome, email, token, credencial TURN nem IP cru; id de
// conexão e sub (UUID) podem ir.
export async function enviarLogs(env, linhas) {
  if (!linhas.length) return
  for (const l of linhas) console.log(JSON.stringify(l))
  if (!env?.BETTERSTACK_TOKEN || !env?.BETTERSTACK_HOST) return
  try {
    const r = await fetch(`https://${env.BETTERSTACK_HOST.replace(/^https?:\/\//, '')}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.BETTERSTACK_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(linhas),
    })
    if (!r.ok) console.log('Better Stack: HTTP', r.status)
  } catch (e) { console.log('Better Stack falhou:', e.message) }
}

export const linhaWorker = (evento, campos) =>
  ({ dt: new Date().toISOString(), message: evento, origem: 'worker', evento, ...campos })
