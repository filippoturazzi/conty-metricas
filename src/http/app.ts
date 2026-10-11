import type { Fault, FakeProvider } from "../provider/fake-provider.ts";
import type { Platform, PostSnapshot } from "../provider/contract.ts";
import { ServiceError, type ServiceErrorCode, type SyncService } from "../sync/sync-service.ts";

const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  validation_error: 400,
  not_found: 404,
  sync_in_progress: 409,
};

class BadRequest extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
  }
  throw new BadRequest("corpo da requisição deve ser um objeto JSON");
}

export type App = { handle(request: Request): Promise<Response> };


export function createApp(service: SyncService, fake?: FakeProvider): App {
  async function route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "GET" && pathname === "/health") return json({ ok: true });
    if (method === "POST" && pathname === "/connections") {
      return json(service.connect(await readBody(request)), 201);
    }

    const match = /^\/connections\/([^/]+)(?:\/(sync|syncs|posts|metrics))?$/.exec(pathname);
    if (match) {
      const id = decodeURIComponent(match[1] ?? "");
      const resource = match[2];
      if (method === "GET" && resource === undefined) return json(service.connection(id));
      if (method === "POST" && resource === "sync") {
        const run = await service.sync(id, await readBody(request));
  
        return json(run, run.status === "succeeded" ? 200 : 502);
      }
      if (method === "GET" && resource === "syncs") return json(service.runs(id));
      if (method === "GET" && resource === "posts") return json(service.posts(id));
      if (method === "GET" && resource === "metrics") return json(service.totals(id));
    }

    if (fake && method === "POST" && pathname === "/fake/posts") {
      const body = await readBody(request);
      fake.upsertPost(body.platform as Platform, String(body.access_token), body.post as PostSnapshot);
      return json({ ok: true }, 201);
    }
    if (fake && method === "POST" && pathname === "/fake/faults") {
      const body = await readBody(request);
      if (!Array.isArray(body.faults)) throw new BadRequest("faults deve ser uma lista");
      fake.failNext(...(body.faults as Fault[]));
      return json({ pending_faults: fake.pendingFaults() }, 201);
    }

    return json({ error: { code: "not_found", message: "rota não encontrada" } }, 404);
  }

  return {
    async handle(request) {
      try {
        return await route(request);
      } catch (error) {
        if (error instanceof ServiceError) {
          return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
        }
        if (error instanceof BadRequest) {
          return json({ error: { code: "validation_error", message: error.message } }, 400);
        }
        console.error(error);
        return json({ error: { code: "internal_error", message: "erro interno" } }, 500);
      }
    },
  };
}
