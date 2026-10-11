# Conty. Sincronização de métricas

Serviço que recebe uma conexão já autorizada com Instagram, TikTok, YouTube ou X e sincroniza as métricas dos posts. O OAuth fica de fora: o token é fictício. O provedor é simulado e consegue falhar de propósito com timeout, 5xx, 429 com `Retry-After` e resposta duplicada.

## Como rodar

Node 22.18 ou mais novo. Não há dependências para instalar: o projeto usa só `node:http` e `node:test`, e o Node roda os `.ts` direto.

```bash
npm test     # 25 testes
npm start    # sobe em http://127.0.0.1:3004 com o provedor simulado
```

## Como o código está dividido

```
src/provider/contract.ts       tipos da fronteira: requisição, resposta, snapshot de um post
src/provider/fake-provider.ts  PROVEDOR SIMULADO (posts, paginação, falhas roteirizadas)
src/provider/client.ts         traduz a resposta do provedor: 200 → página, 429 → RateLimited,
                               timeout/5xx → Transient, 401/4xx/payload inválido → Permanent
─────────────────────────────── fronteira ───────────────────────────────
src/sync/retry.ts              política de retry: o que esperar, quanto, até quando
src/sync/store.ts              gravação idempotente das métricas
src/sync/sync-service.ts       o sync: pagina, aplica a política, registra cada execução
src/http/app.ts                rotas HTTP
```

A regra de negócio só conhece `ProviderTransport`, a interface do provedor. Para ligar uma rede de verdade, basta escrever um transporte que chame a API dela e devolva o mesmo formato. Nada abaixo da fronteira muda.

## Idempotência

**A chave é `(conexão, post_id)`, e o snapshot é identificado pelo `captured_at`**, o momento em que o provedor mediu os números. O serviço guarda **um registro por post com os números absolutos**, nunca um por sync. Por isso receber o mesmo post de novo não soma nada:

| O que chega | O que acontece | Contado como |
|---|---|---|
| post que não existe ainda | grava | `created` |
| mesmo post, `captured_at` mais novo | **substitui** os números (não soma) | `updated` |
| mesmo post, mesmo `captured_at` | não muda os números; só atualiza `last_fetched_at` | `unchanged` |
| mesmo post, `captured_at` mais velho | ignora, porque chegou fora de ordem | `stale` |

Isso cobre todos os jeitos de o mesmo post chegar de novo:

- **janelas sobrepostas:** o post que está nas duas janelas cai na mesma chave;
- **resposta duplicada:** o mesmo post repetido na página vira `unchanged`;
- **retry depois de timeout:** se o provedor processou a chamada mas a resposta se perdeu, a nova tentativa devolve os mesmos snapshots;
- **sync que falha no meio:** as páginas já gravadas ficam, e repetir o sync é seguro.

Cada execução fica registrada com essas contagens.

## Retry, timeout e 429

A política fica em `src/sync/retry.ts` e vale para cada página. Padrão: `maxAttempts: 4`, `baseBackoffMs: 500`, `maxBackoffMs: 8000`, `maxRetryAfterMs: 60000`.

- **Timeout, 5xx e 408:** nova tentativa com backoff exponencial (500 ms, 1 s, 2 s…). Depois de `maxAttempts` chamadas, o sync para com `retries_exhausted`. Não há loop infinito.
- **429 com `Retry-After`:** o serviço espera **exatamente** o prazo pedido, em segundos (`"30"`) ou como data HTTP, e tenta de novo.
  - Se o prazo for **maior que `maxRetryAfterMs`**, o serviço **não espera**. O sync para na hora com `rate_limited` e `retry_at`, o momento a partir do qual o provedor aceita nova chamada, para quem agenda o próximo sync.
  - 429 sem `Retry-After` usa o backoff.
  - 429 repetido também respeita `maxAttempts`.
- **401, 403, outros 4xx e payload inválido:** nenhuma nova tentativa (`provider_rejected`), porque repetir não resolve.

Toda tentativa fica no histórico do sync com o resultado e quanto se esperou depois dela.

O relógio é injetado (`Clock`, com `now()` e `sleep()`). Nos testes, `ManualClock` não espera de verdade: só avança o tempo e anota cada espera. Assim o teste confere que o 429 com `Retry-After: 30` gerou exatamente uma espera de 30 000 ms.

## Quando a métrica foi buscada

Cada post traz três horários:

