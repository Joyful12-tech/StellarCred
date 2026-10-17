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
// @stellarcred/sdk — typed error taxonomy
//
// Structured errors that surface contract panics, RPC failures, and indexer
// issues as typed, actionable errors (#404). Every error code maps to the
// same human message everywhere (SDK, frontend, docs), with the contract's
// ProofRegistry error enum as the single source of truth.

/**
 * Maps ProofRegistry on-chain error codes to human-readable messages.
 * Kept in sync with the Rust contract's `Error` enum and the frontend's
 * `PROOF_REGISTRY_ERRORS` table (frontend/lib/contract-errors.ts).
 *
 * Contract error codes:
 *   NotInitialized          = 1
 *   VerificationFailed      = 2
 *   NotAuthorized           = 3
 *   IssuerNotTrusted        = 4
 *   IssuerKeyMismatch       = 5
 *   ProofNotFound           = 6
 *   BatchTooLarge           = 7
 *   BatchEmpty              = 8
 *   DuplicateCredentialType = 9
 *   AggregateLayoutInvalid  = 10
 *   SubmissionsPaused       = 11
 *   InvalidExpiry           = 12
 */
export const PROOF_REGISTRY_ERROR_MESSAGES: Record<number, string> = {
  1: "Contracts not initialised — check that all contract IDs are set in the environment.",
  2: "Proof verification failed — the ZK proof is invalid or was generated against the wrong circuit VK.",
  3: "Not authorised — wallet signature missing or wrong account.",
  4: "Issuer not trusted — the issuer address isn't registered for this credential type.",
  5: "Issuer key mismatch — this credential was signed with a key that doesn't match what's registered on-chain. Re-issue the credential and try again.",
  6: "Proof not found — no on-chain proof exists for this holder and credential type.",
  7: "Batch too large — reduce the number of proofs and try again.",
  8: "Batch is empty — include at least one proof submission.",
  9: "Duplicate credential type — the batch contains two proofs for the same claim type. Remove the duplicate and try again.",
  10: "Aggregate proof layout invalid — the number of credentials or public inputs don't match the expected format. Re-generate the aggregate proof.",
  11: "Submissions paused — the protocol admin has temporarily halted new proof submissions. Try again later.",
  12: "Invalid expiry — the credential expiry is either in the past or too far in the future. Re-issue with a valid validity window.",
};

/**
 * Contract error codes from the ProofRegistry contract's `Error` enum.
 * Exported as a const object so callers can switch on codes without hardcoding
 * magic numbers.
 */
export const ContractErrorCode = {
  NotInitialized: 1,
  VerificationFailed: 2,
  NotAuthorized: 3,
  IssuerNotTrusted: 4,
  IssuerKeyMismatch: 5,
  ProofNotFound: 6,
  BatchTooLarge: 7,
  BatchEmpty: 8,
  DuplicateCredentialType: 9,
  AggregateLayoutInvalid: 10,
  SubmissionsPaused: 11,
  InvalidExpiry: 12,
} as const;

export type ContractErrorCodeType = (typeof ContractErrorCode)[keyof typeof ContractErrorCode];

/**
 * Typed error surfaced when a ProofRegistry transaction fails with a contract
 * panic. Carries the numeric error code and a human message so callers can
 * branch programmatically (e.g. retry for transient errors, show terminal UI
 * for permanent failures) without parsing strings.
 *
 * @example
 * ```ts
 * try {
 *   await submitProof(...);
 * } catch (err) {
 *   if (err instanceof ContractError) {
 *     if (err.code === ContractErrorCode.IssuerNotTrusted) {
 *       // Show "issuer not registered" UI
 *     } else if (err.code === ContractErrorCode.VerificationFailed) {
 *       // Show "proof invalid" UI
 *     }
 *   }
 * }
 * ```
 */
export class ContractError extends Error {
  /**
   * Numeric error code from the contract's `Error` enum. Compare against
   * {@link ContractErrorCode} constants rather than hardcoding numbers.
   */
  code: number;

