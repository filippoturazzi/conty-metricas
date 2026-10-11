import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../src/http/app.ts";
import type { ProviderRequest, ProviderResponse, ProviderTransport } from "../src/provider/contract.ts";
import { SyncService } from "../src/sync/sync-service.ts";
import { ManualClock, START, setup, snapshot, TOKEN, WINDOW } from "./helpers.ts";

function http(app: ReturnType<typeof createApp>) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await app.handle(
      new Request(`http://test${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
}

describe("API", () => {
  it("conecta, sincroniza e expõe posts, totais e histórico", async () => {
    const { fake, service } = setup();
    const call = http(createApp(service));

    const created = await call("POST", "/connections", {
      platform: "youtube",
      account_handle: "@canal",
      access_token: TOKEN,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.access_token, undefined, "o token não sai pela API");
    const id = created.body.id as string;

    fake.upsertPost("youtube", TOKEN, snapshot("v1", "2026-05-02T10:00:00.000Z", 1_000));
    const synced = await call("POST", `/connections/${id}/sync`, WINDOW);
    assert.equal(synced.status, 200);
    assert.equal(synced.body.status, "succeeded");

    const posts = await call("GET", `/connections/${id}/posts`);
    assert.equal(posts.body.length, 1);
    assert.equal(posts.body[0].last_fetched_at, START);

    const metrics = await call("GET", `/connections/${id}/metrics`);
    assert.equal(metrics.body.views, 1_000);
    assert.equal(metrics.body.last_synced_at, START);

    const syncs = await call("GET", `/connections/${id}/syncs`);
    assert.equal(syncs.body.length, 1);
  });

  it("sync que falhou responde 502 com o motivo e quando tentar de novo", async () => {
    const { fake, service, connectionId } = setup();
    fake.failNext({ kind: "rate_limit", retryAfter: "3600" });
    const res = await http(createApp(service))("POST", `/connections/${connectionId}/sync`, WINDOW);

    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, "rate_limited");
    assert.equal(res.body.error.retry_at, "2026-06-01T13:00:00.000Z");
  });

  it("valida a conexão e a janela", async () => {
    const { service, connectionId } = setup();
    const call = http(createApp(service));

    assert.equal((await call("POST", "/connections", { platform: "orkut", account_handle: "@a", access_token: "t" })).status, 400);
    assert.equal((await call("POST", "/connections", { platform: "x", account_handle: "@a" })).status, 400);
    assert.equal((await call("POST", `/connections/${connectionId}/sync`, { since: WINDOW.since })).status, 400);
    assert.equal(
      (await call("POST", `/connections/${connectionId}/sync`, { since: WINDOW.until, until: WINDOW.since })).status,
      400,
    );
    assert.equal((await call("GET", "/connections/con_999/metrics")).status, 404);
  });

  it("recusa um segundo sync da mesma conexão enquanto o primeiro roda", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ProviderTransport = {
      async listPostMetrics(_request: ProviderRequest): Promise<ProviderResponse> {
        await gate;
        return { status: 200, headers: {}, body: { posts: [], next_cursor: null } };
      },
    };
    const service = new SyncService({ transport: slow, clock: new ManualClock(START) });
    const { id } = service.connect({ platform: "x", account_handle: "@a", access_token: TOKEN });
    const call = http(createApp(service));

    const first = call("POST", `/connections/${id}/sync`, WINDOW);
    const second = await call("POST", `/connections/${id}/sync`, WINDOW);
    release();

    assert.equal(second.status, 409);
    assert.equal((await first).status, 200);
  });
});
