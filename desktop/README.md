# Disgalm desktop (PoC, Windows)

Casca Electron do Disgalm. Compartilha a tela com o áudio do sistema **sem o
Discord**, para que quem assiste não ouça a própria voz de volta. O navegador
não consegue fazer isso: o `getDisplayMedia` leva o sistema inteiro.

- A UI é a mesma da web (`../public`). A janela abre `https://disgalm.galm.ai`,
  com login, `/ice` e `/ws` de produção, mas os arquivos estáticos saem deste
  checkout. Assim o app usa a UI do branch sem publicar nada.
  `DISGALM_UI_LOCAL=0` usa a UI publicada.
- `native/loopback.cpp` é um módulo N-API que captura por **WASAPI process
  loopback** (`ActivateAudioInterfaceAsync` com
  `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`) e entrega float32
  estéreo a 48 kHz em pacotes de ~10 ms.
- A captura roda num processo utilitário só dela (`captura.js`), com a thread
  WASAPI em MMCSS "Pro Audio". O PCM vai de lá, por `MessagePort`, direto a um
  AudioWorklet (`renderer/pcm-worklet.js`). Uma
  `MediaStreamAudioDestinationNode` o transforma em `MediaStreamTrack`, e é
  essa track que entra no compartilhamento, no lugar do áudio do
  `getDisplayMedia`.
- A fila do worklet parte de 80 ms. A leitura ajusta o passo em até ±0,3%
  (interpolação linear) para compensar a deriva entre o relógio do WASAPI e o
  do AudioContext. Se a fila secar mesmo assim, o alvo sobe 20 ms, até 160.
- Na UI, em Ajustes, a opção **"Compartilhar áudio do sistema (sem o
  Discord)"** só aparece no app e vem ligada. Se a captura nativa falhar, o
  app volta ao áudio do sistema inteiro e registra o motivo no log. Na web,
  nada muda.

## Compilar e rodar (Windows 11)

Pré-requisitos: Node 22+, Python 3 e Visual Studio 2022 Build Tools com
"Desenvolvimento para desktop com C++".

```powershell
cd desktop
npm install
node node_modules\electron\install.js   # se o npm pulou o download do Electron
npm run build:native
npm start                                # ou: npx electron . "<link de convite>"
```

Na primeira vez, o Firewall do Windows pergunta sobre o Electron. Permitir
libera conexões WebRTC de entrada; sem isso, ainda funciona por saída e TURN.

## Bandeja

Fechar a janela não fecha o app: ele segue na sala, com um ícone na bandeja
(barra de menus no Mac). O ícone ganha uma bolinha vermelha quando o microfone
está aberto e um selo verde quando há tela compartilhada. O menu tem
"Compartilhar a última…", "Parar de compartilhar", "Silenciar/Ativar
microfone", "Abrir Disgalm" e "Sair". A última fonte escolhida no seletor fica
em `ultima-tela.json`, na pasta de dados do app. Telas são achadas pelo id,
janelas pelo título. Se ela não existir mais, o seletor abre. No Linux com
Wayland quem escolhe é o portal do KDE, então o menu abre o seletor dele.

## Releases e atualização automática

