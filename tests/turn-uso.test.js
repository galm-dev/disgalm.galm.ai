import { test } from 'node:test'
import { carregarWorker } from './worker.js'
import assert from 'node:assert/strict'

const { default: worker } = await carregarWorker()

const env = { CF_ACCOUNT_ID: 'conta-1', CF_ANALYTICS_TOKEN: 'segredo-analytics',
  BETTERSTACK_TOKEN: 'segredo-bs', BETTERSTACK_HOST: 'logs.example' }
const grupo = (hora, egressBytes, ingressBytes) =>
  ({ dimensions: { datetimeHour: hora }, sum: { egressBytes, ingressBytes } })

// Roda o cron com fetch simulado e devolve as chamadas e as linhas de log.
async function cron(agora, respostaGraphql, envTeste = env,
  respostaSfu = () => Response.json({ data: { viewer: { accounts: [{ callsUsageAdaptiveGroups: [] }] } } })) {
  const chamadas = []
  const originalFetch = globalThis.fetch, originalLog = console.log
  globalThis.fetch = async (url, init) => {
    chamadas.push({ url, init })
    if (url === 'https://api.cloudflare.com/client/v4/graphql')
      return JSON.parse(init.body).query.includes('callsUsageAdaptiveGroups') ? respostaSfu() : respostaGraphql()
    return new Response(null, { status: 202 })
  }
  console.log = () => {}
  try {
    const pendentes = []
    await worker.scheduled({ scheduledTime: Date.parse(agora), cron: '10 * * * *' }, envTeste,
      { waitUntil: p => pendentes.push(p) })
    await Promise.all(pendentes)
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
  }
  const graphql = chamadas.filter(c => c.url.includes('graphql') && !JSON.parse(c.init.body).query.includes('callsUsageAdaptiveGroups'))
  const logs = chamadas.filter(c => c.url === 'https://logs.example').flatMap(c => JSON.parse(c.init.body))
  return { graphql, logs, chamadas }
}

test('cron consulta o mês por hora e manda período e acumulado ao Better Stack', async () => {
  const { graphql, logs, chamadas } = await cron('2026-10-02T15:10:00Z', () => Response.json({ data: { viewer: {
    accounts: [{ callsTurnUsageAdaptiveGroups: [
      grupo('2026-10-01T08:00:00Z', 300e9, 1e9),
      grupo('2026-10-02T14:00:00Z', 2e9, 5e8),
      grupo('2026-10-02T15:00:00Z', 1e9, 0),
    ] }],
  } } }))

  assert.equal(graphql.length, 1)
  assert.equal(graphql[0].init.headers.authorization, 'Bearer segredo-analytics')
  const corpo = JSON.parse(graphql[0].init.body)
  assert.match(corpo.query, /callsTurnUsageAdaptiveGroups/)
  assert.match(corpo.query, /datetimeHour/)
  assert.deepEqual(corpo.variables, { conta: 'conta-1', de: '2026-10-01', ate: '2026-10-02' })

  assert.equal(logs.length, 1)
  assert.deepEqual({ ...logs[0], dt: undefined }, {
    dt: undefined, message: 'turn_uso', origem: 'worker', evento: 'turn_uso',
    periodo_inicio: '2026-10-02T14:00:00.000Z', periodo_fim: '2026-10-02T15:00:00.000Z',
    egress_bytes_periodo: 2e9, ingress_bytes_periodo: 5e8,
    mes: '2026-10', egress_bytes_mes: 303e9, ingress_bytes_mes: 15e8,
    egress_gb_mes: 303, cota_gb: 1000, cota_pct: 30.3,
  })
  // Nenhuma credencial vai para o log.
  const enviado = chamadas.filter(c => c.url === 'https://logs.example').map(c => c.init.body).join()
  assert.doesNotMatch(enviado, /segredo|conta-1/)
})

test('na virada do mês o período é a última hora do mês anterior, fora do acumulado', async () => {
  const { graphql, logs } = await cron('2026-11-01T00:10:00Z', () => Response.json({ data: { viewer: {
    accounts: [{ callsTurnUsageAdaptiveGroups: [
      grupo('2026-10-31T23:00:00Z', 4e9, 1e9),
      grupo('2026-11-01T00:00:00Z', 1e9, 0),
    ] }],
  } } }))
  assert.deepEqual(JSON.parse(graphql[0].init.body).variables,
    { conta: 'conta-1', de: '2026-10-31', ate: '2026-11-01' })
  assert.equal(logs[0].egress_bytes_periodo, 4e9)
  assert.equal(logs[0].egress_bytes_mes, 1e9)
  assert.equal(logs[0].mes, '2026-11')
})

test('erro da API vira turn_uso_falhou sem credencial', async () => {
  const http = await cron('2026-10-02T15:10:00Z', () => new Response('não', { status: 403 }))
  assert.equal(http.logs[0].evento, 'turn_uso_falhou')
  assert.equal(http.logs[0].status, 403)

  const gql = await cron('2026-10-02T15:10:00Z', () => Response.json({ data: null,
    errors: [{ message: 'not authorized for that account' }] }))
  assert.equal(gql.logs[0].evento, 'turn_uso_falhou')
  assert.equal(gql.logs[0].erro, 'not authorized for that account')

  const rede = await cron('2026-10-02T15:10:00Z', () => { throw new Error('rede caiu') })
  assert.equal(rede.logs[0].evento, 'turn_uso_falhou')
  assert.equal(rede.logs[0].erro, 'rede caiu')
  for (const r of [http, gql, rede]) assert.doesNotMatch(JSON.stringify(r.logs), /segredo/)
})

test('sem os secrets de analytics o cron não consulta nem loga', async () => {
  const { chamadas } = await cron('2026-10-02T15:10:00Z', () => Response.json({}),
    { BETTERSTACK_TOKEN: 'segredo-bs', BETTERSTACK_HOST: 'logs.example' })
  assert.equal(chamadas.length, 0)
})
