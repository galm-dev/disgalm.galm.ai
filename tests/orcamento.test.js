import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { carregarWorker, criarOrcamento, retrato } from './worker.js'

const { Orcamento, default: worker, pasta } = await carregarWorker()
const { avaliar, autorizarCom, coletarUso, TAXAS, TAXA_TURN, TTL_TURN_S, VALIDADE_MS } = await import(`${pasta}/orcamento.mjs`)

const GB = 1e9
const MIN = 60_000
let logs, logOriginal, fetchOriginal
beforeEach(() => {
  logs = []
  logOriginal = console.log
  fetchOriginal = globalThis.fetch
  console.log = l => logs.push(String(l))
})
afterEach(() => { console.log = logOriginal; globalThis.fetch = fetchOriginal })
const eventos = nome => logs.map(l => { try { return JSON.parse(l) } catch { return {} } }).filter(e => e.evento === nome)
const reservas = o => o.storage.saved.get('reservas') ?? {}

test('limiares: 90% nega SFU, 98% nega TURN, contando a margem de 10 GB', async () => {
  const caso = async (turnGb, recurso) => criarOrcamento(Orcamento, { snapshot: retrato({ turn_bytes: turnGb * GB }) })
    .objeto.autorizar({ recurso })
  assert.equal((await caso(879, 'sfu')).ok, true)
  const negado = await caso(890, 'sfu')
  assert.deepEqual([negado.ok, negado.motivo, negado.uso_protegido_pct, negado.limiar_pct], [false, 'limite', 90, 90])
  assert.equal((await caso(890, 'turn')).ok, true)
  assert.equal((await caso(969, 'turn')).ok, true)
  assert.equal((await caso(970, 'turn')).ok, false)
  // O SFU medido entra na mesma conta: a franquia é uma só.
  const somado = criarOrcamento(Orcamento, { snapshot: retrato({ turn_bytes: 500 * GB, sfu_bytes: 400 * GB }) })
  assert.equal((await somado.objeto.autorizar({ recurso: 'sfu' })).ok, false)
  assert.equal((await somado.objeto.autorizar({ recurso: 'turn' })).ok, true)
})

test('reserva: cada assinatura aberta conta até a próxima medição e para de crescer ao fechar', async () => {
  const o = criarOrcamento(Orcamento, { snapshot: retrato({ turn_bytes: 823 * GB }) })
  const tela = TAXAS['tela-video'] * VALIDADE_MS / 1000      // ~16,9 GB por assinatura de tela
  assert.ok(tela > 16 * GB && tela < 17 * GB)
  const pedir = ref => o.objeto.autorizar({ recurso: 'sfu', op: 'assinar', reservas: [{ ref, tipo: 'sfu', bps: TAXAS['tela-video'] }] })
  const a = await pedir('sfu:s1:aaaa0001/tela-1/video')
  assert.equal(a.ok, true)
  assert.equal(a.refs.length, 1)
  assert.ok(a.refs[0].startsWith('sfu:s1:aaaa0001/tela-1/video#'))
  assert.equal((await pedir('sfu:s2:aaaa0001/tela-1/video')).ok, true)      // 823+10+16,9+16,9 = 866,8
  assert.equal((await pedir('sfu:s3:aaaa0001/tela-1/video')).ok, true)      // 883,6
  const quarta = await pedir('sfu:s4:aaaa0001/tela-1/video')                 // 900,5: passa de 90%
  assert.deepEqual([quarta.ok, quarta.motivo], [false, 'limite'])
  assert.equal(Object.keys(reservas(o)).length, 3)
  // Fechar uma assinatura devolve a folga do futuro dela.
  assert.equal(await o.objeto.liberar({ refs: ['sfu:s1:aaaa0001/tela-1/video'] }), 1)
  assert.ok(Object.values(reservas(o)).some(r => r.fim !== null))
  assert.equal((await pedir('sfu:s4:aaaa0001/tela-1/video')).ok, true)
  // Por prefixo (sessão encerrada).
  assert.equal(await o.objeto.liberar({ prefixo: 'sfu:s2:' }), 1)
})

