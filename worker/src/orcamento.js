// Orçamento da franquia gratuita do Cloudflare Realtime: 1.000 GB de saída por
// mês, divididos entre SFU e TURN, sem teto de gasto do lado da Cloudflare. A
// decisão é não pagar nada, então o bloqueio é nosso: em 90% do uso protegido
// o SFU para de aceitar publicações e assinaturas novas, e em 98% o /ice para
// de emitir credenciais TURN da Cloudflare.
// https://developers.cloudflare.com/realtime/sfu/platform/pricing/
//
// Um objeto por conta (idFromName('conta')), não por sala: a franquia é da
// conta inteira. Guarda o último retrato do consumo e as reservas do que já
// foi autorizado e ainda não aparece na medição. Sem timer: a coleta sai do
// cron horário e, se o retrato venceu, de uma consulta pontual no meio de um
// pedido, no máximo a cada 5 min.
//
// Uso protegido = TURN medido + reservas TURN depois da medição
//               + SFU (o maior entre o medido e o teto das assinaturas)
//               + reservas SFU daqui para frente + margem.
// Retrato ausente, incompleto, de outro mês ou com mais de 75 min nega tudo o
// que é cobrado. Erro não vale como consumo zero.
//
// Modo sem medição (decisão do Marcus: sem CF_ACCOUNT_ID/CF_ANALYTICS_TOKEN):
// o TURN da Cloudflare não é bloqueado, como antes do orçamento, e o SFU conta
// só o que o gateway autorizou (teto das assinaturas × tempo), com o mesmo
// limite de 90%. Esse total vive nas reservas do storage e zera na virada do
// mês (UTC). Com os secrets, volta o modo medido, sem mudar código.
import { DurableObject } from 'cloudflare:workers'
import { enviarLogs, linhaWorker } from './logs.js'

export const COTA_BYTES = 1000e9
export const LIMIARES = { sfu: 0.90, turn: 0.98 }
export const VALIDADE_MS = 75 * 60_000
export const MARGEM_BYTES = 10e9
// Credencial TURN curta: quando vence, a Cloudflare para de cobrar na hora e
// derruba a alocação logo depois (FAQ do TURN). O cliente renova antes.
// https://developers.cloudflare.com/realtime/turn/faq/
export const TTL_TURN_S = 300
// Tetos por segundo, em bytes, usados nas reservas. Não são médias: o SFU
// repassa o que o publicador manda, e o maior preset de tela é 25 Mbps.
export const TAXAS = { mic: 0.5e6 / 8, 'tela-audio': 0.5e6 / 8, camera: 2.5e6 / 8, 'tela-video': 30e6 / 8 }
// O que um cliente da malha pode baixar pelo relay numa sala de 4 (três telas
// no preset Equilíbrio com folga). Calibrar com relay_bytes.
export const TAXA_TURN = 50e6 / 8
// O tráfego entre o TURN e o SFU não é cobrado duas vezes: credencial emitida
// para uma chamada em SFU leva esta etiqueta e sai da conta do TURN.
// https://developers.cloudflare.com/realtime/turn/faq/
export const TAG_SFU = 'disgalm-sfu'
export const TAG_MALHA = 'disgalm'

const COLETA_MIN_MS = 5 * 60_000
const COALESCER_MS = 10 * 60_000
const HORA = 3600_000

export const comMedicao = env => !!(env?.CF_ACCOUNT_ID && env?.CF_ANALYTICS_TOKEN)

// Retrato que o modo sem medição usa: nada medido, válido sempre, e o mês
// inteiro coberto só pelas reservas.
const retratoSemMedicao = agora => ({ mes: mesDe(agora), coletado_em: agora, medido_ate: inicioDoMes(agora),
  completo: true, turn_bytes: 0, turn_bytes_sfu: 0, sfu_bytes: null, sfu_fonte: 'estimativa' })

