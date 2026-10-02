# Investigação: SFU para o Disgalm

Consulta: **02/10/2026, horário de Brasília**. Código examinado: branch `investigacao/sfu`, base `feat/electron-poc`, commit `5c31ee5`, repositório `galm-dev/disgalm`. Os números externos são os publicados nas fontes oficiais nesta data; valores em USD, sem impostos/conversão cambial. Este trabalho é documental: nenhum código, limite, credencial ou ambiente foi alterado; não houve teste com SFU real nem inspeção do host `sirius`.

## 1. Recomendação e resultado esperado

**Experimentar Cloudflare Realtime SFU (antigo Calls) como complemento adaptativo: P2P por padrão e promoção da fonte para SFU quando o fan-out prejudicar a entrega.** Manter Worker + Durable Object como controle da sala. Primeiro validar SFU forçado em salas experimentais de quatro pessoas; depois validar a troca de uma fonte em andamento, antes de propor salas de oito. A preferência por P2P e acionamento por degradação foi indicada por Marcus durante esta investigação.

O motivo principal é econômico e operacional: já existe backend Cloudflare, o cliente usa WebRTC nativo e a franquia de mídia é grande. O custo dessa escolha é desenvolver a camada de sessões/publicações/assinaturas, que um SDK como LiveKit já oferece. **LiveKit self-host é a segunda opção** se Marcus priorizar um SDK pronto e aceitar operar um servidor acessível aos amigos. LiveKit Cloud serve para um ensaio curto, mas a franquia de transferência é pequena para telas. Mediasoup e Janus são possíveis, porém exigem mais trabalho de produto e operação para este caso.

O híbrido recomendado decide **por fonte**, não por sala ou número mágico de pessoas. Tela e seu áudio de sistema mudam juntos; voz pode continuar direta. Câmeras precisam da mesma política ou de teto explícito, pois também multiplicam upload. A malha residual ainda tem N−1 PCs por cliente: se a causa for esse custo residual, disponibilizar modo SFU completo em vez de prometer que migrar só tela resolve tudo. Não reconectar a sala toda quando entra a quinta pessoa.

Limite proposto depois da validação: **8 pessoas nas salas com capacidade adaptativa**, inicialmente uma tela assistida em alta qualidade por cliente e câmeras com teto de 800 kbps e elegíveis à promoção. Publicar várias telas continua permitido, mas assinar vídeo por interesse. Evoluir para 12 apenas com medição de dispositivos fracos, custo e rede. Não é limite do fornecedor nem garantia de 8 telas 4K60 simultâneas. Clientes legados/malha sem roteador permanecem em 4. Voz direta no teto atual custa até 7 × 128 = 896 kbps de upload por pessoa em oito, mas os custos de PCs/áudio/CPU precisam passar no ensaio.

## 2. Mapa da dependência atual da malha

As referências abaixo usam as linhas do commit-base, não as linhas de uma implementação futura.

