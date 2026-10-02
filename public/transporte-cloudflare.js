// Transporte pelo Cloudflare Realtime SFU (fase 1, ensaio). Mesmo contrato de
// transporte.js: a sala não sabe se a mídia vai direto ou pelo SFU.
//
// Uma RTCPeerConnection só, com o SFU, e uma sessão do SFU para ela. Cada fonte
// é publicada uma vez, não uma vez por pessoa, e cada pessoa assina o que está
// no catálogo da sala, em camada única. O navegador não fala com a API do SFU:
// pede ao Worker (/sfu) por api(op, corpo), e o Worker confere tudo.
//
// Regras da API seguidas aqui:
// - toda mutação da sessão (publicar, assinar, fechar, renegociar) passa por uma
//   fila só e termina com a troca de SDP completa antes da próxima;
//   https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/
// - publicar: oferta nossa com transceivers sendonly, resposta do SFU;
//   assinar: o SFU oferece, nós respondemos por /renegotiate; fechar: stop()
//   no transceiver e oferta nova;
//   https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/
// - o mid identifica a track na nossa conexão; quem assina recebe em outro mid.
//   https://developers.cloudflare.com/realtime/sfu/concepts/sessions-tracks/
//
// O SFU não preserva o MediaStream.id de quem publica. A sala classifica tela,
// câmera e voz pelo id anunciado, então a track recebida chega à sala com o id
// do stream que o dono publicou, tirado do catálogo.
(() => {
  const ESPERA_CANDIDATOS_MS = 2000
  const TENTATIVAS_ASSINATURA = 3
  const AMOSTRA_MS = 10_000

  const opusEstereo = sdp => globalThis.criarTransporteMesh?.opusEstereo?.(sdp) ?? sdp
  const desc = d => ({ type: d.type, sdp: d.sdp })
  const chaveDe = f => `${f.dono}/${f.fonte}`

  function criarTransporteCloudflare(app, { api } = {}) {
    disgalmTransporte.conferirGanchos(app)
    if (typeof api !== 'function') throw new TypeError('transporte sfu sem api')
    const { log, telemetria } = app

    const pessoas = new Map()      // id → nome, quem está na sala
    const pubs = new Map()         // fonte.id → { fonte, tr, mid }
    const subs = new Map()         // 'dono/fonte' → { dono, fonte, tipo, stream, mid }
    const falhas = new Map()       // 'dono/fonte' → { n, esperando } das assinaturas que falharam
    const bytes = new Map()        // mid → { total, relatado, direcao, fonte, tipo, dono }
    let catalogo = [], versao = 0
    let pc = null, sessao = null, amostrador = null
    // Cada conexão nova é outra tentativa: trabalho enfileirado para a anterior
    // não roda na nova.
    let tentativa = 0
    let fila = Promise.resolve()

    function enfileirar(nome, fn) {
      const minha = tentativa
      fila = fila.then(() => minha === tentativa ? fn() : undefined).catch(e => {
        // Orçamento negou: a sala avisa uma vez; a fonte fica sem ir.
        if (e.status === 503) app.aviso?.('sfu_cota_fonte')
        log(`sfu ${nome}: ${e.message}`)
        telemetria('sfu_erro', { op: nome, erro: String(e.message).slice(0, 200), status: e.status ?? null })
      })
      return fila
    }

    // ---------- conexão ----------

    function garantirPc() {
      if (pc) return pc
      const meu = pc = new RTCPeerConnection({
        iceServers: app.ice(),
        iceTransportPolicy: app.soRelay() ? 'relay' : 'all',
        bundlePolicy: 'max-bundle',
      })
      meu.ontrack = e => trackChegou(e)
      meu.onconnectionstatechange = () => {
        if (meu !== pc) return
        log(`SFU: conexão ${meu.connectionState}`)
        telemetria('sfu_conexao', { estado: meu.connectionState })
        if (meu.connectionState === 'failed') reconstruir('falhou')
      }
      amostrador = setInterval(amostrar, AMOSTRA_MS)
      return meu
    }

    // A API pede a descrição local depois de juntar candidatos. Com prazo: sem
    // ele, uma rede que não termina a coleta trava a fila.
    function juntarCandidatos(p) {
      if (p.iceGatheringState === 'complete') return
      return new Promise(fim => {
        const prazo = setTimeout(pronto, ESPERA_CANDIDATOS_MS)
        function pronto() {
          clearTimeout(prazo)
          p.removeEventListener?.('icegatheringstatechange', mudou)
          fim()
        }
        function mudou() { if (p.iceGatheringState === 'complete') pronto() }
        p.addEventListener?.('icegatheringstatechange', mudou)
      })
    }

    // A sessão nasce quando a primeira troca de SDP vai começar: sessão criada
    // e nunca conectada expira.
    async function garantirSessao() {
      if (sessao) return sessao
      const r = await api('sessao', {})
      sessao = r.sessao
      telemetria('sfu_sessao', { criada: true })
      return sessao
    }

    function fecharConexao() {
      tentativa++
      clearInterval(amostrador)
      amostrador = null
      try { pc?.close() } catch {}
      pc = null
      sessao = null
      for (const s of subs.values()) encerrarRecebida(s)
      pubs.clear()
      subs.clear()
      falhas.clear()
      bytes.clear()
    }

    // A conexão com o SFU morreu: fecha a sessão (o que dá para fechar), abre
    // outra e publica e assina tudo de novo. Reconexão longa é da fase 3.
    function reconstruir(motivo) {
      const velha = sessao
      telemetria('sfu_reconstruir', { motivo })
      fecharConexao()
      if (velha) api('encerrar', { sessao: velha }).catch(() => {})
      enfileirar('publicar', () => publicarAgora(app.fontes.lista()))
      enfileirar('assinar', reconciliar)
    }

    // ---------- publicar ----------

    async function publicarAgora(lista) {
      lista = lista.filter(f => !pubs.has(f.id) && app.fontes.porId(f.id) === f)
      if (!lista.length) return
      const p = garantirPc()
      const novos = lista.map(fonte => ({ fonte, tr: p.addTransceiver(fonte.track,
        { direction: 'sendonly', streams: fonte.stream ? [fonte.stream] : [] }) }))
      const oferta = await p.createOffer()
      oferta.sdp = opusEstereo(oferta.sdp)
      await p.setLocalDescription(oferta)
      await juntarCandidatos(p)
      let r
      try {
        await garantirSessao()
        r = await api('publicar', { sessao, sdp: desc(p.localDescription), fontes: novos.map(({ fonte, tr }) => ({
          fonte: fonte.id, mid: tr.mid, stream: fonte.stream?.id || 'sem-stream', geracao: fonte.geracao })) })
        if (r?.sdp?.type !== 'answer') throw new Error('SFU sem resposta')
      } catch (e) {
        // Oferta sem resposta: volta ao estado estável e larga os transceivers.
        await p.setLocalDescription({ type: 'rollback' }).catch(() => {})
        for (const { tr } of novos) try { tr.stop() } catch {}
        throw e
      }
      // A resposta do SFU nem sempre traz stereo=1; sem ele o Chrome codifica mono.
      await p.setRemoteDescription({ type: 'answer', sdp: opusEstereo(r.sdp.sdp) })
      for (const { fonte, tr } of novos) {
        const res = r.fontes?.find(x => x.fonte === fonte.id)
        const ok = !!res && !res.erro
        if (ok) {
          pubs.set(fonte.id, { fonte, tr, mid: tr.mid })
          bytes.set(tr.mid, { total: 0, relatado: 0, direcao: 'envio', fonte: fonte.id, tipo: fonte.tipo })
        } else tr.sender.replaceTrack(null).catch(() => {})
        telemetria('sfu_publicou', { fonte: fonte.id, tipo: fonte.tipo, ok, erro: res?.erro ?? (res ? null : 'sem resultado') })
      }
    }

    async function pararAgora(id) {
      const p = pubs.get(id)
      if (!p || !pc) return
      pubs.delete(id)
      await amostrar()
      relatar(p.mid)
      try { p.tr.stop() } catch {}
      await fecharMids([p.mid])
    }

    // Fechamento negociado: o transceiver já parou, a oferta nova o leva.
    async function fecharMids(mids) {
      const oferta = await pc.createOffer()
      await pc.setLocalDescription(oferta)
      await juntarCandidatos(pc)
      const r = await api('fechar', { sessao, mids, sdp: desc(pc.localDescription) })
      if (r?.sdp?.type === 'answer') await pc.setRemoteDescription(r.sdp)
      else await pc.setLocalDescription({ type: 'rollback' }).catch(() => {})
      for (const m of r?.mids ?? []) if (m.erro) log(`SFU não fechou o mid ${m.mid}: ${m.erro}`)
    }

    // ---------- assinar ----------

    // O catálogo diz o que existe; aqui vira assinatura. Fonte nova é assinada,
    // fonte que sumiu é fechada, e quem não está na sala não conta.
    async function reconciliar() {
      const eu = app.meuId()
      const desejadas = new Map(catalogo.filter(f => f.dono !== eu && pessoas.has(f.dono)).map(f => [chaveDe(f), f]))
      const sobrando = [...subs.values()].filter(s => !desejadas.has(chaveDe(s)))
      if (sobrando.length && pc) {
        for (const s of sobrando) {
          subs.delete(chaveDe(s))
          relatar(s.mid)
          const tr = pc.getTransceivers().find(t => t.mid === s.mid)
          try { tr?.stop() } catch {}
          encerrarRecebida(s, tr)
        }
        await fecharMids(sobrando.map(s => s.mid))
      }
      for (const k of falhas.keys()) if (!desejadas.has(k)) falhas.delete(k)

      // Fonte que falhou espera a vez dela; outra reconciliação não a apressa.
      const faltando = [...desejadas.values()].filter(f => {
        const falha = falhas.get(chaveDe(f))
        return !subs.has(chaveDe(f)) && !falha?.esperando && (falha?.n ?? 0) < TENTATIVAS_ASSINATURA
      })
      if (!faltando.length) return
      const p = garantirPc()
      await garantirSessao()
      const r = await api('assinar', { sessao, alvos: faltando.map(f => ({ dono: f.dono, fonte: f.fonte })) })
      // O mid de cada assinatura antes de aplicar a oferta: ontrack dispara dentro dela.
      let refazer = 0
      for (const f of faltando) {
        const res = r?.alvos?.find(a => a.dono === f.dono && a.fonte === f.fonte)
        if (res?.mid && !res.erro) {
          subs.set(chaveDe(f), { dono: f.dono, fonte: f.fonte, tipo: f.tipo, stream: f.stream, mid: res.mid })
          bytes.set(res.mid, { total: 0, relatado: 0, direcao: 'recebe', fonte: f.fonte, tipo: f.tipo, dono: f.dono })
          falhas.delete(chaveDe(f))
        } else {
          // Publicação ainda sem pacotes (empty_track_error) ou fora de alcance:
          // tenta de novo, poucas vezes, com espera crescente.
          const n = (falhas.get(chaveDe(f))?.n ?? 0) + 1
          falhas.set(chaveDe(f), { n, esperando: n < TENTATIVAS_ASSINATURA })
          if (n < TENTATIVAS_ASSINATURA) refazer = Math.max(refazer, 1000 * 2 ** n)
        }
        telemetria('sfu_assinou', { dono: f.dono, fonte: f.fonte, tipo: f.tipo, ok: !!res?.mid && !res.erro, erro: res?.erro ?? null })
      }
      if (r?.renegociar && r.sdp?.type === 'offer') {
        await p.setRemoteDescription(r.sdp)
        const resposta = await p.createAnswer()
        resposta.sdp = opusEstereo(resposta.sdp)
        await p.setLocalDescription(resposta)
        await juntarCandidatos(p)
        await api('renegociar', { sessao, sdp: desc(p.localDescription) })
      }
      if (refazer) {
        const minha = tentativa
        setTimeout(() => {
          if (minha !== tentativa) return
          for (const falha of falhas.values()) falha.esperando = false
          enfileirar('assinar', reconciliar)
        }, refazer)
      }
    }

    function trackChegou(e) {
      const s = [...subs.values()].find(x => x.mid === e.transceiver?.mid)
      if (!s) return log(`SFU: track no mid ${e.transceiver?.mid} sem assinatura`)
      s.track = e.track
      app.trackRecebida(s.dono, e.track, { id: s.stream })
    }

    // stop() no transceiver encerra a track recebida sem disparar 'ended', e é
    // por 'ended' que a sala tira o <audio> e o vídeo daquela fonte.
    function encerrarRecebida(s, tr) {
      const t = s.track ?? tr?.receiver?.track
      if (t && typeof Event === 'function') try { t.dispatchEvent(new Event('ended')) } catch {}
    }

    // ---------- uso ----------
    // Bytes por fonte, dos dois lados. Amostra local, sem ir ao Worker: o
    // relato sai junto com a telemetria (saída, fim da fonte, fim da assinatura).

    async function amostrar() {
      if (!pc) return
      let st
      try { st = await pc.getStats() } catch { return }
      st.forEach(r => {
        const b = bytes.get(r.mid)
        if (!b) return
        if (r.type === 'outbound-rtp' && b.direcao === 'envio') b.total = Math.max(b.total, r.bytesSent ?? 0)
        if (r.type === 'inbound-rtp' && b.direcao === 'recebe') b.total = Math.max(b.total, r.bytesReceived ?? 0)
      })
    }

    function relatar(mid) {
      const b = bytes.get(mid)
      if (!b || b.total <= b.relatado) return
      telemetria('sfu_bytes', { fonte: b.fonte, tipo: b.tipo, direcao: b.direcao, dono: b.dono ?? null,
        bytes: b.total - b.relatado })
      b.relatado = b.total
    }

    // ---------- pessoas ----------

    const conexaoDe = () => ({ pc: pc ?? { connectionState: 'closed', iceConnectionState: 'closed', signalingState: 'closed' },
      amostras: [], relay: null })

    function chegou(id, nome) {
      if (pessoas.has(id)) return false
      pessoas.set(id, nome)
      app.pessoaConectando(id, nome)
      return true
    }

    function tirar(id) {
      if (!pessoas.has(id)) return
      app.pessoaDesconectando(id, conexaoDe())
      pessoas.delete(id)
      app.pessoaDesconectada(id)
      enfileirar('assinar', reconciliar)
    }

    const transporte = {
      nome: 'sfu',
      // Não há conexão por pessoa: o diagnóstico por par fica vazio.
      pares: new Map(),

      entrar(presentes, { retomada } = {}) {
        if (!retomada) {
          for (const id of [...pessoas.keys()]) tirar(id)
          fecharConexao()
        }
        for (const { id, nome } of presentes) chegou(id, nome)
        enfileirar('publicar', () => publicarAgora(app.fontes.lista()))
        enfileirar('assinar', reconciliar)
      },

      pessoaEntrou(id, nome) {
        if (!chegou(id, nome)) return
        enfileirar('assinar', reconciliar)
      },

      // A mídia de quem volta nunca dependeu do WebSocket.
      pessoaVoltou(id, nome) {
        const nova = chegou(id, nome)
        enfileirar('assinar', reconciliar)
        return nova
      },

      // Queda com volta: as fontes dela continuam no SFU e no catálogo.
      pessoaSaiu(id, { volta } = {}) {
        if (volta) return false
        tirar(id)
        return true
      },

      limparAusentes(presentes) {
        for (const id of [...pessoas.keys()])
          if (!presentes.has(id) && !catalogo.some(f => f.dono === id)) tirar(id)
      },

      sair() {
        for (const id of [...pessoas.keys()]) tirar(id)
        fecharConexao()
        catalogo = []
        versao = 0
      },

      // Na sala SFU os pares não negociam entre si; só o estado anunciado
      // passa pelo WebSocket, e esse fica com a sala.
      receberSinal(de) { log(`SFU: sinal de transporte de ${app.nome(de) ?? de} ignorado`) },

      atualizarCatalogo({ versao: v, fontes } = {}) {
        if (!Number.isInteger(v) || v < versao || !Array.isArray(fontes)) return
        versao = v
        catalogo = fontes
        enfileirar('assinar', reconciliar)
      },

      publicar(fonte) { enfileirar('publicar', () => publicarAgora([fonte])) },

      // replaceTrack não renegocia: a publicação no SFU é a mesma.
      async substituir(fonte, track) {
        const p = pubs.get(fonte.id)
        if (p) await p.tr.sender.replaceTrack(track)
      },

      parar(fonte) { enfileirar('parar', () => pararAgora(fonte.id)) },

      assinar: dono => pessoas.has(dono),

      // Uma cópia só, para o SFU, por mais gente que assista.
      planejarEnvio({ kbpsTela, orcamentoKbps = 0, telas = 0 }) {
        const kbpsPorCopia = orcamentoKbps ? Math.min(kbpsTela, orcamentoKbps) : kbpsTela
        return { copias: 1, kbpsPorCopia, kbpsPorTela: Math.floor(kbpsPorCopia / Math.max(1, telas)) }
      },

      async aplicarEnvio(limites) {
        for (const { fonte, tr } of pubs.values()) {
          if (tr.sender.track?.kind !== 'video') continue
          const lim = limites(fonte)
          if (!lim) continue
          const par = tr.sender.getParameters()
          par.encodings = par.encodings?.length ? par.encodings : [{}]
          par.encodings[0].maxBitrate = lim.maxBitrate
          par.encodings[0].maxFramerate = lim.maxFramerate
          if (lim.degradacao) par.degradationPreference = lim.degradacao
          await tr.sender.setParameters(par).catch(e => log('setParameters:', e.message))
        }
      },

      stats: async () => pc ? [{ pessoa: 'sfu', relatorio: await pc.getStats() }] : [],

      relatarUso() { for (const mid of bytes.keys()) relatar(mid) },

      // A API do SFU não documenta ICE restart. Quem chega ao SFU pelo relay
      // refaz a sessão com a credencial nova; quem vai direto só troca a lista.
      async atualizarIce(servidores) {
        if (!pc) return 0
        try { disgalmTransporte.trocarIce(pc, servidores) } catch (e) { log(`setConfiguration: ${e.message}`); return 0 }
        if (!disgalmTransporte.temTurn(servidores) || !await disgalmTransporte.usaRelay(pc)) return 0
        reconstruir('credencial')
        return 1
      },

      // Para os testes e o diagnóstico: o que está publicado e assinado.
      estado: () => ({ sessao, versao, publicadas: [...pubs.keys()],
        assinadas: [...subs.values()].map(s => ({ dono: s.dono, fonte: s.fonte, mid: s.mid })) }),
      ocioso: () => fila,
    }
    return disgalmTransporte.validar(transporte)
  }

  globalThis.criarTransporteCloudflare = criarTransporteCloudflare
})()
