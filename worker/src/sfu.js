// Gateway do Cloudflare Realtime SFU. O navegador nunca fala com a API do SFU:
// pede uma operação da lista abaixo, o Worker autentica (membro ou convidado) e
// repassa à Sala, e a Sala confere quem pede, se a pessoa ainda está nela, se a
// sessão é dela e se o alvo da assinatura está publicado, e só então chama a API
// com o App Secret. O cliente nunca vê sessionId de outra pessoa nem trackName:
// pede "a fonte X da pessoa Y", e a Sala resolve no catálogo.
//
// API: https://developers.cloudflare.com/realtime/sfu/api/
// Negociação: https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/
// Receitas: https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/
// Erros: https://developers.cloudflare.com/realtime/sfu/observability/error-codes/
// Limites: https://developers.cloudflare.com/realtime/sfu/platform/limits/
//
// Fase 1 é ensaio: o SFU só liga nas salas de SFU_SALAS, com SFU_APP_ID e
// SFU_APP_SECRET configurados. O orçamento (DO por conta, reserva, bloqueio em
// 90%/98%) ainda não existe; ver tests/sfu.md antes de liberar fora da lista.

const API = 'https://rtc.live.cloudflare.com/v1'

export const CAPACIDADE = 'sfu1'
export const OPS = ['sessao', 'publicar', 'assinar', 'renegociar', 'fechar', 'encerrar']
export const MAX_PEDIDO = 128 * 1024

const LIMITES = { sessoesPorPessoa: 2, fontesPorPessoa: 8, assinaturasPorSessao: 32, lote: 16, sdp: 96 * 1024 }
// Uma operação em andamento, ou uma oferta do SFU esperando resposta, segura a
// sessão. O prazo é conferido na próxima operação, sem timer: um cliente que
// sumiu no meio não trava a sessão para sempre.
const PRAZO_MS = 15_000

export const salasSfu = env => new Set(String(env?.SFU_SALAS || '')
  .split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean))
export const sfuConfigurado = env => !!(env?.SFU_APP_ID && env?.SFU_APP_SECRET)
export const salaEmEnsaio = (env, sala) => sfuConfigurado(env) && salasSfu(env).has(sala)

// ---------- validação do que vem do navegador ----------

const RE_FONTE = /^(?:(mic|camera)-\d{1,6}|(tela-\d{1,6})\/(video|audio))$/
const RE_ID = /^[0-9a-f]{8}$/
const RE_MID = /^\d{1,4}$/
const RE_STREAM = /^[\w{}.-]{1,80}$/
const RE_SESSAO = /^[\w-]{8,64}$/

// O tipo sai do id, não do que o cliente diz: fontes.js monta os dois juntos.
function lerFonte(id) {
  const m = RE_FONTE.exec(id || '')
  if (!m) return null
  return m[1] ? { tipo: m[1] } : { tipo: `tela-${m[3]}`, tela: m[2] }
}

const sdpValido = (sdp, tipo) => sdp && typeof sdp === 'object' && sdp.type === tipo &&
  typeof sdp.sdp === 'string' && sdp.sdp.length > 0 && sdp.sdp.length <= LIMITES.sdp

const resposta = (status, corpo) => ({ status, corpo })
const erro = (status, motivo, extra) => resposta(status, { erro: motivo, ...extra })

// ---------- estado da sala ----------
//
// Um documento só, numa chave do storage do DO: sobrevive à hibernação e é
// lido e gravado sem chamada externa no meio, então duas operações não se
// cruzam entre o get e o put.
//   modo     'sfu' ou 'mesh', decidido por quem abre a chamada.
//   chamada  id opaco da ocupação contínua da sala.
//   versao   sobe a cada mudança do catálogo; o cliente descarta versão velha.
//   sessoes  sessionId → { dono, exp, ocupada, pend, mids: { mid → { tipo, fonte, dono } } }
//   pubs     'dono/fonte' → { dono, fonte, tipo, tela, stream, geracao, sessao, trackName, mid }

export const novoEstado = (modo, chamada) => ({ modo, chamada, versao: 1, sessoes: {}, pubs: {} })

// O que os clientes veem: sem sessionId, trackName nem mid.
export const catalogo = est => Object.values(est?.pubs || {}).map(p => ({
  dono: p.dono, fonte: p.fonte, tipo: p.tipo, stream: p.stream, geracao: p.geracao, ...(p.tela && { tela: p.tela }),
}))