const mesDe = t => new Date(t).toISOString().slice(0, 7)
const inicioDoMes = t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) }
const gb = b => Math.round(b / 1e9 * 1000) / 1000
const pct = b => Math.round(b / COTA_BYTES * 10000) / 100

// ---------- coleta ----------
//
// TURN: dataset callsTurnUsageAdaptiveGroups, documentado em
// https://developers.cloudflare.com/realtime/turn/analytics/ (agrupado também
// por customIdentifier, para separar as credenciais do SFU).
// SFU: dataset callsUsageAdaptiveGroups. Ele existe no schema do GraphQL
// Analytics (dimensões appId, datetimeHour; soma egressBytes), mas não aparece
// na documentação da Cloudflare. Por isso a parte do SFU nunca fica abaixo do
// teto das assinaturas que o gateway autorizou no mês, e se a consulta falhar
// vale só esse teto.

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql'
const USO_TURN = `query ($conta: string!, $de: Date!, $ate: Date!) {
  viewer { accounts(filter: { accountTag: $conta }) {
    callsTurnUsageAdaptiveGroups(limit: 10000, filter: { date_geq: $de, date_leq: $ate }) {
      dimensions { datetimeHour customIdentifier }
      sum { egressBytes ingressBytes }
    }
  } }
}`
const USO_SFU = `query ($conta: string!, $de: Date!, $ate: Date!) {
  viewer { accounts(filter: { accountTag: $conta }) {
    callsUsageAdaptiveGroups(limit: 10000, filter: { date_geq: $de, date_leq: $ate }) {
      dimensions { datetimeHour }
      sum { egressBytes }
    }
  } }
}`