O CI (`.github/workflows/desktop-release.yml`) empacota com electron-builder
(`electron-builder.config.cjs`) e publica releases em
[galm-dev/disgalm.galm.ai](https://github.com/galm-dev/disgalm.galm.ai/releases).
O modelo é o do t3code (`docs/estudo-t3code-distribuicao.md`).

| Canal | Quando sai | Versão | Feed |
|---|---|---|---|
| Nightly | Agenda de hora em hora, mas só com commit novo no `master` e 6 h desde o último. Também sai por dispatch manual. | `0.5.0-nightly.AAAAMMDD.N` (prerelease) | `nightly*.yml` |
| Stable | Dispatch manual com `canal=stable`, que reconstrói o commit do último nightly, ou tag `v<versão>` empurrada | `0.5.0` | `latest*.yml` |

- **Para lançar uma stable:** suba `version` em `desktop/package.json`, espere um
  nightly com esse código e rode o workflow com `canal=stable`.
- **Pacotes:** Mac em DMG e ZIP, só Apple Silicon (o ZIP é o que atualiza),
  Windows em NSIS x64 e Linux em AppImage x64, mais o `SHA256SUMS`.
- **Assinatura:** no Mac é obrigatória (secrets `CSC_LINK` em base64 do `.p12` e
  `CSC_KEY_PASSWORD`). Sem ela o job falha: a permissão de Gravação de Tela e o
  update do Squirrel.Mac dependem da mesma assinatura entre versões. O Windows
  ainda sai sem assinatura, e o SmartScreen avisa.
- **Atualização** (`atualizacao.js`, electron-updater): procura 15 s depois de
  abrir e a cada 30 min, baixa em segundo plano e instala ao sair, ou na hora
  por "Reiniciar e atualizar" na bandeja. Nunca reinicia sozinho no meio da
  chamada. O canal (Stable ou Nightly) é escolhido na bandeja e vem por padrão
  da versão instalada. Na troca de canal, só a primeira checagem pode descer de
  versão. No Linux, só o AppImage se atualiza.
- **Rollback em crash loop** (`saude.js`): uma versão é saudável depois de
  60 s com a janela carregada e sem queda do renderer. Uma versão nova que
  abre mais de 3 vezes sem ficar saudável faz o app baixar e instalar a última
  versão saudável, a partir da release dela, e fica bloqueada para o update.
  Sair pelo menu antes dos 60 s não conta como falha. Não cobre crash do
  próprio Electron antes de o `main.js` rodar.
- **Interface:** instalado, o app carrega a UI publicada em disgalm.galm.ai;
  só em desenvolvimento usa `../public`. `DISGALM_UI_LOCAL=1` ou `0` força.

## Pacote para testar (Windows, Mac, Linux)

Sem ferramenta de distribuição: `node empacotar.mjs`, rodado em cada
sistema depois do `npm install`, copia o Electron pronto, põe o app em
`resources/app` e a UI em `resources/public`. O resultado sai em
`dist/Disgalm-<sistema>-<arch>` (pasta e `.zip`/`.tar.gz`). Não há instalador
nem assinatura; no Mac o bundle é reassinado ad hoc.

- **Windows:** rode antes `npm run build:native`. Abra com `Disgalm.exe`. É o
  único com áudio do sistema sem o Discord.
- **Mac:** para usar no próprio Mac, rode `./instalar-mac.sh`. Ele empacota,
  assina com uma identidade estável (a "Apple Development" do Keychain ou um
  certificado local criado na primeira vez), instala em
  `~/Applications/Disgalm.app` e abre. A permissão de Gravação de Tela fica
  presa à assinatura: com a assinatura ad hoc do `empacotar.mjs`, cada pacote
  novo deixa a chave "ligada" valendo para um app que não existe mais. O
  script só apaga a permissão (`tccutil reset`) quando a assinatura muda.
  O Electron não tem áudio do sistema no Mac, então a tela vai sem som.
  Abrir o app pelo terminal de outro app (T3 Code, por exemplo) faz o macOS
  pedir a permissão em nome desse app; o script abre com `open`.
- **Linux:** `./disgalm`. O áudio do sistema vem do monitor do PipeWire,
  como na web (`loopback.sh` e escolha em Ajustes).
- Para abrir um convite ou uma sala, passe o link como argumento:
  `Disgalm.exe "<link>"`, `open -a Disgalm.app --args "<link>"` ou
  `./disgalm "<link>"`.
- A UI vai congelada no pacote (é a do branch no momento do empacotamento).

## Prova

`teste\cenario.ps1` toca dois tons ao mesmo tempo: 440 Hz num **filho** de um
`Discord.exe` substituto (cópia do `powershell.exe`) e 1000 Hz num processo
comum. Depois abre o app em modo de teste, que passa tela e áudio nativo por
um par `RTCPeerConnection` local e grava a track antes (`local.wav`) e depois
do WebRTC (`recebida.wav`). Rode o script na sessão de desktop.

```powershell
.\teste\cenario.ps1 -Nome exclui                      # exclui o substituto
.\teste\cenario.ps1 -Nome controle -Excluir nada.exe  # não exclui nada
.\teste\cenario.ps1 -Nome depois -Depois              # substituto abre no meio
python teste\analisar.py teste\saida\exclui\recebida.wav
```

### Ponta a ponta numa sala

`teste\e2e\rodar.mjs` sobe uma sala local com `wrangler dev`. A sinalização
é a `Sala` de produção (`worker/src`) e a UI é a de `public/`; só o login
GALM vira um membro fixo (`teste/e2e/sala.js`, que nunca deve ser
publicado). O app Electron entra e compartilha a tela. Um Edge, pelo CDP,
entra como segundo membro e grava o áudio da tela que recebe. Primeiro no
modo sem o Discord, depois no do sistema inteiro (o mesmo da web). Com
`--soak=N`, deixa o compartilhamento nativo ligado N minutos e conta
engasgos e CPU.

```powershell
cd ..\worker; npm install; cd ..\desktop
node teste\e2e\rodar.mjs --soak=10
python teste\analisar.py teste\saida\e2e\nativo.wav teste\saida\e2e\controle.wav
```

Com `DISGALM_TESTE_INCLUIR=1`, o teste grava também `incluido.wav`, que tem
só a árvore excluída. Serve para provar que o Discord de verdade estava
tocando quando o som dele não é um tom.

Resultado na VM `sirius-b` (Windows 11 26200), track depois do WebRTC, nível
do que sobra tirando os tons:

| Cenário | 440 Hz | 1000 Hz | Resto |
|---|---|---|---|
| Substituto excluído | −89 a −104 dBFS | −12,3 | ~−45 (ruído do Opus) |
| Controle, sem excluir | −12,2 | −12,2 | — |
| Discord real tocando vídeo, excluído | — | −12,3 | −54 |
| Discord real tocando vídeo, sem excluir | — | −12,4 | −19 |

Só o Discord, gravado à parte (`incluido.wav`), estava em −17,8 dBFS.

Na sala local (`rodar.mjs`), com o Discord real tocando vídeo, o que o Edge
recebeu:

| Modo de quem compartilha | 1000 Hz | Resto (Discord) |
|---|---|---|
| Sem o Discord (nativo) | −12,3 dBFS | −45 (ruído do Opus) |
| Sistema inteiro (`getDisplayMedia`, igual à web) | −31 | −21 |

O caminho do sistema inteiro do Chromium entregou o tom 18 dB mais baixo que
o nativo. Não investiguei o motivo.

No soak de 10 min sem o Discord: nenhum pacote perdido. A fila do worklet
secou 2 vezes nos primeiros 90 s e assentou em 120 ms; depois, nenhuma vez
em 8,5 min. O processo principal do Electron ficou em 6,8% de CPU na VM.

## Como o Discord é achado

A exclusão vale para a árvore de **um** PID. O Discord roda em vários
processos: o principal, mais GPU, renderer, rede, crashpad e o
`AudioService`, todos filhos do `Discord.exe` principal. O pai dele é o
`Update.exe`, que já saiu. Por isso o alvo é a **raiz**: o `Discord.exe` cujo
pai não é `Discord.exe`. Se o PID do pai foi reusado por um processo mais
novo que o filho, ele não conta como pai. Com mais de uma raiz, fica a que
tem mais descendentes (`alvo.js`, testado em `tests/desktop-alvo.test.js`).
O app confere a cada 2 s e reabre a captura quando a
raiz muda (Discord abriu, fechou ou reiniciou para se atualizar). Sem Discord
aberto, exclui o próprio Disgalm, para o áudio que o app toca não voltar
para quem assiste.

## Limitações conhecidas

- **Windows 10 build 20348+** (na prática, Windows 11). Testado no 26200. Em
  build anterior, a ativação falha e o app usa o áudio do sistema inteiro.
- O WASAPI exclui só **uma** árvore por captura, e excluir só o Discord fazia
  o som que o próprio Disgalm toca (a voz de quem assiste) voltar na tela. Por
  isso a captura é ao contrário: uma INCLUDE por programa que tem sessão de
  áudio na saída padrão, menos o Disgalm e o Discord (`planejarInclusoes` em
  `alvo.js`), somadas em `captura.js`. A lista é refeita a cada segundo: um
  programa que começa a tocar pode perder até ~1 s. Os sons do sistema (a
  sessão sem PID) ficam de fora. No teste com o app tocando 700 Hz nas
  caixas, a captura ficou em −85 dBFS de 700 Hz contra −12,3 de 1000 Hz.
- Discord, PTB e Canary (`Discord.exe`, `DiscordPTB.exe`,
  `DiscordCanary.exe`) são procurados juntos, mas abertos ao mesmo tempo só o
  de árvore maior sai (`DISGALM_EXCLUIR` troca a lista).
- Troca de alvo causa um corte curto, de dezenas de ms, enquanto a captura é
  reaberta. Desligar a saída (`Disable-PnpDevice` no endpoint) por 3 s no
  meio da captura não cortou nada na VM, então o caminho de erro e reabertura
  em 1 s nunca rodou de verdade.
- Latência própria do caminho nativo: buffer WASAPI de 20 ms, pacotes de
  ~10 ms e fila de 80 a 160 ms no worklet. O jitter buffer do WebRTC, medido
  no teste, ficou em ~31 ms. Na VM, a fila ainda seca 2 ou 3 vezes nos
  primeiros minutos (cortes de ~10 ms) até o alvo assentar. Medi pacotes com
  até 64 ms de atraso, e o mesmo padrão aparece com a captura no processo
  principal ou no utilitário. Por isso, a suspeita é o áudio virtual da VM.
  Em hardware de verdade, não medi.
- Se o processo de captura cair, a track fica muda e a página registra o erro.
  Ele não volta sozinho para aquela track: é preciso compartilhar de novo.
- O par `RTCPeerConnection` do teste usa o Opus padrão (mono). A sala de
  verdade força estéreo a 128 kbps (`opusEstereo` em `public/transporte-mesh.js`), e a track
  nativa é estéreo.
- A UI local depende de interceptar `https://disgalm.galm.ai` no Electron.
  Como o handler recebe pedidos sem `Origin`, o app o repõe nos POST para a
  própria origem. Quando a UI estiver publicada, `DISGALM_UI_LOCAL=0` dispensa
  isso.

## Fora do escopo (anotações)

- **macOS:** ScreenCaptureKit (13+) captura áudio por app, com
  `SCContentFilter` excluindo apps (`excludingApplications`), e permite
  excluir o próprio processo (`excludesCurrentProcessAudio`). Ao contrário do
  WASAPI, aceita **vários** apps excluídos. A partir do 14.2 há também os
  Core Audio process taps (`CATapDescription` com lista de exclusão).
- **Linux:** PipeWire permite montar um sink de captura ligado só aos nós de
  saída que não são do Discord (filtrar por `application.process.binary`).
  Na prática, é uma versão por app do `loopback.sh`.
- Instalador, assinatura, auto-update, login GALM próprio e supressão de
  ruído não foram tocados.