test('reserva TURN some quando a medição cobre o período dela', async () => {
  const o = criarOrcamento(Orcamento)
  const r = await o.objeto.autorizar({ recurso: 'turn', op: 'ice', reservas: [{ tipo: 'turn', bps: TAXA_TURN, duracao_ms: TTL_TURN_S * 1000 }] })
  assert.equal(r.ok, true)
  assert.equal(Math.round(r.reserva_bytes / GB * 100) / 100, 1.88)        // 50 Mbps por 5 min
  assert.equal(Object.keys(reservas(o)).length, 1)
  await o.objeto.gravarSnapshot(retrato({ coletado_em: Date.now() + 1, medido_ate: Date.now() + 10 * MIN }))
  assert.equal(Object.keys(reservas(o)).length, 0)
  assert.equal(eventos('orcamento_snapshot').length, 1)
})

test('retrato ausente, incompleto ou vencido nega TURN e SFU; erro não vale zero', async () => {
  const motivos = []
  for (const snapshot of [null, retrato({ completo: false }), retrato({ coletado_em: Date.now() - 80 * MIN })]) {
    const o = criarOrcamento(Orcamento, { snapshot })
    for (const recurso of ['sfu', 'turn']) {
      const r = await o.objeto.autorizar({ recurso })
      assert.equal(r.ok, false)
      motivos.push(r.motivo)
    }
  }
  assert.deepEqual(motivos, ['snapshot_ausente', 'snapshot_ausente', 'snapshot_incompleto', 'snapshot_incompleto',
    'snapshot_vencido', 'snapshot_vencido'])
  // Retrato válido, mas sem binding ou com falha na chamada: também nega.
  assert.deepEqual(await autorizarCom({}, { recurso: 'turn' }), { ok: false, motivo: 'sem_orcamento' })
  const quebrado = { ORCAMENTO: { idFromName: n => n, get: () => ({ autorizar: async () => { throw new Error('DO fora') } }) } }
  assert.equal((await autorizarCom(quebrado, { recurso: 'turn' })).motivo, 'erro')
})

test('retrato vencido dispara uma coleta pontual, no máximo a cada 5 min', async () => {
  const env = { CF_ACCOUNT_ID: 'conta-1', CF_ANALYTICS_TOKEN: 'segredo-analytics' }
  const o = criarOrcamento(Orcamento, { snapshot: retrato({ coletado_em: Date.now() - 2 * 3600_000 }), env, coletar: true })
  let consultas = 0
  globalThis.fetch = async (url, init) => {
    consultas++
    const sfu = JSON.parse(init.body).query.includes('callsUsageAdaptiveGroups')
    const dataset = sfu ? 'callsUsageAdaptiveGroups' : 'callsTurnUsageAdaptiveGroups'
    return Response.json({ data: { viewer: { accounts: [{ [dataset]: [] }] } } })
  }
  const r = await o.objeto.autorizar({ recurso: 'turn' })
  assert.equal(r.ok, true)
  assert.equal(consultas, 2)
  assert.equal(eventos('orcamento_snapshot_vencido').length, 1)
  // Analytics fora do ar: a próxima falta de retrato não consulta de novo tão cedo.
  o.storage.saved.set('snapshot', retrato({ coletado_em: Date.now() - 2 * 3600_000 }))
  assert.equal((await o.objeto.autorizar({ recurso: 'turn' })).ok, false)
  assert.equal(consultas, 2)
})

