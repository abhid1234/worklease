import { test } from "node:test";
import assert from "node:assert/strict";
import { globsOverlap } from "../src/glob.js";

// Each row: [a, b, expected]. Overlap is symmetric, so every row is asserted
// both ways below.
const MATRIX = [
  // identical / disjoint literals
  ["foo.js", "foo.js", true],
  ["a.js", "b.js", false],
  ["src/auth.ts", "src/auth.ts", true],
  ["src/auth.ts", "src/api.ts", false],

  // `*` within a segment
  ["src/*.ts", "src/auth.ts", true],
  ["src/*.ts", "src/auth.js", false],
  ["*.js", "config.js", true],
  ["a*b", "aXYZb", true],
  ["a*b", "ab", true],
  ["a*c", "abd", false],

  // `*` never crosses `/`
  ["src/*.ts", "src/auth/x.ts", false],
  ["src/*", "src/a/b", false],

  // `**` spanning zero and many segments, at start / middle / end
  ["config.js", "**/*.js", true],
  ["src/auth/**", "src/**/*.ts", true],
  ["src/auth/**", "src/api/**", false],
  ["a/**/b", "a/b", true], // ** matches zero segments
  ["a/**/b", "a/x/b", true],
  ["a/**/b", "a/x/y/z/b", true],
  ["**/foo", "a/b/foo", true],
  ["a/**", "a/b/c", true],
  ["a/**", "b/c", false],

  // `**` vs `**` and `**` vs anything
  ["**", "anything/at/all.ts", true],
  ["**", "**", true],
  ["**", "foo.js", true],
  ["src/**", "**/auth.ts", true],

  // normalization equivalence (trailing slash / ./ / duplicate slash)
  ["src/auth/", "src/auth", true],
  ["./src/auth", "src/auth", true],
  ["src//auth", "src/auth", true],

  // in-segment `**` collapses to `*` (no `/` crossing)
  ["a**b", "aXb", true],
  ["src**", "src/auth.ts", false], // `src**` → `src*`, one segment; can't cross `/`
];

test("globsOverlap matrix (both directions)", () => {
  for (const [a, b, expected] of MATRIX) {
    assert.equal(globsOverlap(a, b), expected, `overlap(${a}, ${b})`);
    assert.equal(globsOverlap(b, a), expected, `symmetry: overlap(${b}, ${a})`);
  }
});

test("globsOverlap is symmetric across the matrix", () => {
  for (const [a, b] of MATRIX) {
    assert.equal(
      globsOverlap(a, b),
      globsOverlap(b, a),
      `overlap(${a}, ${b}) must equal overlap(${b}, ${a})`
    );
  }
});

test("deeply nested `**` terminates quickly (memoization)", () => {
  // Would blow up exponentially without the (i, j) memo guard.
  assert.equal(globsOverlap("a/**/**/**/c", "a/x/y/z/c"), true);
  assert.equal(globsOverlap("**/**/**/**/x", "a/b/c/d/e/x"), true);
  assert.equal(globsOverlap("a/**/**/z", "a/b/c/d/nope"), false);
});
