// Transporte em malha: uma RTCPeerConnection por pessoa, negociação perfeita
// entre cada par e a sinalização indo pelo WebSocket da sala. Implementa o
// contrato de transporte.js; a sala não toca nas conexões fora daqui, salvo o
// diagnóstico, que lê as estatísticas de cada uma.
(() => {
  // ---------- Opus estéreo ----------

  const OPUS = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000;useinbandfec=1'

  function opusEstereo(sdp) {
    const linhas = sdp.split(/\r\n|\n/)
    const pts = linhas.flatMap(l => l.match(/^a=rtpmap:(\d+) opus\/48000\/2$/)?.[1] ?? [])
    for (const pt of pts) {
      const i = linhas.findIndex(l => l.startsWith(`a=fmtp:${pt} `))
      if (i >= 0) {
        if (!linhas[i].includes('stereo=1')) linhas[i] += ';' + OPUS
      } else {
        const j = linhas.findIndex(l => l.startsWith(`a=rtpmap:${pt} `))
        linhas.splice(j + 1, 0, `a=fmtp:${pt} ${OPUS}`)
      }
    }
    return linhas.join('\r\n')
  }

  async function definirLocal(pc) {
    const sd = pc.signalingState === 'have-remote-offer' ? await pc.createAnswer() : await pc.createOffer()
    sd.sdp = opusEstereo(sd.sdp)
    await pc.setLocalDescription(sd)
  }

  const morto = pc => pc.connectionState === 'failed' || pc.connectionState === 'closed'

  function criarTransporteMesh(app) {
    disgalmTransporte.conferirGanchos(app)
    const { log, telemetria } = app
    const pares = new Map()

    // Cada conexão tem id próprio, que vai em toda mensagem: é assim que se
    // percebe que o outro lado recriou a dele e a nossa ficou órfã.
    const sinalizarPar = (id, data) => app.sinalizar(id, { ...data, de: pares.get(id)?.conexao })

    // Papel no perfect negotiation vem da ordem dos ids, não de quem chegou
    // primeiro: depois de uma queda os dois lados podem recriar a conexão ao
    // mesmo tempo, e só uma regra simétrica garante um polite e um impolite.
    function criarPar(id, nome) {
      const polite = app.meuId() < id
      // 'relay' descarta candidatos host e srflx: se conectar assim, foi TURN de
      // verdade. Sem isso, o par quase sempre fecha direto e o TURN nunca é exercido.
      const soRelay = !!app.soRelay()
      const pc = new RTCPeerConnection({
        iceServers: app.ice(),
        iceTransportPolicy: soRelay ? 'relay' : 'all',
      })
      const p = { pc, polite, fazendoOferta: false, ignorandoOferta: false,
                  conexao: Math.random().toString(36).slice(2, 10), remota: null,
                  amostras: [], relato: null }
      pares.set(id, p)
      const publicadas = app.fontes.lista()
      telemetria('par_criado', { par: id, polite, soRelay,
        enviaCam: publicadas.some(f => f.tipo === 'camera'),
        enviaTelas: publicadas.filter(f => f.tipo === 'tela-video').length,
        enviaMic: publicadas.some(f => f.tipo === 'mic') })
      app.pessoaConectando(id, nome)

      // Quem recebe a imagem ruim não sabe por que o emissor degradou; quem envia
      // sabe. Cada lado manda ao outro o próprio envio por este canal. Negociado
      // com id fixo: os dois lados o criam e ninguém depende de ondatachannel.
      // Par direto, então não custa mensagem no Durable Object da sinalização.
      p.canal = pc.createDataChannel('telemetria', { negotiated: true, id: 0 })
      p.canal.onmessage = e => {
        try { p.relato = { ...JSON.parse(e.data), recebidoEm: Date.now() } }
        catch { log(`relato inválido de ${app.nome(id)}`) }
      }

      for (const f of publicadas) pc.addTrack(f.track, f.stream)

      pc.ontrack = e => app.trackRecebida(id, e.track, e.streams[0])

      const tipos = new Set()
      pc.onicecandidate = e => {
        if (!e.candidate) {
          telemetria('candidatos_locais', { par: id, tipos: [...tipos].join(',') || 'nenhum' })
          return log(`candidatos de ${app.nome(id)}: ${[...tipos].join(', ') || 'NENHUM'}`)
        }
        if (!tipos.has(e.candidate.type)) {
          tipos.add(e.candidate.type)
          log(`candidato ${e.candidate.type}/${e.candidate.protocol} para ${app.nome(id)}`)
        }
        sinalizarPar(id, { candidate: e.candidate })
      }
      pc.onicecandidateerror = e => {
        log(`ICE erro ${e.errorCode} em ${e.url} — ${e.errorText}`)
        telemetria('ice_erro', { par: id, codigo: e.errorCode, url: e.url, texto: e.errorText })
      }

      pc.oniceconnectionstatechange = () => {
        log(`${app.nome(id)}: ${pc.iceConnectionState}`)
        telemetria('ice', { par: id, estado: pc.iceConnectionState })
        if (pc.iceConnectionState === 'connected') { tipoDeCaminho(id, pc); acompanhar(id, pc) }
        if (pc.iceConnectionState === 'failed') {
          porQueFalhou(id, pc)
          // Rede trocada no meio da chamada: novos candidatos, mesma conexão.
          if (app.sinalizacaoAberta()) pc.restartIce()
        }
      }
      pc.onconnectionstatechange = () => {
        log(`${app.nome(id)}: conexão ${pc.connectionState}`)
        telemetria('conexao', { par: id, estado: pc.connectionState })
        if (pares.get(id)?.pc === pc) app.conexaoMudou(id)
      }

      // A primeira oferta é sempre do impolite. Se as duas pontas oferecem juntas
      // e a polite tem mais mídia (câmera ligada, a outra não), o Chromium falha
      // ao responder depois do rollback ("Failed to start SCTP transport") e a
      // conexão nunca sai de 'new'. Era o caso de dois celulares. O evento volta
      // a disparar quando a resposta deixa a conexão estável. Se a polite recriou
      // a conexão sozinha (retomada com a antiga morta), ninguém mais oferece:
      // depois de 3 s sem oferta, ela oferece como antes.
      pc.onnegotiationneeded = async () => {
        if (polite && !pc.remoteDescription) {
          if (!p.esperandoOferta) p.esperandoOferta = setTimeout(() => {
            if (pares.get(id) === p && !pc.remoteDescription && pc.signalingState === 'stable') negociar()
          }, 3000)
          return
        }
        return negociar()
      }
      const negociar = async () => {
        try {
          p.fazendoOferta = true
          await definirLocal(pc)
          sinalizarPar(id, { description: pc.localDescription })
        } catch (e) { log('negotiationneeded:', e.message); telemetria('negociacao_erro', { par: id, erro: e.message }) }
        finally { p.fazendoOferta = false }
      }
      return p
    }

    async function tipoDeCaminho(id, pc) {
      const st = await pc.getStats()
      let atual
      st.forEach(r => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) atual = r })
      if (!atual) return
      const l = st.get(atual.localCandidateId), r = st.get(atual.remoteCandidateId)
      const via = l?.candidateType === 'relay' || r?.candidateType === 'relay' ? 'RELAY (TURN)' : 'direto'
      // Com dois TURN na lista, saber que houve relay não diz qual respondeu. O
      // endereço do candidato relay é o do servidor que alocou.
      const quem = l?.candidateType === 'relay' ? ` via ${l.address}` : ''
      log(`caminho com ${app.nome(id)}: ${via}${quem} — ${l?.candidateType}/${r?.candidateType}`)
      telemetria('caminho', { par: id, local: l?.candidateType, protocolo: l?.relayProtocol ?? l?.protocol,
        remoto: r?.candidateType, relay: l?.candidateType === 'relay' ? l.url ?? null : null })
    }

    async function porQueFalhou(id, pc) {
      const st = await pc.getStats()
      const cand = new Map()
      st.forEach(r => { if (r.type.endsWith('candidate')) cand.set(r.id, r) })
      const linhas = []
      st.forEach(r => {
        if (r.type !== 'candidate-pair') return
        const l = cand.get(r.localCandidateId), rm = cand.get(r.remoteCandidateId)
        linhas.push(`  ${l?.candidateType}/${l?.protocol} → ${rm?.candidateType}: ${r.state}`)
      })
      const remotos = new Set([...cand.values()].filter(c => c.type === 'remote-candidate').map(c => c.candidateType))
      telemetria('ice_falhou', { par: id, pares: linhas.map(l => l.trim()).slice(0, 30),
        candidatosRemotos: [...remotos].join(',') || 'nenhum' })
      log(`por que falhou com ${app.nome(id)}:\n${linhas.join('\n') || '  nenhum par formado'}`)
    }

    function acompanhar(id, pc) {
      const p = pares.get(id)
      // ICE volta a 'connected' depois de cada 'disconnected': sem a trava, cada
      // volta somava outro timer e duplicava as amostras.
      if (!p || p.timer) return
      const anteriores = new Map()
      p.timer = setInterval(async () => {
        if (pares.get(id) !== p) return clearInterval(p.timer)
        try { await app.amostrar(id, pc, anteriores) }
        catch (e) { log(`estatísticas de vídeo: ${e.message}`) }
      }, 2000)
    }

    // Uma oferta mandada pelo socket que caiu, ou para o socket morto do outro,
    // nunca chegou. localDescription já carrega os candidatos coletados.
    function ressincronizar(id) {
      const p = pares.get(id)
      if (p.pc.signalingState === 'have-local-offer') {
        log(`reenviando oferta pendente para ${app.nome(id)}`)
        sinalizarPar(id, { description: p.pc.localDescription })
      }
      if (p.pc.iceConnectionState === 'failed') p.pc.restartIce()
    }

    function removerPar(id) {
      const p = pares.get(id)
      if (!p) return
      // Quem sai leva as amostras junto: a sala guarda antes de fechar.
      app.pessoaDesconectando(id, p)
      clearInterval(p.timer)
      p.pc.close()
      pares.delete(id)
      app.pessoaDesconectada(id)
    }

    // Retomada sem a conexão viva, ou pessoa que a sala ainda não tinha: do zero.
    function recriar(id, nome) {
      removerPar(id)
      return criarPar(id, nome)
    }

    // Recebe só o que é do transporte: descrição e candidatos. O estado
    // anunciado é da pessoa e fica com a sala.
    async function receberSinal(id, data) {
      let p = pares.get(id)
      // Oferta de outra instância: o outro lado recriou a conexão (voltou de uma
      // queda, ou achou a nossa morta). A nossa não tem mais par; recria e aceita.
      if (data.de && data.description?.type === 'offer' && (!p || (p.remota && p.remota !== data.de))) {
        log(`${app.nome(id) ?? id} recriou a conexão — recriando a nossa`)
        telemetria('par_recriado', { par: id })
        p = recriar(id, app.nome(id) ?? '?')
        app.pessoaReconectada(id)
      }
      if (!p) return
      if (data.de) {
        if (p.remota && p.remota !== data.de) return      // resto da instância velha
        p.remota = data.de
      }
      const { pc } = p
      try {
        if (data.description) {
          const colisao = data.description.type === 'offer' && (p.fazendoOferta || pc.signalingState !== 'stable')
          p.ignorandoOferta = !p.polite && colisao
          if (p.ignorandoOferta) {
            telemetria('oferta_ignorada', { par: id })
            return log(`oferta ignorada de ${app.nome(id)} (impolite)`)
          }
          await pc.setRemoteDescription(data.description)
          if (data.description.type === 'offer') {
            await definirLocal(pc)
            sinalizarPar(id, { description: pc.localDescription })
          }
        } else if (data.candidate) {
          try { await pc.addIceCandidate(data.candidate) } catch (e) { if (!p.ignorandoOferta) throw e }
        }
      } catch (e) { log('sinal:', e.message); telemetria('sinal_erro', { par: id, erro: e.message }) }
    }

    const transporte = {
      nome: 'mesh',
      pares,

      // Id novo: para os outros somos outra pessoa e os pares antigos nunca mais
      // recebem sinal. Retomada: os pares continuam, só a negociação é conferida.
      entrar(presentes, { retomada } = {}) {
        if (!retomada) for (const id of [...pares.keys()]) removerPar(id)
        for (const { id, nome } of presentes) {
          const p = pares.get(id)
          if (p && !morto(p.pc)) ressincronizar(id)
          else recriar(id, nome)
        }
      },

      pessoaEntrou(id, nome) { recriar(id, nome) },

      // O outro reconectou com o mesmo id. O que mandamos para o socket velho
      // dele pode ter se perdido.
      pessoaVoltou(id, nome) {
        const p = pares.get(id)
        if (p && !morto(p.pc)) { ressincronizar(id); return false }
        recriar(id, nome)
        return true
      },

      // Queda de sinalização (volta=true) não derruba mídia viva: a pessoa deve
      // retomar o id em segundos. limparAusentes remove se a mídia morrer.
      pessoaSaiu(id, { volta } = {}) {
        if (volta && pares.get(id)?.pc.connectionState === 'connected') return false
        removerPar(id)
        return true
      },

      // Par que o servidor não lista e cuja conexão morreu é fantasma: a pessoa
      // recarregou ou saiu enquanto a sinalização estava fora e o aviso se perdeu.
      // Par fora da lista com mídia viva fica: ele pode estar reconectando.
      limparAusentes(presentes) {
        for (const [id, p] of pares)
          if (!presentes.has(id) && (morto(p.pc) || p.pc.connectionState === 'disconnected')) {
            log(`${app.nome(id)} não está na sala e a conexão está ${p.pc.connectionState} — removendo`)
            removerPar(id)
          }
      },

      sair() { for (const id of [...pares.keys()]) removerPar(id) },

      receberSinal,

      // Na malha cada par manda o que tem; não há catálogo da sala.
      atualizarCatalogo() {},

      // Malha: cada conexão leva sua cópia de cada fonte.
      publicar(fonte) {
        for (const [, p] of pares) p.pc.addTrack(fonte.track, fonte.stream)
      },

      // replaceTrack não renegocia, então o receptor nem vê troca — e some o
      // transceiver morto que o par removeTrack/addTrack deixava.
      async substituir(fonte, track) {
        for (const [, p] of pares)
          for (const sd of p.pc.getSenders())
            if (sd.track === fonte.track) await sd.replaceTrack(track)
      },

      parar(fonte) {
        for (const [, p] of pares)
          for (const sd of p.pc.getSenders())
            if (sd.track && sd.track === fonte.track) p.pc.removeTrack(sd)
      },

      // Na malha tudo o que o dono publica já chega; assinar é só confirmar o caminho.
      assinar: dono => pares.has(dono),

      // Em malha você envia uma cópia para CADA par, e as conexões não coordenam
      // entre si: cada uma sonda a banda sozinha e a que subir primeiro fica com
      // ela. Declarar o teto POR PAR faz a subida total crescer a cada pessoa que
      // entra. Declarar o total e dividir é o que evita uma conexão matar a outra.
      // Toda tela vai a todo par, mesmo que ele só olhe uma: dividem o teto.
      planejarEnvio({ kbpsTela, orcamentoKbps = 0, telas = 0 }) {
        const copias = Math.max(1, pares.size)
        const kbpsPorCopia = orcamentoKbps ? Math.min(kbpsTela, Math.floor(orcamentoKbps / copias)) : kbpsTela
        return { copias, kbpsPorCopia, kbpsPorTela: Math.floor(kbpsPorCopia / Math.max(1, telas)) }
      },

      async aplicarEnvio(limites) {
        for (const [, p] of pares)
          for (const s of p.pc.getSenders()) {
            if (s.track?.kind !== 'video') continue
            const fonte = app.fontes.porTrack(s.track)
            const lim = fonte && limites(fonte)
            if (!lim) continue
            const par = s.getParameters()
            par.encodings = par.encodings?.length ? par.encodings : [{}]
            par.encodings[0].maxBitrate = lim.maxBitrate
            par.encodings[0].maxFramerate = lim.maxFramerate
            if (lim.degradacao) par.degradationPreference = lim.degradacao
            await s.setParameters(par).catch(e => log('setParameters:', e.message))
            const aplicada = s.getParameters().degradationPreference
            if (lim.degradacao && aplicada !== lim.degradacao)
              log(`navegador não aplicou ${lim.degradacao} na tela (ficou ${aplicada ?? 'sem valor'})`)
          }
      },

      stats: () => Promise.all([...pares].map(async ([id, p]) => ({ pessoa: id, relatorio: await p.pc.getStats() }))),

      relatarUso() { for (const [id, p] of pares) app.relayUsado(id, p) },

      // Sem TURN na lista nova (orçamento negou), refazer o ICE não acha relay:
      // a conexão segue até a alocação cair, e a falha cuida do resto.
      async atualizarIce(servidores) {
        const comTurn = disgalmTransporte.temTurn(servidores)
        let reiniciados = 0
        for (const [id, p] of pares) {
          try { disgalmTransporte.trocarIce(p.pc, servidores) } catch (e) { log(`setConfiguration: ${e.message}`); continue }
          if (comTurn && !morto(p.pc) && await disgalmTransporte.usaRelay(p.pc)) {
            log(`credencial TURN renovada: refazendo o ICE com ${app.nome(id)}`)
            p.pc.restartIce()
            reiniciados++
          }
        }
        return reiniciados
      },
    }
    return disgalmTransporte.validar(transporte)
  }

  criarTransporteMesh.opusEstereo = opusEstereo
  globalThis.criarTransporteMesh = criarTransporteMesh
})()