- `captured_at`: quando o provedor mediu;
- `first_fetched_at`: quando o serviço viu o post pela primeira vez;
- `last_fetched_at`: a última vez que o serviço buscou e confirmou os números.

Os totais da conexão trazem `last_synced_at` e `oldest_fetched_at`, ou seja, o quão antigo está o número mais desatualizado da soma. O histórico de syncs (`GET /connections/:id/syncs`) mostra janela, início, fim, contagens, tentativas e erro de cada execução.

## Endpoints

| Método e rota | O que faz |
|---|---|
| `POST /connections` `{platform, account_handle, access_token}` | Registra a conexão. O token nunca volta na resposta. |
| `POST /connections/:id/sync` `{since, until}` | Sincroniza os posts publicados em `[since, until)`. Responde `200` se deu certo e `502` se o provedor não deixou; o corpo traz o registro do sync nos dois casos. Responde `409` se já houver um sync rodando para a conexão. |
| `GET /connections/:id/posts` | Posts com métricas e horários. |
| `GET /connections/:id/metrics` | Totais da conexão. |
| `GET /connections/:id/syncs` | Histórico de execuções. |

Só no servidor de demonstração:

- `POST /fake/posts` publica ou atualiza um post no provedor simulado;
- `POST /fake/faults` enfileira falhas para as próximas chamadas.

## Exemplos

Respostas reais do servidor de demonstração, encurtadas com `…`. Nele, o teto de espera é de 5 s, para a demonstração não travar o terminal.

**Conectar**

```bash
curl -s -X POST localhost:3004/connections -H 'content-type: application/json' \
  -d '{"platform":"instagram","account_handle":"@ana.cria","access_token":"tok_ficticio_123"}'
```

```json
{ "id": "con_1", "platform": "instagram", "account_handle": "@ana.cria", "created_at": "2026-10-11T22:05:48.606Z", "last_synced_at": null }
```

**Publicar três posts no provedor simulado** (ig_1 em 01/10, ig_2 em 05/10, ig_3 em 09/10)

```bash
curl -s -X POST localhost:3004/fake/posts -H 'content-type: application/json' -d '{
  "platform":"instagram","access_token":"tok_ficticio_123",
  "post":{"post_id":"ig_1","published_at":"2026-10-01T15:00:00Z","captured_at":"2026-10-11T20:00:00Z",
          "views":1200,"likes":140,"comments":12,"shares":5}}'
# o mesmo para ig_2 (800 views) e ig_3 (300 views)
```

**Duas janelas sobrepostas**: 01/10 a 07/10, depois 04/10 a 11/10. O ig_2 está nas duas.

```bash
curl -s -X POST localhost:3004/connections/con_1/sync -H 'content-type: application/json' \
  -d '{"since":"2026-10-01T00:00:00Z","until":"2026-10-07T00:00:00Z"}'
curl -s -X POST localhost:3004/connections/con_1/sync -H 'content-type: application/json' \
  -d '{"since":"2026-10-04T00:00:00Z","until":"2026-10-11T00:00:00Z"}'
```

```json
{ "id": "sync_1", "status": "succeeded", "counts": { "received": 2, "created": 2, "updated": 0, "unchanged": 0, "stale": 0 }, "…": "…" }
{ "id": "sync_2", "status": "succeeded", "counts": { "received": 2, "created": 1, "updated": 0, "unchanged": 1, "stale": 0 }, "…": "…" }
```

**Totais**: 3 posts e 2300 views (1200 + 800 + 300). O ig_2 não foi contado duas vezes.

```bash
curl -s localhost:3004/connections/con_1/metrics
```

```json
{
  "connection_id": "con_1",
  "posts": 3,
  "views": 2300,
  "likes": 250,
  "comments": 20,
  "shares": 7,
  "last_synced_at": "2026-10-11T22:05:48.659Z",
  "oldest_fetched_at": "2026-10-11T22:05:48.650Z"
}
```

**429 com `Retry-After: 2`**: o serviço espera 2 s e consegue. Repare em `started_at` e `finished_at`.

```bash
curl -s -X POST localhost:3004/fake/faults -H 'content-type: application/json' \
  -d '{"faults":[{"kind":"rate_limit","retryAfter":"2"}]}'
curl -s -X POST localhost:3004/connections/con_1/sync -H 'content-type: application/json' \
  -d '{"since":"2026-10-01T00:00:00Z","until":"2026-10-02T00:00:00Z"}'
```

