#!/usr/bin/env node
// worklease CLI. v0.1 implements a single verb: `validate <file>`.
//
// Reads a JSON file, auto-detects claim (object) vs registry (array) by its
// top-level type, runs the matching validator, prints human-readable errors
// (or `--json` for a machine-readable `{ valid, errors }`), and exits 0 when
// valid, 1 when invalid / file-missing / parse-error.

import { readFileSync } from "node:fs";
import { validateClaim, validateRegistry } from "../src/schema.js";

const USAGE = `worklease — coordination format for fleets of AI coding agents

Usage:
  worklease validate <file> [--json]   Validate a claim or registry JSON file

Exit code: 0 = valid, 1 = invalid / error`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main(argv) {
  const args = argv.slice(2);
  const command = args[0];

  if (command !== "validate") {
    // Unknown / missing subcommand → usage on stderr, exit 1.
    fail(USAGE);
    return;
  }

  const rest = args.slice(1);
  const json = rest.includes("--json");
  const file = rest.find((a) => a !== "--json");

  if (!file) {
    fail("error: `validate` requires a file argument\n\n" + USAGE);
    return;
  }

  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    fail(`error: cannot read file: ${file}`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`error: ${file} is not valid JSON: ${e.message}`);
    return;
  }

  // Auto-detect: array → registry, plain object → claim.
  const isArray = Array.isArray(parsed);
  const result = isArray ? validateRegistry(parsed) : validateClaim(parsed);
  const kind = isArray ? "registry" : "claim";

  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (result.valid) {
    process.stdout.write(`✓ ${file}: valid ${kind}\n`);
  } else {
    process.stdout.write(`✗ ${file}: invalid ${kind} (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})\n`);
    for (const e of result.errors) {
      const at = e.path === "" ? "<root>" : e.path;
      process.stdout.write(`  ${at}: ${e.message} [${e.code}]\n`);
    }
  }

  process.exit(result.valid ? 0 : 1);
}

main(process.argv);
