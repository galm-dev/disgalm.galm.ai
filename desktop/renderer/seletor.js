// Seletor de tela do app, no lugar da caixa de diálogo do sistema: abas
// Telas/Janelas, miniaturas que se atualizam a cada 2 s, ícone e nome de cada
// janela, como no Discord. O processo principal manda as fontes
// ('tela-escolher', 'tela-atualizar') e espera a resposta. Só carrega no app
// (o preload injeta), e o Shadow DOM isola o estilo da página.
const d = window.disgalmDesktop

const ESTILO = `
:host { all: initial }
.fundo { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center;
  background: rgba(0, 0, 0, .62); backdrop-filter: blur(3px); font-family: var(--body, system-ui, sans-serif);
  color: var(--fg, #edeef2); -webkit-app-region: no-drag }
.caixa { width: min(880px, calc(100vw - 48px)); max-height: calc(100vh - 64px); display: flex; flex-direction: column;
  background: var(--surface, #0c0d12); border: 1px solid var(--line-2, rgba(237,238,242,.14));
  border-radius: var(--r-3, 14px); box-shadow: var(--shadow, 0 24px 60px -16px rgba(0,0,0,.75)); overflow: hidden }
header { padding: 20px 24px 0 }
h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600 }
p { margin: 0; color: var(--fg-3, rgba(237,238,242,.42)); font-size: 13px }
.abas { display: flex; gap: 4px; margin-top: 16px; border-bottom: 1px solid var(--line, rgba(237,238,242,.08)) }
.aba { all: unset; cursor: pointer; padding: 10px 14px; font-size: 13px; color: var(--fg-2, rgba(237,238,242,.64));
  border-bottom: 2px solid transparent; margin-bottom: -1px }
.aba:hover { color: var(--fg, #edeef2) }
.aba[aria-selected="true"] { color: var(--fg, #edeef2); border-bottom-color: var(--accent-text, #b3b6c1) }
.aba small { color: var(--fg-4, rgba(237,238,242,.26)); margin-left: 6px }
.grade { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; padding: 20px 24px;
  overflow-y: auto; min-height: 220px; align-content: start }
.fonte { all: unset; cursor: pointer; display: flex; flex-direction: column; gap: 8px; padding: 8px;
  border-radius: var(--r-2, 10px); border: 2px solid transparent; transition: background .12s }
.fonte:hover { background: var(--surface-2, #12131a) }
.fonte[aria-checked="true"] { border-color: var(--accent-text, #b3b6c1); background: var(--surface-2, #12131a) }
.fonte:focus-visible { outline: 2px solid var(--accent-line, rgba(124,130,149,.34)); outline-offset: 2px }
.quadro { aspect-ratio: 16 / 9; border-radius: var(--r-1, 6px); background: #000 center / contain no-repeat;
  border: 1px solid var(--line, rgba(237,238,242,.08)) }
.rotulo { display: flex; align-items: center; gap: 8px; font-size: 13px; min-width: 0 }
.rotulo img { width: 16px; height: 16px; flex: none }
.rotulo span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.vazio { grid-column: 1 / -1; align-self: center; text-align: center; color: var(--fg-3, rgba(237,238,242,.42)); font-size: 13px }
footer { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 24px;
  border-top: 1px solid var(--line, rgba(237,238,242,.08)); background: var(--bg, #07080b) }
.botao { all: unset; cursor: pointer; padding: 9px 16px; border-radius: var(--r-1, 6px); font-size: 13px; font-weight: 500 }
.botao.fraco { color: var(--fg-2, rgba(237,238,242,.64)) }
.botao.fraco:hover { color: var(--fg, #edeef2); background: var(--surface-2, #12131a) }
.botao.forte { background: var(--btn, #7c8295); color: var(--btn-ink, #fff) }
.botao.forte:hover { background: var(--btn-hover, #8b91a2) }
.botao.forte:disabled { opacity: .4; cursor: default }
`

let aberto = null

function fechar(id) {
  if (!aberto) return
  const { pedido, hospedeiro, teclas } = aberto
  aberto = null
  removeEventListener('keydown', teclas, true)
  hospedeiro.remove()
  d.tela.escolher(pedido, id)
}

