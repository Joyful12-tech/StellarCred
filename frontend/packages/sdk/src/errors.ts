// @stellarcred/sdk — normalized transient errors surfaced from transaction
// submission (Issue #744)
//
// The SDK reads against the Soroban RPC by constructing and submitting a
// `submit_*`-shaped transaction (simulation path). That submission can fail
// transiently — the RPC rate-limits (HTTP 429), returns 5xx while unhealthy,
// or drops/timed-out the transport. This module normalizes those failures to
// stable error `code`s with human-readable messages so callers can route and
// retry them predictably.
//
// Transient failures (429, 5xx, timeouts, dropped connections) are retried
// with exponential backoff + jitter via the existing `withRetry` wrapper —
// this module just adds the classification so `withRetry`/`isTransient`
// only retries what is genuinely retryable and surfaces a nicer reason than a
// raw exception.

export type TransientErrorCode =
  | "RPC_RATE_LIMITED"     // HTTP 429 / "Try again later" from the RPC
  | "RPC_SERVER_ERROR"     // 5xx from the RPC
  | "RPC_TIMEOUT"          // transport/request timeout
  | "RPC_NETWORK_ERROR"    // dropped/reset connection, DNS, etc.
  | "RPC_SIMULATION_FAILED"// contract simulation rejected the tx (non-consensus)
  | "UNKNOWN_RPC_ERROR";

/** Stable, machine-routable classification of a failed RPC submission. */
export interface TransientErrorInfo {
  readonly code: TransientErrorCode;
  /**
   * Human-readable, actionable message. Prefer reading this over introspecting
   * the raw exception — it is stable across transports and versions.
   */
  readonly message: string;
}

/** Result of full error classification: transient, permanent, or unclassified. */
type ClassifiedError =
  | { kind: "transient"; info: TransientErrorInfo }
  | { kind: "permanent"; info: TransientErrorInfo }
  | { kind: "unclassified"; info: TransientErrorInfo };

/**
 * Classify an error thrown while submitting or waiting on a transaction to the
 * Soroban RPC.
 *
 * Transient conditions are identified by:
 *   - HTTP status in `error.status`, `error.statusCode`, `error.response?.status`,
 *     or parseable from `error.message`
 *   - Transport keywords in `error.message` / `error.name` (`timed out`, `ECONNRESET`,
 *     `fetch failed`, `network`, `socket`, `timeout`, `ETIMEDOUT`, `ESOCKETTIMEDOUT`)
 *   - Generic errors we cannot positively classify as permanent are treated as
 *     transient so they get retried (matching the existing `isRetryable` default).
 */
export function classifyTransientError(error: unknown): TransientErrorInfo {
  const classified = classifyError(error);
  if (classified.kind === "transient") return classified.info;
  if (classified.kind === "permanent") return classified.info;
  return classified.info;
}

export function isTransient(error: unknown): boolean {
  const kind = classifyError(error).kind;
  // Retriable = transient OR unclassified (unclassified errors are retried
  // by the withRetry path, matching the existing isRetryable default).
  return kind === "transient" || kind === "unclassified";
}

export function isPermanent(error: unknown): boolean {
  return classifyError(error).kind === "permanent";
}

/**
 * Wrap an unexpected RPC failure for callers that want a consistent, typed error.
 *
 * Preserves the original exception as `cause` so callers can still inspect it,
 * but surfaces a stable `message` + `code` they can reason about without
 * parsing SDK-internal formats.
 */
