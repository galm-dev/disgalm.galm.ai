// Captura do microfone com a supressão de ruído escolhida. Nos modos RNNoise e
// DeepFilterNet o navegador não filtra ruído (só eco e ganho) e o áudio passa
// por uma rede neural num AudioWorklet antes de ir para os pares. Os outros
// modos entregam a track do getUserMedia direto, como antes.
(() => {
  const CHAVE = 'disgalm.ruido'
  const MODOS = ['rnnoise', 'deepfilter', 'navegador', 'desligado']
  const ERROS_DE_CAPTURA = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError', 'AbortError']
  const ROTULOS = { rnnoise: 'Com RNNoise', deepfilter: 'Com DeepFilterNet', navegador: 'Com o filtro do navegador', desligado: 'Sem filtro de ruído' }

  const modo = () => {
    const salvo = localStorage.getItem(CHAVE)
    return MODOS.includes(salvo) ? salvo : 'rnnoise'
  }
  const definirModo = m => { if (MODOS.includes(m)) localStorage.setItem(CHAVE, m) }

  async function capturar(filtroDoNavegador) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: filtroDoNavegador, autoGainControl: true },
    })
  }

  // Sem gesto do usuário (entrada automática depois do login) o contexto nasce
  // suspenso e o destino entrega silêncio; o primeiro clique ou tecla destrava.
  function destravar(ctx) {
    if (ctx.state === 'running') return
    const retomar = () => ctx.resume()
    for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, retomar, { once: true, capture: true })
  }

  const carregar = (url, ler) => fetch(url).then(r => {
    if (!r.ok) throw new Error(`${url} ${r.status}`)
    return ler(r)
  })

  // O WASM do DeepFilterNet tem 32 MiB e o Workers aceita 25 MiB por asset, por
  // isso vai em gzip. Se algum servidor mandar Content-Encoding: gzip, o fetch
  // já entrega o WASM; os primeiros bytes dizem qual dos dois chegou.
  async function descompactar(r) {
    const bytes = new Uint8Array(await r.arrayBuffer())
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  }

  // Cada filtro: worklet, processador e o que o worklet recebe. O módulo vem
  // pronto da thread principal porque o worklet não tem fetch.
  const FILTROS = {
    rnnoise: {
      worklet: '/rnnoise-worklet.js',
      processador: 'rnnoise',
      opcoes: () => carregar('/vendor/rnnoise/rnnoise.wasm', r => r.arrayBuffer()).then(wasm => ({ wasm })),
    },
    deepfilter: {
      worklet: '/deepfilter-worklet.js',
      processador: 'deepfilter',
      // O worklet só responde depois de instanciar o modelo; sem isso uma falha
      // passaria áudio mudo para os pares.
      esperarPronto: true,
      opcoes: () => carregar('/vendor/deepfilternet/df_bg.wasm.gz', descompactar)
        .then(b => WebAssembly.compile(b)).then(modulo => ({ modulo })),
    },
  }
  const opcoesCache = {}

  function pronto(filtro) {
    return new Promise((ok, falha) => {
      const limite = setTimeout(() => falha(new Error('o filtro não respondeu em 15 s')), 15000)
      filtro.port.onmessage = ev => {
        clearTimeout(limite)
        if (ev.data?.pronto) ok()
        else falha(new Error(ev.data?.erro || 'falha ao iniciar o filtro'))
      }
    })
  }

  async function comWorklet(m) {
    const cfg = FILTROS[m]
    opcoesCache[m] ??= cfg.opcoes()
    opcoesCache[m].catch(() => { delete opcoesCache[m] })
    const processorOptions = await opcoesCache[m]
    const ctx = new AudioContext({ sampleRate: 48000 })
    let bruto
    try {
      await ctx.audioWorklet.addModule(cfg.worklet)
      const filtro = new AudioWorkletNode(ctx, cfg.processador, {
        processorOptions,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      })
      // O contexto suspenso não roda o construtor do processador; destrava antes de esperar.
      ctx.resume().catch(() => {})
      if (cfg.esperarPronto) await pronto(filtro)
      bruto = await capturar(false)
      const fonte = ctx.createMediaStreamSource(bruto)
      const destino = ctx.createMediaStreamDestination()
      destino.channelCount = 1     // voz mono; sem isso o destino duplica em estéreo
      fonte.connect(filtro).connect(destino)
      destravar(ctx)
      return {
        modo: m,
        rotulo: ROTULOS[m],
        stream: destino.stream,
        // A gravação usa destinos próprios: a track enviada aos pares pode estar
        // desativada pelo mudo, e a comparação precisa do mesmo trecho de fala
        // antes e depois do filtro.
        tapar() {
          const dBruto = ctx.createMediaStreamDestination()
          const dFiltrado = ctx.createMediaStreamDestination()
          fonte.connect(dBruto)
          filtro.connect(dFiltrado)
          return {
            bruto: dBruto.stream,
            filtrado: dFiltrado.stream,
            soltar() {
              try { fonte.disconnect(dBruto) } catch {}
              try { filtro.disconnect(dFiltrado) } catch {}
            },
          }
        },
        parar() {
          for (const t of [...destino.stream.getTracks(), ...bruto.getTracks()]) t.stop()
          filtro.port.postMessage('fechar')
          ctx.close().catch(() => {})
        },
      }
    } catch (e) {
      for (const t of bruto?.getTracks() || []) t.stop()
      ctx.close().catch(() => {})
      throw e
    }
  }

  function direto(stream, m) {
    return {
      modo: m,
      rotulo: ROTULOS[m],
      stream,
      tapar() {
        const copia = stream.getAudioTracks()[0].clone()
        copia.enabled = true
        return { bruto: null, filtrado: new MediaStream([copia]), soltar() { copia.stop() } }
      },
      parar() { for (const t of stream.getTracks()) t.stop() },
    }
  }

  // Se o filtro neural falhar (navegador sem AudioWorklet, wasm fora do ar), a
  // chamada segue com o filtro do navegador e quem chamou registra o motivo.
  async function abrir(m = modo(), aoFalhar = () => {}) {
    if (FILTROS[m]) {
      try { return await comWorklet(m) } catch (e) {
        // Permissão negada ou microfone ausente não melhora trocando de filtro.
        if (ERROS_DE_CAPTURA.includes(e.name)) throw e
        aoFalhar(e)
        m = 'navegador'
      }
    }
    return direto(await capturar(m === 'navegador'), m)
  }

  window.disgalmRuido = { MODOS, modo, definirModo, abrir }
})()
