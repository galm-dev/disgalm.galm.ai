# Workers Logs — disgalm / Sala — 02/10/2026

**Classificação: inconclusivo nas duas janelas.** Os logs confirmam fechamento 1006 e reconexão com `naSala=1`, mas não mostram uma exceção/OOM nem uma mensagem do provider que explique a recriação.

Consulta somente leitura pelo Twilight, container **Default** (segundo item homônimo do menu File → New Container Tab; userContextId não exposto pela UI). Conta Galm, Worker `disgalm`, Production → Observability → Events. Nenhuma configuração alterada; nenhum commit ou push.

## Fuso e filtros

O seletor mostrou **Brasilia Standard Time (GMT-3)** e a lista mostrou timestamps **GMT-3**. Todas as horas abaixo são de 02/10/2026; UTC = Brasília + 3 horas.

O seletor aceita `yyyy-MM-dd HH:mm`; ao perder foco, valores com segundos foram revertidos. Portanto, as janelas exatas foram examinadas pelos timestamps dos eventos dentro de consultas de minuto. Não foi confirmado um filtro de segundos no painel.

| Janela | Recorte solicitado em Brasília / UTC | Filtro temporal realmente aplicado | Contagem sem filtro adicional |
|---|---|---|---|
| A | 15:08:10–15:08:25 / 18:08:10–18:08:25 | 15:08:00–15:09:00 / 18:08:00–18:09:00 | 32 Success, 0 Errors |
| B | 18:46:30–18:46:45 / 21:46:30–21:46:45 | 18:46:00–18:47:00 / 21:46:00–21:47:00 | 70 Success, 0 Errors |

Conforme pedido na retomada, a busca foi **ampliada para cobrir ±2 minutos**, com arredondamento externo a minutos: A 15:06:00–15:11:00 Brasília (18:06:00–18:11:00 UTC); B 18:44:00–18:49:00 Brasília (21:44:00–21:49:00 UTC). A ampliada, sem condição adicional, mostrou 58 Success, 0 Errors.

Filtros executados pelo campo “Search with query language...”:

```text
$workers.outcome != "ok" OR regex($metadata.message, "(?i)reset|updated|disconnect|connection lost|internal error|memory|exceeded|hibernat")
regex($metadata.message, "(?i)reset|updated|disconnect|connection lost|internal error|memory|exceeded|hibernat")
```

O primeiro retornou seis eventos em A e cinco em B. Seus detalhes mostraram outcomes não-ok, listados abaixo. A busca somente de mensagens mostrou **“No events found”**, 0 Success e 0 Errors, nas duas janelas ampliadas. Em B também foi executado `$workers.outcome != "ok"`, com os mesmos cinco eventos. **“0 Errors” no gráfico não significa que todos os outcomes sejam `ok`.**

## Janela A

Script version de todos os eventos detalhados nesta janela: **23ddbadd-25c8-4b5a-a872-c47f6e5e2b03**.

| Brasília | UTC | Entrypoint / evento | Outcome | Evidência técnica mínima |
|---|---|---|---|---|
| 15:07:41.265 | 18:07:41.265 | Worker / fetch, stateless | responseStreamDisconnected | wallTimeMs 426, cpuTimeMs 2 |
| 15:07:41.320 | 18:07:41.320 | Sala / fetch, durableObject | responseStreamDisconnected | wallTimeMs 137, cpuTimeMs 3 |
| **15:07:41.445** | **18:07:41.445** | **Sala / hibernatableWebSocket, mensagem** | **ok** | **Último evento listado anterior a 15:08:19 no entorno consultado**, a 37,555 s do instante; portanto dentro de ±5 minutos. wallTimeMs 101, cpuTimeMs 0 |
| 15:08:20.287 | 18:08:20.287 | Worker / fetch GET /ws, stateless | ok | HTTP 401; wallTimeMs 167, cpuTimeMs 1 |
| **15:08:20.333** | **18:08:20.333** | **Sala / fetch, log da invocação** | Não exposto no log individual | Evento `voltou`, conexão `a6a77bc0`, **naSala=1** |
| 15:08:20.393 | 18:08:20.393 | Worker / fetch, stateless | ok | wallTimeMs 117, cpuTimeMs 1 |
| **15:08:20.454** | **18:08:20.454** | **Sala / fetch, durableObject** | **ok** | Invocação aberta na retomada; wallTimeMs 121, cpuTimeMs 1. “View invocation” exibiu o log `voltou` de 15:08:20.333 e este fetch |
| 15:08:20.470 | 18:08:20.470 | Sala / fetch, durableObject | canceled | wallTimeMs 17, cpuTimeMs 1 |
| 15:08:20.517 | 18:08:20.517 | Worker / fetch, stateless | canceled | wallTimeMs 398, cpuTimeMs 3 |
| 15:08:22.531 | 18:08:22.531 | Worker / fetch, stateless | canceled | wallTimeMs 132, cpuTimeMs 2 |
| 15:08:22.558 | 18:08:22.558 | Sala / fetch, durableObject | canceled | wallTimeMs 82, cpuTimeMs 1 |

