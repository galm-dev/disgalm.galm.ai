// Registro das fontes que esta aba publica. A captura (getUserMedia,
// getDisplayMedia, ruido.js, áudio nativo do desktop) entrega tracks; aqui cada
// uma vira uma fonte lógica com id, tipo, dono e geração, e o transporte
// publica a fonte, não a track. Recapturar a tela ou trocar o microfone troca a
// track e sobe a geração sem mudar o id. Vídeo e áudio da mesma tela levam o
// mesmo id de tela, então quem recebe sabe que andam juntos.
//
// O id não leva o dono: o microfone abre antes do welcome, e uma reconexão com
// id novo não muda a fonte. O dono é campo, atualizado por definirDono.
(() => {
  const TIPOS = ['mic', 'camera', 'tela-video', 'tela-audio']
  // Ordem em que uma conexão nova recebe as tracks, a mesma de antes do registro.
  const ORDEM = { mic: 0, 'tela-video': 1, 'tela-audio': 1, camera: 2 }

  function criarRegistro() {
    const fontes = new Map()
    let dono = null, seq = 0

    const registro = {
      get dono() { return dono },
      definirDono(id) {
        dono = id ?? null
        for (const f of fontes.values()) f.dono = dono
      },

      // Id lógico de uma tela, compartilhado pelas fontes de vídeo e de áudio dela.
      novaTela: () => `tela-${++seq}`,

      abrir(tipo, track, stream, { tela } = {}) {
        if (!TIPOS.includes(tipo)) throw new TypeError(`tipo de fonte desconhecido: ${tipo}`)
        if (!track) throw new TypeError(`fonte ${tipo} sem track`)
        const deTela = tipo.startsWith('tela-')
        if (deTela && !tela) throw new TypeError(`${tipo} sem id de tela`)
        if (!deTela && tela) throw new TypeError(`${tipo} não pertence a uma tela`)
        const id = deTela ? `${tela}/${tipo === 'tela-video' ? 'video' : 'audio'}` : `${tipo}-${++seq}`
        if (fontes.has(id)) throw new Error(`fonte repetida: ${id}`)
        const f = { id, tipo, dono, geracao: 1, track, stream, ...(deTela && { tela }) }
        fontes.set(id, f)
        return f
      },

      // Mesma fonte, outra track. O stream só muda no microfone, que reabre inteiro.
      substituir(f, track, stream = f.stream) {
        if (fontes.get(f?.id) !== f) return null
        f.track = track
        f.stream = stream
        f.geracao++
        return f
      },

      fechar(f) { return !!f && fontes.get(f.id) === f && fontes.delete(f.id) },

      porId: id => fontes.get(id) ?? null,
      porTrack: track => [...fontes.values()].find(f => f.track === track) ?? null,
      doStream: stream => [...fontes.values()].filter(f => f.stream === stream),
      daTela: tela => ({ video: fontes.get(`${tela}/video`) ?? null, audio: fontes.get(`${tela}/audio`) ?? null }),
      // O par da mesma tela: o áudio do vídeo e o vídeo do áudio.
      associada(f) {
        if (!f?.tela) return null
        const { video, audio } = registro.daTela(f.tela)
        return f.tipo === 'tela-video' ? audio : video
      },

      // sort é estável: dentro do mesmo tipo vale a ordem de abertura.
      lista: () => [...fontes.values()].sort((a, b) => ORDEM[a.tipo] - ORDEM[b.tipo]),

      // O que vai no anúncio aos outros. Sem track nem dono: quem recebe já sabe
      // de quem veio, e o id da track remota não é o mesmo daqui.
      catalogo: () => registro.lista().map(f => ({
        id: f.id, tipo: f.tipo, geracao: f.geracao, stream: f.stream?.id ?? null, ...(f.tela && { tela: f.tela }),
      })),
    }
    return registro
  }

  globalThis.disgalmFontes = { TIPOS, criarRegistro }
})()
