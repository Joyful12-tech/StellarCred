// @stellarcred/sdk
//
// A tiny, zero-dependency* read-only client for protocols integrating
// StellarCred. The only thing a protocol trusts is the on-chain
// ProofRegistry — there is no API key, no backend, and no personal data
// handling. `hasClaim` is the primary integration call.
//
// *Requires @stellar/stellar-sdk as a peer dependency.
//
// Quick start (Next.js / Vite / Node.js):
//
//   import StellarCred from "@stellarcred/sdk";
//
//   // Option A: configure explicitly at startup (recommended for servers)
//   StellarCred.configure({
//     registryId: process.env.PROOF_REGISTRY_ID,
//     rpcUrl: "https://soroban-testnet.stellar.org",
//   });
//
//   // Option B: set env vars instead (STELLARCRED_REGISTRY_ID, etc.)
//   //           — works in both Node.js and Next.js (NEXT_PUBLIC_* prefix)
//
//   const ok = await StellarCred.hasClaim(walletAddress, "kyc");

// ---------------------------------------------------------------------------
// All implementation lives in claims.ts — this file is a thin re-export shell.
// Do not add logic here. Do not import from index.ts in claims.ts / core.ts /
// react.ts (that would create a circular dependency).
// ---------------------------------------------------------------------------

export {
  // config
  configure,
  healthCheck,
  isConfigured,
  // error classes
  TimeoutError,
  ConfigError,
  InvalidAddressError,
  RpcError,
  // constants / types
  CLAIM_TYPES,
  // functions
  hasClaim,
  getClaim,
  hasClaims,
  getClaims,
  verifyPreset,
  buildVerifyUrl,
  buildBadgeUrl,
  buildBadgeEmbedCode,
  parseReturnParams,
  watchClaim,
  withRetry,
} from "./claims";

export type {
  ClaimType,
  ClaimOptions,
  Claim,
  BatchClaimOptions,
  PresetClaim,
  PresetVerificationResult,
  UntrustedReturnParams,
  WatchClaimOptions,
  WatchClaimCallbackOptions,
} from "./claims";

// ---------------------------------------------------------------------------
// Namespace export (StellarCred.hasClaim / StellarCred.getClaims / etc.)
// Re-imported from claims to guarantee these are the same function references.
// ---------------------------------------------------------------------------

import {
  configure,
  healthCheck,
  isConfigured,
  hasClaim,
  getClaim,
  hasClaims,
  getClaims,
  verifyPreset,
  buildVerifyUrl,
  buildBadgeUrl,
  buildBadgeEmbedCode,
  parseReturnParams,
  watchClaim,
  CLAIM_TYPES,
  TimeoutError,
  ConfigError,
  InvalidAddressError,
  RpcError,
} from "./claims";

export const StellarCred = {
  configure,
  healthCheck,
  isConfigured,
  hasClaim,
  getClaim,
  hasClaims,
  getClaims,
  verifyPreset,
  buildVerifyUrl,
  buildBadgeUrl,
  buildBadgeEmbedCode,
  parseReturnParams,
  watchClaim,
  CLAIM_TYPES,
  TimeoutError,
  ConfigError,
  InvalidAddressError,
  RpcError,
};
export default StellarCred;

// Framework-agnostic core — for use outside React (Vue, Svelte, vanilla).
export { createClaimGate } from "./core";
export type { ClaimGateConfig, ClaimGateState, ClaimGateListener, ClaimGate } from "./core";

// React hook — React wrapper around the batched `hasClaims` read.
export { useStellarCred } from "./react";
export type { UseStellarCredOptions, UseStellarCredResult } from "./react";