// ---------- chamada à API ----------

export async function chamarApi(env, metodo, caminho, corpo) {
  try {
    const r = await fetch(`${API}/apps/${encodeURIComponent(env.SFU_APP_ID)}${caminho}`, {
      method: metodo,
      headers: { authorization: `Bearer ${env.SFU_APP_SECRET}`, 'content-type': 'application/json' },
      ...(corpo !== undefined && { body: JSON.stringify(corpo) }),
    })
    let json = {}
    try { json = (await r.json()) || {} } catch {}
    return { status: r.status, ok: r.ok && !json.errorCode, json }
  } catch (e) {
    return { status: 0, ok: false, json: { errorCode: 'rede', errorDescription: String(e?.message || e).slice(0, 200) } }
  }
}

// Fecha à força as tracks conhecidas de uma sessão: quem saiu não responde mais.
async function fecharAForca(c, sid, mids, motivo) {
  if (!mids.length) return
  const r = await c.api('PUT', `/sessions/${sid}/tracks/close`, { tracks: mids.map(mid => ({ mid })), force: true })
  if (!r.ok) c.registrar('sfu_api_erro', { op: 'fechar_forcado', motivo, status: r.status, codigo: r.json.errorCode ?? null })
}

// ---------- operações ----------
//
// c = { autor: { id, exp }, presentes: Set de ids na sala em modo SFU,
//       carregar(), salvar(est), api(metodo, caminho, corpo), registrar(evento, campos),
//       difundir(est), agora() }

export async function operar(c, op, corpo) {
  if (!OPS.includes(op)) return erro(400, 'operação desconhecida')
  const est = await c.carregar()
  if (est?.modo !== 'sfu') return erro(409, 'sala sem SFU')
  if (op === 'sessao') return criarSessao(c, est)

  const sid = corpo?.sessao
  if (typeof sid !== 'string' || !RE_SESSAO.test(sid)) return erro(400, 'sessão inválida')
  // Sessão que não existe e sessão de outra pessoa dão a mesma resposta: quem
  // pergunta não descobre ids alheios.
  const s = est.sessoes[sid]
  if (!s || s.dono !== c.autor.id) return erro(403, 'sessão alheia')
  if (op === 'encerrar') return encerrar(c, est, sid)

  const agora = c.agora()
  const pendente = s.pend && s.pend.ate > agora
  if (op === 'renegociar') {
    if (!pendente) return erro(409, 'nada a renegociar')
  } else if (pendente || (s.ocupada && s.ocupada.ate > agora)) return erro(409, 'sessão ocupada')

  const fn = { publicar, assinar, renegociar, fechar }[op]
  return fn(c, est, sid, corpo)
}

// Marca a sessão como ocupada antes da chamada externa e devolve o estado
// recarregado depois dela. null: a sessão sumiu no meio (a pessoa saiu).
async function segurar(c, est, sid, op) {
  est.sessoes[sid].ocupada = { op, ate: c.agora() + PRAZO_MS }
  await c.salvar(est)
}
async function soltar(c, sid) {
  const est = await c.carregar()
  const s = est?.sessoes?.[sid]
  if (s) s.ocupada = null
  return { est, s }
}

function erroApi(c, op, r) {
  c.registrar('sfu_api_erro', { id: c.autor.id, op, status: r.status, codigo: r.json.errorCode ?? null })
  return erro(502, 'SFU recusou', { codigo: r.json.errorCode ?? null })
}

async function criarSessao(c, est) {
  const minhas = Object.values(est.sessoes).filter(s => s.dono === c.autor.id).length
  if (minhas >= LIMITES.sessoesPorPessoa) return erro(429, 'sessões demais')
  const r = await c.api('POST', '/sessions/new')
  const sid = r.json.sessionId
  if (!r.ok || typeof sid !== 'string' || !RE_SESSAO.test(sid)) return erroApi(c, 'sessao', r)
  const depois = await c.carregar()
  // A chamada acabou ou a pessoa saiu enquanto a API respondia: a sessão nasce
  // órfã e sem tracks, e o SFU a descarta sozinho.
  if (depois?.modo !== 'sfu' || depois.chamada !== est.chamada || !c.presentes.has(c.autor.id))
    return erro(410, 'saiu da sala')
  depois.sessoes[sid] = { dono: c.autor.id, exp: c.autor.exp, criada: c.agora(), ocupada: null, pend: null, mids: {} }
  await c.salvar(depois)
  c.registrar('sfu_sessao_criada', { id: c.autor.id, sessao: sid.slice(0, 8) })
  return resposta(200, { sessao: sid })
}

