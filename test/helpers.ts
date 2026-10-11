import type { Clock } from "../src/clock.ts";
import type { PostSnapshot } from "../src/provider/contract.ts";
import { FakeProvider } from "../src/provider/fake-provider.ts";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "../src/sync/retry.ts";
import { SyncService } from "../src/sync/sync-service.ts";

export class ManualClock implements Clock {
  current: number;
  readonly sleeps: number[] = [];

  constructor(start: string) {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export const START = "2026-06-01T12:00:00.000Z";
export const TOKEN = "tok_ficticio";

export function setup(options: { policy?: Partial<RetryPolicy>; pageSize?: number } = {}) {
  const clock = new ManualClock(START);
  const fake = new FakeProvider({ pageSize: options.pageSize ?? 2 });
  const service = new SyncService({
    transport: fake,
    clock,
    policy: { ...DEFAULT_RETRY_POLICY, ...options.policy },
  });
  const connection = service.connect({ platform: "instagram", account_handle: "@ana", access_token: TOKEN });
  return { clock, fake, service, connectionId: connection.id };
}

export function snapshot(postId: string, publishedAt: string, views: number, capturedAt = START): PostSnapshot {
  return {
    post_id: postId,
    published_at: publishedAt,
    captured_at: capturedAt,
    views,
    likes: Math.floor(views / 10),
    comments: Math.floor(views / 100),
    shares: 0,
  };
}

export const WINDOW = { since: "2026-05-01T00:00:00.000Z", until: "2026-06-01T00:00:00.000Z" };
