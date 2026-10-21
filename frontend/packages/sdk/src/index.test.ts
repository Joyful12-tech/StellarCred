import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isVerified = vi.fn();
const checkClaim = vi.fn();
const getRecord = vi.fn();

vi.mock("../../proof-registry/src/index", () => ({
  Client: vi.fn(function ProofRegistryClient() {
    return {
      is_verified: isVerified,
      check_claim: checkClaim,
      get_record: getRecord,
    };
  }),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {},
  StrKey: {
    isValidEd25519PublicKey: vi.fn(
      (address: string) => address === "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    ),
  },
}));

import {
  configure,
  hasClaim,
  getClaims,
  getClaimRecord,
  buildVerifyUrl,
  checkClaimStatus,
  verifyPreset,
  ConfigError,
  InvalidAddressError,
  RpcError,
  TimeoutError,
  StellarCred,
  withRetry,
  __resetBoundaryWarningForTesting,
} from "./index";
import { hasClaim as sharedHasClaim } from "./claims";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

describe("error taxonomy exports", () => {
  it("exports ConfigError, RpcError, and TimeoutError on the namespace", () => {
    expect(StellarCred.ConfigError).toBe(ConfigError);
    expect(StellarCred.RpcError).toBe(RpcError);
    expect(StellarCred.TimeoutError).toBe(TimeoutError);
    expect(StellarCred.InvalidAddressError).toBe(InvalidAddressError);
    expect(new ConfigError().name).toBe("ConfigError");
    expect(new RpcError().name).toBe("RpcError");
    expect(new InvalidAddressError().name).toBe("InvalidAddressError");
  });
});

describe("hasClaim â€” address validation", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({ registryId: "C_TEST_REGISTRY" });
  });

  it("returns false for an invalid Stellar address without making an RPC call", async () => {
    await expect(hasClaim("invalid-address", "kyc")).resolves.toBe(false);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("returns false for an empty address without making an RPC call", async () => {
    await expect(hasClaim("", "kyc")).resolves.toBe(false);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("returns false for a whitespace-only address without making an RPC call", async () => {
    await expect(hasClaim("   ", "kyc")).resolves.toBe(false);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("trims a valid Stellar address before making the RPC call", async () => {
    isVerified.mockResolvedValue({
      result: [true, 1_700_000_000n, 1_800_000_000n],
    });

    await expect(hasClaim(`  ${WALLET}  `, "kyc")).resolves.toBe(true);

    expect(isVerified).toHaveBeenCalledTimes(1);
    expect(isVerified).toHaveBeenCalledWith({
      holder: WALLET,
      credential_type: "kyc",
      trusted_issuers: undefined,
    });
  });

  it("throws InvalidAddressError for an invalid address when throwOnError is enabled", async () => {
    await expect(
      hasClaim("invalid-address", "kyc", { throwOnError: true }),
    ).rejects.toBeInstanceOf(InvalidAddressError);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("does not make an RPC call for an invalid threshold claim", async () => {
    await expect(
      hasClaim("invalid-address", "age", { minThreshold: 21 }),
    ).resolves.toBe(false);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });
});

describe("hasClaim â€” fail-soft default", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({ registryId: "" });
  });

  it("returns false when registryId is missing (no throw)", async () => {
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
    expect(isVerified).not.toHaveBeenCalled();
  });

  it("returns false when is_verified throws (network/simulation)", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue(new Error("network down"));
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("returns false when the holder is not verified", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockResolvedValue({ result: [false, 0n, 0n] });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("returns true when the holder is verified", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockResolvedValue({ result: [true, 1_700_000_000n, 1_800_000_000n] });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
  });

  it("returns false when check_claim throws under fail-soft", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    checkClaim.mockRejectedValue(new Error("rpc timeout"));
    await expect(hasClaim(WALLET, "age", { minThreshold: 21 })).resolves.toBe(false);
  });
});

describe("hasClaim â€” throwOnError", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
  });

  afterEach(() => {
    configure({ registryId: "C_TEST_REGISTRY" });
  });

  it("throws ConfigError when registryId is missing", async () => {
    configure({ registryId: "" });
    await expect(hasClaim(WALLET, "kyc", { throwOnError: true })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("throws RpcError when is_verified fails, not ConfigError", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue(new Error("connection reset"));
    const err = await hasClaim(WALLET, "kyc", { throwOnError: true }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).not.toBeInstanceOf(ConfigError);
    expect((err as RpcError).cause).toBeInstanceOf(Error);
  });

  it("throws RpcError when check_claim fails", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    checkClaim.mockRejectedValue(new Error("simulation failed"));
    await expect(
      hasClaim(WALLET, "funds", { minThreshold: 50_000, throwOnError: true }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it("still returns false for not-verified (does not throw)", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockResolvedValue({ result: [false, 0n, 0n] });
    await expect(hasClaim(WALLET, "kyc", { throwOnError: true })).resolves.toBe(false);
  });

  it("returns true for verified claims", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockResolvedValue({ result: [true, 10n, 20n] });
    await expect(hasClaim(WALLET, "kyc", { throwOnError: true })).resolves.toBe(true);
  });
});

describe("read request timeout", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({
      registryId: "C_TEST_REGISTRY",
      requestTimeoutMs: 25,
      retries: 0,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when is_verified never settles", async () => {
    isVerified.mockImplementation(() => new Promise(() => {}));

    const result = hasClaim(WALLET, "kyc");
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBe(false);
  });

  it("applies the configured timeout to shared framework reads", async () => {
    vi.useRealTimers();
    isVerified.mockImplementation(() => new Promise(() => {}));

    await expect(sharedHasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("returns false when check_claim never settles", async () => {
    checkClaim.mockImplementation(() => new Promise(() => {}));

    const result = hasClaim(WALLET, "age", { minThreshold: 21 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBe(false);
  });

  it("returns an empty list when getClaims reads never settle", async () => {
    isVerified.mockImplementation(() => new Promise(() => {}));

    const result = getClaims(WALLET);
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual([]);
    expect(isVerified).toHaveBeenCalledTimes(6);
  });

  it("preserves RpcError when a timed out read opts into errors", async () => {
    isVerified.mockImplementation(() => new Promise(() => {}));

    const result = hasClaim(WALLET, "kyc", {
      requestTimeoutMs: 25,
      throwOnError: true,
    });
    const assertion = expect(result).rejects.toBeInstanceOf(RpcError);
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
  });
});

describe("getClaims â€” address validation", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({ registryId: "C_TEST_REGISTRY" });
  });

  it("returns an empty list for an invalid address without making RPC calls", async () => {
    await expect(getClaims("invalid-address")).resolves.toEqual([]);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("returns an empty list for an empty address without making RPC calls", async () => {
    await expect(getClaims("")).resolves.toEqual([]);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("throws InvalidAddressError when getClaims receives an invalid address and throwOnError is enabled", async () => {
    await expect(
      getClaims("invalid-address", { throwOnError: true }),
    ).rejects.toBeInstanceOf(InvalidAddressError);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });
});

describe("getClaims â€” throwOnError", () => {
  beforeEach(() => {
    isVerified.mockReset();
  });

  it("fail-soft returns [] when unconfigured", async () => {
    configure({ registryId: "" });
    await expect(getClaims(WALLET)).resolves.toEqual([]);
  });

  it("throws ConfigError when unconfigured and throwOnError", async () => {
    configure({ registryId: "" });
    await expect(getClaims(WALLET, { throwOnError: true })).rejects.toBeInstanceOf(ConfigError);
  });

  it("throws RpcError when a read fails under throwOnError", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue(new Error("boom"));
    await expect(getClaims(WALLET, { throwOnError: true })).rejects.toBeInstanceOf(RpcError);
  });
});

describe("SDK withRetry with exponential backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default config for testing
    configure({
      retries: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return immediately if operation succeeds", async () => {
    const operation = vi.fn().mockResolvedValue("success");
    const promise = withRetry(operation);
    const result = await promise;
    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should fail fast if error is non-retryable", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("invalid argument provided"));

    await expect(withRetry(operation)).rejects.toThrow("invalid argument provided");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should retry transient errors with exponential backoff + jitter and eventually succeed", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce("success");

    const promise = withRetry(operation);
    // First attempt fails -> wait one backoff window (~100ms)
    await vi.advanceTimersByTimeAsync(100);
    expect(operation).toHaveBeenCalledTimes(2);
    // Second attempt fails -> wait next backoff window (~200ms)
    await vi.advanceTimersByTimeAsync(200);
    expect(operation).toHaveBeenCalledTimes(3);
    // Third attempt succeeds
    await promise;
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("should throw after max retries are exceeded on transient errors", async () => {
    vi.useRealTimers();
    configure({ retries: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: false });
    const operation = vi.fn().mockRejectedValue(new Error("network error"));

    const start = Date.now();
    await expect(withRetry(operation)).rejects.toThrow("network error");
    const elapsed = Date.now() - start;
    expect(operation).toHaveBeenCalledTimes(4); // initial + 3 retries
    // Backoff (no jitter): 10 + 20 + 40 = 70 ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("should jitter the backoff in the configured range", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    configure({ retries: 1, baseDelayMs: 100, maxDelayMs: 1000, jitter: true });
    const operation = vi.fn().mockRejectedValue(new Error("network error"));
    const start = Date.now();
    const promise = withRetry(operation).catch(() => {});
    // With jitter enabled, baseDelayMs * 2^1 = 200ms window, halved by jitter -> 50-150ms
    await vi.advanceTimersByTimeAsync(150);
    await promise;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThanOrEqual(150);
    vi.useRealTimers();
  });

  it("should disable jitter when jitter is false", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    configure({ retries: 1, baseDelayMs: 100, maxDelayMs: 1000, jitter: false });
    const operation = vi.fn().mockRejectedValue(new Error("network error"));
    const start = Date.now();
    const promise = withRetry(operation).catch(() => {});
    // Without jitter, baseDelayMs * 2^1 = 200ms exactly
    await vi.advanceTimersByTimeAsync(200);
    await promise;
    const elapsed = Date.now() - start;
    expect(elapsed).toBe(200);
    vi.useRealTimers();
  });

  it("should retry 429 and 5xx transient errors", async () => {
    vi.useRealTimers();
    configure({ retries: 2, baseDelayMs: 10, maxDelayMs: 50, jitter: false });

    const operation = vi.fn()
      .mockRejectedValueOnce({ status: 429, message: "Too many requests" })
      .mockRejectedValueOnce({ status: 503, message: "Service Unavailable" })
      .mockResolvedValueOnce("ok");

    const start = Date.now();
    await expect(withRetry(operation)).resolves.toBe("ok");
    const elapsed = Date.now() - start;
    expect(operation).toHaveBeenCalledTimes(3);
    // Backoff (no jitter): 10 + 20 = 30 ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("should NOT retry 400 bad request errors", async () => {
    configure({ retries: 3, baseDelayMs: 50, maxDelayMs: 500 });

    const operation = vi.fn().mockRejectedValue(new Error("bad request"));

    await expect(withRetry(operation)).rejects.toThrow("bad request");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

// ── normalized error types exposed to callers (Issue #744) ────────────────

describe("normalized RPC errors exposed to callers", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({ registryId: "C_TEST_REGISTRY", retries: 0 });
  });

  it("surfaces a stable RpcError.code for transient failures", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue({ status: 429, message: "Too many requests" });

    const err = await hasClaim(WALLET, "kyc", { throwOnError: true }).catch((e: any) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as any).code).toBe("RPC_RATE_LIMITED");
    expect(typeof (err as any).message).toBe("string");
    expect((err as any).cause).toEqual({ status: 429, message: "Too many requests" });
  });

  it("surfaces a stable RpcError.code for server errors", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue({ status: 503, message: "Service Unavailable" });

    const err = await hasClaim(WALLET, "kyc", { throwOnError: true }).catch((e: any) => e);
    expect((err as any).code).toBe("RPC_SERVER_ERROR");
  });

  it("surfaces a stable RpcError.code for timeout failures", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue(new Error("request timed out"));

    const err = await hasClaim(WALLET, "kyc", { throwOnError: true }).catch((e: any) => e);
    expect((err as any).code).toBe("RPC_TIMEOUT");
  });

  it("keeps cause even when an actionable message is surfaced", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue({ status: 500, message: "Internal Server Error" });

    const err = await hasClaim(WALLET, "kyc", { throwOnError: true }).catch((e: any) => e);
    expect((err as any).cause).toEqual({ status: 500, message: "Internal Server Error" });
    expect(typeof (err as any).message).toBe("string");
    expect((err as any).message.toLowerCase()).toContain("retry");
  });

  it("still throws RpcError when simulation fails (non-transient)", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue(new Error("invalid argument provided"));

    const err = await hasClaim(WALLET, "kyc", { throwOnError: true }).catch((e: any) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as any).code).toBe("RPC_SIMULATION_FAILED");
  });
});

// ── transient error classification (Issue #744) ──────────────────────────

import { classifyTransientError, isTransient, formatTransientErrorMessage } from "./errors";

describe("transient error classification (Issue #744)", () => {
  it("classifies HTTP 429 as RPC_RATE_LIMITED", () => {
    const err = { status: 429, message: "Too many requests" };
    expect(classifyTransientError(err).code).toBe("RPC_RATE_LIMITED");
    expect(isTransient(err)).toBe(true);
  });

  it("classifies HTTP 429 in the message field", () => {
    const err = new Error("Request failed with status code 429");
    expect(classifyTransientError(err).code).toBe("RPC_RATE_LIMITED");
  });

  it("classifies HTTP 503 as RPC_SERVER_ERROR", () => {
    const err = { status: 503, message: "Service Unavailable" };
    expect(classifyTransientError(err).code).toBe("RPC_SERVER_ERROR");
    expect(classifyTransientError(err).message).toContain("503");
    expect(isTransient(err)).toBe(true);
  });

  it("classifies a transport timeout as RPC_TIMEOUT", () => {
    const err = new Error("request timed out after 10000ms");
    expect(classifyTransientError(err).code).toBe("RPC_TIMEOUT");
    expect(isTransient(err)).toBe(true);
  });

  it("classifies ECONNRESET as RPC_TIMEOUT", () => {
    const err = { message: "read ECONNRESET", name: "error" };
    expect(classifyTransientError(err).code).toBe("RPC_TIMEOUT");
    expect(isTransient(err)).toBe(true);
  });

  it("classifies fetch failures as RPC_TIMEOUT", () => {
    const err = { message: "fetch failed", name: "error" };
    expect(classifyTransientError(err).code).toBe("RPC_TIMEOUT");
    expect(isTransient(err)).toBe(true);
  });

  it("classifies a dropped-network message as RPC_TIMEOUT", () => {
    const err = new Error("network down");
    expect(classifyTransientError(err).code).toBe("RPC_TIMEOUT");
  });

  it("classifies an AbortError-style name as RPC_TIMEOUT", () => {
    const err = { message: "request was aborted", name: "AbortedError" };
    expect(classifyTransientError(err).code).toBe("RPC_TIMEOUT");
  });

  it("classifies unknown errors as UNKNOWN_RPC_ERROR (transient, retried)", () => {
    const err = new Error("something broke");
    const info = classifyTransientError(err);
    expect(info.code).toBe("UNKNOWN_RPC_ERROR");
    expect(isTransient(err)).toBe(true);
  });

  it("does NOT treat invalid argument as transient", () => {
    const err = new Error("invalid argument provided");
    expect(isTransient(err)).toBe(false);
    expect(classifyTransientError(err).code).toBe("RPC_SIMULATION_FAILED");
  });

  it("does NOT treat bad request as transient", () => {
    const err = new Error("bad request");
    expect(isTransient(err)).toBe(false);
  });

  it("does NOT treat parse error as transient", () => {
    const err = { message: "parse error", name: "Error" };
    expect(isTransient(err)).toBe(false);
  });

  it("does NOT treat not found as transient", () => {
    const err = { message: "not found", status: 404 };
    expect(isTransient(err)).toBe(false);
  });

  it("still treats not-found-like rate-limit wording as transient", () => {
    const err = { message: "not found: try again later" };
    expect(isTransient(err)).toBe(true);
    expect(classifyTransientError(err).code).toBe("RPC_RATE_LIMITED");
  });

  it("returns a stable, actionable message for transient failures", () => {
    const err = { status: 502, message: "Bad Gateway" };
    const msg = formatTransientErrorMessage(err);
    expect(msg).toContain("502");
    expect(msg.toLowerCase()).toContain("retry");
  });

  it("returns a readable message for non-transient failures", () => {
    const err = new Error("invalid argument provided");
    const msg = formatTransientErrorMessage(err);
    expect(msg).toContain("not retryable");
    expect(msg).toContain("invalid client input");
  });

  it("returns a readable message for null/undefined errors", () => {
    expect(classifyTransientError(null).code).toBe("UNKNOWN_RPC_ERROR");
    expect(typeof formatTransientErrorMessage(undefined)).toBe("string");
  });
});

// â”€â”€ verifyPreset (#386) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("verifyPreset", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({ registryId: "C_TEST_REGISTRY" });
  });

  it("is allValid when every claim in the preset passes", async () => {
    isVerified.mockResolvedValue({ result: [true, 1_700_000_000n, 1_800_000_000n] });

    const { allValid, results } = await verifyPreset(WALLET, [
      { type: "kyc" },
      { type: "jurisdiction" },
    ]);

    expect(allValid).toBe(true);
    expect(results).toEqual({ kyc: true, jurisdiction: true });
  });

  it("is not allValid when any single claim fails, but still reports every result", async () => {
    isVerified.mockImplementation(async ({ credential_type }: { credential_type: string }) => ({
      result: [credential_type === "kyc", 1_700_000_000n, 1_800_000_000n],
    }));

    const { allValid, results } = await verifyPreset(WALLET, [
      { type: "kyc" },
      { type: "jurisdiction" },
    ]);

    expect(allValid).toBe(false);
    expect(results).toEqual({ kyc: true, jurisdiction: false });
  });

  it("routes a thresholded claim through check_claim with the preset's minThreshold", async () => {
    checkClaim.mockResolvedValue({ result: true });

    const { allValid } = await verifyPreset(WALLET, [
      { type: "accreditation", minThreshold: 1_000_000 },
    ]);

    expect(allValid).toBe(true);
    expect(checkClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        credential_type: "accreditation",
        min_threshold: 1_000_000n,
      }),
    );
  });

  it("is not allValid for an empty preset", async () => {
    const { allValid, results } = await verifyPreset(WALLET, []);
    expect(allValid).toBe(false);
    expect(results).toEqual({});
    expect(isVerified).not.toHaveBeenCalled();
  });

  it("is exported on the StellarCred namespace", () => {
    expect(StellarCred.verifyPreset).toBe(verifyPreset);
  });
});

