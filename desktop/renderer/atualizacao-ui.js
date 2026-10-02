// Badge de atualização no topo da janela, como no T3 Code: aparece quando há
// versão nova baixando ("Baixando 0.5.1… 40%") ou pronta ("Atualizar e
// reiniciar"), e some quando está em dia. Clicar no pronto instala e reabre.
// Só carrega no app (o preload injeta); Shadow DOM isola o estilo.
const d = window.disgalmDesktop

const host = document.createElement('div')
const raiz = host.attachShadow({ mode: 'closed' })
const direita = d?.plataforma === 'darwin' ? 16 : 150   // Windows/Linux: botões da janela à direita
raiz.innerHTML = `<style>
  :host { all: initial }
  .badge { position: fixed; top: 7px; right: ${direita}px; z-index: 2147482000; display: none; align-items: center;
    gap: 7px; height: 26px; padding: 0 11px; border-radius: 999px; font: 500 12px var(--body, system-ui, sans-serif);
    color: var(--fg, #edeef2); background: var(--surface-3, #1a1b23); border: 1px solid var(--line-2, rgba(237,238,242,.14));
    -webkit-app-region: no-drag; user-select: none; cursor: default }
  .badge.pronta { cursor: pointer; background: #1f6f43; border-color: #2c9a5d }
  .badge.pronta:hover { background: #24804d }
  .ponto { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-text, #b3b6c1) }
  .pronta .ponto { background: #7dffb0 }
</style><div class="badge" role="status"><span class="ponto"></span><span class="texto"></span></div>`
const badge = raiz.querySelector('.badge')
const texto = raiz.querySelector('.texto')

function desenhar(a) {
  if (!a?.suportado || !['baixando', 'pronta'].includes(a.situacao)) { badge.style.display = 'none'; return }
  badge.style.display = 'flex'
  badge.classList.toggle('pronta', a.situacao === 'pronta')
  texto.textContent = a.situacao === 'pronta' ? `Atualizar para ${a.nova} e reiniciar` : `Baixando ${a.nova}… ${a.progresso}%`
  badge.title = `Disgalm ${a.versao} · canal ${a.canal === 'nightly' ? 'Nightly' : 'Stable'}`
}
badge.onclick = () => { if (badge.classList.contains('pronta')) d.atualizacao.instalar() }

if (d?.atualizacao) {
  document.body.append(host)
  d.atualizacao.aoMudar(desenhar)
  d.atualizacao.estado().then(desenhar)
}