test('virada do mês: retrato do mês passado não vale e reservas dele saem', async () => {
  const agora = Date.now()
  const d = new Date(agora)
  const inicioMes = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const mesPassado = new Date(inicioMes - 1).toISOString().slice(0, 7)
  const o = criarOrcamento(Orcamento, { snapshot: retrato({ mes: mesPassado, turn_bytes: 990 * GB }) })
  const r = await o.objeto.autorizar({ recurso: 'turn' })
  assert.deepEqual([r.ok, r.motivo], [false, 'snapshot_vencido'])
  // Assinatura que atravessa a virada: só o trecho deste mês conta.
  o.storage.saved.set('reservas', {
    velha: { ref: 'velha', tipo: 'sfu', bps: TAXAS['tela-video'], inicio: inicioMes - 3 * 3600_000, fim: inicioMes - 3600_000 },
    atravessa: { ref: 'atravessa', tipo: 'sfu', bps: 1e6, inicio: inicioMes - 3600_000, fim: inicioMes + 1000 },
  })
  await o.objeto.gravarSnapshot(retrato())
  assert.deepEqual(Object.keys(reservas(o)), ['atravessa'])
  const est = avaliar({ snapshot: retrato(), reservas: Object.values(reservas(o)), agora, recurso: 'sfu' })
  assert.equal(est.ok, true)
  assert.ok(est.uso_protegido_pct < 1.01)                      // 10 GB de margem + 1 MB do trecho deste mês
})

test('sem medição do SFU, vale o teto das assinaturas do mês', async () => {
  const agora = Date.now()
  const hora = { tipo: 'sfu', bps: TAXAS['tela-video'], inicio: agora - 2 * 3600_000, fim: agora - 3600_000 }
  const comMedicao = avaliar({ snapshot: retrato({ sfu_bytes: 1 * GB }), reservas: [hora], agora, recurso: 'sfu' })
  const semMedicao = avaliar({ snapshot: retrato({ sfu_bytes: null, sfu_fonte: 'estimativa' }), reservas: [hora], agora, recurso: 'sfu' })
  // Uma hora de tela a 30 Mbps = 13,5 GB; a medição de 1 GB não baixa a conta.
  assert.equal(comMedicao.uso_protegido_pct, semMedicao.uso_protegido_pct)
  assert.equal(semMedicao.uso_protegido_pct, 2.35)
  const medidoMaior = avaliar({ snapshot: retrato({ sfu_bytes: 100 * GB }), reservas: [hora], agora, recurso: 'sfu' })
  assert.equal(medidoMaior.uso_protegido_pct, 11)
})

test('coleta separa o TURN que leva ao SFU e cai na estimativa se o dataset do SFU falhar', async () => {
  const agora = new Date('2026-10-02T15:10:00Z')
  const turn = [
    { dimensions: { datetimeHour: '2026-10-02T13:00:00Z', customIdentifier: 'disgalm' }, sum: { egressBytes: 5e9, ingressBytes: 1 } },
    { dimensions: { datetimeHour: '2026-10-02T14:00:00Z', customIdentifier: 'disgalm-sfu' }, sum: { egressBytes: 2e9, ingressBytes: 1 } },
    { dimensions: { datetimeHour: '2026-09-30T23:00:00Z', customIdentifier: 'disgalm' }, sum: { egressBytes: 9e9, ingressBytes: 1 } },
  ]
  const env = { CF_ACCOUNT_ID: 'conta-1', CF_ANALYTICS_TOKEN: 'segredo-analytics' }
  let sfuOk = true
  globalThis.fetch = async (url, init) => {
    if (JSON.parse(init.body).query.includes('callsUsageAdaptiveGroups'))
      return sfuOk ? Response.json({ data: { viewer: { accounts: [{ callsUsageAdaptiveGroups: [
        { dimensions: { datetimeHour: '2026-10-02T14:00:00Z' }, sum: { egressBytes: 7e9 } }] }] } } })
        : Response.json({ data: null, errors: [{ message: 'unknown field callsUsageAdaptiveGroups' }] })
    return Response.json({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: turn }] } } })
  }
  const r = await coletarUso(env, agora)
  assert.deepEqual(r.snapshot, { mes: '2026-10', coletado_em: +agora, medido_ate: Date.parse('2026-10-02T14:00:00Z'),
    completo: true, turn_bytes: 5e9, turn_bytes_sfu: 2e9, sfu_bytes: 7e9, sfu_fonte: 'graphql' })
  assert.deepEqual(r.linhas.map(l => l.evento), ['turn_uso'])
  // O turn_uso continua com o TURN inteiro, como antes.
  assert.equal(r.linhas[0].egress_bytes_mes, 7e9)
  sfuOk = false
  const semSfu = await coletarUso(env, agora)
  assert.deepEqual([semSfu.snapshot.completo, semSfu.snapshot.sfu_bytes, semSfu.snapshot.sfu_fonte], [true, null, 'estimativa'])
  assert.deepEqual(semSfu.linhas.map(l => l.evento), ['turn_uso', 'sfu_uso_falhou'])
  assert.doesNotMatch(JSON.stringify(semSfu.linhas), /segredo|conta-1/)
})