| Área | Evidência no checkout | Implicação para SFU |
|---|---|---|
| Admissão | `worker/src/index.js:9` define `MAX = 4`; `worker/src/index.js:255` compara a ocupação antes do welcome | Aumentar esse número sozinho só libera mais fan-out. Admissão precisa considerar modo e capacidades dos clientes. |
| Uma conexão por pessoa remota | `public/index.html:370` mantém `pares`; `public/index.html:1141` cria `criarPar`; `public/index.html:1147` instancia `RTCPeerConnection` com ICE e opção relay | Separar participante visual de conexão de transporte. Um participante remoto não deve exigir uma PC própria no SFU. |
| Negociação perfeita | `public/index.html:1132` cria offer/answer e altera Opus; `public/index.html:1142` escolhe polite por IDs; `public/index.html:1232` trata negotiationneeded, incluindo espera inicial de 3 s; `public/index.html:1520` recebe sinal, trata geração remota e colisões; `public/index.html:1560` aplica SDP | Esse protocolo vale entre pares. Cloudflare precisa de uma fila de mutações por sessão e respostas da API; SDKs LiveKit/mediasoup e Janus têm seus próprios protocolos. |
| Transporte de SDP/ICE | `public/index.html:1193` envia candidatos; `public/index.html:1587` envia `signal` com ID da instância; `worker/src/index.js:287` recebe e `worker/src/index.js:299` encaminha ao destinatário | Na sala SFU, SDP não é oferta para um amigo; o backend chama a API do SFU ou emite autorização para o servidor de mídia. |
| Fontes locais | `public/index.html:481` substitui mic nos senders; `public/index.html:591` adiciona câmera em cada PC; `public/index.html:636` captura tela; `public/index.html:651` junta áudio nativo; `public/index.html:673` adiciona todas as tracks em cada PC; `public/index.html:1175` repete mic/telas/câmera para quem entra | Captura pode ser reaproveitada. Publicar cada track uma vez, com tipo e proprietário explícitos. |
| Várias telas e estado | `public/index.html:359` guarda telas em streams separados, com áudio do sistema em apenas uma; `public/index.html:376` anuncia `idsTelas`, `streamId`, `idTela2`, `idCam`, mute/deafen/nome/foto para todos os pares | Introduzir IDs de fonte estáveis do aplicativo; vincular ID de pessoa, tipo, geração, publicação SFU e MID de recepção. Não supor que o SFU preserve `MediaStream.id`. |
| Classificação e remoção remota | `public/index.html:1037` classifica vídeo pelo anúncio; `public/index.html:1071` distingue áudio de tela/voz; `public/index.html:1079` cria um elemento por track | Preservar volumes separados e reconciliação por catálogo. Não depender de `ended`: `removeTrack` pode deixar o último quadro, conforme `public/index.html:1033`. |
| Recaptura e fim | `public/index.html:685` recaptura; `public/index.html:698` substitui track mantendo stream; `public/index.html:720` para tela com removeTrack por PC | Substituição deve preservar ID lógico da fonte. Fim fecha publicação, remove anúncio e reconcilia assinaturas, inclusive após falha parcial. |
| Presets | `public/index.html:336`: Código 1080p5/1,5 Mbps, Equilíbrio 1080p30/4, Fluido 1080p120/15, Jogo 1440p60/12, Máximo 4K60/25; câmera 0,8 em `public/index.html:344` | Presets de captura continuam; camadas e assinaturas passam a controlar distribuição. SFU não cria resolução/fps ausentes na captura. |
| Orçamento por sender | `public/index.html:350` divide orçamento por `pares.size`; `public/index.html:356` divide entre telas; `public/index.html:775` aplica constraints e `public/index.html:790` percorre cada PC para maxBitrate/maxFramerate e maintain-resolution; `public/index.html:829` multiplica upload por pares | Orçamento SFU divide entre fontes/camadas, sem multiplicar pelos espectadores. Simulcast ainda envia várias codificações; somar seus tetos. |
| Estéreo | `public/index.html:1115` fixa Opus stereo/sprop-stereo/128 kbps/FEC; `public/index.html:1132` aplica o SDP alterado; `public/index.html:656` pede loopback sem processamento de voz e com 2 canais | Verificar ambos os trechos navegador→SFU e SFU→receptor. Aceitar Opus não prova separação L/R. |
| Diagnóstico por par | `public/index.html:1169` cria DataChannel negociado `telemetria`, ID 0; `public/index.html:1283` amostra a cada 2 s; `public/index.html:1416` relaciona stats com track local/remota, remote-inbound, candidate pair; `public/index.html:1461` manda relato ao receptor; `public/index.html:1498` exporta relatório | RTT/perda do publicador passam a descrever navegador→SFU, não o caminho até cada amigo. Registrar upload por publicação e download por assinatura/camada; correlacionar sem atribuir falha do assinante ao publicador. |
| Logs | `public/index.html:289` enfileira telemetria; `public/index.html:325` envia lotes a cada 10 s; `worker/src/index.js:29` envia ao Better Stack; `worker/src/index.js:372` autentica/limita `/telemetria`; `worker/src/index.js:49` sanitiza | Reaproveitar com evento e dimensões de transporte/publicação. Evitar SDP, tokens e payload de mídia nos logs; um heartbeat estatístico contínuo no DO pode tirar a economia obtida. |
| Reconexão | `public/index.html:1216` restartIce; `public/index.html:1578` heartbeat 20 s/timeout 45 s; `public/index.html:1654` backoff até 15 s; `public/index.html:1688` reenvia oferta; `public/index.html:1713` retoma ID ou recria pares; `public/index.html:1763` preserva mídia viva na queda do WS | Separar reconexão do controle da sala e da mídia SFU. Manter mídia viva na queda do WS; regenerar catálogo e assinaturas quando a sessão SFU mudar. |
| Hibernação | `worker/src/index.js:106` deriva presença dos sockets/attachments; `worker/src/index.js:113` configura resposta automática; `worker/src/index.js:227` usa acceptWebSocket; `worker/src/index.js:271` serializa identidade | Não manter catálogo essencial somente em Map, nem instalar timers ou WS de saída permanente do DO para o SFU. Persistir catálogo/versionamento e recuperar ao acordar. |
| TURN | `worker/src/index.js:62` gera credenciais Cloudflare com TTL 86.400 s; `worker/src/index.js:83` admite coturn alternativo; `worker/src/index.js:367` protege `/ice`; `public/index.html:1778` busca configuração | Credenciais são de conectividade, não autorização para publicar/assinar. Tratar expiração em chamadas longas e reconstrução de conexão. |
| Desktop: mesmo cliente | `desktop/main.js:21` usa UI local por padrão; `desktop/main.js:43` intercepta assets locais sobre a origem; `desktop/empacotar.mjs:63` inclui `public/` | Adaptadores em public chegam ao desktop, mas pacotes antigos podem carregar HTML antigo contra Worker novo. Negociar versão antes de admitir em sala SFU. |
| Desktop: captura | `desktop/main.js:130` intercepta getDisplayMedia; `desktop/main.js:168` entrega loopback Windows; `desktop/main.js:211` anuncia PCM 48 kHz/2 canais; `desktop/renderer/audio-nativo.js:38` captura PipeWire estéreo; `desktop/renderer/audio-nativo.js:97` monta AudioWorklet e destino; `desktop/pipewire.js:38` exclui árvores do app/Discord | SFU recebe tracks normais; não reescrever WASAPI/PipeWire. Confirmar que eco, exclusão de processos, bandeja, suspensão e autoplay continuam corretos. |

`PLANO-POC.md:46` e `PLANO-POC.md:138` fundamentam a banda; a primeira seção registra uma regra histórica, não toda a implementação atual. Há várias telas no código e orçamento global. Com uma tela a 4 Mbps e três destinatários são 12 Mbps; com sete são 28 Mbps. A 25 Mbps seriam 75 e 175 Mbps. Uma publicação SFU de camada única reduz esses tetos para 4 ou 25 Mbps, antes do áudio e overhead, independentemente dos sete destinatários. Ela não elimina downloads nem a replicação no servidor.

## 3. Alternativas e integração

### Cloudflare Realtime SFU

