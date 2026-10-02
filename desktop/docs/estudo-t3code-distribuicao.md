# Distribuição desktop do T3 Code: estudo para o Disgalm

Investigação somente leitura em 02/10/2026. Clone novo com `git clone --depth 200 https://github.com/pingdotgg/t3code /tmp/t3code-estudo`. Commit estudado: **`e0db2a5e58bcbe7d738bca7667d2440ddb83e30f`**. A cópia pessoal do Marcus não foi acessada. Nenhum build, instalação do app ou commit foi feito.

As citações `caminho:linha` abaixo referem-se a esse SHA, salvo quando identificadas como Disgalm ou dependência externa. Para abrir qualquer citação: `https://github.com/pingdotgg/t3code/blob/e0db2a5e58bcbe7d738bca7667d2440ddb83e30f/<caminho>#L<linha>`. Código define o comportamento configurado; não comprova sozinho a assinatura de um binário publicado nem o funcionamento de updates numa máquina real.

Também foram consultados `gh release list/view -R pingdotgg/t3code`, os assets de metadados da stable e `gh run list --workflow release.yml`. Exemplos públicos:

- [Stable v0.0.45](https://github.com/pingdotgg/t3code/releases/tag/v0.0.45), publicada em 02/10/2026 às **15:17:31 de Brasília**, sem flag prerelease.
- [Nightly v0.0.45-nightly.20261002.2595](https://github.com/pingdotgg/t3code/releases/tag/v0.0.45-nightly.20261002.2595), publicada em 02/10/2026 às **14:59:35 de Brasília**, com flag prerelease.
- Ambas apontam para `6c8fed35dded9ff71c5b46807125457acbb76be6`; não confundir esse commit lançado com o HEAD clonado, que já contém mudanças posteriores.

## 1. CI/CD

### Como faz

CI comum roda em PRs e pushes em `main` (`.github/workflows/ci.yml:3`). Lint, typecheck, build desktop e testes têm jobs separados; lint/typecheck/build usam Ubuntu Blacksmith (`ci.yml:20`, `:58`, `:84`). Instala Vite+/dependências com cache e verifica o runtime Electron. O build chama `vp run build:desktop` e verifica o preload (`ci.yml:126`). Essa CI não é uma matriz de instaladores dos três sistemas.

O workflow de distribuição é `release.yml`; cada alvo chama o workflow reutilizável `release-desktop.yml`, recebido por `workflow_call` (`release-desktop.yml:9`). Os seis jobs, em vez de uma única `strategy.matrix`, são:

| SO / arquitetura | Runner configurado | Alvo inicial |
| --- | --- | --- |
| macOS arm64 | `blacksmith-12vcpu-macos-26` | dmg |
| macOS x64 | `blacksmith-12vcpu-macos-26` | dmg |
| Linux x64 | `blacksmith-32vcpu-ubuntu-2404` | AppImage |
| Linux arm64 | `blacksmith-16vcpu-ubuntu-2404-arm` | AppImage |
| Windows x64 | `blacksmith-32vcpu-windows-2025` | nsis |
| Windows arm64 | `windows-11-arm` | nsis |

Evidência: `.github/workflows/release.yml:543–690`. O mesmo nome de runner macOS é usado nas duas arquiteturas; o YAML, isoladamente, não demonstra a arquitetura física desse runner. O CLI macOS x64 não é publicado: o comentário em `release.yml:587` registra a limitação/segfault do Node SEA; isso não exclui o desktop x64.

O JS comum é construído uma vez, entregue como `js-bundle` contendo `apps/server/dist` e `apps/desktop/dist-electron`, com retenção de um dia (`release.yml:446`, `:519–534`). Cada plataforma baixa esse bundle, ajusta versões e empacota (`release-desktop.yml:199–209`, `:373`). O script usa electron-builder **26.15.6**, com `--publish never`; upload é responsabilidade do workflow, não do builder (`apps/desktop/package.json:39`; `scripts/build-desktop-artifact.ts:3806–3817`).

Há checks/typecheck, testes comuns e três shards de testes do servidor no workflow de release (`release.yml:235–338`). A publicação no GitHub exige sucesso dos seis builds e da publicação CLI (`release.yml:756–769`). Os testes entram na dependência da publicação CLI (`release.yml:694`), portanto a release não é liberada só porque os instaladores compilaram.

Caches e nativos:

- Vite+ usa cache em macOS/Linux; o lane de release Windows deliberadamente não usa cache de pacotes, com medições de custo/tempo documentadas no próprio YAML (`release-desktop.yml:132–157`). Não generalizar isso para toda CI Windows: `windows-tests.yml:40–58` usa outro cache.
- Monitor de recursos Rust e helpers de captura Linux têm cache por target e hashes de Cargo/fontes (`release-desktop.yml:159–181`). Os builds usam `cargo build` por target (`build-desktop-artifact.ts:2148`, `:2208`). Linux também instala `libsecret-1-dev` e ferramentas de imagem; Windows instala bibliotecas MSVC Spectre quando o monitor não está em cache (`release-desktop.yml:211–239`).
- `node-pty` usa prebuilds no Windows (`release-desktop.yml:211`), prebuilds Darwin filtrados por arquitetura e build de fonte Linux (`build-desktop-artifact.ts:967–989`). No Windows `npmRebuild = false` (`:2783`): **não copiar essa opção para o módulo node-gyp do Disgalm sem compilação explícita anterior**.
- Assets são recolhidos e enviados como `desktop-<platform>-<arch>`; monitor e CLI têm artifacts próprios (`release-desktop.yml:557–627`). Windows também embute o CLI Linux para WSL e espera o artifact da arquitetura correspondente (`:312–371`). Essa dependência não se aplica ao Disgalm.

### O que não há / limites

Não há CI obrigatória geral de testes Windows equivalente à Linux: o lane `windows-tests.yml:1–12` é manual e seu comentário diz que a suíte ainda precisa ser integrada quando estiver verde. Há build Windows de release, o que não equivale a testes funcionais completos de update nos três SOs. Não executei os workflows nem confirmei toda a cadeia por logs.

## 2. Versões e canais

### Como faz

`release.yml:3–26` aceita tags `v*.*.*`, exclui tags nightly/preview, agenda a cada meia hora (`cron: "8,38 * * * *"`) e permite dispatch manual com `preview` (padrão), `stable` ou `nightly`.

O cron **não publica um nightly a cada meia hora**. `.github/scripts/check-nightly-release.cjs:1`, `:55–81` impõe seis horas desde a última publicação e exige que o commit candidato esteja adiante da última nightly. Dispatch manual nightly não passa por esse gate de cadência (`release.yml:88–99`), logo pode publicar antes das seis horas. Há serialização separada para stable e nightly/preview, sem cancelar publishers em andamento (`release.yml:28–37`).

Nightly parte da versão em `apps/desktop/package.json`, remove sufixo e incrementa o patch para representar a próxima stable (`scripts/resolve-nightly-release.ts:86–97`, `:129–156`). Forma: `<base>-nightly.<AAAAMMDD>.<github.run_number>`, tag `v<version>`, nome com SHA curto de 12 caracteres (`:111–125`). A data usada pelo workflow é derivada do início do run em UTC (`release.yml:147–159`); esse detalhe explica o campo de data da versão, não é uma hora local mostrada ao usuário.

Preview usa o mesmo esquema com `-preview.` e nome explícito de teste de mantenedor. É manual, permite branch não lançada e não recebe feed de atualização (`release.yml:164–185`; `check-nightly-release.cjs:25–38`). Há ainda builds de PR macOS identificados por `-pr.`; são outra modalidade de preview, não um canal escolhível no updater (`build-desktop-artifact.ts:2568–2576`).

Stable por **dispatch manual** reconstrói o commit já publicado na nightly mais recente, com versão derivada dela ou override informado (`release.yml:91–96`, `:187–213`; `check-nightly-release.cjs:84–102`). Stable por **tag push** usa o SHA do evento: não há obrigação de que tenha sido a última nightly (`release.yml:97–99`). Ambas validam presença do commit na branch padrão. Portanto “stable sempre promove a última nightly” seria uma generalização incorreta.

Versões numéricas puras são release e `make_latest=true`; sufixos aceitos no caminho stable produzem prerelease e não latest (`release.yml:203–213`). Nightly/preview são prerelease e não latest. O canal de feed stable chama-se **`latest`**, enquanto o workflow chama-o `stable` (`build-desktop-artifact.ts:2538–2565`).

Após uma stable, o job finalize usa `RELEASE_APP_ID` e `RELEASE_APP_PRIVATE_KEY` para ajustar versões/lockfile e commitar/push em `main` (`release.yml:1240–1251`, `:1286–1316`). Os jobs de empacotamento já haviam alinhado os manifests à versão da release em seus checkouts temporários.

### O que não há

Não há canal beta/alpha selecionável no app estudado. Preview é deliberadamente excluído de updates e das escolhas do usuário. Não há promoção byte a byte da nightly para stable: o workflow reconstrói o mesmo código com outra versão.

## 3. Releases no GitHub

### Como faz

O workflow recolhe os assets, junta manifests macOS/Windows entre arquiteturas e publica com `softprops/action-gh-release`, notas geradas e base na tag anterior (`release.yml:793–939`). Exemplo curto: `generate_release_notes`, `prerelease` e `make_latest` recebem os valores da etapa preflight (`:917–921`).

As duas releases públicas consultadas apresentam:

| Tipo | Assets |
| --- | --- |
| macOS | DMG e ZIP arm64/x64, blockmaps correspondentes |
| Windows | Instalador NSIS `.exe` arm64/x64 e blockmaps |
| Linux | AppImage arm64/x86_64 e DEB arm64/amd64 |
| Update stable | `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` |
| Update nightly | `nightly.yml`, `nightly-mac.yml`, `nightly-linux.yml`, `nightly-linux-arm64.yml` |
| CLI separado | tar.gz Darwin arm64/Linux arm64/x64; ZIP Windows arm64/x64; `SHA256SUMS` |
| Diagnóstico | `builder-debug.yml`, também presente nos assets observados |

O nome desktop vem de `artifactName: "T3-Code-${version}-${arch}.${ext}"` (`build-desktop-artifact.ts:2644`); nomes Linux são normalizados pelo builder conforme o formato. ZIP Windows `t3-…-win32-….zip` é **CLI**, não distribuição portátil do desktop.

`SHA256SUMS` cobre somente `t3-*.tar.gz` e `t3-*.zip` (CLI), calculado sobre os bytes finais assinados (`release.yml:807–820`). Os instaladores desktop têm hashes **sha512 nos manifests de update**, não nesse arquivo. Conferi os assets públicos `latest.yml`, `latest-mac.yml` e `latest-linux.yml`: contêm versão, URL, sha512 e tamanho; o Linux também tem `blockMapSize` para AppImage. São evidências de artefatos realmente publicados, além da configuração.

macOS e Windows inicialmente recebem manifests por arquitetura; o publisher os une para evitar colisão de nomes (`release-desktop.yml:583–600`; `release.yml:840–868`). Linux mantém nomes distintos para arm64. Preview é publicado com aviso em vez de changelog gerado e o publisher recusa manifests/blockmaps de updater se eles aparecerem (`release.yml:823–838`, `:892–908`).

### O que não há / limites

Não encontrei checksum SHA256 avulso de todos os instaladores desktop, nem assinatura independente dos manifests no fluxo estudado. Não verifiquei autenticidade dos certificados dos binários publicados, nem testei downloads diferenciais. Release pública e hash no mesmo servidor não substituem assinatura de código.

## 4. Assinatura e notarização

### macOS

O lane só adiciona `--signed` quando tem certificado/senha e as três variáveis da API Apple. Se isso ocorrer, também exige team ID e provisioning profile; materializa os arquivos temporários e passa-os ao build (`release-desktop.yml:413–434`). O script usa hook `scripts/sign-macos.ts:1–5`, que delega a `@electron/osx-sign` com chamadas agrupadas. A descoberta de uma identidade **Developer ID Application** é explícita no trecho que assina o monitor para o CLI (`release-desktop.yml:495–500`); o desktop deixa a seleção ao builder com `CSC_LINK`.

Entitlements gerados: application identifier, team identifier, associated domains para passkeys, `allow-jit`, `allow-unsigned-executable-memory` e `disable-library-validation` (`build-desktop-artifact.ts:1281–1306`). São associados ao build com provisioning profile (`:2703–2709`, `:3630–3640`). A declaração de uso de captura de tela aparece em `:2693–2695`. Passkeys/associated domains não são requisitos genéricos de distribuição Electron.

**Hardened runtime e notarização são defaults da dependência, não flags explícitas no script T3.** Para evitar inferência sem evidência, consultei o pacote oficial `app-builder-lib@26.15.6` via `npm pack` em `/tmp`: `package/out/mac/MacTargetHelper.js:176–182` habilita hardened runtime por padrão fora de MAS; `:236–243` lê a API key Apple; `:256–269` chama `@electron/notarize` quando há credenciais. `package/out/macPackager.js:318` chama esse helper depois da assinatura. Fonte externa reproduzível: [pacote oficial versionado](https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.15.6.tgz). O T3 fixa essa versão em `apps/desktop/package.json:39` e não desliga esses defaults em `createBuildConfig`.

Limite importante: quando faltam segredos Apple, o workflow escreve que assinatura está desabilitada e continua (`release-desktop.yml:432–434`). O build remove credenciais e desliga auto-discovery quando `signed=false` (`build-desktop-artifact.ts:3776–3783`). A existência do pipeline não comprova que toda release foi assinada/notarizada. Não extraí tickets ou requisitos designados dos apps lançados.

### Windows e Linux

Windows **tem suporte de assinatura**, via Azure Trusted Signing; não é correto dizer que é sempre unsigned. Prepara o módulo PowerShell TrustedSigning somente com os segredos presentes (`release-desktop.yml:250–299`), acrescenta `--signed` condicionalmente (`:435–454`) e passa `azureSignOptions` ao builder (`build-desktop-artifact.ts:2796–2799`). SHA256 e timestamp RFC3161 têm defaults explícitos (`:1527–1538`). Sem os segredos, pode gerar unsigned.

Linux produz AppImage e DEB do mesmo app desempacotado (`build-desktop-artifact.ts:2735–2741`). Não encontrei assinatura GPG dos pacotes/feeds no workflow desktop. Existe publicação AUR separada, com `AUR_SSH_PRIVATE_KEY` (`.github/workflows/publish-aur.yml:5–27`), não um formato extra de asset desktop na release.

### Segredos usados pelo lane desktop (somente nomes)

- Apple: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE`.
- Windows: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Publicação GitHub: token automático `github.token`/`GITHUB_TOKEN`; finalize stable usa `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`.

Evidência: `release-desktop.yml:11–37`, `:379–393`; `release.yml:924`, `:1246–1251`. `APPLE_TEAM_ID` e `CLERK_PASSKEY_RP_DOMAINS` são **vars**, não secrets (`release-desktop.yml:384–386`). Esta lista cobre distribuição/assinatura; os workflows também têm credenciais de relay, web, mobile e anúncios, que não são requisitos para distribuir o Disgalm.

## 5. Auto-update nos três SOs

### Biblioteca, feed e seleção

Usa **electron-updater 6.8.9**, encapsulado por `ElectronUpdater` (`apps/desktop/package.json:29`; `apps/desktop/src/electron/ElectronUpdater.ts:7`). O builder gera configuração de provider GitHub a partir de `T3CODE_DESKTOP_UPDATE_REPOSITORY` ou `GITHUB_REPOSITORY`; escolhe release/prerelease e canal nightly (`build-desktop-artifact.ts:2538–2561`). O runtime lê `app-update.yml`; feed generic localhost só é aplicado explicitamente para testes (`DesktopUpdates.ts:915–924`). Preview não tem publish config e fica sem feed (`build-desktop-artifact.ts:2568–2576`).

Configurações mostram **Update track**, Stable/Nightly (`apps/web/src/components/settings/SettingsPanels.tsx:446–475`). A escolha persiste em settings, com marcador de escolha explícita; sem escolha explícita, o default é derivado da versão instalada (`apps/desktop/src/settings/DesktopAppSettings.ts:195–244`, `:347–352`; `updates/updateChannels.ts:16–18`). O feed stable chama-se `latest`.

Trocar de canal persiste a escolha, reseta o estado, aplica o canal e faz check imediato com **`allowDowngrade=true` temporário**, restaurando a política depois (`DesktopUpdates.ts:972–1011`). Isso permite nightly → stable mesmo quando o SemVer alvo é menor. Na política ordinária nightly permite prerelease e downgrade; stable não (`:390–403`). Updates cuja versão não corresponde ao canal escolhido são rejeitados (`:737–752`). Isso é troca voluntária de canal, não rollback por falha de boot.

### Check, download, instalação e UI

Checa 15 segundos após startup e a cada quatro minutos (`DesktopUpdates.ts:50–51`, `:705–735`). Desliga download automático e instalação automática ao fechar: `setAutoDownload(false)`, `setAutoInstallOnAppQuit(false)` (`:933–934`). Assim, o caminho local é check automático, **download e instalação por ação do usuário**, com progresso/erros/notas. O controle da sidebar chama `downloadUpdate` e `installUpdate` (`SidebarUpdatePill.tsx:183–240`), e exibe estado/tooltip (`:134–157`); nightly pode apresentar notas agrupadas (`SidebarUpdateReleaseNotes.tsx:55`).

Antes de instalar, coordena a ação, grava marcador de restart, para os backends com cinco segundos de tolerância e chama `quitAndInstall` silencioso com relaunch (`DesktopUpdates.ts:581–683`, em especial `:630–649`). Há também atualização iniciada por cliente remoto, com preparação, token/commit e TTL de cinco minutos (`DesktopRemoteUpdates.ts:28–48`). Portanto não confundir a política local manual com inexistência de instalação remota autorizada.

Linux só habilita auto-update para AppImage (`APPIMAGE`) ou DEB identificado por `resources/package-type`; desenvolvimento, app não empacotado, ausência de feed e `T3CODE_DISABLE_AUTO_UPDATE` desabilitam o mecanismo (`DesktopUpdates.ts:251–269`, `:336–343`). O builder inclui os dois formatos no feed para preservar o tipo da instalação (`build-desktop-artifact.ts:2737–2740`). macOS usa ZIP para atualizar a app; DMG serve à instalação inicial, conforme os assets dos manifests públicos. Windows segue os instaladores NSIS. Não há auto-update genérico para o tar.gz artesanal do Disgalm.

Há cuidado adicional com Intel no Apple Silicon: desabilita download diferencial e informa que o update mudará para arm64 (`DesktopUpdates.ts:936–946`).

### O que não há / limites

Não há auto-update do preview, nem opção preview na UI. Não foi demonstrado por teste neste estudo que o downgrade funciona em instalação real de cada SO, especialmente permissões/elevacão do DEB, identidade macOS e dados alterados pela versão nightly. Os mecanismos estão no código; a validação de ponta a ponta continua necessária.

## 6. Rollback e crash loop

**Não encontrei rollback automático para uma versão anterior do desktop.** Não há, no fluxo estudado, contador persistente de boots da versão nova, confirmação durável de boot saudável, retenção explícita da versão anterior e substituição automática depois de falhas. Busca por crash loop/rollback/previous version/boot ok em `apps/desktop`, scripts e workflows não encontrou implementação desse protocolo. Ocorrências de rollback do backend/WSL tratam troca de ambiente, não versão do aplicativo.

O mais próximo é:

1. **Recuperação do renderer:** `DesktopWindow.ts:775–805` trata `crashed`, `oom` e `abnormal-exit` e recarrega a janela. Limite: três tentativas numa janela de 60 segundos, delay de 500 ms (`:59–61`). Timestamps ficam em memória do processo; não é contador persistente entre boots e não altera a versão.
2. **Falha de instalação:** `DesktopUpdates.ts:551–575` limpa estado de quitting/marcador, reinicia backends e mostra erro quando a instalação falha. Recupera a sessão atual, não restaura uma instalação anterior depois de crash.
3. **Marcador `desktop-update-restart`:** escrito antes de instalar (`DesktopUpdates.ts:520–540`). Serve para manter o túnel gerenciado entre backends; servidor o considera com TTL de um minuto (`apps/server/src/cloud/http.ts:118`, `:1184–1229`). Não é marcador de boot saudável.
4. **Downgrade na troca de canal:** descrito acima; depende do usuário e do feed, não de detecção de falha.

O cache interno do updater ou uma release antiga ainda disponível no GitHub não constituem um mecanismo completo de rollback. Não foi auditado todo o comportamento interno das dependências para recuperação transacional durante a substituição de arquivos; a conclusão é sobre rollback de versão/crash loop implementado pelo T3.

## 7. Outros mecanismos de segurança de distribuição

- **Separação de código não confiável e segredos em preview macOS:** o workflow de PR compila JS sem segredos/token de escrita; outro workflow, em `main`, valida autorização e assina/empacota sem executar o bundle. A label é uma autorização por commit (`desktop-macos-preview.yml:3–15`, `:17–32`; `desktop-macos-preview-publish.yml:3–11`). Esse desenho merece ser preservado se o Disgalm vier a assinar previews de PRs externos.
- **Metadados proibidos no canal de teste:** validação negativa no publisher, além da ausência de publish config no builder (`release.yml:823–838`). Reduz o risco de um preview cair no feed stable/nightly.
- **Rastreabilidade:** staged package inclui `t3codeCommitHash` e versão/buildVersion (`build-desktop-artifact.ts:3665–3669`); nomes nightly incluem SHA. Hashes de assets e blockmaps ajudam a conferir bytes e reduzir downloads.
- **Dados compartilhados entre stable/nightly:** o diretório Electron é `t3code` para produção, distinguindo apenas dev (`apps/desktop/src/app/DesktopEnvironment.ts:191`). Estado/baseDir também distinguem dev por configuração, não o canal (`:169–189`). Nome/ícone nightly são diferentes (`build-desktop-artifact.ts:2583–2619`), mas não comprovam isolamento de dados.
- **Migrações:** servidor importa migrações estáticas e roda pendentes no startup. Usa tabela `effect_sql_migrations` e IDs crescentes (`apps/server/src/persistence/Migrations.ts:1–8`, `:139–175`). Não encontrei migração reversa ou restauração de snapshot vinculada ao downgrade desktop. Isso torna compatibilidade de dados uma questão separada do `allowDowngrade`.
- **Observabilidade:** logs com rotação (10 arquivos de 10 MiB), snapshots de falha do backend e infraestrutura de traces/OTLP (`DesktopObservability.ts:1–35`, `:45–52`). Crash do renderer gera log com motivo/exitCode/decisão de recuperação (`DesktopWindow.ts:796–800`). Telemetria desktop inclui host/power e relatório de update ao backend (`DesktopTelemetryPublisher.ts:27–32`, `:63–78`). Não encontrei integração desktop explícita com `crashReporter.start`, Sentry ou upload de minidumps no código próprio pesquisado; logs/traces não são um coletor de crashes nativos comprovado.
- **Flags/canais:** há branding, escolha de feed, configurações públicas embutidas e habilitação de update por ambiente. Não encontrei uma política geral de feature flags gated por stable/nightly que seja necessária copiar para distribuição. Existem outros sistemas de flags do produto; não foram auditados integralmente.

## O que aplicar no Disgalm

Estas são recomendações de projeto, não funcionalidades já presentes no T3 ou implementação feita neste turno.

1. **Adotar electron-builder + electron-updater.** Substituir a função de distribuição de `desktop/empacotar.mjs`, que hoje copia Electron e gera ZIP/tar.gz (`Disgalm desktop/empacotar.mjs:1–10`, `:72–85`). Usar DMG+ZIP macOS, NSIS Windows e AppImage Linux; acrescentar DEB se houver demanda e teste de elevação. Gerar manifests/blockmaps pelo builder e publicar assets somente após todos os alvos e checks estarem prontos. Manter artifacts intermediários separados por SO/arch e fazer merge explícito quando o nome do feed colidir.
2. **Runner Windows obrigatório para o N-API.** `desktop/package.json:8` usa node-gyp; `empacotar.mjs` exige `loopback.node` no Windows. Compilar por arquitetura suportada com MSVC/Python e testar carregamento do `.node` no Electron empacotado. N-API reduz acoplamento de ABI, mas não elimina dependência de SO/arquitetura nem erros de linking. Configurar `asarUnpack`/resources para o binário. Não herdar `npmRebuild=false` apenas porque o T3 pode usar prebuilds; o Disgalm precisa de etapa explícita de build e verificação do resultado.
3. **Canais explícitos com feed público.** Stable=`latest`, nightly prerelease com versão monotônica por data/run; previews técnicos sem feed e com proibição de metadata no publisher. Reaproveitar default pelo build e escolha persistida, resetar downloads quando muda de canal e permitir downgrade temporariamente no check da troca. Distinguir promoção do commit validado de rebuild de HEAD. Se adotar nightly automático, seis horas com mudanças é um bom ponto inicial; não é uma exigência técnica.
4. **Exigir assinatura em releases macOS.** Usar Developer ID do mesmo time e manter bundle ID `ai.galm.disgalm`, signing identifier e requisito designado compatíveis entre versões/canais. Proibir fallback ad hoc nos canais distribuídos; falhar CI se faltar identidade ou notarização. O código atual já alerta que ad hoc perde a permissão de Gravação de Tela (`Disgalm desktop/empacotar.mjs:64–70`). Não copiar entitlements de passkeys do T3 sem necessidade. Guardar evidência de `codesign -d -r-`, `codesign --verify`, `spctl` e ticket stapled, e testar atualização/downgrade no mesmo caminho instalado com Gravação de Tela previamente autorizada. A identidade estável deve ser validada; nome visual e bundle ID sozinhos não bastam.
5. **Windows assinado e Linux com formato atualizável.** Avaliar Azure Trusted Signing ou certificado conforme a conta disponível e tornar assinatura exigida nos canais oficiais, em vez da tolerância a segredos ausentes do T3. Linux AppImage dá um caminho inicial de auto-update; DEB deve ser testado com suas permissões. O tar.gz atual não ganha atualização segura simplesmente adicionando um botão. Publicar checksums de todos os assets finais pode facilitar suporte, além de SHA512 dos feeds.
6. **UX adequada a áudio/chamada.** Checar em background e mostrar versão/canal/notas/progresso; download e restart sob ação explícita, adiando instalação enquanto houver chamada/captura. Encerrar captura e processos de modo coordenado antes de substituir arquivos. Testar instalação inicial → update, update interrompido, troca de canal e downgrade em cada SO/arquitetura suportada. O mock update server do T3 é uma referência para testes locais, não substitui o teste do pacote assinado.
7. **Construir rollback real como requisito separado.** `electron-updater` e o T3 não entregam o protocolo de crash loop pedido. Definir um launcher/supervisor que rode antes do Electron e sobreviva a sua falha; persistir versão candidata, versão anterior saudável, início/tentativa e confirmação de saúde. Após limiar de falhas precoces sem confirmação, restaurar o pacote anterior verificado e bloquear a candidata para não reinstalá-la pelo polling. Evitar classificar saída voluntária ou reinício de update como crash. Retenção, substituição e privilégios exigem desenho específico para macOS/NSIS/AppImage/DEB; não presumir um único rename aplicável aos três. Guardar pacote anterior assinado e restaurar identidade/caminho macOS. A aceitação deve incluir crashes do main antes da UI, crashes repetidos do renderer e falta de rede.
8. **Compatibilidade e diagnóstico do rollback.** Definir o que significa boot saudável (main, renderer e subsistema de captura prontos por um período; não depender de login/rede externa). Versionar configuração, preferir migrações compatíveis com a versão anterior e fazer snapshot antes de alterações incompatíveis; restauração não deve apagar dados criados depois do update. Registrar motivo/versão/canal/contagem localmente, com coleta de crash separada se desejada. Sem essa política, downgrade de binário pode continuar falhando sobre dados migrados.

## Evidência que ficou faltando

Não inspecionei certificados, requisitos designados, tickets de notarização ou hashes recalculados dos instaladores completos; não executei updates nos três SOs; não confirmei a arquitetura física dos runners macOS; não fiz auditoria de todas as flags, telemetria ou compatibilidade histórica das migrações. Os workflows recentes consultados mostram execuções concluídas com sucesso, mas sucesso do cron também pode significar que ele pulou a publicação por cadência. Ausência de rollback é uma conclusão do código de distribuição/runtime examinado, não promessa sobre dependências ou trabalho futuro do projeto.
