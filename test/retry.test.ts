import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRetryAfter } from "../src/provider/client.ts";
import { REVOKED_TOKEN } from "../src/provider/fake-provider.ts";
import { START, setup, snapshot, TOKEN, WINDOW } from "./helpers.ts";

function withOnePost() {
  const ctx = setup();
  ctx.fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-02T10:00:00.000Z", 100));
  return ctx;
}

describe("429 com Retry-After", () => {
  it("espera exatamente os segundos pedidos e tenta de novo", async () => {
    const { clock, fake, service, connectionId } = withOnePost();
    fake.failNext({ kind: "rate_limit", retryAfter: "30" });

    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.status, "succeeded");
    assert.deepEqual(clock.sleeps, [30_000]);
    assert.equal(fake.calls, 2);
    assert.deepEqual(
      run.attempts.map((a) => [a.attempt, a.outcome, a.waited_ms]),
      [
        [1, "rate_limited", 30_000],
        [2, "ok", 0],
      ],
    );

    assert.equal(service.posts(connectionId)[0]?.last_fetched_at, "2026-06-01T12:00:30.000Z");
  });

  it("aceita Retry-After como data HTTP", async () => {
    const { clock, fake, service, connectionId } = withOnePost();
    const inTwentySeconds = new Date(Date.parse(START) + 20_000).toUTCString();
    fake.failNext({ kind: "rate_limit", retryAfter: inTwentySeconds });

    await service.sync(connectionId, WINDOW);

    assert.deepEqual(clock.sleeps, [20_000]);
  });

  it("não espera além do teto: para o sync e informa quando tentar de novo", async () => {
    const { clock, fake, service, connectionId } = withOnePost();
    fake.failNext({ kind: "rate_limit", retryAfter: "120" });

    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.status, "failed");
    assert.equal(run.error?.code, "rate_limited");
    assert.equal(run.error?.retry_at, "2026-06-01T12:02:00.000Z");
    assert.deepEqual(clock.sleeps, []);
    assert.equal(fake.calls, 1);
    assert.equal(service.totals(connectionId).posts, 0);
  });

  it("espera no limite exato do teto", async () => {
    const { clock, fake, service, connectionId } = withOnePost();
    fake.failNext({ kind: "rate_limit", retryAfter: "60" });

    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.status, "succeeded");
    assert.deepEqual(clock.sleeps, [60_000]);
  });

  it("sem Retry-After, usa o backoff padrão", async () => {
    const { clock, fake, service, connectionId } = withOnePost();
    fake.failNext({ kind: "rate_limit" });

    await service.sync(connectionId, WINDOW);

    assert.deepEqual(clock.sleeps, [500]);
  });

  it("429 repetido para no teto de tentativas", async () => {
    const { clock, fake, service, connectionId } = withOnePost();
    const limited = { kind: "rate_limit", retryAfter: "5" } as const;
    fake.failNext(limited, limited, limited, limited, limited);

    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.status, "failed");
    assert.equal(run.error?.code, "rate_limited");
    assert.equal(fake.calls, 4);
    assert.deepEqual(clock.sleeps, [5_000, 5_000, 5_000]);
  });

  it("o teto de espera é configurável", async () => {
    const { clock, fake, service, connectionId } = setup({ policy: { maxRetryAfterMs: 10_000 } });
    fake.failNext({ kind: "rate_limit", retryAfter: "11" });

    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.error?.code, "rate_limited");
    assert.deepEqual(clock.sleeps, []);
  });
});

describe("falha transitória", () => {
  it("timeout e 503 são repetidos com backoff exponencial", async () => {
    const { clock, fake, service, connectionId } = withOnePost();
    fake.failNext({ kind: "timeout" }, { kind: "status", status: 503 });

    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.status, "succeeded");
    assert.deepEqual(clock.sleeps, [500, 1_000]);
    assert.deepEqual(
      run.attempts.map((a) => a.outcome),
      ["transient_error", "transient_error", "ok"],
    );
  });

  it("para depois do número máximo de tentativas, sem loop infinito", async () => {
    const { clock, fake, service, connectionId } = withOnePost();
    for (let i = 0; i < 10; i += 1) fake.failNext({ kind: "timeout" });

    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.status, "failed");
    assert.equal(run.error?.code, "retries_exhausted");
    assert.equal(fake.calls, 4);
    assert.deepEqual(clock.sleeps, [500, 1_000, 2_000]);
    assert.equal(fake.pendingFaults(), 6);
  });

  it("o backoff respeita o teto configurado", async () => {
    const { clock, fake, service, connectionId } = setup({
      policy: { maxAttempts: 6, baseBackoffMs: 1_000, maxBackoffMs: 3_000 },
    });
    for (let i = 0; i < 5; i += 1) fake.failNext({ kind: "status", status: 500 });

    await service.sync(connectionId, WINDOW);

    assert.deepEqual(clock.sleeps, [1_000, 2_000, 3_000, 3_000, 3_000]);
  });
});

describe("falha permanente", () => {
  it("token recusado não é repetido", async () => {
    const { clock, fake, service } = setup();
    const revoked = service.connect({ platform: "tiktok", account_handle: "@ana", access_token: REVOKED_TOKEN });

    const run = await service.sync(revoked.id, WINDOW);

    assert.equal(run.status, "failed");
    assert.equal(run.error?.code, "provider_rejected");
    assert.equal(fake.calls, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  it("400 do provedor não é repetido", async () => {
    const { fake, service, connectionId } = withOnePost();
    fake.failNext({ kind: "status", status: 400 });

    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.error?.code, "provider_rejected");
    assert.equal(fake.calls, 1);
  });
});

describe("leitura do Retry-After", () => {
  const now = new Date(START);

  it("segundos, data HTTP, data no passado e valor inválido", () => {
    assert.equal(parseRetryAfter("45", now), 45_000);
    assert.equal(parseRetryAfter(" 0 ", now), 0);
    assert.equal(parseRetryAfter(new Date(Date.parse(START) + 90_000).toUTCString(), now), 90_000);
    assert.equal(parseRetryAfter(new Date(Date.parse(START) - 90_000).toUTCString(), now), 0);
    assert.equal(parseRetryAfter("amanhã", now), null);
    assert.equal(parseRetryAfter(undefined, now), null);
  });
});