  /**
   * Human-readable error message from {@link PROOF_REGISTRY_ERROR_MESSAGES}.
   * Safe to display directly to users.
   */
  friendlyMessage: string;

  /**
   * Raw error string from the RPC/contract layer, e.g. `"Error(Contract, #4)"`.
   * Useful for debugging but not user-facing.
   */
  raw: string;

  constructor(code: number, friendlyMessage: string, raw: string) {
    super(friendlyMessage);
    this.name = "ContractError";
    this.code = code;
    this.friendlyMessage = friendlyMessage;
    this.raw = raw;
  }

  /**
   * Returns true if this error represents a transient/retryable failure
   * (e.g. submissions paused, RPC timeout) vs. a terminal failure that
   * requires user action (e.g. invalid proof, issuer not trusted).
   */
  isRetryable(): boolean {
    return this.code === ContractErrorCode.SubmissionsPaused;
  }

  /**
   * Returns true if this error indicates the holder needs to take action
   * before retrying (e.g. re-issue credential, register issuer).
   */
  isTerminal(): boolean {
    const terminalCodes: readonly number[] = [
      ContractErrorCode.VerificationFailed,
      ContractErrorCode.IssuerNotTrusted,
      ContractErrorCode.IssuerKeyMismatch,
      ContractErrorCode.InvalidExpiry,
      ContractErrorCode.NotInitialized,
    ];
    return terminalCodes.includes(this.code);
  }
}

/**
 * Parse a raw contract error string into a {@link ContractError}.
 * Handles multiple error formats from the RPC layer:
 * - `Error(Contract, #N)` → contract error code N
 * - `ContractError(N)` or `ContractError(Some(N))` → contract error code N
 * - Unrecognized → returns null (caller should handle as generic error)
 *
 * @example
 * ```ts
 * const err = parseContractError("Error(Contract, #4)");
 * if (err) {
 *   console.log(err.code); // 4
 *   console.log(err.friendlyMessage); // "Issuer not trusted..."
 * }
 * ```
 */
export function parseContractError(raw: string): ContractError | null {
  if (!raw) return null;

  // Match `Error(Contract, #N)` format
  let match = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (match) {
    const code = parseInt(match[1], 10);
    const message = PROOF_REGISTRY_ERROR_MESSAGES[code] ?? `Contract error #${code}.`;
    return new ContractError(code, message, raw);
  }

  // Match `ContractError(N)` or `ContractError(Some(N))` format (simulation errors)
  match = raw.match(/ContractError\((?:Some\()?(\d+)/);
  if (match) {
    const code = parseInt(match[1], 10);
    const message = PROOF_REGISTRY_ERROR_MESSAGES[code] ?? `Contract error #${code}.`;
    return new ContractError(code, message, raw);
  }

  return null;
}

/**
 * Error thrown when an RPC request to the Soroban network fails.
 * Distinguishes between network failures (timeout, unreachable), server errors
 * (500), and transaction failures (contract panic).
 */
export class RpcError extends Error {
  cause?: unknown;
  /** HTTP status code when the RPC responded with an error status. */
  status?: number;
  /** Parsed contract error if the RPC failure was due to a contract panic. */
  contractError?: ContractError;

  constructor(
    message = "Soroban RPC request failed",
    options?: { cause?: unknown; status?: number; contractError?: ContractError },
  ) {
    super(message);
    this.name = "RpcError";
    this.cause = options?.cause;
    this.status = options?.status;
    this.contractError = options?.contractError;
  }

  /**
   * Returns true if this RPC error wraps a contract panic (as opposed to
   * a network/timeout issue).
   */
  isContractError(): boolean {
    return this.contractError !== undefined;
  }
}

/**
 * Error thrown when an indexer request fails or returns malformed data.
 * Already exists in indexer.ts; re-exported here for completeness.
 */
export { IndexerError } from "./indexer";
