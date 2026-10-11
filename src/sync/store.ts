import type { Platform, PostSnapshot } from "../provider/contract.ts";
import type { AttemptLog, SyncFailureCode } from "./retry.ts";

export type Connection = {
  id: string;
  platform: Platform;
  account_handle: string;
  access_token: string;
  created_at: string;
  last_synced_at: string | null;
};

export type StoredPost = {
  connection_id: string;
  platform: Platform;
  post_id: string;
  published_at: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  captured_at: string;
  first_fetched_at: string;
  last_fetched_at: string;
  last_sync_id: string;
};

export type ApplyOutcome = "created" | "updated" | "unchanged" | "stale";

export type SyncRun = {
  id: string;
  connection_id: string;
  window: { since: string; until: string };
  status: "running" | "succeeded" | "failed";
  started_at: string;
  finished_at: string | null;
  pages: number;
  counts: Record<ApplyOutcome | "received", number>;
  attempts: Array<AttemptLog & { page: number }>;
  error: { code: SyncFailureCode; message: string; retry_at: string | null } | null;
};

export class MetricsStore {
  readonly connections = new Map<string, Connection>();
  readonly runs = new Map<string, SyncRun>();
  private readonly posts = new Map<string, StoredPost>();
  private readonly sequences = new Map<string, number>();

  nextId(prefix: string): string {
    const next = (this.sequences.get(prefix) ?? 0) + 1;
    this.sequences.set(prefix, next);
    return `${prefix}_${next}`;
  }


  applySnapshot(connection: Connection, snapshot: PostSnapshot, fetchedAt: string, syncId: string): ApplyOutcome {
    const key = `${connection.id}:${snapshot.post_id}`;
    const current = this.posts.get(key);
    const numbers = {
      views: snapshot.views,
      likes: snapshot.likes,
      comments: snapshot.comments,
      shares: snapshot.shares,
    };

    if (!current) {
      this.posts.set(key, {
        connection_id: connection.id,
        platform: connection.platform,
        post_id: snapshot.post_id,
        published_at: snapshot.published_at,
        ...numbers,
        captured_at: snapshot.captured_at,
        first_fetched_at: fetchedAt,
        last_fetched_at: fetchedAt,
        last_sync_id: syncId,
      });
      return "created";
    }

    if (snapshot.captured_at > current.captured_at) {
      Object.assign(current, numbers, {
        captured_at: snapshot.captured_at,
        last_fetched_at: fetchedAt,
        last_sync_id: syncId,
      });
      return "updated";
    }

    if (snapshot.captured_at === current.captured_at) {
      current.last_fetched_at = fetchedAt;
      current.last_sync_id = syncId;
      return "unchanged";
    }

    return "stale";
  }

  postsOf(connectionId: string): StoredPost[] {
    return [...this.posts.values()]
      .filter((post) => post.connection_id === connectionId)
      .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.post_id.localeCompare(b.post_id));
  }

  runsOf(connectionId: string): SyncRun[] {
    return [...this.runs.values()].filter((run) => run.connection_id === connectionId);
  }
}
