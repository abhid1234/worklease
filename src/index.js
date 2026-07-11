// worklease — public entry point (package `main`).
// Re-exports the pure `check` / glob-overlap API.
// (Schema/validator exports from #1 are unioned in here when that lands.)

export { globsOverlap } from "./glob.js";
export { check } from "./check.js";