async function publicar(c, est, sid, corpo) {
  if (!sdpValido(corpo.sdp, 'offer')) return erro(400, 'oferta inválida')
  const pedidas = corpo.fontes
  if (!Array.isArray(pedidas) || !pedidas.length || pedidas.length > LIMITES.lote) return erro(400, 'fontes inválidas')
  const s = est.sessoes[sid]
  const minhas = Object.values(est.pubs).filter(p => p.dono === c.autor.id).length
  if (minhas + pedidas.length > LIMITES.fontesPorPessoa) return erro(429, 'fontes demais')
  const novas = [], mids = new Set()
  for (const f of pedidas) {
    const lida = lerFonte(f?.fonte)
    if (!lida || !RE_MID.test(f.mid || '') || !RE_STREAM.test(f.stream || '') ||
        !Number.isInteger(f.geracao) || f.geracao < 1 || f.geracao > 1e6) return erro(400, 'fonte inválida')
    if (mids.has(f.mid) || s.mids[f.mid]) return erro(409, 'mid em uso')
    if (est.pubs[`${c.autor.id}/${f.fonte}`] || novas.some(n => n.fonte === f.fonte)) return erro(409, 'fonte já publicada')
    mids.add(f.mid)
    // O trackName é nosso, não do cliente: dono e fonte, sem nada pessoal.
    novas.push({ dono: c.autor.id, fonte: f.fonte, ...lida, stream: f.stream, geracao: f.geracao,
      sessao: sid, mid: f.mid, trackName: `${c.autor.id}_${f.fonte.replace('/', '_')}` })
  }

  await segurar(c, est, sid, 'publicar')
  const r = await c.api('POST', `/sessions/${sid}/tracks/new`, {
    sessionDescription: corpo.sdp,
    tracks: novas.map(n => ({ location: 'local', mid: n.mid, trackName: n.trackName })),
  })
  const { est: depois, s: s2 } = await soltar(c, sid)
  if (!s2) return erro(410, 'sessão encerrada')
  const itens = Array.isArray(r.json.tracks) ? r.json.tracks : []
  const resultado = []
  let mudou = false
  for (const n of novas) {
    const item = itens.find(t => t.trackName === n.trackName)
    const falha = !item ? (r.json.errorCode || 'sem resultado') : item.errorCode
    if (!falha && c.presentes.has(c.autor.id)) {
      s2.mids[n.mid] = { tipo: 'pub', fonte: n.fonte }
      depois.pubs[`${n.dono}/${n.fonte}`] = n
      mudou = true
    }
    resultado.push({ fonte: n.fonte, mid: n.mid, ...(falha && { erro: String(falha) }) })
    c.registrar('sfu_publicou', { id: c.autor.id, fonte: n.fonte, tipo: n.tipo, ok: !falha, codigo: falha || null })
  }
  if (mudou) depois.versao++
  await c.salvar(depois)
  if (mudou) c.difundir(depois)
  if (!r.ok && !itens.length) return erroApi(c, 'publicar', r)
  return resposta(200, { sdp: r.json.sessionDescription ?? null, fontes: resultado })
}

