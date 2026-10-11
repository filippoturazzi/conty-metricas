import type { Clock } from "../clock.ts";
import { ProviderClient } from "../provider/client.ts";
import { PLATFORMS, type Platform, type ProviderTransport } from "../provider/contract.ts";
import { type AttemptLog, DEFAULT_RETRY_POLICY, type RetryPolicy, SyncFailure, withRetry } from "./retry.ts";
import { type Connection, MetricsStore, type StoredPost, type SyncRun } from "./store.ts";

export type ServiceErrorCode = "validation_error" | "not_found" | "sync_in_progress";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type PublicConnection = Omit<Connection, "access_token">;

export type MetricsTotals = {
  connection_id: string;
  posts: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  last_synced_at: string | null;
  oldest_fetched_at: string | null;
};

const MAX_PAGES = 1_000;

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ServiceError("validation_error", `${field} é obrigatório`);
  }
  return value.trim();
}

function instant(value: unknown, field: string): string {
  const raw = text(value, field);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new ServiceError("validation_error", `${field} deve ser uma data ISO 8601`);
  return new Date(parsed).toISOString();
}

function publicConnection(connection: Connection): PublicConnection {
  const { access_token: _secret, ...rest } = connection;
  return { ...rest };
}

export class SyncService {
  readonly store: MetricsStore;
  private readonly client: ProviderClient;
  private readonly clock: Clock;
  private readonly policy: RetryPolicy;
  private readonly running = new Set<string>();

  constructor(options: {
    transport: ProviderTransport;
    clock: Clock;
    policy?: RetryPolicy;
    store?: MetricsStore;
  }) {
    this.clock = options.clock;
    this.client = new ProviderClient(options.transport, options.clock);
    this.policy = options.policy ?? DEFAULT_RETRY_POLICY;
    this.store = options.store ?? new MetricsStore();
  }

  /** Registra uma conexão já autorizada (o OAuth acontece fora deste serviço). */
  connect(input: { platform?: unknown; account_handle?: unknown; access_token?: unknown }): PublicConnection {
    const platform = text(input.platform, "platform");
    if (!PLATFORMS.includes(platform as Platform)) {
      throw new ServiceError("validation_error", `platform deve ser uma de: ${PLATFORMS.join(", ")}`);
    }
    const connection: Connection = {
      id: this.store.nextId("con"),
      platform: platform as Platform,
      account_handle: text(input.account_handle, "account_handle"),
      access_token: text(input.access_token, "access_token"),
      created_at: this.clock.now().toISOString(),
      last_synced_at: null,
    };
    this.store.connections.set(connection.id, connection);
    return publicConnection(connection);
  }

  connection(id: string): PublicConnection {
    return publicConnection(this.find(id));
  }

  posts(id: string): StoredPost[] {
    this.find(id);
    return this.store.postsOf(id).map((post) => ({ ...post }));
  }

  runs(id: string): SyncRun[] {
    this.find(id);
    return this.store.runsOf(id).map((run) => structuredClone(run));
  }

  totals(id: string): MetricsTotals {
    const connection = this.find(id);
    const posts = this.store.postsOf(id);
    const sum = (field: "views" | "likes" | "comments" | "shares") =>
      posts.reduce((total, post) => total + post[field], 0);
    const fetched = posts.map((post) => post.last_fetched_at).sort();
    return {
      connection_id: id,
      posts: posts.length,
      views: sum("views"),
      likes: sum("likes"),
      comments: sum("comments"),
      shares: sum("shares"),
      last_synced_at: connection.last_synced_at,
      oldest_fetched_at: fetched[0] ?? null,
    };
  }

  /** Sincroniza os posts publicados em [since, until). Pode repetir e sobrepor janelas sem duplicar. */
  async sync(id: string, input: { since?: unknown; until?: unknown }): Promise<SyncRun> {
    const connection = this.find(id);
    const since = instant(input.since, "since");
    const until = instant(input.until, "until");
    if (since >= until) throw new ServiceError("validation_error", "since deve ser anterior a until");
    if (this.running.has(id)) {
      throw new ServiceError("sync_in_progress", "já existe uma sincronização em andamento para esta conexão");
    }

    const run: SyncRun = {
      id: this.store.nextId("sync"),
      connection_id: id,
      window: { since, until },
      status: "running",
      started_at: this.clock.now().toISOString(),
      finished_at: null,
      pages: 0,
      counts: { received: 0, created: 0, updated: 0, unchanged: 0, stale: 0 },
      attempts: [],
      error: null,
    };
    this.store.runs.set(run.id, run);
    this.running.add(id);

    try {
      let cursor: string | null = null;
      do {
        if (run.pages >= MAX_PAGES) {
          throw new SyncFailure("provider_rejected", `mais de ${MAX_PAGES} páginas: cursor do provedor em loop?`);
        }
        const pageNumber = run.pages + 1;
        const log: AttemptLog[] = [];
        try {
          const page = await withRetry(
            () =>
              this.client.fetchPage({
                platform: connection.platform,
                accessToken: connection.access_token,
                since,
                until,
                cursor,
              }),
            this.policy,
            this.clock,
            log,
          );
          const fetchedAt = this.clock.now().toISOString();
          for (const snapshot of page.posts) {
            run.counts.received += 1;
            run.counts[this.store.applySnapshot(connection, snapshot, fetchedAt, run.id)] += 1;
          }
          run.pages = pageNumber;
          cursor = page.next_cursor;
        } finally {
          run.attempts.push(...log.map((entry) => ({ ...entry, page: pageNumber })));
        }
      } while (cursor !== null);

      run.status = "succeeded";
      connection.last_synced_at = this.clock.now().toISOString();
    } catch (error) {
      if (!(error instanceof SyncFailure)) throw error;
      // As páginas já gravadas ficam: como a gravação é idempotente, repetir o sync é seguro.
      run.status = "failed";
      run.error = { code: error.code, message: error.message, retry_at: error.retryAt };
    } finally {
      run.finished_at = this.clock.now().toISOString();
      this.running.delete(id);
    }
    return structuredClone(run);
  }

  private find(id: string): Connection {
    const connection = this.store.connections.get(id);
    if (!connection) throw new ServiceError("not_found", "conexão não encontrada");
    return connection;
  }
}
