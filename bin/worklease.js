#!/usr/bin/env node
// worklease CLI — `check` verb: does my planned edit overlap any active claim
// held by another agent?
//
//   worklease check <globs...> [--agent <id>] [--registry <path>] [--json]
//
// Loads the registry file, resolves it to the current claim array, runs the
// pure `check` core, prints a readable summary (or `--json`), and exits 0 when
// clear / 1 when any conflict is found. The non-zero exit is an advisory signal
// a pre-edit hook can gate on — not a hard lock.
//
// (Registry issue #4 owns the real loader + default path; until it lands this
// uses a small local reader isolated in `loadRegistry` so it can be swapped in.)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../src/check.js";

const USAGE = `worklease — coordination format for fleets of AI coding agents

Usage:
  worklease check <globs...> [--agent <id>] [--registry <path>] [--json]
      Report whether the planned edit globs overlap any active claim held by
      another agent. Exit 0 = clear, 1 = conflict.

Flags:
  --agent <id>       identify "me" (env WORKLEASE_AGENT); own claims are clear
  --registry <path>  registry file (default: env WORKLEASE_REGISTRY or
                     .worklease/registry.jsonl)
  --json             emit { clear, conflicts } for harness consumption`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Default registry path — mirrors #4's `defaultRegistryPath`: WORKLEASE_REGISTRY
// if set, else `.worklease/registry.jsonl` under the cwd.
function defaultRegistryPath() {
  return (
    process.env.WORKLEASE_REGISTRY || join(process.cwd(), ".worklease", "registry.jsonl")
  );
}

// Interim JSONL reader (swappable for #4's loader): read the file, JSON.parse
// each non-empty line, keep the latest record per `id`, and treat a missing
// file as an empty registry.
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

// Minimal flag parser for the `check` verb: collects positional globs and the
// three known flags; an unknown `--flag` is an error.
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

function main(argv) {
  const args = argv.slice(2);
  const command = args[0];

  if (command === "check") {
    runCheck(args.slice(1));
    return;
  }

  // Unknown / missing subcommand → usage on stderr, exit 1.
  fail(USAGE);
}

main(process.argv);
