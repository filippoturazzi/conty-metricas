import { createServer } from "node:http";
import { systemClock } from "./clock.ts";
import { createApp } from "./http/app.ts";
import { FakeProvider } from "./provider/fake-provider.ts";
import { SyncService } from "./sync/sync-service.ts";

const fake = new FakeProvider({ pageSize: 2 });
const service = new SyncService({
  transport: fake,
  clock: systemClock,
  policy: { maxAttempts: 4, baseBackoffMs: 200, maxBackoffMs: 2_000, maxRetryAfterMs: 5_000 },
});
const app = createApp(service, fake);
const port = Number(process.env.PORT ?? 3004);

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === "GET" || req.method === "HEAD" || chunks.length === 0 ? undefined : Buffer.concat(chunks),
  });
  const response = await app.handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});

server.listen(port, () => {
  console.log(`métricas em http://127.0.0.1:${port}`);
});