// â”€â”€ Client/server boundary warning (Issue #535) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("warnOnClientServerBoundaryViolation", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Reset the one-shot flag before every test so each case starts fresh.
    __resetBoundaryWarningForTesting();
    // Ensure no leaked env vars linger from a previous test.
    delete (process.env as Record<string, string | undefined>)["STELLARCRED_REGISTRY_ID"];
    delete (process.env as Record<string, string | undefined>)["PROOF_REGISTRY_ID"];
    delete (process.env as Record<string, string | undefined>)["STELLARCRED_RPC_URL"];
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    __resetBoundaryWarningForTesting();
    // Clean up any injected globals or env vars.
    delete (globalThis as Record<string, unknown>).window;
    delete (process.env as Record<string, string | undefined>)["STELLARCRED_REGISTRY_ID"];
    delete (process.env as Record<string, string | undefined>)["PROOF_REGISTRY_ID"];
    delete (process.env as Record<string, string | undefined>)["STELLARCRED_RPC_URL"];
  });

  it("does NOT warn in a non-browser (Node.js) context even with server-only env vars", () => {
    // In vitest/Node, `window` is not defined â€” simulates a real Node.js environment.
    // Ensure window is absent.
    delete (globalThis as Record<string, unknown>).window;
    process.env["STELLARCRED_REGISTRY_ID"] = "C_SERVER_REGISTRY";

    configure({ registryId: "C_SERVER_REGISTRY" });

    // No boundary warning should fire â€” we're in Node, not a browser.
    const boundaryWarnings = consoleWarnSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("[StellarCred]") && msg.includes("server-only"),
    );
    expect(boundaryWarnings).toHaveLength(0);
  });

  it("warns in a browser context when a leaked STELLARCRED_* env var is visible in process.env", () => {
    // Simulate browser context by setting window on globalThis.
    (globalThis as Record<string, unknown>).window = {};
    // Simulate a leaked server-only env var visible in process.env.
    process.env["STELLARCRED_REGISTRY_ID"] = "C_LEAKED_REGISTRY";

    configure({ registryId: "C_LEAKED_REGISTRY" });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[StellarCred]"),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("server-only environment variables"),
    );
  });

  it("warns in a browser context when configure() is called with a PROOF_REGISTRY_ID server env value", () => {
    (globalThis as Record<string, unknown>).window = {};
    process.env["PROOF_REGISTRY_ID"] = "C_SERVER_ONLY_ID";

    // Simulate the integrator mistake: using the server-only var value in configure().
    configure({ registryId: process.env["PROOF_REGISTRY_ID"] });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[StellarCred]"),
    );
  });

  it("does NOT warn in a browser context when no suspicious env indicators are present", () => {
    (globalThis as Record<string, unknown>).window = {};
    // Ensure no leaked vars exist.
    delete (process.env as Record<string, string | undefined>)["STELLARCRED_REGISTRY_ID"];
    delete (process.env as Record<string, string | undefined>)["PROOF_REGISTRY_ID"];

    // Use a fresh value not in process.env.
    configure({ registryId: "C_FRESH_PUBLIC_REGISTRY_ID_NOT_IN_ENV" });

    const boundaryWarnings = consoleWarnSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("[StellarCred]") && msg.includes("server-only"),
    );
    expect(boundaryWarnings).toHaveLength(0);
  });

  it("warns at most once per load even if configure() is called multiple times", () => {
    (globalThis as Record<string, unknown>).window = {};
    process.env["STELLARCRED_REGISTRY_ID"] = "C_LEAKED";

    configure({ registryId: "C_LEAKED" });
    configure({ registryId: "C_LEAKED" });
    configure({ registryId: "C_LEAKED" });

    const boundaryWarnings = consoleWarnSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("[StellarCred]") && msg.includes("server-only"),
    );
    expect(boundaryWarnings).toHaveLength(1);
  });

  it("does NOT warn when NODE_ENV is 'production'", () => {
    (globalThis as Record<string, unknown>).window = {};
    process.env["STELLARCRED_REGISTRY_ID"] = "C_LEAKED_PROD";
    const envMut = process.env as Record<string, string | undefined>;
    const origNodeEnv = envMut["NODE_ENV"];
    envMut["NODE_ENV"] = "production";

    try {
      configure({ registryId: "C_LEAKED_PROD" });

      const boundaryWarnings = consoleWarnSpy.mock.calls.filter(([msg]) =>
        typeof msg === "string" && msg.includes("[StellarCred]") && msg.includes("server-only"),
      );
      expect(boundaryWarnings).toHaveLength(0);
    } finally {
      envMut["NODE_ENV"] = origNodeEnv;
    }
  });
});