É uma API de sessões/tracks, sem impor a sala do Disgalm. Criar PC e sessão, publicar tracks locais, distribuir referências autorizadas e solicitar tracks remotas. Manter associação entre MID e fonte lógica. Segredo do app fica no Worker; o cliente nunca recebe credencial administrativa. [Modelo de sessões](https://developers.cloudflare.com/realtime/sfu/concepts/sessions-tracks/) e [receitas de conexão](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/).

Offer/answer passa pela API, com renegociação quando pedida pela resposta. Serializar mutações da mesma sessão; verificar resultados por track, sem refazer cegamente um lote parcialmente aceito. A negociação perfeita da malha não substitui essa máquina de estados. [Ciclo de negociação](https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/).

**Simulcast:** configurar sendEncodings/RIDs antes da oferta; cada assinatura escolhe RID e pode atualizá-lo. O fallback de camada não é automático na configuração padrão; escolher política explicitamente. **SVC:** a documentação consultada não estabelece suporte a seleção de camadas SVC; não condicionar a migração a isso. Começar com camada única, depois testar simulcast compatível com os navegadores. [Simulcast](https://developers.cloudflare.com/realtime/sfu/features/simulcast/).

**Áudio:** preservar captura estéreo e negociar Opus nos dois sentidos. A lista oficial inclui Opus, mas isso não comprova os fmtp/128 kbps do Disgalm no caminho completo: aprovação depende de teste L/R recebido. Não usar adaptador WebSocket/PCM, gravação ou RealtimeKit para esta migração. [Codecs e limites](https://developers.cloudflare.com/realtime/sfu/platform/limits/).

**Controle/TURN/operação:** Worker permanece como gateway autenticado das operações SFU; DO conserva presença, convites e catálogo. Não passa mídia pelo Worker. Manter `/ice` para malha e usar configuração de conectividade apropriada ao SFU, validando UDP e relay/TLS. TURN continua útil em redes restritas; não exigir relay para todos. Não há servidor próprio, mas há responsabilidade por quotas, limpeza, reconexão e autorização. Sessões perdidas têm janela de reutilização de 30 s; tracks sem pacotes por 30 s são coletadas. Retomar publicações expiradas e reconstruir assinaturas, inclusive depois de mute prolongado. [Limites](https://developers.cloudflare.com/realtime/sfu/platform/limits/).

### LiveKit Cloud e LiveKit self-host

O SDK JS `livekit-client` assume publicação, assinatura, negociação e reconexão. Adaptar Room/participantes/eventos para a UI; publicar MediaStreamTracks já capturadas em vez de substituir a captura por uma chamada genérica de screen share. Usar nome/metadata por fonte e publication SID, com múltiplas telas identificadas individualmente; `source=screen_share` sozinho não diferencia todas. Servidor emite JWT de curta validade, limitado à sala/identidade/permissões. [SDK JS](https://docs.livekit.io/reference/client-sdk-js/), [tokens](https://docs.livekit.io/frontends/reference/tokens-grants/).

Simulcast, dynacast e VP9/AV1 SVC são suportados; a escolha depende do codec/dispositivo. Desabilitar assinatura automática de todas as telas e controlar qualidade/foco. Não multiplicar manualmente o bitrate por participantes. [Codecs e camadas](https://docs.livekit.io/transport/media/advanced/).

Para som do sistema, publicar a track existente com `forceStereo`, preset de áudio adequado e processamento de voz desligado na captura. Manter mic e áudio de tela separados. A API oferece `audioPreset`, `forceStereo`, `screenShareEncoding` e `screenShareSimulcastLayers`. Validar estéreo/bitrate recebido, não só o parâmetro de publicação. [Opções JS](https://docs.livekit.io/reference/client-sdk-js/interfaces/TrackPublishOptions.html).

**Cloud:** a sinalização de mídia é WS entre SDK e LiveKit; Worker emite autorização, continua convites/logs e, se necessário, presença do produto. Evitar duas autoridades divergentes para admissão. TURN é gerido pelo serviço; `/ice` atual fica apenas para malha. Não somar Cloudflare TURN à conexão LiveKit por padrão.

**Self-host:** mesmo SDK, servidor open source próprio; Worker continua autenticando/emissor de token, sinalização de mídia vai ao LiveKit. Há TURN embutido; configurar TLS/DNS, IP anunciado, firewall e monitoramento. Opção de UDP mux 7882 ou faixa UDP 50000–60000, ICE/TCP 7881, API/WS atrás de TLS, TURN UDP 3478 e TURN/TLS conforme topologia. Um único nó é suficiente como desenho inicial, sujeito a benchmark. Redis/distribuição e serviços de gravação/ingestão não são necessários para este escopo. [Self-host](https://docs.livekit.io/transport/self-hosting/), [portas](https://docs.livekit.io/transport/self-hosting/ports-firewall/).

No `sirius`, não presumir IP público, upload disponível ou uptime. Estar na tailnet dá acesso administrativo, não acesso WebRTC público aos amigos. Confirmar NAT/CGNAT, portas UDP, domínio/TLS, concorrência com o desktop/VM e plano de indisponibilidade. Proxy HTTPS para sinalização não resolve sozinho a mídia UDP. TURN Cloudflare pode complementar conectividade de um desenho self-host, mas não transforma por si só um servidor inacessível em SFU público.

### Mediasoup self-host

Biblioteca SFU e cliente, não aplicação de conferência pronta. Servidor Node mantém Router/WebRtcTransport/Producer/Consumer; cliente usa Device e transportes de envio/recepção. Precisaremos de serviço persistente no Linux e protocolo próprio para criar/conectar transportes, anunciar produtores, consumir, pausar e retomar. Worker/DO pode conservar controle e autorizar chamadas ao serviço; runtime Worker não hospeda os workers nativos do mediasoup. [Comunicação cliente/servidor](https://mediasoup.org/documentation/v3/communication-between-client-and-server/).

Há simulcast e SVC nos parâmetros RTP; encaminha sem transcodificar. `opusStereo` e opções de Opus permitem negociar estéreo quando a fonte já o é. Usar appData/IDs de produtor para mapear fontes; não reutilizar streamId remoto como contrato. [RTP e camadas](https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/), [opções do cliente](https://mediasoup.org/documentation/v3/mediasoup-client/api/), [escalabilidade](https://mediasoup.org/documentation/v3/scalability/).

Sem TURN completo embutido no produto: planejar coturn ou serviço Cloudflare com credenciais efêmeras. Operar serviço, porta pública/anunciada, TLS para controle, limites, reconexão, liberação de consumers e monitoramento de banda/CPU. Software ISC, sem cobrança por minuto/GB nem franquia de hospedagem; custo é infraestrutura e trabalho. [Licença oficial](https://github.com/versatica/mediasoup/blob/v3/LICENSE). É flexível, mas desenvolver a sala aqui custa mais que integrar LiveKit.

### Janus self-host

Usar **VideoRoom multistream**, protocolo Janus/JSEP e handles de publisher/subscriber. Não escolher AudioBridge, que mistura áudio e altera o modelo de fontes/volumes. VideoRoom permite agrupar múltiplas publicações/assinaturas numa PC; mapear feed/MID/metadata para pessoa e fonte. Tem simulcast e seleção SVC VP9/AV1; documenta estéreo nos streams. Ainda exigir teste L/R do SDP de publicação e recepção. [VideoRoom](https://janus.conf.meetecho.com/docs/videoroom.html).

Sinalização de mídia passa para Janus; Worker preserva autenticação de produto/convite e entrega acesso limitado, sem expor API administrativa. Usar WS/HTTP seguro e sessões autenticadas, não sala pública acessível só pelo número. No Linux, operar binário/plugins, dependências, range UDP/IP anunciado e coturn ou TURN Cloudflare. [Operação/NAT](https://janus.conf.meetecho.com/docs/deploy.html).

Software GPLv3, sem tarifa de uso; licença comercial e suporte por consulta. Não há cota gratuita de banda de um serviço self-host. [Licença](https://janus.conf.meetecho.com/docs/COPYING.html). Só priorizar se houver experiência prévia com Janus ou necessidade de seus plugins.

## 4. Custo comparável e limites do cálculo

Não há medição de frequência/tamanho do grupo neste pedido. **Hipótese de referência**, a confirmar: 8 pessoas, 12 encontros de 3 h/mês = 36 h, uma tela publicada durante todo o encontro, 7 assinantes, áudio do sistema 128 kbps, cada mic 64 kbps contínuos, sem câmeras. O mic de 64 kbps é hipótese financeira, não mudança do Opus atual (teto 128 kbps). Sem DTX, camadas adicionais, retransmissões, RTP/UDP/IP, TURN de malha ou outros projetos na conta. GB decimais; fornecedores podem medir bytes de outra forma.

`GB = 0,45 × horas × soma dos Mbps efetivamente entregues`. Para S telas: `S × (bitrate de vídeo + 0,128) × 7`; mic: `8 × 7 × 0,064`. Se duas telas pertencem ao mesmo publicador com um único áudio de sistema, contar esse áudio só uma vez. Participante-minutos = `8 × 36 × 60 = 17.280`.

| Cenário mensal de referência | Egress estimado | Cloudflare SFU/TURN | LiveKit Cloud Ship |
|---|---:|---:|---:|
| 1 tela Código 1,5 Mbps + áudios | 242,68 GB | US$ 0 | US$ 50,00 |
| 1 tela Equilíbrio 4 Mbps + áudios | 526,18 GB | US$ 0 | US$ 83,14 |
| 1 tela Jogo 12 Mbps + áudios | 1.433,38 GB | US$ 21,67 | US$ 192,01 |
| 1 tela Máximo 25 Mbps + áudios | 2.907,58 GB | US$ 95,38 | US$ 368,91 |

**Cloudflare:** 1.000 GB/mês gratuitos compartilhados entre SFU e TURN; excedente US$ 0,05/GB de egress; ingresso gratuito, sem tarifa de participante-minuto nesta tabela. Tráfego TURN↔SFU Cloudflare não é cobrado em dobro. Workers/DO têm cobrança separada. Fórmula usada: `max(0, GB − 1000) × 0,05`. [Preço oficial, consultado em 02/10/2026](https://developers.cloudflare.com/realtime/sfu/platform/pricing/).

**LiveKit Cloud:** Build US$ 0, 5.000 participante-minutos e 50 GB/mês, 100 conexões concorrentes; franquias são tetos, com novas requisições falhando ao ultrapassar. Ship a partir de US$ 50/mês inclui 150.000 minutos/250 GB; excedentes US$ 0,0005/min e US$ 0,12/GB. Scale começa em US$ 500, inclui 1,5 milhão de minutos/3 TB, excedentes US$ 0,0004/min e US$ 0,10/GB. Tabela usa Ship, sem agentes, gravação ou transcode. [Preço oficial](https://livekit.com/pricing) e [comportamento das quotas](https://docs.livekit.io/deploy/admin/quotas-and-limits/), consultados em 02/10/2026.

Build esgota 50 GB em aproximadamente **3,42 h** no cenário Equilíbrio; uma chamada de 3 h usa 43,85 GB e 1.440 participante-minutos. A cota de minutos permitiria 10,42 h com 8 pessoas, mas a banda acaba antes. Cloudflare permite aproximadamente **68,42 h** desse cenário na franquia, se não houver outro consumo. No 4K60, uma chamada de 3 h usa aproximadamente 242,30 GB. Não confundir uma hora de sala com uma hora de participante.

Sensibilidade: 8 câmeras a 0,8 Mbps para os outros 7 acrescentam **326,59 GB/mês**, levando Equilíbrio a 852,77 GB. Dois publicadores com tela/áudio Equilíbrio para sete cada, mais os mics, chegam a **994,29 GB**, antes de overhead: já não é prudente prometer gratuidade. Mics todos no teto atual de 128 kbps acrescentariam 58,06 GB ao cenário-base. Reservar inicialmente **25% de margem** como hipótese de planejamento, depois substituir por bytes faturados: base 657,72 GB; base com câmeras 1.065,96 GB (~US$ 3,30 Cloudflare). Reduzir assinaturas efetivas/camadas pode reduzir muito a conta, sem desligar a publicação.

**Self-host LiveKit/mediasoup/Janus:** não existe preço oficial por GB do software nem franquia de um serviço gerido. Nas condições acima o host envia 526,18 GB/mês no Equilíbrio, recebe mídia dos publicadores e precisa sustentar **32,48 Mbps de saída** antes de overhead (28,896 de tela/sistema + 3,584 de mics); com 8 câmeras, 77,28 Mbps. 4K60 exige 179,48 Mbps de saída. Em `sirius` há desembolso de servidor potencialmente zero se já disponível, mas não custo total zero. Energia incremental: `W / 1000 × horas ligado × tarifa local`; VPS: mensalidade + egress excedente + domínio/TURN. Não atribuir um preço ou capacidade ao host sem medição e decisão. Em dez assinantes adicionais, o servidor paga/envia dez cópias mesmo que o publicador continue enviando uma.

Hibernação permanece critério de aceite, conforme medição `PLANO-POC.md:151` e conclusão `PLANO-POC.md:166` (ordem de 1.600–2.400× em duração cobrada nas rodadas). Não interpretar isso como benchmark do SFU. Criar sessões por chamadas HTTPS pontuais e catálogo persistido não exige manter o DO residente. Estatísticas a cada 2 s devem ficar locais ou num DataChannel SFU com fan-out autorizado; eventos de controle no DO somente quando houver mudança. A compatibilidade do DataChannel negociado ID 0 atual não pode ser presumida.

## 5. Roteamento adaptativo: P2P primeiro, SFU quando ajudar

É viável sem modelo de IA no caminho: regras observáveis, estado por fonte e razões registradas são suficientes. O número de espectadores aumenta a demanda prevista, mas não comprova esgotamento. Três espectadores em 1080p5 podem funcionar bem; dois em 4K60 podem saturar o mesmo host. Só contar espectadores **efetivamente assinantes**, em vez de sempre enviar todas as telas a todos como hoje (`public/index.html:354`).

### Sinais e diagnóstico

Reaproveitar as amostras de `public/index.html:1307`, `public/index.html:1328` e `public/index.html:1350`. O diagnóstico atual já percebe que `maintain-resolution` pode produzir poucos quadros com `qualityLimitationReason=none` (`public/index.html:1383`). O roteador deve usar valores numéricos por fonte e destinatário, não interpretar a frase exibida pela UI.

O padrão WebRTC define `qualityLimitationReason`, tempo de codificação, frames, estatísticas remotas e estimativas do candidate pair; campos podem faltar. `availableOutgoingBitrate` é uma estimativa do caminho de uma conexão, não medição independente da capacidade total do uplink: não somar estimativas dos pares como se fossem links físicos separados. [W3C WebRTC Stats, consultado em 02/10/2026](https://www.w3.org/TR/webrtc-stats/).

| Situação observada | Decisão sugerida |
|---|---|
| Captura saudável, FPS/resolução enviados caem em vários pares, motivo bandwidth ou backlog de envio; upload agregado crescente | Candidata a promoção da fonte inteira: retirar cópias P2P pode aliviar o uplink. |
| Captura saudável, limitação de encoder por CPU em vários envios, tempo médio de encode cresce | Testar SFU inicialmente com **uma codificação**; simulcast pode manter ou piorar CPU. Não pressupor uma codificação extra gratuita durante a transição. |
| Só um destinatário ruim, demais bons | Não diagnosticar uplink global. Reduzir qualidade para ele; testar SFU apenas nesse caminho se houver evidência de rota P2P/relay ruim. Isso economiza poucas cópias e é etapa posterior do roteador. |
| FPS baixo já na captura, portal Wayland preso ou resolução física inferior ao preset | Recapturar/ajustar captura; SFU não corrige a origem. |
| FPS recebido cai por decode/framesDropped no espectador | Reduzir assinatura/camada nele. Encaminhar a mesma resolução via SFU não resolve o decoder. |
| Orçamento configurado corta bitrate por pessoa, sem sinal de limitação reportada | O próprio teto pode causar degradação: considerar demanda/qualidade entregue, não depender apenas de qualityLimitationReason. |

Não há CPU total portátil/confiável exposta ao JavaScript web. `qualityLimitationReason=cpu` refere-se ao encoder; carga de OS no desktop pode complementar depois, por API local restrita, mas não é requisito inicial nem pressupõe mudar a captura nativa.

### Política inicial, para calibrar em ensaio

- Amostrar localmente a cada 2 s, com 10 s de estabilização depois de iniciar fonte/entrada/recaptura. Não transmitir todas as amostras pelo DO.
- Promover quando houver degradação sustentada por 10 s em pelo menos dois destinatários (ou no único destinatário existente, com evidência local), e causa provável de fan-out. Sementes de calibração: FPS enviado abaixo de 70% do FPS efetivamente capturado em fonte com movimento; redução de resolução frente à captura; perda acima de 5% com crescimento de RTT frente ao baseline, combinada com indicadores de envio. **Não usar esses limiares isoladamente**: tela estática, conteúdo, codec e rede mudam a relação entre FPS/bitrate e qualidade.
- Antecipar promoção antes de adicionar outro envio se a demanda calculada ultrapassar orçamento de upload explicitamente definido pelo usuário, já reservando câmera/áudio. Não interpretar três espectadores como limite universal nem aguardar falha completa da mídia.
- Começar promovendo a tela para **todos** os seus espectadores, migrando seu áudio de sistema junto. Mistura P2P/SFU por destinatário fica para depois, pois preserva mais encoders e duplica estados. Outras fontes/pessoas permanecem onde estavam.
- Permanecer no SFU até parar essa fonte na primeira versão. Na evolução, considerar retorno apenas após queda do fan-out e pelo menos 60 s de saúde, com cooldown mínimo de 120 s. Saúde no SFU não prova que o antigo uplink suporta malha: retorno exige demanda conservadora/orçamento ou sondagem limitada. Disponibilizar controles Auto/P2P/SFU para diagnóstico, sem permitir ultrapassar o orçamento/admissão do backend.

### Transição e falha

Estados por fonte: `p2p → preparando-sfu → sfu` ou `preparando-sfu → p2p` por falha. ID lógico não muda; geração de rota muda. Publicar uma vez, preparar assinaturas, aguardar track/keyframe efetivamente recebido, obter ACK de cada espectador e comutar o elemento. Áudio tem só **uma rota audível** em cada instante; a outra fica muda/preparada. Após ACK remover o sender P2P de vídeo/áudio daquela fonte, preservando mic, outras fontes e PC/DataChannel. Não fechar a PC inteira só porque uma tela migrou.

A sobreposição temporária acrescenta upload/encoder justamente quando o emissor está saturado. Ensaiar uma publicação provisória de bitrate menor, migrar destinatários em sequência e liberar cópias antigas rapidamente; timeout inicial de 10 s e nenhum make-before-break ilimitado. Se o host não sustentar nem essa preparação, oferecer transição com breve pausa e explicação, em vez de prometer troca imperceptível. Ao falhar, fechar recursos SFU parciais e preservar P2P restante; quando P2P também não é viável, reduzir qualidade/número de envios. Não tentar repetidamente a mesma promoção: backoff de pelo menos 120 s e razão visível.

DO guarda catálogo, rota e geração, recebe apenas mudanças/ACKs e preserva hibernação. O dono da fonte propõe promoção; o backend autentica e autoriza orçamento/recursos. Snapshot no reconnect informa rota corrente, evitando novo assinante criar envio P2P para fonte já migrada. Revogação e limpeza também cobrem ambas as rotas.

**Economia:** a tabela anterior é referência de SFU integral, não custo obrigatório do híbrido. Se a única tela Equilíbrio e seu áudio passarem 25% das 36 h no SFU para sete espectadores, seu egress SFU será aproximadamente **117,03 GB** (25% de 468,12); mic direto fica fora da conta SFU. Somar TURN dos pares, câmeras promovidas, transições e demais projetos. Em 4K60, a mesma fração equivale a 712,38 GB de tela/sistema. Economia segue bytes/assinaturas, não apenas porcentagem de tempo: as promoções provavelmente coincidem com períodos mais caros. P2P direto pode custar zero em mídia do provedor; P2P por TURN já consome a franquia compartilhada.

## 6. Migração incremental proposta e critérios de aceite

Todas as alterações abaixo são **plano futuro**, sujeito a autorização de implementação/conta/deploy. Nesta investigação só se escreve este documento.

### Fase 0 — separar captura, pessoa e transporte, mantendo malha

Em `public/index.html`, extrair criação/negociação/remoção de pares para `public/transporte-mesh.js`; criar contrato em `public/transporte.js` para entrar/sair, publicar/substituir/parar fonte, assinar e obter stats. Manter UI de pessoas separada do mapa de PCs. IDs lógicos de fontes com tipo (`mic`, `camera`, `tela-video`, `tela-audio`), dono e geração; associação de vídeo/áudio da mesma tela. Captura/filtros permanecem em `public/ruido.js` e desktop. Presets tornam-se configuração de captura e orçamento de transporte. Não adicionar SFU nesta fase.

Validar regressão com `tests/reconexao.test.js`, `tests/video-stats.test.js`, `tests/telemetria.test.js`, `tests/signaling-ui.test.js`, `tests/sala-worker.test.js` e `tests/worker-auth.test.js`; usar roteiros `tests/reconexao.md`/`tests/video-stats.md`. Reproduzir tela+câmera+voz+som, várias telas, recaptura, parar fonte, entrar tarde, dois celulares e colisão de oferta. Aceite: mesma malha, mesmos volumes e preservação da mídia com WS fora; nenhum aumento de limite.

### Fase 1 — prova SFU isolada, ainda até quatro pessoas

Adicionar `public/transporte-cloudflare.js` com PC/sessão, fila de negociação, publicação e assinatura de camada única. Adicionar gateway restrito `worker/src/sfu.js`, roteado por `worker/src/index.js`, para criar/alterar/fechar recursos; secrets configurados apenas numa etapa futura autorizada. Novo protocolo anuncia capacidade/versão e modo `mesh` ou `sfu` em welcome. Reutilizar membro/convidado e validar pertença atual à sala, dono da sessão, alvo da assinatura, limites e expiração em **cada** operação. Não aceitar IDs arbitrários da conta nem transformar o Worker num proxy livre da API.

Persistir catálogo de fontes/publicações e versão da sala no DO (SQLite/storage ou attachments para campos adequados). Toda operação sobre uma sessão precisa de coordenação que sobreviva a concorrência HTTP/WS; fila de Promise só no cliente é insuficiente para clientes duplicados/maliciosos. Usar geração para descartar respostas antigas e reconciliar recursos após resultado parcial. Revalidar após hibernação. Conservar resposta automática de ping; não introduzir timers periódicos no DO.

Validar em ambiente de ensaio autorizado: 2→4 clientes, publicação/assinatura, criação simultânea de câmera/tela, entrada tardia e 20 ciclos de publicar/parar/substituir. Medir crescimento de SDP/transceivers/recursos e ausência de quadros fantasmas. Teste estéreo usa tons distintos L/R recebidos e compara separação e sincronismo, com mic simultâneo. Testar Windows WASAPI e Linux PipeWire, exclusions, relay forçado e UDP bloqueado; fechar track/sala limpa recursos. Aceite: uma publicação por fonte, sem multiplicação por pessoas, áudio separado e reconciliação correta. Se falhar em estéreo/compatibilidade, comparar o mesmo ensaio com LiveKit antes de seguir.

### Fase 2 — qualidade por assinatura e diagnóstico

No adaptador SFU, adicionar simulcast somente depois de medir custo/CPU; em `public/index.html`, ligar palco/tiles à seleção de fonte/camada. Começar tela de código com alta resolução/baixo fps, câmera com camadas pequenas; assinar alta só no palco e interromper vídeo não assistido, mantendo áudio escolhido. Não reduzir automaticamente texto a camada ilegível. Orçamento de upload soma fontes e camadas, não participantes. Atualizar `custoUpload`, relatório e UI de diagnóstico; distinguir conexão com SFU de entrega ao assinante.

Publicador relata stats locais por fonte; assinante mede bytes, resolução, FPS, perdas e freezes por assinatura. Correlacionar IDs/geração/camada e horário; identificar relay/UDP/TCP do trecho local. Adaptar `tests/video-stats.test.js`, `tests/telemetria.test.js` e `/telemetria` sem quebrar sanitização. DataChannel SFU exige protocolo novo; usar referências oficiais, não assumir canal ID 0 ponto a ponto. Validar foco trocado, rede lenta num único assinante e publicação boa nos demais. Aceite: assinante lento não degrada obrigatoriamente todos e diagnósticos identificam o trecho correto.

### Fase 3 — reconexão longa, desktop e orçamento

Implementar em adaptador/DO snapshot do catálogo no retorno do WS, geração de sessão SFU e republicação/reassinatura quando expirar. Queda só de controle conserva mídia; queda de SFU não usa `criarPar` por amigo. Testar falha <30 s, >30 s, mute longo, troca Wi-Fi, F5, abas duplicadas, convite expirado/revogado e saída abrupta. Remover acesso efetivo ao SFU ao expirar autorização: apenas TTL do login no Worker não encerra uma publicação já conectada. Prever fechamento/reconciliação com alarme e política de expiração, sem residente permanente.

Em `desktop/empacotar.mjs`/`desktop/package.json`, verificar inclusão dos novos assets e versionamento de pacote; em `desktop/main.js`/`desktop/preload.js`, só ajustar se contratos de assets/estado exigirem. Não reescrever `desktop/captura.js`, `desktop/native/loopback.cpp`, `desktop/pipewire.js` ou worklet para trocar transporte. Adaptar `desktop/teste/e2e/rodar.mjs` e `desktop/teste/e2e/sala.js`, que hoje conhecem `pares`/PC diretamente. Conferir app empacotado antigo e novo, bandeja, minimize/background e fechar janela sem sair.

Adicionar ensaio de 3 h e retomada do DO; medir requests/duração cobrada e comparar com sinalização ociosa atual. Confrontar bytes locais com SFU/TURN faturados, margem e uso de outras salas. Alertar em 70%/90% de orçamento; alertas não são teto de gasto. Antes de publicar o modo SFU, definir política aplicada pelo backend para recusar novas publicações ou reduzir assinaturas ao atingir orçamento, com explicação visível. Aceite: reconexão não duplica áudio/assinaturas e hibernação não perde catálogo nem mantém timers.

### Fase 4 — roteador adaptativo com até quatro pessoas

Adicionar `public/roteador-midia.js` sobre os dois adaptadores, estatísticas por fonte e estados/gerações descritos acima. `public/index.html` passa a renderizar fonte lógica sem depender da rota; exibe Auto/P2P/SFU e motivo da troca. Em `worker/src/index.js` e `worker/src/sfu.js`, persistir e validar proposta/commit/ACK de rota com timeout e snapshot. Só após o ensaio de SFU forçado das fases anteriores ativar P2P por padrão e promoção automática.

Ensaios adicionais: limitar uplink do publicador e adicionar espectadores; sobrecarregar encoder; restringir somente download de um receptor; tela estática; captura presa em fps baixo; quota SFU atingida; falha de API no meio da troca; saída/recaptura simultânea à promoção; WS fora durante ACK. Aceite: promoção por causa correta, remoção das cópias P2P, nenhum áudio duplicado, transição limitada, CPU/upload menores após promover e ausência de alternância repetida. Medir tempo de recuperação e pausa percebida; calibrar limiares com dados. Criar testes de política/estado e testes de mídia reais, não só fixtures que reproduzem as regras.

### Fase 5 — salas adaptativas de oito pessoas

Somente após fases anteriores, propor alteração de admissão por capacidade em `worker/src/index.js` e testes `tests/sala-worker.test.js`, com adaptadores/roteador suportados por todos os clientes. Oito participantes podem começar com mídia direta; antes de admiti-los, o caminho SFU de recuperação precisa estar disponível e autorizado. Definir comportamento quando quota/provedor falhar, sem garantir oito se apenas mesh/4 foi validada. Atualizar mensagem de sala cheia `public/index.html:1752`, convite `public/index.html:2307`, documentação `README.md`/`PLANO-POC.md` e versão desktop. Atualizar `worker/wrangler.toml` somente se bindings/configuração persistente exigirem; secrets não entram nele. Para `server.js`, manter explicitamente mesh ou implementar gateway local de ensaio separado; não prometer equivalência SFU no servidor local que hoje só repassa sinal.

Validar 8 participantes em redes distintas, pelo menos um celular/dispositivo fraco, tela 1080p30, áudio estéreo e câmeras; ensaio separado de 1440p60 e 4K60 com captura capaz. Registrar p95 de tempo até mídia, RTT, freezes, FPS efetivo, CPU, upload total, consumo mensal projetado e diferença para cenário mesh de 4. Meta inicial proposta: mídia em até 5 s no p95 em rede estável, zero áudio duplicado, retomada sem intervenção nos casos previstos, FPS/resolução próximos da captura disponível e sem aumento de upload com espectadores (camada única). Fixar tolerâncias de perda/freezes com baseline real; não inventar SLA de qualidade por falta de dados.

Rollback: desativar automação e novas salas adaptativas por configuração; novas salas voltam a mesh/4, mantendo protocolo compatível. Não converter automaticamente fontes SFU de uma sala de oito para fan-out P2P sem verificar capacidade; reduzir qualidade/assinaturas ou oferecer reentrada limitada quando necessário. Não dobrar publicação por longos períodos para esconder falha. Política de sala é negociada na entrada; rotas de fontes podem mudar pelo protocolo coordenado. Sem deploy nem alteração de `MAX` nesta entrega.

## 7. Riscos e decisões pendentes de Marcus

| Decisão/pergunta | Por que muda o plano |
|---|---|
| Quantos amigos, horas/mês e salas simultâneas? | O cenário de 8/36 h é hipótese. Cota é mensal da conta, não por sala; telas 4K60 mudam radicalmente a conta. |
| Uma tela principal ou várias assistidas ao mesmo tempo? Câmeras sempre abertas? | Publicação única não limita egress. Assinar somente o que se vê é a principal economia e evita vários decoders caros. |
| Qual teto mensal aceito, inclusive em USD? Pode bloquear qualidade/publicação perto dele? | Cloudflare excedente barato ainda pode crescer; 4K60 de referência custa ~US$ 95/mês antes de overhead. Precisa de regra de produto e reserva para TURN existente. |
| Gratuidade estrita ou aceitar custo pequeno em troca de nenhuma operação? | Gratuidade estrita exige controlar horas/assinaturas/qualidade. LiveKit Cloud gratuito não atende uso regular da hipótese; self-host transfere custo para banda/energia/tempo. |
| Manter 4K60/1080p120 como opções ocasionais ou exigir como padrão? | SFU não melhora capacidade de captura/encoder/decoder. Simulcast aumenta upload/CPU; VP9/AV1 SVC exige matriz real de dispositivos. |
| Quais navegadores/OS são obrigatórios? Estéreo 128 kbps é critério eliminatório? | No Mac atual não há o caminho nativo de sistema mostrado no Windows/Linux; trocar SFU não adiciona captura. Estéreo e múltiplas fontes são gates do ensaio. |
| Aceita mídia terminando no provedor SFU ou exige E2EE? | DTLS/SRTP protege cada trecho, sem equivaler a E2EE entre amigos. E2EE adiciona gestão de chaves/compatibilidade; precisa de investigação própria antes da decisão de arquitetura. |
| Se optar por self-host, aceita depender de `sirius` ligado? Há IP público/portas/upload sobrando? | A tailnet não prova conectividade pública ou 179 Mbps disponíveis. Disponibilidade residencial e disputa com VM/desktop são riscos não medidos. |
| P2P por padrão foi indicado; aceita manter fonte promovida no SFU até ela parar na primeira versão? | Evita retorno instável; retorno automático depois pode ser uma evolução com cooldown e cálculo de demanda. |
| Aceita breve pausa se o emissor saturado não sustentar duas rotas durante a promoção? | Make-before-break exige banda/encoder extra. A preferência por continuidade muda estratégia e limiares. |

Riscos técnicos adicionais: autorização de assinatura cruzando salas; leaks de publicações órfãs; catálogo perdido na hibernação; resultado parcial de API; incompatibilidade entre pacote desktop e backend; mute causando expiração de publicação; diagnósticos confundindo RTT ao SFU com RTT ponta a ponta; custos por espectadores ocultos. Os critérios das fases cobrem esses riscos, mas não estão validados por esta leitura documental.

**Decisão proposta:** ensaiar Cloudflare com quatro clientes e gates de estéreo, múltiplas fontes, recuperação e hibernação; depois implementar/ensaiar promoção por fonte, com P2P como padrão. Só após comprovar que o roteamento recupera degradação e reduz upload/CPU, preparar salas adaptativas de oito. Se os gates falharem ou a camada de controle se mostrar cara de manter, comparar LiveKit self-host depois de medir conectividade/capacidade de `sirius`, em vez de começar um servidor mediasoup/Janus do zero.
