// Qual processo excluir do loopback. Puro, para testar sem Windows:
// procs = [{ pid, ppid, nome }], criadoEm(pid) = ms da criação ou null.
// O loopback exclui a árvore de UM processo. O Discord roda em vários
// (principal, GPU, renderer, utilitários), todos filhos do Discord.exe
// principal; então o alvo é a raiz: o Discord.exe cujo pai não é Discord.exe.
// Um PID reusado conta como "não pai" quando o pai nasceu depois do filho.
function raizesDe(procs, nomes, criadoEm) {
  const nomesMin = new Set(nomes.map(n => n.toLowerCase()))
  const alvo = procs.filter(p => nomesMin.has(p.nome.toLowerCase()))
  const pids = new Map(alvo.map(p => [p.pid, p]))
  const criado = new Map()
  const nasceu = pid => {
    if (!criado.has(pid)) criado.set(pid, criadoEm(pid))
    return criado.get(pid)
  }
  // Pai que nasceu depois do filho é outro processo no PID antigo.
  const paiReusado = p => {
    const pai = nasceu(p.ppid), filho = nasceu(p.pid)
    return pai != null && filho != null && pai > filho
  }
  const raizes = alvo.filter(p => !pids.has(p.ppid) || paiReusado(p))
  // Mais de uma raiz (Discord reiniciando, ou um órfão cujo pai morreu): fica
  // com a que tem mais descendentes, que é a que toca a voz.
  // PID reusado pode fechar um ciclo de ppid; cada processo conta uma vez.
  const contar = (pid, vistos = new Set([pid])) => procs.reduce((n, p) => {
    if (p.ppid !== pid || vistos.has(p.pid) || paiReusado(p)) return n
    vistos.add(p.pid)
    return n + 1 + contar(p.pid, vistos)
  }, 0)
  return raizes.map(p => ({ pid: p.pid, nome: p.nome, descendentes: contar(p.pid) }))
    .sort((a, b) => b.descendentes - a.descendentes)
}

module.exports = { raizesDe }