async function consultar(env, query, variables, dataset) {
  let r
  try {
    r = await fetch(GRAPHQL, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
  } catch (e) { return { erro: String(e.message).slice(0, 500) } }
  if (!r.ok) return { status: r.status }
  const corpo = await r.json().catch(() => null)
  if (corpo?.errors?.length) return { erro: corpo.errors.map(e => e.message).join('; ').slice(0, 500) }
  const grupos = corpo?.data?.viewer?.accounts?.[0]?.[dataset]
  return Array.isArray(grupos) ? { grupos } : { erro: `resposta sem ${dataset}` }
}

// Devolve as linhas de log (turn_uso como antes, e falhas) e o retrato para o
// orçamento. null sem os secrets de analytics.
export async function coletarUso(env, agora = new Date()) {
  if (!env?.CF_ACCOUNT_ID || !env?.CF_ANALYTICS_TOKEN) return null
  const dia = d => d.toISOString().slice(0, 10)
  const inicioMes = new Date(inicioDoMes(agora))
  const horaAtual = new Date(agora); horaAtual.setUTCMinutes(0, 0, 0)
  const horaAnterior = new Date(horaAtual - HORA)
  const conta = env.CF_ACCOUNT_ID
  // Uma consulta traz o mês (UTC) em fatias de uma hora: a soma é o acumulado,
  // e a fatia da hora cheia anterior é o período. Na virada do mês a hora
  // anterior é do mês passado: a consulta começa nela.
  const turn = await consultar(env, USO_TURN,
    { conta, de: dia(new Date(Math.min(inicioMes, horaAnterior))), ate: dia(agora) }, 'callsTurnUsageAdaptiveGroups')
  const sfu = await consultar(env, USO_SFU, { conta, de: dia(inicioMes), ate: dia(agora) }, 'callsUsageAdaptiveGroups')

  const hora = g => Date.parse(g.dimensions?.datetimeHour)
  const doMes = g => hora(g) >= +inicioMes
  const soma = (lista, campo) => lista.reduce((t, g) => t + (g.sum?.[campo] || 0), 0)
  const linhas = []
  if (!turn.grupos) linhas.push(linhaWorker('turn_uso_falhou', turn))
  else {
    const mes = turn.grupos.filter(doMes), periodo = turn.grupos.filter(g => hora(g) === +horaAnterior)
    const egress = soma(mes, 'egressBytes')
    linhas.push(linhaWorker('turn_uso', {
      periodo_inicio: horaAnterior.toISOString(), periodo_fim: horaAtual.toISOString(),
      egress_bytes_periodo: soma(periodo, 'egressBytes'), ingress_bytes_periodo: soma(periodo, 'ingressBytes'),
      mes: mesDe(agora), egress_bytes_mes: egress, ingress_bytes_mes: soma(mes, 'ingressBytes'),
      egress_gb_mes: gb(egress), cota_gb: COTA_BYTES / 1e9, cota_pct: pct(egress),
    }))
  }
  if (!sfu.grupos) linhas.push(linhaWorker('sfu_uso_falhou', sfu))

  const turnMes = turn.grupos?.filter(doMes) ?? []
  const deSfu = g => g.dimensions?.customIdentifier === TAG_SFU
  return {
    linhas,
    snapshot: {
      mes: mesDe(agora),
      coletado_em: +agora,
      // A hora que acabou de fechar pode ainda não estar inteira na analytics:
      // a medição só vale até o começo dela. O que vier depois disso continua
      // contando pelas reservas.
      medido_ate: +horaAnterior,
      completo: !!turn.grupos,
      turn_bytes: soma(turnMes.filter(g => !deSfu(g)), 'egressBytes'),
      turn_bytes_sfu: soma(turnMes.filter(deSfu), 'egressBytes'),
      sfu_bytes: sfu.grupos ? soma(sfu.grupos.filter(doMes), 'egressBytes') : null,
      sfu_fonte: sfu.grupos ? 'graphql' : 'estimativa',
    },
  }
}

// ---------- conta ----------

function validade(snapshot, agora) {
  if (!snapshot) return 'snapshot_ausente'
  if (!snapshot.completo) return 'snapshot_incompleto'
  // Virada do mês: o retrato do mês passado não diz nada sobre este.
  if (snapshot.mes !== mesDe(agora)) return 'snapshot_vencido'
  if (agora - snapshot.coletado_em > VALIDADE_MS) return 'snapshot_vencido'
  return null
}

// Bytes de uma reserva dentro de [de, ate). Reserva aberta (fim null) é uma
// assinatura que ainda corre: conta até o horizonte da próxima medição válida.
const trecho = (r, de, ate) => Math.max(0, Math.min(r.fim ?? Infinity, ate) - Math.max(r.inicio, de)) / 1000 * r.bps

export function avaliar({ snapshot, reservas = [], agora, recurso, novas = [] }) {
  const motivoSnapshot = validade(snapshot, agora)
  const inicioMes = inicioDoMes(agora)
  const horizonte = agora + VALIDADE_MS
  const lista = [...reservas, ...novas]
  const turn = lista.filter(r => r.tipo === 'turn'), sfu = lista.filter(r => r.tipo === 'sfu')
  const medidoAte = motivoSnapshot ? inicioMes : Math.max(snapshot.medido_ate, inicioMes)
  const soma = (rs, de, ate) => rs.reduce((t, r) => t + trecho(r, de, ate), 0)

  const turnBytes = (motivoSnapshot ? 0 : snapshot.turn_bytes) + soma(turn, medidoAte, Infinity)
  // SFU: o passado pelo maior entre medição e teto autorizado; o futuro pelas reservas.
  const sfuPassado = Math.max(motivoSnapshot ? 0 : snapshot.sfu_bytes ?? 0, soma(sfu, inicioMes, agora))
  const sfuBytes = sfuPassado + soma(sfu, agora, horizonte)
  const reservaBytes = soma(novas, inicioMes, horizonte)
  const uso = turnBytes + sfuBytes + MARGEM_BYTES
  const limiar = LIMIARES[recurso] ?? 0
  return {
    ok: !motivoSnapshot && uso / COTA_BYTES < limiar,
    motivo: motivoSnapshot ?? (uso / COTA_BYTES < limiar ? null : 'limite'),
    uso_protegido_pct: pct(uso),
    cota_pct: motivoSnapshot ? null : pct(snapshot.turn_bytes + (snapshot.sfu_bytes ?? 0)),
    limiar_pct: limiar * 100,
    medicao_idade_s: snapshot ? Math.round((agora - snapshot.coletado_em) / 1000) : null,
    medicao_completa: !!snapshot?.completo,
    sfu_fonte: snapshot?.sfu_fonte ?? null,
    reserva_bytes: Math.round(reservaBytes),
  }
}

// TURN coberto pela medição sai; SFU fica até o mês acabar, porque é ele que
// sustenta a estimativa enquanto o dataset do SFU não for documentado.
function podar(reservas, snapshot, agora) {
  const inicioMes = inicioDoMes(agora)
  const medidoAte = validade(snapshot, agora) ? -Infinity : snapshot.medido_ate
  for (const [ref, r] of Object.entries(reservas)) {
    if (r.fim !== null && r.fim < inicioMes) delete reservas[ref]
    else if (r.tipo === 'turn' && r.fim <= medidoAte) delete reservas[ref]
  }
  return reservas
}

export class Orcamento extends DurableObject {
  #registrar(evento, campos) {
    const envio = enviarLogs(this.env, [linhaWorker(evento, campos)])
    if (this.ctx.waitUntil) this.ctx.waitUntil(envio)
  }

  async #ler() {
    const [snapshot, reservas] = await Promise.all([this.ctx.storage.get('snapshot'), this.ctx.storage.get('reservas')])
    return { snapshot: snapshot ?? null, reservas: reservas ?? {} }
  }

  // Pedido = { recurso: 'sfu'|'turn', op, sala, reservas: [{ ref?, tipo, bps, duracao_ms? }] }.
  // Reserva sem duração fica aberta até liberar().
  async autorizar(pedido = {}) {
    const agora = Date.now()
    const novas = (pedido.reservas ?? []).map((r, i) => ({
      // A ref de quem pede vira prefixo: a mesma fonte assinada de novo não
      // apaga a reserva da vez anterior, que ainda conta no mês.
      ref: `${String(r.ref ?? pedido.recurso).slice(0, 100)}#${agora.toString(36)}.${i}.${Math.random().toString(36).slice(2, 8)}`,
      tipo: r.tipo === 'turn' ? 'turn' : 'sfu', bps: Math.max(0, Number(r.bps) || 0), inicio: agora,
      fim: Number.isFinite(r.duracao_ms) ? agora + r.duracao_ms : null, sala: pedido.sala ?? null,
    }))
    if (!comMedicao(this.env)) return this.#autorizarSemMedicao(pedido, novas, agora)
    await this.#registrarModo('medido', agora)
    let est = await this.#ler()
    let r = avaliar({ ...est, reservas: Object.values(est.reservas), agora, recurso: pedido.recurso, novas })
    if (!r.ok && r.motivo !== 'limite' && await this.#coletarSobDemanda(agora, r)) {
      est = await this.#ler()
      r = avaliar({ ...est, reservas: Object.values(est.reservas), agora, recurso: pedido.recurso, novas })
    }
    if (!r.ok) {
      await this.#bloqueio(pedido, r, agora)
      return r
    }
    // Sem chamada externa entre a leitura acima e esta gravação: duas
    // autorizações não reservam em cima da mesma folga.
    est = await this.#ler()
    for (const n of novas) est.reservas[n.ref] = n
    await this.ctx.storage.put('reservas', podar(est.reservas, est.snapshot, agora))
    return { ...r, refs: novas.map(n => n.ref) }
  }

  async #autorizarSemMedicao(pedido, novas, agora) {
    const est = await this.#ler()
    const reservas = podar(est.reservas, null, agora)
    const snapshot = retratoSemMedicao(agora)
    const sfu = novas.filter(n => n.tipo === 'sfu')
    await this.#registrarModo('sem_medicao', agora, reservas)
    // TURN sem bloqueio e sem reserva: sem medição não há com o que comparar.
    if (pedido.recurso === 'turn') return { ok: true, motivo: null, modo: 'sem_medicao', refs: [] }
    const r = { ...avaliar({ snapshot, reservas: Object.values(reservas), agora, recurso: pedido.recurso, novas: sfu }),
      cota_pct: null, medicao_idade_s: null, medicao_completa: false, modo: 'sem_medicao' }
    if (!r.ok) {
      await this.#bloqueio(pedido, r, agora)
      return r
    }
    for (const n of sfu) reservas[n.ref] = n
    await this.ctx.storage.put('reservas', reservas)
    return { ...r, refs: sfu.map(n => n.ref) }
  }

  // Um evento por dia (UTC) no modo sem medição, e um na troca de modo.
  async #registrarModo(modo, agora, reservas) {
    const dia = new Date(agora).toISOString().slice(0, 10)
    const anterior = await this.ctx.storage.get('modo')
    if (anterior?.modo === modo && (modo === 'medido' || anterior.dia === dia)) return
    await this.ctx.storage.put('modo', { modo, dia })
    const campos = { modo, modo_anterior: anterior?.modo ?? null }
    if (modo === 'sem_medicao') {
      const r = avaliar({ snapshot: retratoSemMedicao(agora), reservas: Object.values(reservas ?? {}), agora, recurso: 'sfu' })
      const inicioMes = inicioDoMes(agora)
      const sfuMes = Object.values(reservas ?? {}).filter(x => x.tipo === 'sfu')
        .reduce((t, x) => t + trecho(x, inicioMes, agora), 0)
      Object.assign(campos, { mes: mesDe(agora), sfu_estimado_gb_mes: gb(sfuMes), uso_protegido_pct: r.uso_protegido_pct,
        assinaturas_abertas: sfuMes ? Object.values(reservas).filter(x => x.tipo === 'sfu' && x.fim === null).length : 0 })
    }
    this.#registrar('orcamento_modo', campos)
  }

  // Fecha reservas abertas (assinatura encerrada): pela ref dada em autorizar,
  // pela devolvida, ou por prefixo.
  async liberar({ refs = [], prefixo = null } = {}) {
    const agora = Date.now()
    const est = await this.#ler()
    let n = 0
    for (const [ref, r] of Object.entries(est.reservas))
      if (r.fim === null && (refs.some(x => ref === x || ref.startsWith(`${x}#`)) || (prefixo && ref.startsWith(prefixo)))) {
        r.fim = agora
        n++
      }
    if (n) await this.ctx.storage.put('reservas', podar(est.reservas, est.snapshot, agora))
    return n
  }

  async gravarSnapshot(s) {
    const campos = ['coletado_em', 'medido_ate', 'turn_bytes']
    if (!s || typeof s.mes !== 'string' || campos.some(c => !Number.isFinite(s[c]))) return false
    const est = await this.#ler()
    if (est.snapshot && est.snapshot.coletado_em > s.coletado_em) return false
    const snapshot = { mes: s.mes, coletado_em: s.coletado_em, medido_ate: s.medido_ate, completo: !!s.completo,
      turn_bytes: s.turn_bytes, turn_bytes_sfu: Number(s.turn_bytes_sfu) || 0,
      sfu_bytes: Number.isFinite(s.sfu_bytes) ? s.sfu_bytes : null, sfu_fonte: s.sfu_fonte === 'graphql' ? 'graphql' : 'estimativa' }
    await this.ctx.storage.put('snapshot', snapshot)
    await this.ctx.storage.put('reservas', podar(est.reservas, snapshot, Date.now()))
    const r = avaliar({ snapshot, reservas: Object.values(est.reservas), agora: Date.now(), recurso: 'sfu' })
    this.#registrar('orcamento_snapshot', { mes: snapshot.mes, completo: snapshot.completo, sfu_fonte: snapshot.sfu_fonte,
      turn_gb: gb(snapshot.turn_bytes), turn_sfu_gb: gb(snapshot.turn_bytes_sfu),
      sfu_gb: snapshot.sfu_bytes === null ? null : gb(snapshot.sfu_bytes),
      uso_protegido_pct: r.uso_protegido_pct, reservas: Object.keys(est.reservas).length })
    return true
  }

  async estado() {
    const est = await this.#ler(), agora = Date.now()
    const medido = comMedicao(this.env)
    const snapshot = medido ? est.snapshot : retratoSemMedicao(agora)
    return { ...avaliar({ snapshot, reservas: Object.values(est.reservas), agora, recurso: 'sfu' }),
      modo: medido ? 'medido' : 'sem_medicao', snapshot: est.snapshot, reservas: Object.keys(est.reservas).length }
  }

  // Coleta fora do cron: primeiro deploy, cron que falhou, virada do mês.
  async #coletarSobDemanda(agora, r) {
    const ultima = await this.ctx.storage.get('coleta_tentativa')
    if (ultima && agora - ultima < COLETA_MIN_MS) return false
    await this.ctx.storage.put('coleta_tentativa', agora)
    this.#registrar('orcamento_snapshot_vencido', { motivo: r.motivo, medicao_idade_s: r.medicao_idade_s })
    const res = await coletarUso(this.env, new Date(agora))
    if (!res) return false
    const envio = enviarLogs(this.env, res.linhas)
    if (this.ctx.waitUntil) this.ctx.waitUntil(envio)
    return res.snapshot.completo && await this.gravarSnapshot(res.snapshot)
  }

  // Negações iguais em sequência viram uma linha com o número de repetições.
  async #bloqueio(pedido, r, agora) {
    const chave = `${pedido.recurso}|${pedido.op ?? ''}|${r.motivo}`
    const anterior = await this.ctx.storage.get('bloqueio')
    if (anterior?.chave === chave && agora - anterior.desde < COALESCER_MS) {
      await this.ctx.storage.put('bloqueio', { ...anterior, repeticoes: anterior.repeticoes + 1 })
      return
    }
    await this.ctx.storage.put('bloqueio', { chave, desde: agora, repeticoes: 0 })
    this.#registrar('rota_cota_bloqueio', { operacao: pedido.op ?? pedido.recurso, recurso: pedido.recurso,
      sala: pedido.sala ?? null, motivo: r.motivo, cota_pct: r.cota_pct, uso_protegido_pct: r.uso_protegido_pct,
      limiar_pct: r.limiar_pct, medicao_idade_s: r.medicao_idade_s, medicao_completa: r.medicao_completa,
      sfu_fonte: r.sfu_fonte, reserva_bytes: r.reserva_bytes, acao: 'negado',
      repeticoes_anteriores: anterior?.chave === chave ? anterior.repeticoes : 0 })
  }
}

// O objeto da conta, ou null sem o binding (aí tudo o que é cobrado é negado).
export const orcamentoDa = env => env?.ORCAMENTO ? env.ORCAMENTO.get(env.ORCAMENTO.idFromName('conta')) : null

// Consulta segura: binding ausente ou erro na chamada negam, nunca liberam.
export async function autorizarCom(env, pedido) {
  const o = orcamentoDa(env)
  if (!o) return { ok: false, motivo: 'sem_orcamento' }
  try { return await o.autorizar(pedido) } catch (e) { return { ok: false, motivo: 'erro', erro: String(e.message).slice(0, 200) } }
}
export async function liberarCom(env, pedido) {
  try { return await orcamentoDa(env)?.liberar(pedido) } catch { return 0 }
}