test('cron grava o retrato no orçamento da conta', async () => {
  const o = criarOrcamento(Orcamento, { snapshot: null })
  const env = { CF_ACCOUNT_ID: 'conta-1', CF_ANALYTICS_TOKEN: 'segredo-analytics', ORCAMENTO: o.binding }
  globalThis.fetch = async (url, init) => {
    const ds = JSON.parse(init.body).query.includes('callsUsageAdaptiveGroups') ? 'callsUsageAdaptiveGroups' : 'callsTurnUsageAdaptiveGroups'
    return Response.json({ data: { viewer: { accounts: [{ [ds]: [] }] } } })
  }
  const pendentes = []
  await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: p => pendentes.push(p) })
  await Promise.all(pendentes)
  assert.equal(o.storage.saved.get('snapshot').completo, true)
  assert.equal((await o.objeto.autorizar({ recurso: 'turn' })).ok, true)
})

test('negações repetidas viram um evento só, sem dado pessoal', async () => {
  const o = criarOrcamento(Orcamento, { snapshot: retrato({ turn_bytes: 975 * GB }) })
  for (let i = 0; i < 5; i++) await o.objeto.autorizar({ recurso: 'turn', op: 'ice', sala: 'galm' })
  await Promise.all(o.tarefas)
  const bloqueios = eventos('rota_cota_bloqueio')
  assert.equal(bloqueios.length, 1)
  assert.deepEqual([bloqueios[0].operacao, bloqueios[0].motivo, bloqueios[0].limiar_pct, bloqueios[0].acao],
    ['ice', 'limite', 98, 'negado'])
  assert.equal(o.storage.saved.get('bloqueio').repeticoes, 4)
})

// ---------- /ice ----------

function envIce({ orcamento, modo = 'mesh', turn = true } = {}) {
  const chamadas = []
  globalThis.fetch = async (url, init) => {
    chamadas.push({ url, corpo: init?.body ? JSON.parse(init.body) : null })
    return Response.json({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }] }, { status: 201 })
  }
  const SALA = { idFromName: n => n, get: () => ({ fetch: async req => {
    const p = new URL(req.url).pathname
    if (p === '/guest/check') return Response.json({ exp: Math.floor(Date.now() / 1000) + 900 })
    if (p === '/modo') return Response.json({ modo })
    return new Response('?', { status: 404 })
  } }) }
  const env = { SALA, ...(orcamento && { ORCAMENTO: orcamento.binding }),
    ...(turn && { CF_TURN_KEY_ID: 'chave', CF_TURN_API_TOKEN: 'segredo-turn' }) }
  const pedir = () => worker.fetch(new Request('https://disgalm.galm.ai/ice?sala=galm',
    { headers: { cookie: `__Host-disgalm_guest=${'d'.repeat(64)}` } }), env, {})
  return { chamadas, pedir }
}