async function assinar(c, est, sid, corpo) {
  const alvos = corpo.alvos
  if (!Array.isArray(alvos) || !alvos.length || alvos.length > LIMITES.lote) return erro(400, 'alvos inválidos')
  const s = est.sessoes[sid]
  const assinadas = Object.values(s.mids).filter(m => m.tipo === 'sub')
  if (assinadas.length + alvos.length > LIMITES.assinaturasPorSessao) return erro(429, 'assinaturas demais')
  const pedidos = []
  for (const a of alvos) {
    if (!RE_ID.test(a?.dono || '') || !lerFonte(a.fonte)) return erro(400, 'alvo inválido')
    if (a.dono === c.autor.id) return erro(400, 'alvo é a própria pessoa')
    const pub = est.pubs[`${a.dono}/${a.fonte}`]
    // Só o que está no catálogo, de quem está na sala agora. Fonte que não
    // existe e fonte de quem saiu dão o mesmo 404.
    if (!pub || !c.presentes.has(a.dono)) return erro(404, 'fonte não publicada')
    if (assinadas.some(m => m.dono === a.dono && m.fonte === a.fonte) ||
        pedidos.some(p => p.pub === pub)) return erro(409, 'fonte já assinada')
    pedidos.push({ pub })
  }

  await segurar(c, est, sid, 'assinar')
  const r = await c.api('POST', `/sessions/${sid}/tracks/new`, {
    tracks: pedidos.map(({ pub }) => ({ location: 'remote', sessionId: pub.sessao, trackName: pub.trackName })),
  })
  const { est: depois, s: s2 } = await soltar(c, sid)
  if (!s2) return erro(410, 'sessão encerrada')
  const itens = Array.isArray(r.json.tracks) ? r.json.tracks : []
  const resultado = []
  for (const { pub } of pedidos) {
    const item = itens.find(t => t.sessionId === pub.sessao && t.trackName === pub.trackName)
    const falha = !item ? (r.json.errorCode || 'sem resultado') : item.errorCode || (!RE_MID.test(item.mid || '') && 'sem mid')
    if (!falha) s2.mids[item.mid] = { tipo: 'sub', fonte: pub.fonte, dono: pub.dono }
    resultado.push({ dono: pub.dono, fonte: pub.fonte, ...(falha ? { erro: String(falha) } : { mid: item.mid }) })
    c.registrar('sfu_assinou', { id: c.autor.id, dono: pub.dono, fonte: pub.fonte, ok: !falha, codigo: falha || null })
  }
  const renegociar = !!r.json.requiresImmediateRenegotiation && sdpValido(r.json.sessionDescription, 'offer')
  if (renegociar) s2.pend = { ate: c.agora() + PRAZO_MS }
  await c.salvar(depois)
  if (!r.ok && !itens.length) return erroApi(c, 'assinar', r)
  return resposta(200, { sdp: renegociar ? r.json.sessionDescription : null, renegociar, alvos: resultado })
}

async function renegociar(c, est, sid, corpo) {
  if (!sdpValido(corpo.sdp, 'answer')) return erro(400, 'resposta inválida')
  await segurar(c, est, sid, 'renegociar')
  const r = await c.api('PUT', `/sessions/${sid}/renegotiate`, { sessionDescription: corpo.sdp })
  const { est: depois, s: s2 } = await soltar(c, sid)
  if (!s2) return erro(410, 'sessão encerrada')
  // Aceita ou não, a oferta não espera mais: uma resposta repetida falha
  // depois que a primeira passou, e o cliente refaz a conexão.
  s2.pend = null
  await c.salvar(depois)
  if (!r.ok) return erroApi(c, 'renegociar', r)
  return resposta(200, {})
}

async function fechar(c, est, sid, corpo) {
  const mids = corpo.mids
  if (!Array.isArray(mids) || !mids.length || mids.length > LIMITES.assinaturasPorSessao) return erro(400, 'mids inválidos')
  const s = est.sessoes[sid]
  if (mids.some(m => typeof m !== 'string' || !s.mids[m]) || new Set(mids).size !== mids.length)
    return erro(403, 'mid alheio')
  if (corpo.sdp !== undefined && !sdpValido(corpo.sdp, 'offer')) return erro(400, 'oferta inválida')

  // Primeiro sai do catálogo, depois fecha: quem assina para de pedir a fonte
  // mesmo que o fechamento falhe.
  let mudou = false
  for (const m of mids) {
    const ref = s.mids[m]
    if (ref.tipo === 'pub' && est.pubs[`${s.dono}/${ref.fonte}`]?.mid === m) {
      delete est.pubs[`${s.dono}/${ref.fonte}`]
      mudou = true
    }
  }
  if (mudou) est.versao++
  await segurar(c, est, sid, 'fechar')
  if (mudou) c.difundir(est)

  const r = await c.api('PUT', `/sessions/${sid}/tracks/close`, {
    tracks: mids.map(mid => ({ mid })), force: !corpo.sdp, ...(corpo.sdp && { sessionDescription: corpo.sdp }),
  })
  const { est: depois, s: s2 } = await soltar(c, sid)
  if (!s2) return erro(410, 'sessão encerrada')
  const itens = Array.isArray(r.json.tracks) ? r.json.tracks : []
  const resultado = mids.map(mid => {
    const item = itens.find(t => t.mid === mid)
    // close_track_error: já não existe. Para limpeza, isso basta.
    const fechado = item && (!item.errorCode || item.errorCode === 'close_track_error')
    if (fechado) delete s2.mids[mid]
    return { mid, ...(!fechado && { erro: String(item?.errorCode || r.json.errorCode || 'sem resultado') }) }
  })
  await c.salvar(depois)
  if (!r.ok && !itens.length) return erroApi(c, 'fechar', r)
  return resposta(200, { sdp: r.json.sessionDescription ?? null, mids: resultado })
}

