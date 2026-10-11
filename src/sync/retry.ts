import type { Clock } from "../clock.ts";
import { PermanentProviderError, RateLimitedError, TransientProviderError } from "../provider/client.ts";

export type RetryPolicy = {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxRetryAfterMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  maxRetryAfterMs: 60_000,
};

export type AttemptLog = {
  attempt: number;
  outcome: "ok" | "rate_limited" | "transient_error" | "rejected";
  detail: string | null;
  waited_ms: number;
};

export type SyncFailureCode = "rate_limited" | "retries_exhausted" | "provider_rejected";

export class SyncFailure extends Error {
  readonly code: SyncFailureCode;
  readonly retryAt: string | null;

  constructor(code: SyncFailureCode, message: string, retryAt: string | null = null) {
    super(message);
    this.code = code;
    this.retryAt = retryAt;
  }
}

function backoff(policy: RetryPolicy, failedAttempt: number): number {
  return Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** (failedAttempt - 1));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  clock: Clock,
  log: AttemptLog[],
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await operation();
      log.push({ attempt, outcome: "ok", detail: null, waited_ms: 0 });
      return result;
    } catch (error) {
      if (error instanceof PermanentProviderError) {
        log.push({ attempt, outcome: "rejected", detail: error.message, waited_ms: 0 });
        throw new SyncFailure("provider_rejected", error.message);
      }

      let waitMs: number;
      let entry: AttemptLog;
      if (error instanceof RateLimitedError) {
        waitMs = error.retryAfterMs ?? backoff(policy, attempt);
        entry = { attempt, outcome: "rate_limited", detail: error.message, waited_ms: 0 };
        if (waitMs > policy.maxRetryAfterMs) {
          log.push(entry);
          const retryAt = new Date(clock.now().getTime() + waitMs).toISOString();
          throw new SyncFailure(
            "rate_limited",
            `o provedor pediu ${waitMs} ms de espera, acima do teto de ${policy.maxRetryAfterMs} ms`,
            retryAt,
          );
        }
      } else if (error instanceof TransientProviderError) {
        waitMs = backoff(policy, attempt);
        entry = { attempt, outcome: "transient_error", detail: error.message, waited_ms: 0 };
      } else {
        throw error;
      }

      if (attempt >= policy.maxAttempts) {
        log.push(entry);
        const retryAt =
          entry.outcome === "rate_limited" ? new Date(clock.now().getTime() + waitMs).toISOString() : null;
        throw new SyncFailure(
          entry.outcome === "rate_limited" ? "rate_limited" : "retries_exhausted",
          `${policy.maxAttempts} tentativas sem sucesso; última falha: ${error.message}`,
          retryAt,
        );
      }

      entry.waited_ms = waitMs;
      log.push(entry);
      await clock.sleep(waitMs);
    }
  }
}
