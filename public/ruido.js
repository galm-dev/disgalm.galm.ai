// Captura do microfone com a supressão de ruído escolhida. No modo RNNoise o
// navegador não filtra ruído (só eco e ganho) e o áudio passa por uma rede
// neural pequena num AudioWorklet antes de ir para os pares. Os outros modos
// entregam a track do getUserMedia direto, como antes.
(() => {
  const CHAVE = 'disgalm.ruido'
  const MODOS = ['rnnoise', 'navegador', 'desligado']
  const ERROS_DE_CAPTURA = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError', 'AbortError']
  let wasm = null

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

  async function comRnnoise() {
    wasm ??= fetch('/vendor/rnnoise/rnnoise.wasm').then(r => {
      if (!r.ok) throw new Error(`rnnoise.wasm ${r.status}`)
      return r.arrayBuffer()
    })
    wasm.catch(() => { wasm = null })
    const bytes = await wasm
    const ctx = new AudioContext({ sampleRate: 48000 })
    let bruto
    try {
      await ctx.audioWorklet.addModule('/rnnoise-worklet.js')
      bruto = await capturar(false)
      const filtro = new AudioWorkletNode(ctx, 'rnnoise', {
        processorOptions: { wasm: bytes },
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      })
      const fonte = ctx.createMediaStreamSource(bruto)
      const destino = ctx.createMediaStreamDestination()
      destino.channelCount = 1     // voz mono; sem isso o destino duplica em estéreo
      fonte.connect(filtro).connect(destino)
      ctx.resume().catch(() => {})
      destravar(ctx)
      return {
        modo: 'rnnoise',
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
      stream,
      tapar() {
        const copia = stream.getAudioTracks()[0].clone()
        copia.enabled = true
        return { bruto: null, filtrado: new MediaStream([copia]), soltar() { copia.stop() } }
      },
      parar() { for (const t of stream.getTracks()) t.stop() },
    }
  }

  // Se o RNNoise falhar (navegador sem AudioWorklet, wasm fora do ar), a
  // chamada segue com o filtro do navegador e quem chamou registra o motivo.
  async function abrir(m = modo(), aoFalhar = () => {}) {
    if (m === 'rnnoise') {
      try { return await comRnnoise() } catch (e) {
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
