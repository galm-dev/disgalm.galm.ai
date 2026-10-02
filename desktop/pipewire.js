// Linux: áudio do sistema sem o Disgalm e sem o Discord, pelo PipeWire.
//
// O monitor de uma saída (loopback.sh) leva tudo, inclusive o som dos outros
// que o próprio Disgalm toca: quem assiste se ouve de volta. Aqui o app cria
// uma saída virtual só dele (null sink) e liga nela uma CÓPIA de cada fluxo de
// áudio que está tocando, menos os do Disgalm e os do Discord (pela árvore de
// processos). O som continua indo para as caixas normalmente. Uma fonte
// remapeada do monitor dessa saída aparece no Chromium como entrada de áudio,
// e é dela que sai a track. A cada segundo os fluxos são conferidos de novo.
const { execFile, execFileSync } = require('node:child_process')
const { readdirSync, readFileSync } = require('node:fs')
const { promisify } = require('node:util')

const run = promisify(execFile)
const SAIDA = 'disgalm_captura'
const ROTULO = 'Disgalm_SemDiscord'

async function pactl(...args) {
  return (await run('pactl', args)).stdout.trim()
}

// { pid: { ppid, nome } } de /proc.
function processos() {
  const todos = new Map()
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8')
      const fim = stat.lastIndexOf(')')
      const nome = stat.slice(stat.indexOf('(') + 1, fim)
      const ppid = Number(stat.slice(fim + 2).split(' ')[1])
      todos.set(Number(d), { ppid, nome })
    } catch {}
  }
  return todos
}

// PIDs das árvores a excluir: o próprio app e todo processo chamado Discord
// (Discord, DiscordPTB, DiscordCanary), com os descendentes.
function excluidos(pidApp, padrao) {
  const procs = processos()
  const raizes = new Set([pidApp])
  for (const [pid, p] of procs) if (padrao.test(p.nome)) raizes.add(pid)
  const fora = new Set()
  for (const [pid] of procs) {
    for (let atual = pid, passos = 0; atual > 1 && passos < 64; passos++) {
      if (raizes.has(atual)) { fora.add(pid); break }
      atual = procs.get(atual)?.ppid ?? 0
    }
  }
  return fora
}

// Ligações que deveriam existir: [porta de saída do fluxo, porta de entrada da
// saída virtual]. Mono vai para os dois lados.
function planejar(dump, fora, padrao) {
  const props = o => o.info?.props || {}
  const nos = dump.filter(o => o.type === 'PipeWire:Interface:Node')
  const alvo = nos.find(o => props(o)['node.name'] === SAIDA)
  if (!alvo) return null
  const portas = dump.filter(o => o.type === 'PipeWire:Interface:Port')
  const entradas = {}
  for (const p of portas)
    if (props(p)['node.id'] === alvo.id && props(p)['port.direction'] === 'in') entradas[props(p)['audio.channel']] = p.id
  // Nem todo nó traz o PID (pw-play, qemu): aí vale o do cliente dono dele,
  // que o próprio servidor preenche (pipewire.sec.pid).
  const pidDoCliente = new Map(dump.filter(o => o.type === 'PipeWire:Interface:Client').map(c =>
    [c.id, Number(props(c)['application.process.id'] || props(c)['pipewire.sec.pid'])]))
  const querido = []
  for (const n of nos) {
    const pr = props(n)
    if (pr['media.class'] !== 'Stream/Output/Audio') continue
    const pid = Number(pr['application.process.id']) || pidDoCliente.get(Number(pr['client.id']))
    if (fora.has(pid) || padrao.test(pr['application.process.binary'] || '') || padrao.test(pr['application.name'] || ''))
      continue
    for (const p of portas) {
      if (props(p)['node.id'] !== n.id || props(p)['port.direction'] !== 'out') continue
      const canal = props(p)['audio.channel']
      const destinos = canal === 'MONO' ? ['FL', 'FR'] : [canal]
      for (const c of destinos) if (entradas[c]) querido.push([p.id, entradas[c]])
    }
  }
  const atuais = dump.filter(o => o.type === 'PipeWire:Interface:Link' &&
    Object.values(entradas).includes(o.info?.['input-port-id']))
    .map(o => [o.info['output-port-id'], o.info['input-port-id']])
  return { querido, atuais }
}

// Módulos desta captura que sobraram de uma execução que caiu. Só os com o
// nome do app: o Sunshine, por exemplo, também usa null sinks.
async function limparSobras() {
  for (const l of (await pactl('list', 'short', 'modules')).split('\n')) {
    const [id, , args = ''] = l.split('\t')
    if (args.includes(`sink_name=${SAIDA}`) || args.includes(`source_name=${SAIDA}_fonte`))
      await pactl('unload-module', id).catch(() => {})
  }
}

async function abrir({ pidApp, padrao = /^discord/i, aoAviso = () => {} }) {
  await limparSobras()
  const antes = await pactl('get-default-sink')
  const modulos = []
  modulos.push(await pactl('load-module', 'module-null-sink', `sink_name=${SAIDA}`,
    `sink_properties=device.description=Disgalm_captura node.passive=true`))
  modulos.push(await pactl('load-module', 'module-remap-source', `master=${SAIDA}.monitor`,
    `source_name=${SAIDA}_fonte`, `source_properties=device.description=${ROTULO}`))
  // A saída virtual não pode virar a padrão: o som do sistema sumiria das caixas.
  if ((await pactl('get-default-sink')) !== antes) await pactl('set-default-sink', antes)

  let parado = false
  const ligadas = new Set()
  async function sincronizar() {
    const dump = JSON.parse((await run('pw-dump', [], { maxBuffer: 64 << 20 })).stdout)
    const plano = planejar(dump, excluidos(pidApp, padrao), padrao)
    if (!plano) return
    const chave = ([a, b]) => `${a}:${b}`
    const querido = new Set(plano.querido.map(chave))
    for (const l of plano.atuais) if (!querido.has(chave(l))) await run('pw-link', ['-d', String(l[0]), String(l[1])]).catch(() => {})
    const atuais = new Set(plano.atuais.map(chave))
    for (const l of plano.querido) if (!atuais.has(chave(l))) await run('pw-link', [String(l[0]), String(l[1])]).catch(() => {})
    const agora = [...querido].sort().join(',')
    if (agora !== [...ligadas].sort().join(',')) {
      ligadas.clear(); for (const k of querido) ligadas.add(k)
      aoAviso(`${plano.querido.length} canais ligados à captura`)
    }
  }
  const laco = async () => {
    while (!parado) {
      await sincronizar().catch(e => aoAviso(`PipeWire: ${e.message}`))
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  laco()

  return {
    rotulo: ROTULO,
    async fechar() {
      parado = true
      for (const m of modulos.splice(0).reverse()) await pactl('unload-module', m).catch(() => {})
    },
    // Na saída do app não dá para esperar promessa.
    fecharJa() {
      parado = true
      for (const m of modulos.splice(0).reverse()) {
        try { execFileSync('pactl', ['unload-module', m]) } catch {}
      }
    },
  }
}

// Disponível se as ferramentas do PipeWire existem.
async function disponivel() {
  try {
    await run('pw-dump', ['--version'])
    await run('pactl', ['info'])
    return true
  } catch { return false }
}

module.exports = { abrir, disponivel, planejar, SAIDA }