function desenhar() {
  const { raiz, fontes, aba, escolhida } = aberto
  const daAba = fontes.filter(f => f.tipo === aba)
  for (const b of raiz.querySelectorAll('.aba')) {
    const n = fontes.filter(f => f.tipo === b.dataset.aba).length
    b.setAttribute('aria-selected', String(b.dataset.aba === aba))
    b.querySelector('small').textContent = n
  }
  const grade = raiz.querySelector('.grade')
  // Reaproveita os cartões existentes: trocar só a imagem evita piscar e não
  // perde o foco do teclado quando as miniaturas se atualizam.
  const vistos = new Set()
  for (const f of daAba) {
    vistos.add(f.id)
    let c = grade.querySelector(`[data-id="${CSS.escape(f.id)}"]`)
    if (!c) {
      c = document.createElement('button')
      c.className = 'fonte'
      c.dataset.id = f.id
      c.setAttribute('role', 'radio')
      c.innerHTML = '<div class="quadro"></div><div class="rotulo"><span></span></div>'
      c.onclick = () => { aberto.escolhida = f.id; desenhar() }
      c.ondblclick = () => fechar(f.id)
      grade.append(c)
    }
    c.querySelector('.quadro').style.backgroundImage = f.miniatura ? `url("${f.miniatura}")` : ''
    const rotulo = c.querySelector('.rotulo')
    let icone = rotulo.querySelector('img')
    if (f.icone && !icone) { icone = document.createElement('img'); rotulo.prepend(icone) }
    if (icone) icone.src = f.icone || ''
    rotulo.querySelector('span').textContent = f.tipo === 'tela' && /^(Entire screen|Screen \d+)$/i.test(f.nome)
      ? `Tela ${daAba.indexOf(f) + 1}` : f.nome
    c.title = f.nome
    c.setAttribute('aria-checked', String(f.id === escolhida))
  }
  for (const c of grade.querySelectorAll('.fonte')) if (!vistos.has(c.dataset.id)) c.remove()
  let vazio = grade.querySelector('.vazio')
  if (!daAba.length && !vazio) {
    vazio = document.createElement('div')
    vazio.className = 'vazio'
    grade.append(vazio)
  }
  if (vazio) {
    if (daAba.length) vazio.remove()
    else vazio.textContent = aba === 'tela' ? 'Nenhuma tela encontrada.' : 'Nenhuma janela aberta para compartilhar.'
  }
  raiz.querySelector('.forte').disabled = !fontes.some(f => f.id === escolhida)
}

function abrir({ pedido, fontes }) {
  if (aberto) fechar(null)
  const hospedeiro = document.createElement('div')
  const raiz = hospedeiro.attachShadow({ mode: 'closed' })
  raiz.innerHTML = `<style>${ESTILO}</style>
    <div class="fundo"><div class="caixa" role="dialog" aria-modal="true" aria-labelledby="t">
      <header><h2 id="t">Compartilhar tela</h2><p>Escolha uma tela inteira ou uma janela.</p>
        <div class="abas" role="tablist">
          <button class="aba" role="tab" data-aba="tela">Telas<small></small></button>
          <button class="aba" role="tab" data-aba="janela">Janelas<small></small></button>
        </div></header>
      <div class="grade" role="radiogroup"></div>
      <footer><button class="botao fraco">Cancelar</button><button class="botao forte">Compartilhar</button></footer>
    </div></div>`
  const telas = fontes.filter(f => f.tipo === 'tela')
  aberto = { pedido, hospedeiro, raiz, fontes, aba: 'tela', escolhida: telas.length === 1 ? telas[0].id : null }
  for (const b of raiz.querySelectorAll('.aba')) b.onclick = () => { aberto.aba = b.dataset.aba; desenhar() }
  raiz.querySelector('.fraco').onclick = () => fechar(null)
  raiz.querySelector('.forte').onclick = () => fechar(aberto.escolhida)
  raiz.querySelector('.fundo').onclick = e => { if (e.target === e.currentTarget) fechar(null) }
  aberto.teclas = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar(null) }
    else if (e.key === 'Enter' && aberto.escolhida) { e.preventDefault(); e.stopPropagation(); fechar(aberto.escolhida) }
  }
  addEventListener('keydown', aberto.teclas, true)
  document.body.append(hospedeiro)
  desenhar()
  raiz.querySelector('.fonte')?.focus()
}

d?.tela?.aoEscolher(abrir)
d?.tela?.aoAtualizar(({ pedido, fontes }) => {
  if (!aberto || aberto.pedido !== pedido) return
  aberto.fontes = fontes
  desenhar()
})