```json
{
  "id": "sync_3",
  "status": "succeeded",
  "started_at": "2026-10-11T22:05:48.687Z",
  "finished_at": "2026-10-11T22:05:50.690Z",
  "attempts": [
    { "attempt": 1, "outcome": "rate_limited", "detail": "o provedor respondeu 429 (limite de taxa)", "waited_ms": 2000, "page": 1 },
    { "attempt": 2, "outcome": "ok", "detail": null, "waited_ms": 0, "page": 1 }
  ],
  "…": "…"
}
```

**429 pedindo 1 hora, acima do teto**: o serviço não espera, responde `502` e informa quando tentar de novo.

```json
{
  "id": "sync_4",
  "status": "failed",
  "attempts": [ { "attempt": 1, "outcome": "rate_limited", "waited_ms": 0, "…": "…" } ],
  "error": {
    "code": "rate_limited",
    "message": "o provedor pediu 3600000 ms de espera, acima do teto de 5000 ms",
    "retry_at": "2026-10-11T23:05:50.706Z"
  },
  "…": "…"
}
```

**Quatro timeouts seguidos**: o backoff vai de 200 a 400 e a 800 ms, e o sync para na 4ª tentativa.

```json
{
  "id": "sync_5",
  "status": "failed",
  "attempts": [
    { "attempt": 1, "outcome": "transient_error", "waited_ms": 200, "…": "…" },
    { "attempt": 2, "outcome": "transient_error", "waited_ms": 400, "…": "…" },
    { "attempt": 3, "outcome": "transient_error", "waited_ms": 800, "…": "…" },
    { "attempt": 4, "outcome": "transient_error", "waited_ms": 0, "…": "…" }
  ],
  "error": { "code": "retries_exhausted", "message": "4 tentativas sem sucesso; última falha: o provedor não respondeu dentro do prazo", "retry_at": null }
}
```

## Testes

- `test/idempotency.test.ts`:
  - janelas sobrepostas;
  - mesma janela repetida;
  - snapshot novo substitui;
  - duplicata na mesma resposta;
  - snapshot velho fora de ordem;
  - timeout seguido de retry;
  - sync que falha no meio e é repetido;
  - horários de busca.
- `test/retry.test.ts`:
  - 429 com `Retry-After` em segundos e em data HTTP;
  - espera acima do teto, no limite exato e com teto configurável;
  - 429 sem cabeçalho e 429 repetido;
  - backoff e teto de tentativas;
  - falhas permanentes sem retry.
- `test/api.test.ts`: fluxo pela API, validações, token fora da resposta e bloqueio de sync simultâneo.

## O que ficou de fora e o que eu mudaria com mais tempo

- **Armazenamento em memória.** Num banco, a chave `(conexão, post_id)` viraria uma restrição única. A gravação seria um upsert condicional (`ON CONFLICT … DO UPDATE … WHERE excluded.captured_at > posts.captured_at`), que mantém a idempotência mesmo com dois processos sincronizando ao mesmo tempo. O bloqueio de sync simultâneo hoje só vale dentro de um processo.
- **Histórico de snapshots.** Hoje guardo só o estado atual de cada post. Para mostrar a evolução das views, eu guardaria cada snapshot numa tabela própria com chave `(post, captured_at)`, que é idempotente do mesmo jeito.
- **Timeout simulado no transporte.** O provedor falso lança o erro de timeout em vez de demorar. Num transporte real, eu usaria `AbortSignal.timeout` no `fetch`.
- **Agendamento.** O `retry_at` de um 429 longo diz quando tentar de novo, mas não existe um agendador que faça isso sozinho. Eu colocaria o sync numa fila de jobs.
- **Teto de tempo total do sync.** Hoje há teto por tentativa e por espera, mas não um orçamento total para syncs com muitas páginas.
- **Payload por rede.** Cada rede tem formato e limites próprios. Aqui todas usam o mesmo formato simulado; os adaptadores reais ficariam do lado do provedor da fronteira.
- **Token.** O token fica em memória e em texto puro. Em produção, ficaria cifrado num cofre de segredos, com renovação pelo refresh token.

## Uso de IA

O código, os testes e este README foram escritos com o Claude (Anthropic), a partir do enunciado e das decisões discutidas com ele.

O que eu revisei:

- _(preencha com o que você conferiu: por exemplo, li cada arquivo de `src/`, rodei `npm test`, testei o fluxo com os `curl` acima e conferi a regra de idempotência e o tratamento de 429 contra o enunciado)._