async function encerrar(c, est, sid) {
  const mids = Object.keys(est.sessoes[sid].mids)
  tirarSessao(est, sid)
  est.versao++
  await c.salvar(est)
  c.difundir(est)
  c.registrar('sfu_sessao_fechada', { id: c.autor.id, sessao: sid.slice(0, 8), motivo: 'encerrar', mids: mids.length })
  await fecharAForca(c, sid, mids, 'encerrar')
  return resposta(200, {})
}

function tirarSessao(est, sid) {
  const s = est.sessoes[sid]
  for (const [chave, p] of Object.entries(est.pubs)) if (p.sessao === sid) delete est.pubs[chave]
  delete est.sessoes[sid]
  return s
}

// Pessoa saiu de vez (botão Sair, F5, acesso expirado, fantasma): o catálogo
// perde as fontes dela e as sessões são fechadas à força, porque ela não vai
// mandar oferta de fechamento. Queda com volta prevista não passa por aqui.
export async function limparPessoa(c, id, motivo) {
  const est = await c.carregar()
  if (est?.modo !== 'sfu') return
  const fechar = []
  for (const [sid, s] of Object.entries(est.sessoes))
    if (s.dono === id) fechar.push([sid, Object.keys(tirarSessao(est, sid).mids)])
  if (!fechar.length) return
  est.versao++
  await c.salvar(est)
  c.difundir(est)
  for (const [sid, mids] of fechar) {
    c.registrar('sfu_sessao_fechada', { id, sessao: sid.slice(0, 8), motivo, mids: mids.length })
    await fecharAForca(c, sid, mids, motivo)
  }
}

// Chamada nova (sala vazia): o que sobrou da anterior é fechado à força.
export async function encerrarChamada(c, est) {
  for (const [sid, s] of Object.entries(est?.sessoes || {})) {
    const mids = Object.keys(s.mids)
    c.registrar('sfu_sessao_fechada', { id: s.dono, sessao: sid.slice(0, 8), motivo: 'chamada_nova', mids: mids.length })
    await fecharAForca(c, sid, mids, 'chamada_nova')
  }
}

// ---------- rota no Worker ----------
//
// O Worker só autentica e repassa; quem decide é a Sala, que sabe quem está
// nela. identificar() devolve { papel, sub, exp, convite } ou null.
export async function rotaSfu(req, env, { sala, mesmaOrigem, identificar, objeto, origem }) {
  if (req.method !== 'POST') return new Response('método inválido', { status: 405 })
  if (!mesmaOrigem) return new Response('origem inválida', { status: 403 })
  if (!salaEmEnsaio(env, sala)) return new Response('sala sem SFU', { status: 404 })
  if (req.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return new Response('conteúdo inválido', { status: 415 })
  const chave = req.headers.get('x-disgalm-sfu') || ''
  if (!/^[0-9a-f]{64}$/.test(chave)) return new Response('acesso negado', { status: 401 })
  const corpo = await req.text()
  if (corpo.length > MAX_PEDIDO) return new Response('pedido grande demais', { status: 413 })
  const autor = await identificar()
  if (!autor) return new Response('acesso negado', { status: 401 })
  const headers = new Headers({ 'content-type': 'application/json', 'x-disgalm-sfu': chave,
    'x-disgalm-role': autor.papel, 'x-disgalm-exp': String(autor.exp) })
  if (autor.papel === 'member') headers.set('x-disgalm-sub', autor.sub)
  else headers.set('x-disgalm-guest-token', autor.convite)
  return objeto.fetch(new Request(`${origem}/sfu?sala=${encodeURIComponent(sala)}`, { method: 'POST', headers, body: corpo }))
}