A lista também mostrou `message` após a reconexão, `voltou` em 15:08:20.454 e 15:08:22.477 Brasília (18:08:20.454 e 18:08:22.477 UTC) e `sinalizacao_fechou` em 15:08:23.904 Brasília (18:08:23.904 UTC); os detalhes desses outros logs não foram usados para atribuir causa.

Não apareceu mensagem explícita de reset, atualização, conexão perdida, erro interno, memória/exceeded ou hibernação no filtro indicado. Não foi capturada exceção, OOM, mensagem de storage ou stack trace. O eventType `hibernatableWebSocket` é metadado do handler; não constitui uma mensagem de erro de hibernação.

**Conclusão A: inconclusivo.** `voltou` com `naSala=1` às 15:08:20.333 confirma estado vazio na primeira reconexão observada. O fetch `Sala` às 15:08:20.454 tem outcome `ok`; a versão é a mesma do último evento anterior. Os `canceled` são posteriores ao instante investigado e não provam o motivo da recriação.

## Janela B

Script version de todos os eventos detalhados nesta janela: **8867f3b9-5354-4dd4-8370-07418e368214**.

Primeiro evento listado no minuto, em ordenação temporal decrescente: **18:46:53.489 Brasília = 21:46:53.489 UTC**, `Sala / hibernatableWebSocket`, mensagem, outcome `ok`, wallTimeMs 0, cpuTimeMs 0. Está fora do recorte exato, mas dentro do minuto pedido.

| Brasília | UTC | Entrypoint / evento | Outcome | Evidência técnica mínima |
|---|---|---|---|---|
| 18:45:33.536 | 21:45:33.536 | Worker / fetch, stateless | responseStreamDisconnected | wallTimeMs 127, cpuTimeMs 1 |
| 18:45:33.568 | 21:45:33.568 | Sala / fetch, durableObject | responseStreamDisconnected | wallTimeMs 87, cpuTimeMs 3 |
| **18:46:37.188** | **21:46:37.188** | **Worker / fetch, stateless** | **ok** | Último evento listado anterior ao close de 18:46:39.022; wallTimeMs 672, cpuTimeMs 2 |
| **18:46:39.022** | **21:46:39.022** | **Sala / hibernatableWebSocket, close** | **ok** | **code=1006, wasClean=false**; wallTimeMs 5, cpuTimeMs 2. A lista exibiu vários close no mesmo timestamp |
| **18:46:40.503** | **21:46:40.503** | **Sala / fetch, log** | Não exposto no log individual | Evento `voltou`, **naSala=1** |
| 18:46:42.936 | 21:46:42.936 | Worker / fetch, stateless | responseStreamDisconnected | wallTimeMs 125, cpuTimeMs 1 |
| 18:46:51.301 | 21:46:51.301 | Worker / fetch, stateless | canceled | wallTimeMs 128, cpuTimeMs 1; fora do recorte exato |
| 18:46:51.369 | 21:46:51.369 | Sala / fetch, durableObject | responseStreamDisconnected | wallTimeMs 129, cpuTimeMs 1; fora do recorte exato |
| 18:46:53.489 | 21:46:53.489 | Sala / hibernatableWebSocket, mensagem | ok | Primeiro evento listado no minuto; fora do recorte exato |

Não apareceu mensagem explícita de reset, atualização, conexão perdida, erro interno, memória/exceeded ou hibernação no filtro indicado. Não foi capturada exceção, OOM, mensagem de storage ou stack trace.

**Conclusão B: inconclusivo.** O close `Sala` de 18:46:39.022 prova fechamento anormal 1006 e `wasClean=false`, com outcome `ok`. O log `voltou` de 18:46:40.503 mostra `naSala=1`. A versão é igual antes e depois, mas não há mensagem que atribua a recriação ao código ou ao provider.

## Deploys e versões

Nenhuma mudança de scriptVersion foi observada entre os eventos anteriores e posteriores de cada janela. Isso não exclui reset do runtime sem nova versão.

A aba Deployments mostrou as versões `23ddbadd` e `8867f3b9` na página 2 de Version History (11–20 de 59), com data relativa “1d ago”. “View all deployments” expôs apenas dez deploys recentes, sem os deploys que antecederam A e B; não expôs paginação nem registros adicionais após rolagem. Assim, **não foi possível confirmar no painel um horário exato de deploy dessas duas versões, nem excluir todo evento de deploy nos intervalos**. Nenhuma mensagem `updated` foi encontrada nos Workers Logs pelo filtro aplicado.

## Checkpoint final

- Consulta encerrada; GUI deixada como estava, sem fechar abas ou executar mais ações após o encerramento.
- Twilight, container Default autenticado; fuso confirmado na Observability: Brasília / GMT-3.
- Tela final: Deployments → Version History, página 2, mostrando `8867f3b9` e `23ddbadd`; última ação foi clicar na data relativa de `8867f3b9`, sem exposição de horário exato.
- URL confirmada: `https://dash.cloudflare.com/d7b9d3320fcf3246053d5333800c2e72/workers/services/view/disgalm/production/deployments`.
- Limitação remanescente: falta um evento causal explícito de runtime/provider ou exceção/OOM; os eventos capturados sustentam apenas a classificação inconclusiva.
