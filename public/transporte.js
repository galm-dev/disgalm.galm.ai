// Contrato entre a sala e o transporte de mídia. A sala (index.html) cuida das
// pessoas, da captura e do controle pelo WebSocket; o transporte só leva as
// fontes (fontes.js) de um lado ao outro. A malha (transporte-mesh.js) tem uma
// RTCPeerConnection por pessoa; o SFU (transporte-cloudflare.js) tem uma
// conexão só, com o Cloudflare Realtime SFU. O welcome diz qual vale na sala.
//
// Métodos do transporte:
//   entrar(presentes, { retomada })   welcome do servidor; presentes = [{ id, nome }].
//                                     Sem retomada, o que havia é descartado.
//   pessoaEntrou(id, nome)            alguém entrou com id novo.
//   pessoaVoltou(id, nome) → bool     voltou com o mesmo id; true se a mídia recomeçou do zero.
//   pessoaSaiu(id, { volta }) → bool  saiu da sinalização; false se a mídia segue (queda curta).
//   limparAusentes(presentes)         descarta mídia morta de quem o servidor não lista.
//   sair()                            encerra tudo.
//   receberSinal(de, data)            mensagem do transporte que veio pelo controle da sala.
//   atualizarCatalogo({ versao, fontes })  catálogo de fontes da sala (só SFU; a malha ignora).
//   publicar(fonte)                   passa a enviar a fonte a todos.
//   substituir(fonte, track)          troca a track sem renegociar; a sala atualiza o registro depois.
//   parar(fonte)                      deixa de enviar.
//   assinar(dono, fonteId) → bool     pede para receber; false se não há caminho até o dono.
//   planejarEnvio(pedido) → plano     pedido = { kbpsTela, orcamentoKbps, telas };
//                                     plano = { copias, kbpsPorCopia, kbpsPorTela }.
//   aplicarEnvio(limites) → Promise   limites(fonte) → { maxBitrate, maxFramerate, degradacao } ou null.
//   stats() → Promise<[{ pessoa, relatorio }]>   um RTCStatsReport por conexão.
//   relatarUso()                      manda à telemetria o tráfego por relay desde o último relato.
//   atualizarIce(servidores) → Promise<n>  credencial TURN nova (a anterior vence em minutos):
//                                     troca a configuração e refaz o ICE de quem está no relay.
//
// Ganchos que a sala passa ao criar o transporte:
//   meuId(), nome(id), ice(), soRelay(), sinalizar(para, data), sinalizacaoAberta(),
//   fontes (o registro), log(...), telemetria(evento, campos),
//   pessoaConectando(id, nome)      a mídia com a pessoa começa do zero: o que veio antes não vale.
//   pessoaDesconectando(id, conexao) antes de fechar, com as amostras ainda lá.
//   pessoaDesconectada(id)          depois de fechar.
//   pessoaReconectada(id)           a conexão foi refeita a pedido do outro lado.
//   trackRecebida(id, track, stream)
//   conexaoMudou(id)
//   amostrar(id, conexao, anteriores)   a cada 2 s com a mídia conectada.
//   relayUsado(id, conexao)          a conexão vai sair ou a página fechar: hora de relatar o relay.
(() => {
  const METODOS = [
    'entrar', 'pessoaEntrou', 'pessoaVoltou', 'pessoaSaiu', 'limparAusentes', 'sair', 'receberSinal', 'atualizarCatalogo',
    'publicar', 'substituir', 'parar', 'assinar', 'planejarEnvio', 'aplicarEnvio', 'stats', 'relatarUso',
    'atualizarIce',
  ]
  const GANCHOS = [
    'meuId', 'nome', 'ice', 'soRelay', 'sinalizar', 'sinalizacaoAberta', 'log', 'telemetria',
    'pessoaConectando', 'pessoaDesconectando', 'pessoaDesconectada', 'pessoaReconectada',
    'trackRecebida', 'conexaoMudou', 'amostrar', 'relayUsado',
  ]

  const faltando = (obj, nomes) => nomes.filter(n => typeof obj?.[n] !== 'function')

  // Um transporte incompleto falha na criação, não no meio da chamada.
  function validar(t) {
    const f = faltando(t, METODOS)
    if (f.length) throw new TypeError(`transporte ${t?.nome ?? '?'} sem ${f.join(', ')}`)
    return t
  }

  function conferirGanchos(app) {
    const f = faltando(app, GANCHOS)
    if (typeof app?.fontes?.lista !== 'function') f.push('fontes')
    if (f.length) throw new TypeError(`sala sem os ganchos ${f.join(', ')}`)
    return app
  }

  // A credencial TURN vale poucos minutos. Quando ela vence, a Cloudflare para
  // de cobrar e derruba a alocação logo depois; setConfiguration só vale para
  // a próxima coleta de candidatos, então quem está no relay precisa refazer o
  // ICE com a credencial nova antes disso.
  // https://developers.cloudflare.com/realtime/turn/faq/
  const temTurn = servidores => (servidores || []).some(s => [s.urls].flat().some(u => /^turns?:/.test(u)))
  async function usaRelay(pc) {
    let st
    try { st = await pc.getStats() } catch { return false }
    let par
    st.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) par = st.get(r.selectedCandidatePairId) })
    if (!par) st.forEach(r => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) par = r })
    return st.get(par?.localCandidateId)?.candidateType === 'relay'
  }
  function trocarIce(pc, servidores) {
    pc.setConfiguration({ ...pc.getConfiguration(), iceServers: servidores })
  }

  globalThis.disgalmTransporte = { METODOS, GANCHOS, validar, conferirGanchos, temTurn, usaRelay, trocarIce }
})()