export class RpcError extends Error {
  readonly code: TransientErrorCode;
  readonly cause?: unknown;
  constructor(message: string, code: TransientErrorCode, cause?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Classify `error` as transient, permanent, or unclassified.
 *
 * Returns `transient` for retryable RPC failures (429, 5xx, timeouts, network
 * drops), `permanent` for client/protocol failures that should not be retried
 * (invalid argument, bad request, parse error, not found unless rate-limited),
 * and `unclassified` for everything else (treated as transient by the retry
 * path, matching the existing `isRetryable` default).
 */
function classifyError(error: unknown): ClassifiedError {
  if (!error || typeof error !== "object") {
    return { kind: "unclassified", info: { code: "UNKNOWN_RPC_ERROR", message: formatUnknown(error) } };
  }

  const e = error as Record<string, unknown>;

  // ── Status fields ──────────────────────────────────────────────────────
  const status =
    extractStatus(e.status) ??
    extractStatus(e.statusCode) ??
    (e.response && typeof (e.response as Record<string, unknown>).status === "number"
      ? (e.response as { status: number }).status
      : undefined) ??
    extractStatus(parseStatusFromMessage(e.message));

  if (status === 429 || isRetryLaterMessage(e)) {
    return {
      kind: "transient",
      info: {
        code: "RPC_RATE_LIMITED",
        message: "The RPC rate-limited the request (HTTP 429). Back off and retry.",
      },
    };
  }
  if (status != null && status >= 500 && status < 600) {
    return {
      kind: "transient",
      info: {
        code: "RPC_SERVER_ERROR",
        message: `The RPC returned a server error (HTTP ${status}). The service may be temporarily unavailable — retry with backoff.`,
      },
    };
  }
  if (status != null && status >= 400 && status < 500 && isRetryLaterMessage(e)) {
    return {
      kind: "transient",
      info: {
        code: "RPC_RATE_LIMITED",
        message: "The RPC asked the client to retry (HTTP request with a retry signal). Back off and retry.",
      },
    };
  }

  // ── Transport / connectivity keywords ──────────────────────────────────
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  const name = typeof e.name === "string" ? e.name.toLowerCase() : "";

  if (
    // Timeouts
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    name === "timeouterror" ||
    name === "aborterror" ||
    // Network / DNS / dropped connections
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("fetch()") ||
    msg.includes("socket") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enetunreach") ||
    msg.includes("enotfound") ||
    msg.includes("invalid response") ||
    msg.includes("http_parser_error") ||
    msg.includes("socket hang up") ||
    // Abort / cancelled
    msg.includes("(cancelled)") ||
    msg.includes("abort") ||
    msg.includes("request was aborted")
  ) {
    return {
      kind: "transient",
      info: {
        code: "RPC_TIMEOUT",
        message: "The RPC request timed out or dropped connection mid-flight. The SDK is retrying — if this keeps failing, raise requestTimeoutMs or check network connectivity.",
      },
    };
  }

  // ── Permanent (client/protocol) failures — not worth retrying ──────────
  if (
    msg.includes("invalid argument") ||
    msg.includes("bad request") ||
    msg.includes("parse error") ||
    (msg.includes("not found") && !isRateLimited4xx(e))
  ) {
    return {
      kind: "permanent",
      info: {
        code: "RPC_SIMULATION_FAILED" as TransientErrorCode,
        message: "The request was rejected by the RPC as invalid client input (bad request, parse error, invalid argument, or not found). This is not retryable — fix the call parameters.",
      },
    };
  }

  // ── Unknown: treated as transient by the retry path (matches existing
  //    isRetryable default for unclassified errors) ───────────────────────
  return {
    kind: "unclassified",
    info: {
      code: "UNKNOWN_RPC_ERROR",
      message: "An unknown RPC failure occurred. The SDK will retry it — if it persists, inspect the underlying exception in `error.cause`.",
    },
  };
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatTransientErrorMessage(error: unknown): string {
  const classified = classifyError(error);
  if (classified.kind === "transient" || classified.kind === "permanent") {
    return classified.info.message;
  }
  return classified.info.message;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractStatus(s: unknown): number | undefined {
  if (s == null) return undefined;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 100 && n < 600) return n;
  return undefined;
}

/**
 * Pull an HTTP status out of a JSON-ish string like
 * `"Request failed with status code 429"` or `"HTTP 500 Internal Server Error"`.
 */
function parseStatusFromMessage(msg: unknown): number | undefined {
  if (typeof msg !== "string") return undefined;
  const m = msg.toLowerCase();
  const match =
    /status ?code\s*[:=]?\s*(\d{3})/.exec(m) ??
    /http\s+(\d{3})/.exec(m);
  if (match) return Number(match[1]);
  return undefined;
}

function isRetryLaterMessage(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (
    msg.includes("try again later") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("ratelimit") ||
    msg.includes("throttled")
  ) {
    return true;
  }
  return false;
}

function isRateLimited4xx(error: unknown): boolean {
  return isRetryLaterMessage(error);
}

function formatUnknown(error: unknown): string {
  if (error instanceof Error) {
    // `Error.cause` is ES2022; the SDK tsconfig targets ES2020, so gate on
    // the presence of the property rather than the type.
    if ("cause" in error && error.cause instanceof Error) {
      return `${error.message} (cause: ${error.cause.message})`;
    }
    return error.message || String(error);
  }
  if (typeof error === "string") return error;
  return String(error);
}
