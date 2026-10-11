import type { Clock } from "../clock.ts";
import {
  type MetricsPage,
  type PostSnapshot,
  type ProviderRequest,
  ProviderTimeoutError,
  type ProviderTransport,
} from "./contract.ts";


export class RateLimitedError extends Error {
  readonly retryAfterMs: number | null;

  constructor(retryAfterMs: number | null) {
    super("o provedor respondeu 429 (limite de taxa)");
    this.retryAfterMs = retryAfterMs;
  }
}

export class TransientProviderError extends Error {}

export class PermanentProviderError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

export function parseRetryAfter(value: string | undefined, now: Date): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now.getTime());
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseSnapshot(raw: unknown): PostSnapshot {
  const item = raw as Record<string, unknown> | null;
  if (
    item === null ||
    typeof item !== "object" ||
    typeof item.post_id !== "string" ||
    item.post_id === "" ||
    !isInstant(item.published_at) ||
    !isInstant(item.captured_at) ||
    !isCount(item.views) ||
    !isCount(item.likes) ||
    !isCount(item.comments) ||
    !isCount(item.shares)
  ) {
    throw new PermanentProviderError("post com formato inválido na resposta do provedor", null);
  }
  return {
    post_id: item.post_id,
    published_at: new Date(item.published_at).toISOString(),
    captured_at: new Date(item.captured_at).toISOString(),
    views: item.views,
    likes: item.likes,
    comments: item.comments,
    shares: item.shares,
  };
}

export class ProviderClient {
  private readonly transport: ProviderTransport;
  private readonly clock: Clock;

  constructor(transport: ProviderTransport, clock: Clock) {
    this.transport = transport;
    this.clock = clock;
  }

  async fetchPage(request: ProviderRequest): Promise<MetricsPage> {
    let response;
    try {
      response = await this.transport.listPostMetrics(request);
    } catch (error) {
      if (error instanceof ProviderTimeoutError) throw new TransientProviderError(error.message);
      throw error;
    }

    const { status } = response;
    if (status === 429) {
      throw new RateLimitedError(parseRetryAfter(header(response.headers, "retry-after"), this.clock.now()));
    }
    if (status === 408 || status >= 500) {
      throw new TransientProviderError(`o provedor respondeu ${status}`);
    }
    if (status === 401 || status === 403) {
      throw new PermanentProviderError("token recusado pelo provedor", status);
    }
    if (status !== 200) {
      throw new PermanentProviderError(`o provedor respondeu ${status}`, status);
    }

    const body = response.body as { posts?: unknown; next_cursor?: unknown } | null;
    if (body === null || typeof body !== "object" || !Array.isArray(body.posts)) {
      throw new PermanentProviderError("resposta do provedor sem lista de posts", null);
    }
    const nextCursor = body.next_cursor;
    if (nextCursor !== null && nextCursor !== undefined && typeof nextCursor !== "string") {
      throw new PermanentProviderError("cursor inválido na resposta do provedor", null);
    }
    return { posts: body.posts.map(parseSnapshot), next_cursor: nextCursor ?? null };
  }
}