test('/ice emite TURN de 5 min com etiqueta e reserva, se o orçamento libera', async () => {
  const o = criarOrcamento(Orcamento)
  const { chamadas, pedir } = envIce({ orcamento: o })
  const r = await pedir()
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('x-disgalm-ice-validade'), '300')
  assert.equal(r.headers.get('x-disgalm-relay'), null)
  assert.equal((await r.json())[0].username, 'u')
  assert.deepEqual(chamadas.at(-1).corpo, { ttl: 300, customIdentifier: 'disgalm' })
  assert.equal(Object.values(reservas(o)).filter(x => x.tipo === 'turn').length, 1)

  // Chamada em SFU: etiqueta própria e nenhuma reserva de TURN.
  const sfu = envIce({ orcamento: o, modo: 'sfu' })
  await sfu.pedir()
  assert.deepEqual(sfu.chamadas.at(-1).corpo, { ttl: 300, customIdentifier: 'disgalm-sfu' })
  assert.equal(Object.values(reservas(o)).filter(x => x.tipo === 'turn').length, 1)
})

test('/ice em 98%, sem retrato ou sem orçamento: só STUN, motivo no cabeçalho', async () => {
  const casos = [
    [criarOrcamento(Orcamento, { snapshot: retrato({ turn_bytes: 975 * GB }) }), 'negado;limite'],
    [criarOrcamento(Orcamento, { snapshot: null }), 'negado;snapshot_ausente'],
    [null, 'negado;sem_orcamento'],
  ]
  for (const [o, relay] of casos) {
    const { chamadas, pedir } = envIce({ orcamento: o })
    const r = await pedir()
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('x-disgalm-relay'), relay)
    assert.equal(r.headers.get('x-disgalm-ice-validade'), '600')
    assert.deepEqual(await r.json(), [{ urls: 'stun:stun.cloudflare.com:3478' }])
    assert.ok(!chamadas.some(c => String(c.url).includes('/turn/keys/')), relay)
  }
  // Sem TURN da Cloudflare configurado, nada a negar.
  const { pedir } = envIce({ turn: false })
  assert.equal((await pedir()).headers.get('x-disgalm-relay'), null)
})

// ---------- modo sem medição ----------

test('sem medição: TURN nunca é negado, mesmo sem retrato, e não reserva', async () => {
  const o = criarOrcamento(Orcamento, { snapshot: null, semMedicao: true })
  for (let i = 0; i < 3; i++) {
    const r = await o.objeto.autorizar({ recurso: 'turn', op: 'ice', reservas: [{ tipo: 'turn', bps: TAXA_TURN, duracao_ms: 300_000 }] })
    assert.deepEqual([r.ok, r.modo], [true, 'sem_medicao'])
  }
  assert.deepEqual(reservas(o), {})
  // Nem um retrato velho de antes, nem a falta dele, mudam isso.
  o.storage.saved.set('snapshot', retrato({ coletado_em: Date.now() - 5 * 3600_000, turn_bytes: 999e9 }))
  assert.equal((await o.objeto.autorizar({ recurso: 'turn' })).ok, true)
  // E o /ice entrega a credencial de 5 min normalmente.
  const { chamadas, pedir } = envIce({ orcamento: o })
  const resp = await pedir()
  assert.equal(resp.headers.get('x-disgalm-relay'), null)
  assert.equal(resp.headers.get('x-disgalm-ice-validade'), '300')
  assert.deepEqual(chamadas.at(-1).corpo, { ttl: 300, customIdentifier: 'disgalm' })
})

