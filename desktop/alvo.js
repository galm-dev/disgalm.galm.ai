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

// Windows só exclui UMA árvore por captura. Para deixar de fora o Disgalm e o
// Discord juntos, inverte: uma captura INCLUDE por programa que tem sessão de
// áudio, menos os excluídos. Devolve os PIDs a incluir, sem repetir árvore:
// se um processo incluído é ancestral de outro, a captura do ancestral já
// pega o descendente.
function planejarInclusoes(procs, sessoes, { pidApp, nomes }) {
  const porPid = new Map(procs.map(p => [p.pid, p]))
  const nomesMin = new Set(nomes.map(n => n.toLowerCase()))
  const ancestrais = pid => {
    const cadeia = []
    for (let atual = pid, passos = 0; atual && passos < 64; passos++) {
      cadeia.push(atual)
      const p = porPid.get(atual)
      if (!p || p.ppid === atual) break
      atual = p.ppid
    }
    return cadeia
  }
  const excluido = pid => ancestrais(pid).some(a => a === pidApp || nomesMin.has(porPid.get(a)?.nome.toLowerCase()))
  const candidatos = [...new Set(sessoes.map(s => s.pid))].filter(pid => pid > 4 && porPid.has(pid) && !excluido(pid))
  const conjunto = new Set(candidatos)
  return candidatos.filter(pid => !ancestrais(pid).slice(1).some(a => conjunto.has(a))).sort((a, b) => a - b)
}

module.exports = { raizesDe, planejarInclusoes }