describe("checkClaimStatus and getClaimRecord â€” failure state handling", () => {
  beforeEach(() => {
    getRecord.mockReset();
    configure({ registryId: "C_TEST_REGISTRY" });
  });

  it("evaluates 'not_verified' when no on-chain record exists", async () => {
    getRecord.mockResolvedValue({ result: null });
    const res = await checkClaimStatus(WALLET, "kyc");
    expect(res.valid).toBe(false);
    expect(res.status).toBe("not_verified");
    expect(res.record).toBeNull();
    expect(res.error).toContain("no on-chain proof");
  });

  it("evaluates 'revoked' when record.revoked is true", async () => {
    getRecord.mockResolvedValue({
      result: {
        verified_at: 1_700_000_000n,
        expiry: 2_000_000_000n,
        revoked: true,
        issuer: "G_ISSUER_1",
        threshold: undefined,
        vk_version: 1,
      },
    });
    const res = await checkClaimStatus(WALLET, "kyc");
    expect(res.valid).toBe(false);
    expect(res.status).toBe("revoked");
    expect(res.record?.revoked).toBe(true);
    expect(res.error).toContain("revoked");
  });

  it("evaluates 'expired' when expiry is in the past", async () => {
    getRecord.mockResolvedValue({
      result: {
        verified_at: 1_000_000_000n,
        expiry: 1_000_000_100n, // way in the past
        revoked: false,
        issuer: "G_ISSUER_1",
        threshold: undefined,
        vk_version: 1,
      },
    });
    const res = await checkClaimStatus(WALLET, "kyc");
    expect(res.valid).toBe(false);
    expect(res.status).toBe("expired");
    expect(res.error).toContain("expired");
  });

  it("evaluates 'wrong_issuer' when issuer is not in trustedIssuers list", async () => {
    getRecord.mockResolvedValue({
      result: {
        verified_at: 1_700_000_000n,
        expiry: 2_000_000_000n,
        revoked: false,
        issuer: "G_UNTRUSTED_ISSUER",
        threshold: undefined,
        vk_version: 1,
      },
    });
    const res = await checkClaimStatus(WALLET, "kyc", {
      trustedIssuers: ["G_TRUSTED_PERSONA_ISSUER"],
    });
    expect(res.valid).toBe(false);
    expect(res.status).toBe("wrong_issuer");
    expect(res.error).toContain("not in trusted issuers list");
  });

  it("evaluates 'unmet_threshold' when threshold is below required minimum", async () => {
    getRecord.mockResolvedValue({
      result: {
        verified_at: 1_700_000_000n,
        expiry: 2_000_000_000n,
        revoked: false,
        issuer: "G_ISSUER_1",
        threshold: 25_000n,
        vk_version: 1,
      },
    });
    const res = await checkClaimStatus(WALLET, "funds", {
      minThreshold: 50_000,
    });
    expect(res.valid).toBe(false);
    expect(res.status).toBe("unmet_threshold");
    expect(res.error).toContain("less than required minimum");
  });

  it("evaluates 'verified' when all requirements are met", async () => {
    getRecord.mockResolvedValue({
      result: {
        verified_at: 1_700_000_000n,
        expiry: 2_000_000_000n,
        revoked: false,
        issuer: "G_TRUSTED_ISSUER",
        threshold: 75_000n,
        vk_version: 1,
      },
    });
    const res = await checkClaimStatus(WALLET, "funds", {
      minThreshold: 50_000,
      trustedIssuers: ["G_TRUSTED_ISSUER"],
    });
    expect(res.valid).toBe(true);
    expect(res.status).toBe("verified");
    expect(res.record?.threshold).toBe(75_000);
  });

  it("getClaimRecord returns formatted details or null", async () => {
    getRecord.mockResolvedValue({
      result: {
        verified_at: 1_700_000_000n,
        expiry: 2_000_000_000n,
        revoked: false,
        issuer: "G_ISSUER_A",
        threshold: 21n,
        vk_version: 2,
      },
    });
    const rec = await getClaimRecord(WALLET, "age");
    expect(rec).toEqual({
      verifiedAt: 1_700_000_000,
      expiry: 2_000_000_000,
      revoked: false,
      issuer: "G_ISSUER_A",
      threshold: 21,
      vkVersion: 2,
    });
  });
});
describe("buildVerifyUrl expiry + single-use", () => {
  const base = { returnUrl: "https://proto.example/cb", claim: "kyc" as const };

  it("defaults to a link with no exp and no jti (legacy behaviour)", () => {
    const u = new URL(buildVerifyUrl(base));
    expect(u.searchParams.has("exp")).toBe(false);
    expect(u.searchParams.has("jti")).toBe(false);
  });

  it("sets exp = now + expiresInMinutes*60 when expiresInMinutes is given", () => {
    const before = Math.floor(Date.now() / 1000);
    const u = new URL(buildVerifyUrl({ ...base, expiresInMinutes: 5 }));
    const after = Math.floor(Date.now() / 1000);
    const exp = Number(u.searchParams.get("exp"));
    expect(exp).toBeGreaterThanOrEqual(before + 300);
    expect(exp).toBeLessThanOrEqual(after + 300);
  });

  it("rejects a non-positive expiresInMinutes", () => {
    expect(() => buildVerifyUrl({ ...base, expiresInMinutes: 0 })).toThrow();
    expect(() => buildVerifyUrl({ ...base, expiresInMinutes: -5 })).toThrow();
  });

  it("sets a URL-safe jti when singleUse is true", () => {
    const u = new URL(buildVerifyUrl({ ...base, singleUse: true }));
    const jti = u.searchParams.get("jti");
    expect(jti).toBeTruthy();
    expect(jti!).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("produces distinct jti values across calls", () => {
    const a = new URL(buildVerifyUrl({ ...base, singleUse: true })).searchParams.get("jti");
    const b = new URL(buildVerifyUrl({ ...base, singleUse: true })).searchParams.get("jti");
    expect(a).not.toBe(b);
  });
});

describe("unique personhood and nullifier support (#395)", () => {
  it("derives deterministic nullifier within the same context", () => {
    const n1 = StellarCred.deriveNullifier("secret_123", "app_context_a");
    const n2 = StellarCred.deriveNullifier("secret_123", "app_context_a");
    expect(n1).toBe(n2);
    expect(n1).toHaveLength(64);
  });

  it("derives unlinkable nullifiers across different contexts for same secret", () => {
    const n_a = StellarCred.deriveNullifier("secret_123", "app_context_a");
    const n_b = StellarCred.deriveNullifier("secret_123", "app_context_b");
    expect(n_a).not.toBe(n_b);
  });

  it("derives different nullifiers for different secrets in same context", () => {
    const n1 = StellarCred.deriveNullifier("secret_1", "app_context_a");
    const n2 = StellarCred.deriveNullifier("secret_2", "app_context_a");
    expect(n1).not.toBe(n2);
  });
});