test('sem medição: o SFU conta o que autorizou e para em 90%, sem depender de retrato', async () => {
  const o = criarOrcamento(Orcamento, { snapshot: null, semMedicao: true })
  assert.equal((await o.objeto.autorizar({ recurso: 'sfu', op: 'chamada' })).ok, true)
  // 880 GB autorizados e já gastos neste mês (uma assinatura longa, fechada).
  const agora = Date.now()
  const d = new Date(agora), inicioMes = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const bps = 880e9 / ((agora - inicioMes) / 1000)
  o.storage.saved.set('reservas', { longa: { ref: 'longa', tipo: 'sfu', bps, inicio: inicioMes, fim: agora } })
  const tela = { ref: 'sfu:s1:aaaa0001/tela-1/video', tipo: 'sfu', bps: TAXAS['tela-video'] }   // +16,9 GB
  const r = await o.objeto.autorizar({ recurso: 'sfu', op: 'assinar', reservas: [tela] })
  assert.deepEqual([r.ok, r.motivo, r.modo], [false, 'limite', 'sem_medicao'])
  assert.ok(r.uso_protegido_pct >= 90 && r.uso_protegido_pct < 91)
  assert.equal((await o.objeto.autorizar({ recurso: 'sfu', op: 'publicar' })).ok, true)     // 89% sem nada novo
  // TURN continua liberado no mesmo estado.
  assert.equal((await o.objeto.autorizar({ recurso: 'turn' })).ok, true)
  // Total sobrevive à hibernação: objeto novo com o mesmo storage.
  const outro = new Orcamento({ storage: o.storage, waitUntil() {} }, {})
  assert.equal((await outro.autorizar({ recurso: 'sfu', op: 'assinar', reservas: [tela] })).ok, false)
  const est = await outro.estado()
  assert.equal(est.modo, 'sem_medicao')
})

test('sem medição: a virada do mês zera o total do SFU', async () => {
  const o = criarOrcamento(Orcamento, { snapshot: null, semMedicao: true })
  const d = new Date(), inicioMes = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  o.storage.saved.set('reservas', {
    passado: { ref: 'passado', tipo: 'sfu', bps: 999e9 / 3600, inicio: inicioMes - 2 * 3600_000, fim: inicioMes - 3600_000 } })
  const r = await o.objeto.autorizar({ recurso: 'sfu', op: 'assinar', reservas: [{ ref: 'x', tipo: 'sfu', bps: TAXAS.mic }] })
  assert.equal(r.ok, true)
  assert.ok(r.uso_protegido_pct < 1.1)
  assert.deepEqual(Object.keys(reservas(o)).map(k => k.split('#')[0]), ['x'])
})

test('modo: evento por dia sem medição com o total do SFU, e na troca quando os secrets aparecem', async () => {
  const o = criarOrcamento(Orcamento, { snapshot: retrato(), semMedicao: true })
  for (let i = 0; i < 3; i++) await o.objeto.autorizar({ recurso: 'turn' })
  await o.objeto.autorizar({ recurso: 'sfu', reservas: [{ ref: 'a', tipo: 'sfu', bps: TAXAS.mic }] })
  await Promise.all(o.tarefas)
  let modos = eventos('orcamento_modo')
  assert.equal(modos.length, 1)
  assert.deepEqual([modos[0].modo, modos[0].modo_anterior, typeof modos[0].sfu_estimado_gb_mes, typeof modos[0].uso_protegido_pct],
    ['sem_medicao', null, 'number', 'number'])
  // No dia seguinte, outro.
  o.storage.saved.set('modo', { modo: 'sem_medicao', dia: '2000-01-01' })
  await o.objeto.autorizar({ recurso: 'turn' })
  await Promise.all(o.tarefas)
  assert.equal(eventos('orcamento_modo').length, 2)
  // Os secrets existem agora: mesmo código, modo medido, e o retrato volta a valer.
  const medido = new Orcamento({ storage: o.storage, waitUntil: p => o.tarefas.push(p) },
    { CF_ACCOUNT_ID: 'conta-teste', CF_ANALYTICS_TOKEN: 'token-teste' })
  o.storage.saved.set('snapshot', retrato({ turn_bytes: 975e9 }))
  const turn = await medido.autorizar({ recurso: 'turn' })
  assert.deepEqual([turn.ok, turn.motivo], [false, 'limite'])
  await Promise.all(o.tarefas)
  modos = eventos('orcamento_modo')
  assert.deepEqual(modos.at(-1), { ...modos.at(-1), modo: 'medido', modo_anterior: 'sem_medicao' })
  assert.doesNotMatch(JSON.stringify(modos), /conta-teste|token-teste/)
})
