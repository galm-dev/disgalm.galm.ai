// AppImage: segura a montagem até o último processo do app sair.
//
// O runtime do AppImage monta o app em /tmp/.mount_* e o desmonta quando
// fecha a ponta de leitura de um pipe ("keepalive") que só o processo
// principal herdou. Os filhos do Chromium (zygote, GPU, rede, áudio) não
// herdam esse pipe e ainda estão encerrando quando o principal sai; com a
// montagem desfeita, o código deles some do mapa e eles morrem com SIGBUS
// (core dump a cada vez que o app fecha).
//
// Aqui um sh de fora da montagem herda a mesma ponta de leitura e só a solta
// quando nenhum processo roda mais de dentro dela (ou depois de 10 s).
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Ponta de leitura do keepalive: pipe aberto só para leitura aqui, cuja ponta
// de escrita está num processo que também tem o /dev/fuse (o servidor FUSE).
function acharKeepalive() {
  const pipes = new Map()
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    try {
      const alvo = fs.readlinkSync(`/proc/self/fd/${fd}`)
      const ino = /^pipe:\[(\d+)\]$/.exec(alvo)?.[1]
      if (!ino) continue
      const leitura = (parseInt(/flags:\s*(\d+)/.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))[1], 8) & 3) === 0
      if (!pipes.has(ino)) pipes.set(ino, { fd: Number(fd), soLeitura: leitura })
      else pipes.get(ino).soLeitura = false
    } catch {}
  }
  const candidatos = new Map([...pipes].filter(([, p]) => p.soLeitura).map(([ino, p]) => [ino, p.fd]))
  if (!candidatos.size) return null
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
    let fds
    try { fds = fs.readdirSync(`/proc/${pid}/fd`).map(fd => fs.readlinkSync(`/proc/${pid}/fd/${fd}`)) } catch { continue }
    if (!fds.includes('/dev/fuse')) continue
    for (const alvo of fds) {
      const ino = /^pipe:\[(\d+)\]$/.exec(alvo)?.[1]
      if (candidatos.has(ino)) return candidatos.get(ino)
    }
  }
  return null
}

// O stdin do sh é um pipe com a outra ponta só no processo principal: o `cat`
// termina quando ele sai, sem ficar consultando nada enquanto o app roda.
const SCRIPT = `
cat >/dev/null
i=0
while [ $i -lt 100 ]; do
  vivo=
  for e in /proc/[0-9]*/exe; do
    case $(readlink "$e" 2>/dev/null) in "$1"/*) vivo=1; break;; esac
  done
  [ -z "$vivo" ] && exit 0
  sleep 0.1
  i=$((i + 1))
done
`

function segurarMontagem() {
  if (process.platform !== 'linux' || !process.env.APPIMAGE) return
  try {
    const fd = acharKeepalive()
    if (fd == null) return
    const montagem = path.dirname(process.execPath)
    const filho = spawn('/bin/sh', ['-c', SCRIPT, 'disgalm-montagem', montagem],
      { cwd: '/', detached: true, stdio: ['pipe', 'ignore', 'ignore', fd] })
    filho.on('error', () => {})
    filho.unref()
    filho.stdin.on('error', () => {})
  } catch (e) {
    console.error('montagem:', e)
  }
}

module.exports = { segurarMontagem }
