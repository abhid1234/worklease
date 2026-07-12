// worklease — public entry point (package `main`).
// Re-exports the pure schema/validator API.
// Re-exports the pure `check` / glob-overlap API.
// Re-exports the pure `conformance` after-the-fact coordination-score API.
// Re-exports the pure `makeClaim` / `parseTtl` claim-constructor API.
// Re-exports the append-only registry store (`loadRegistry`, `appendRecord`, …).
// Re-exports the git pre-commit adapter (`checkStagedPaths`, `installHook`, …).

export {
  validateClaim,
  validateRegistry,
  isIso8601Utc,
  isAllowedGlob,
  STATUSES,
  CLAIM_FIELDS,
  ERROR_CODES,
} from "./schema.js";
export { globsOverlap } from "./glob.js";
export { check } from "./check.js";
export { conformance } from "./conformance.js";
export { makeClaim, parseTtl } from "./claim.js";
export {
  canonicalize,
  computeRecordId,
  resolveRecords,
  loadRegistry,
  appendRecord,
  defaultRegistryPath,
  listActive,
  formatRelative,
  shortId,
} from "./registry.js";
export {
  stagedPaths,
  checkStagedPaths,
  hookPath,
  renderHookBlock,
  installHook,
} from "./adapters/git-hook.js";
