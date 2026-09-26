# Desconexão da sinalização

Em 08/09/2026, na versão publicada anterior à correção, um WebSocket fechado
em sala isolada deixou o indicador verde e o perfil com “Na sala”. O texto
lateral mudou para “Sinalização desconectada”. O log registrou apenas
“sinalização caiu”. Reproduzido no navegador, sem microfone ou câmera reais.

Após a alteração, um fechamento real no servidor local produziu evento 1006,
sem motivo e com wasClean=false. O indicador ficou vermelho, o perfil mudou
para “Desconectado” e o aviso apareceu em viewport de 390×844. O botão de
reentrada abriu o formulário mantendo o código da sala.

A revisão procurou falsificar a correção com fechamento normal, nova mensagem
no aviso comum, novo welcome e mídia ainda conectada. Os quatro testes em
`tests/signaling-ui.test.js` passaram. Perder sinalização não encerra a mídia
por iniciativa deste tratamento.

A causa da queda relatada por Marcus continua desconhecida. O evento 1006 do
teste local não identifica a causa da chamada original. Os novos logs guardam
horário, código, motivo, wasClean e estados de conexão/ICE por destinatário.
