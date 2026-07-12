#!/usr/bin/env node
// worklease CLI.
//
// Dispatches to subcommands:
//  - `validate <file>`: validate a claim or registry file.
//  - `check <globs...>`: check for overlap with active claims.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateClaim, validateRegistry } from "../src/schema.js";
import { check } from "../src/check.js";

const USAGE = `worklease — coordination format for fleets of AI coding agents

Usage:
  worklease validate <file> [--json]   Validate a claim or registry JSON file
  worklease check <globs...> [--agent <id>] [--registry <path>] [--json]
      Report whether the planned edit globs overlap any active claim held by
      another agent. Exit 0 = clear, 1 = conflict.

Flags:
  --agent <id>       identify "me" (env WORKLEASE_AGENT); own claims are clear
  --registry <path>  registry file (default: env WORKLEASE_REGISTRY or
                     .worklease/registry.jsonl)
  --json             emit machine-readable output for the active command`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// `validate` subcommand implementation
function runValidate(args) {
  const json = args.includes("--json");
  const file = args.find((a) => a !== "--json");

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


// `check` subcommand implementation
function defaultRegistryPath() {
  return (
    process.env.WORKLEASE_REGISTRY || join(process.cwd(), ".worklease", "registry.jsonl")
  );
}

function loadRegistry(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // missing file → empty registry
  }
  const latest = new Map();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed);
    latest.set(record.id, record);
  }
  return [...latest.values()];
}

function parseCheckArgs(args) {
  const globs = [];
  let agent = process.env.WORKLEASE_AGENT || null;
  let registry = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--agent") {
      agent = args[++i];
      if (agent == null) fail("error: --agent requires a value\n\n" + USAGE);
    } else if (a === "--registry") {
      registry = args[++i];
      if (registry == null) fail("error: --registry requires a value\n\n" + USAGE);
    } else if (a.startsWith("--")) {
      fail(`error: unknown flag: ${a}\n\n` + USAGE);
    } else {
      globs.push(a);
    }
  }
  return { globs, agent, registry, json };
}

function runCheck(args) {
  const { globs, agent, registry, json } = parseCheckArgs(args);

  if (globs.length === 0) {
    fail("error: `check` requires one or more globs\n\n" + USAGE);
    return;
  }

  const path = registry || defaultRegistryPath();
  const claims = loadRegistry(path);
  const result = check(globs, claims, { agent, now: Date.now() });

  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (result.clear) {
    process.stdout.write("clear ✓ — no overlap with active claims\n");
  } else {
    const n = result.conflicts.length;
    process.stdout.write(
      `⚠ conflict — planned edit overlaps ${n} active claim${n === 1 ? "" : "s"}:\n`
    );
    for (const { claim, overlapping_globs } of result.conflicts) {
      process.stdout.write(
        `  ${claim.agent} holds ${overlapping_globs.join(", ")} — ` +
          `"${claim.intent}" (expires ${claim.expires})\n`
      );
    }
  }

  process.exit(result.clear ? 0 : 1);
}

// Main router
function main(argv) {
  const args = argv.slice(2);
  const command = args[0];

  if (command === "check") {
    runCheck(args.slice(1));
    return;
  }
  if (command === "validate") {
    runValidate(args.slice(1));
    return;
  }

  // Unknown / missing subcommand → usage on stderr, exit 1.
  fail(USAGE);
}

main(process.argv);
