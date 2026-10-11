import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { START, setup, snapshot, TOKEN, WINDOW } from "./helpers.ts";

describe("idempotência do sync", () => {
  it("janelas sobrepostas não contam o mesmo post duas vezes", async () => {
    const { fake, service, connectionId } = setup();
    fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-01T10:00:00.000Z", 100));
    fake.upsertPost("instagram", TOKEN, snapshot("p2", "2026-05-05T10:00:00.000Z", 200));
    fake.upsertPost("instagram", TOKEN, snapshot("p3", "2026-05-10T10:00:00.000Z", 300));

    const first = await service.sync(connectionId, {
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-07T00:00:00.000Z",
    });
    const second = await service.sync(connectionId, {
      since: "2026-05-04T00:00:00.000Z",
      until: "2026-05-11T00:00:00.000Z",
    });

    assert.deepEqual(first.counts, { received: 2, created: 2, updated: 0, unchanged: 0, stale: 0 });
    assert.deepEqual(second.counts, { received: 2, created: 1, updated: 0, unchanged: 1, stale: 0 });
    const totals = service.totals(connectionId);
    assert.equal(totals.posts, 3);
    assert.equal(totals.views, 600);
  });

  it("repetir a mesma janela não muda nenhum número", async () => {
    const { fake, service, connectionId } = setup();
    fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-02T10:00:00.000Z", 100));
    fake.upsertPost("instagram", TOKEN, snapshot("p2", "2026-05-03T10:00:00.000Z", 50));

    await service.sync(connectionId, WINDOW);
    const before = service.totals(connectionId);
    const again = await service.sync(connectionId, WINDOW);

    assert.deepEqual(again.counts, { received: 2, created: 0, updated: 0, unchanged: 2, stale: 0 });
    const after = service.totals(connectionId);
    assert.deepEqual(
      [after.posts, after.views, after.likes, after.comments],
      [before.posts, before.views, before.likes, before.comments],
    );
  });

  it("snapshot mais novo substitui os números em vez de somar", async () => {
    const { clock, fake, service, connectionId } = setup();
    fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-02T10:00:00.000Z", 100, START));
    await service.sync(connectionId, WINDOW);

    clock.advance(3_600_000);
    fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-02T10:00:00.000Z", 450, clock.now().toISOString()));
    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.counts.updated, 1);
    assert.equal(service.totals(connectionId).views, 450);
  });

  it("post repetido dentro da mesma resposta conta uma vez", async () => {
    const { fake, service, connectionId } = setup();
    fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-02T10:00:00.000Z", 100));
    fake.upsertPost("instagram", TOKEN, snapshot("p2", "2026-05-03T10:00:00.000Z", 200));
    fake.failNext({ kind: "duplicate" });

    const run = await service.sync(connectionId, WINDOW);

    assert.deepEqual(run.counts, { received: 4, created: 2, updated: 0, unchanged: 2, stale: 0 });
    assert.equal(service.totals(connectionId).views, 300);
  });

  it("snapshot mais velho que chega depois não sobrescreve o mais novo", async () => {
    const { fake, service, connectionId } = setup();
    fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-02T10:00:00.000Z", 900, "2026-06-01T11:00:00.000Z"));
    await service.sync(connectionId, WINDOW);

    // Uma réplica atrasada do provedor devolve a medição das 10h, anterior à das 11h já guardada.
    fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-02T10:00:00.000Z", 700, "2026-06-01T10:00:00.000Z"));
    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.counts.stale, 1);
    const [post] = service.posts(connectionId);
    assert.equal(post?.views, 900);
    assert.equal(post?.captured_at, "2026-06-01T11:00:00.000Z");
  });

  it("timeout seguido de retry que devolve a mesma página não duplica", async () => {
    const { fake, service, connectionId } = setup();
    fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-02T10:00:00.000Z", 100));
    fake.failNext({ kind: "timeout" });

    const run = await service.sync(connectionId, WINDOW);

    assert.equal(run.status, "succeeded");
    assert.equal(fake.calls, 2);
    assert.equal(service.totals(connectionId).views, 100);
  });

  it("sync que falha no meio pode ser repetido sem duplicar o que já gravou", async () => {
    const { fake, service, connectionId } = setup({ pageSize: 1 });
    fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-02T10:00:00.000Z", 100));
    fake.upsertPost("instagram", TOKEN, snapshot("p2", "2026-05-03T10:00:00.000Z", 200));
    // Página 1 passa; página 2 falha nas 4 tentativas.
    const unavailable = { kind: "status", status: 503 } as const;
    fake.failNext({ kind: "pass" }, unavailable, unavailable, unavailable, unavailable);
    const failed = await service.sync(connectionId, WINDOW);

    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.code, "retries_exhausted");
    assert.equal(service.totals(connectionId).views, 100);

    const retried = await service.sync(connectionId, WINDOW);
    assert.equal(retried.status, "succeeded");
    assert.deepEqual(retried.counts, { received: 2, created: 1, updated: 0, unchanged: 1, stale: 0 });
    assert.equal(service.totals(connectionId).views, 300);
  });
});

describe("quando a métrica foi buscada", () => {
  it("guarda quando o provedor mediu e quando o serviço buscou", async () => {
    const { clock, fake, service, connectionId } = setup();
    fake.upsertPost("instagram", TOKEN, snapshot("p1", "2026-05-02T10:00:00.000Z", 100, "2026-06-01T09:00:00.000Z"));
    await service.sync(connectionId, WINDOW);

    clock.advance(60_000);
    await service.sync(connectionId, WINDOW);

    const [post] = service.posts(connectionId);
    assert.equal(post?.captured_at, "2026-06-01T09:00:00.000Z");
    assert.equal(post?.first_fetched_at, START);
    assert.equal(post?.last_fetched_at, "2026-06-01T12:01:00.000Z");
    const totals = service.totals(connectionId);
    assert.equal(totals.last_synced_at, "2026-06-01T12:01:00.000Z");
    assert.equal(totals.oldest_fetched_at, "2026-06-01T12:01:00.000Z");
    assert.equal(service.runs(connectionId).length, 2);
  });
});
