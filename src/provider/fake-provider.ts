import {
  type Platform,
  type PostSnapshot,
  type ProviderRequest,
  type ProviderResponse,
  ProviderTimeoutError,
  type ProviderTransport,
} from "./contract.ts";

export type Fault =
  | { kind: "pass" }
  | { kind: "timeout" }
  | { kind: "status"; status: number }
  | { kind: "rate_limit"; retryAfter?: string }
  | { kind: "duplicate" };

export const REVOKED_TOKEN = "revogado";

export class FakeProvider implements ProviderTransport {
  readonly pageSize: number;
  calls = 0;
  private readonly posts = new Map<string, PostSnapshot[]>();
  private readonly faults: Fault[] = [];

  constructor(options: { pageSize?: number } = {}) {
    this.pageSize = options.pageSize ?? 2;
  }

  upsertPost(platform: Platform, accessToken: string, snapshot: PostSnapshot): void {
    const key = `${platform}:${accessToken}`;
    const list = this.posts.get(key) ?? [];
    const index = list.findIndex((post) => post.post_id === snapshot.post_id);
    if (index === -1) list.push({ ...snapshot });
    else list[index] = { ...snapshot };
    this.posts.set(key, list);
  }

  failNext(...faults: Fault[]): void {
    this.faults.push(...faults);
  }

  pendingFaults(): number {
    return this.faults.length;
  }

  async listPostMetrics(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls += 1;
    const fault = this.faults.shift();
    if (fault?.kind === "timeout") throw new ProviderTimeoutError();
    if (fault?.kind === "status") return { status: fault.status, headers: {}, body: { error: "falha simulada" } };
    if (fault?.kind === "rate_limit") {
      const headers: Record<string, string> = fault.retryAfter === undefined ? {} : { "Retry-After": fault.retryAfter };
      return { status: 429, headers, body: { error: "rate limited" } };
    }

    if (request.accessToken.trim() === "" || request.accessToken === REVOKED_TOKEN) {
      return { status: 401, headers: {}, body: { error: "invalid token" } };
    }

    const since = Date.parse(request.since);
    const until = Date.parse(request.until);
    const inWindow = (this.posts.get(`${request.platform}:${request.accessToken}`) ?? [])
      .filter((post) => {
        const published = Date.parse(post.published_at);
        return published >= since && published < until;
      })
      .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.post_id.localeCompare(b.post_id));

    const offset = request.cursor === null ? 0 : Number(request.cursor);
    let page = inWindow.slice(offset, offset + this.pageSize).map((post) => ({ ...post }));
    if (fault?.kind === "duplicate") page = page.flatMap((post) => [post, { ...post }]);
    const next = offset + this.pageSize < inWindow.length ? String(offset + this.pageSize) : null;

    return { status: 200, headers: {}, body: { posts: page, next_cursor: next } };
  }
}
