// Transforma o PCM do loopback nativo numa MediaStreamTrack de áudio comum,
// que entra no RTCPeerConnection como qualquer outra.
//
// Caminho: thread WASAPI → processo principal → MessagePort → AudioWorklet
// (fila de ~40 ms) → MediaStreamAudioDestinationNode. A porta vai direto para
// o worklet, então um engasgo na thread da página não corta o som.
// Escolhido no lugar do MediaStreamTrackGenerator porque AudioWorklet existe
// em todo Chromium e o relógio da saída é o do AudioContext, não o nosso.

function esperarPorta() {
  return new Promise(resolve => {
    const f = e => {
      if (e.source !== window || e.origin !== location.origin || !e.data?.disgalmAudioPorta) return
      removeEventListener('message', f)
      resolve({ info: e.data.disgalmAudioPorta, porta: e.ports[0] })
    }
    addEventListener('message', f)
  })
}

// Abre a captura e devolve a track. track.stop() fecha a captura também.
export async function abrirAudioSemDiscord(log = () => {}) {
  const d = window.disgalmDesktop
  if (!d?.audioSemDiscord?.disponivel) throw new Error(d?.audioSemDiscord?.motivo || 'fora do app desktop')

  // Os primeiros eventos (qual processo ficou de fora) podem chegar antes do
  // id; ficam guardados até saber se são desta captura.
  let id = null
  const antes = []
  const tratar = ev => {
    if (id === null) return antes.push(ev)
    if (ev.id !== id) return
    if (ev.tipo === 'alvo') log(`áudio do sistema sem ${ev.valor.nome} (PID ${ev.valor.pid}` +
      `${ev.valor.raizes > 1 ? `, ${ev.valor.raizes} raízes; excluída a maior` : ''})`)
    else if (ev.tipo === 'inicio') log(`loopback nativo ligado (${ev.valor})`)
    else if (ev.tipo === 'erro') log(`loopback nativo: ${ev.valor}`)
  }
  const largar = d.aoEventoAudio(tratar)
  let ctx = null
  try {
    return await montar()
  } catch (e) {
    largar()
    if (id !== null) d.fecharAudio(id)
    ctx?.close()
    throw e
  }

  async function montar() {
    const chegou = esperarPorta()
    id = await d.abrirAudio()
    antes.splice(0).forEach(tratar)
    const { info, porta } = await chegou
    if (info.id !== id) throw new Error('porta de áudio trocada')

    ctx = new AudioContext({ sampleRate: info.taxa, latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule('/_desktop/pcm-worklet.js')
    const no = new AudioWorkletNode(ctx, 'disgalm-pcm', {
      numberOfInputs: 0,
      outputChannelCount: [info.canais],
      processorOptions: { taxa: info.taxa, canais: info.canais },
    })
    no.port.onmessage = e => { if (e.data.engasgo !== undefined) log(`loopback nativo: fila vazia em t=${e.data.engasgo.toFixed(2)} s (alvo ${e.data.alvoMs} ms)`); if (e.data.engasgos) log(`loopback nativo: ${e.data.engasgos} engasgos, fila ${e.data.filaMs} ms`) }
    no.port.postMessage({ porta }, [porta])
    const destino = ctx.createMediaStreamDestination()
    destino.channelCount = info.canais
    no.connect(destino)
    if (ctx.state !== 'running') await ctx.resume()

    const track = destino.stream.getAudioTracks()[0]
    const pararTrack = track.stop.bind(track)
    let fechada = false
    track.stop = () => {
      pararTrack()
      if (fechada) return
      fechada = true
      largar()
      d.fecharAudio(id)
      ctx.close()
    }
    track.disgalmNativo = true
    return track
  }
}
