#!/usr/bin/env node
// worklease CLI.
//
// Dispatches to subcommands:
//  - `validate <file>`: validate a claim or registry file.
//  - `check <globs...>`: check for overlap with active claims.
//  - `claim <globs...>`: file a claim (append to the registry).
//  - `list`: show active claims (who holds what, expiring when).
//  - `release <id>`: drop a claim by appending a release record.
//  - `conformance <registry> <merges>`: score whether merges respected claims.

import { readFileSync } from "node:fs";
import { validateClaim, validateRegistry } from "../src/schema.js";
import { check } from "../src/check.js";
import { conformance } from "../src/conformance.js";
import { makeClaim, parseTtl } from "../src/claim.js";
import {
  loadRegistry,
  appendRecord,
  defaultRegistryPath,
  formatRelative,
  shortId,
} from "../src/registry.js";

const USAGE = `worklease — coordination format for fleets of AI coding agents

Usage:
  worklease validate <file> [--json]   Validate a claim or registry JSON file
  worklease check <globs...> [--agent <id>] [--registry <path>] [--json]
      Report whether the planned edit globs overlap any active claim held by
      another agent. Exit 0 = clear, 1 = conflict.
  worklease claim <globs...> --intent "<why>" [--ttl <dur>] [--agent <id>]
                             [--registry <path>] [--json]
      File a claim for the globs and append it to the registry. Exit 0 on write.
  worklease list [--all] [--verbose] [--agent <id>] [--registry <path>] [--json]
      Show active claims: who holds what, expiring when. --all also shows
      released/expired claims labeled with their effective status. --all or
      --verbose also warn (to stderr) about skipped/tampered/expired lines.
  worklease release <id> [--agent <id>] [--registry <path>] [--json]
      Drop a claim (full id or unambiguous prefix) by appending a release
      record. No-op with a note if it is already released/expired.
  worklease conformance <registry> <merges> [--json]
      Score whether merged changes respected the claims. Reads the registry and
      a merges file (each agent's touched files) and reports a coordination
      score, respected/total, violations, and warnings. Exit 0 = no violations,
      1 = at least one violation.

Flags:
  --intent <str>     why you're claiming (required for \`claim\`)
  --ttl <dur>        lease length: <n>s|m|h or bare seconds (claim; default 30m)
  --all              include released/expired claims (list)
  --verbose          warn about skipped/tampered/expired lines to stderr (list)
  --agent <id>       identify "me" (env WORKLEASE_AGENT); own claims are clear
  --registry <path>  registry file (default: env WORKLEASE_REGISTRY or
                     .worklease/registry.jsonl)
  --json             emit machine-readable output for the active command`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Surface loadRegistry/resolveRecords `notes` (skipped/tampered/expired lines)
// to stderr as warnings. A dropped line is a corrupt/stale/tampered claim, and
// PRODUCT.md decision 3 makes the warning the mitigation: without it a dropped
// claim silently vanishes and two agents can both be told a path is clear.
function warnNotes(notes) {
  for (const note of notes) process.stderr.write(`warning: ${note}\n`);
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
  const now = Date.now();
  const { claims, notes } = loadRegistry(path, { now });
  // Always warn: a claim dropped here means `check` may report `clear` for a
  // path another agent actually holds — the exact collision worklease prevents.
  warnNotes(notes);
  const result = check(globs, claims, { agent, now });

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

// `claim` subcommand implementation
function parseClaimArgs(args) {
  const globs = [];
  let intent = null;
  let ttl = null;
  let agent = process.env.WORKLEASE_AGENT || null;
  let registry = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--intent") {
      intent = args[++i];
      if (intent == null) fail("error: --intent requires a value\n\n" + USAGE);
    } else if (a === "--ttl") {
      ttl = args[++i];
      if (ttl == null) fail("error: --ttl requires a value\n\n" + USAGE);
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
  return { globs, intent, ttl, agent, registry, json };
}

function runClaim(args) {
  const { globs, intent, ttl, agent, registry, json } = parseClaimArgs(args);

  if (globs.length === 0) {
    fail("error: `claim` requires one or more globs\n\n" + USAGE);
    return;
  }
  if (intent == null || intent.trim().length === 0) {
    fail("error: `claim` requires a non-empty --intent\n\n" + USAGE);
    return;
  }
  if (agent == null || agent.trim().length === 0) {
    fail("error: `claim` requires --agent (or the WORKLEASE_AGENT env var)\n\n" + USAGE);
    return;
  }
  const ttl_seconds = ttl == null ? 1800 : parseTtl(ttl);
  if (ttl_seconds == null) {
    fail(`error: invalid --ttl: ${ttl} (use <n>s|m|h or a positive integer of seconds)`);
    return;
  }

  // The clock is read only here; makeClaim stays pure over the injected `created`.
  const created = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const claim = makeClaim(globs, { agent, intent, ttl_seconds, created });

  // Validate the finished record via #1's validator; gate the write on it so an
  // unsupported glob (or any other defect) is rejected rather than written.
  const result = validateClaim(claim);
  if (!result.valid) {
    process.stdout.write(
      `✗ cannot file claim (${result.errors.length} error${result.errors.length === 1 ? "" : "s"}):\n`
    );
    for (const e of result.errors) {
      const at = e.path === "" ? "<root>" : e.path;
      process.stdout.write(`  ${at}: ${e.message} [${e.code}]\n`);
    }
    process.exit(1);
    return;
  }

  const path = registry || defaultRegistryPath();
  // Append-only via the shared store: one whole JSON line, existing lines never
  // rewritten, parent dir created if missing. The claim already carries its
  // content-hash id, so appendRecord writes it verbatim.
  appendRecord(path, claim);

  if (json) {
    process.stdout.write(JSON.stringify(claim) + "\n");
  } else {
    process.stdout.write(
      `filed ${claim.id} — ${claim.agent} holds ${claim.globs.join(", ")} — ` +
        `"${claim.intent}" (expires ${claim.expires})\n`
    );
  }
  process.exit(0);
}

// `list` subcommand implementation
function parseListArgs(args) {
  let all = false;
  let verbose = false;
  let agent = null;
  let registry = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--all") {
      all = true;
    } else if (a === "--verbose") {
      verbose = true;
    } else if (a === "--agent") {
      agent = args[++i];
      if (agent == null) fail("error: --agent requires a value\n\n" + USAGE);
    } else if (a === "--registry") {
      registry = args[++i];
      if (registry == null) fail("error: --registry requires a value\n\n" + USAGE);
    } else if (a.startsWith("--")) {
      fail(`error: unknown flag: ${a}\n\n` + USAGE);
    } else {
      fail(`error: \`list\` takes no positional arguments (got: ${a})\n\n` + USAGE);
    }
  }
  return { all, verbose, agent, registry, json };
}

function runList(args) {
  const { all, verbose, agent, registry, json } = parseListArgs(args);

  const path = registry || defaultRegistryPath();
  const now = Date.now();
  const { claims, notes } = loadRegistry(path, { now });
  // Surface skipped/tampered/expired notes to stderr under --all or --verbose,
  // so a dropped (corrupt/stale) claim is visible rather than silently gone.
  if (all || verbose) warnNotes(notes);

  let rows = all ? claims : claims.filter((c) => c.status === "active");
  if (agent != null) rows = rows.filter((c) => c.agent === agent);

  if (json) {
    process.stdout.write(JSON.stringify(rows) + "\n");
    process.exit(0);
  }

  if (rows.length === 0) {
    process.stdout.write("no active claims\n");
    process.exit(0);
  }

  for (const c of rows) {
    // Active rows show the relative expiry; released/expired rows show the label.
    const when = c.status === "active" ? `expires ${formatRelative(c.expires, now)}` : c.status;
    process.stdout.write(
      `${c.agent}  ${c.globs.join(", ")}  "${c.intent}"  ${when}  ${shortId(c.id)}\n`
    );
  }
  process.exit(0);
}

// `release` subcommand implementation
function parseReleaseArgs(args) {
  let id = null;
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
    } else if (id == null) {
      id = a;
    } else {
      fail(`error: \`release\` takes a single <id> (extra: ${a})\n\n` + USAGE);
    }
  }
  return { id, agent, registry, json };
}

function runRelease(args) {
  const { id, agent, registry, json } = parseReleaseArgs(args);

  if (id == null || id.trim().length === 0) {
    fail("error: `release` requires a claim <id>\n\n" + USAGE);
    return;
  }

  const path = registry || defaultRegistryPath();
  const now = Date.now();
  const { claims } = loadRegistry(path, { now });

  // Resolve the target: exact id first, else a unique id prefix.
  let target = claims.find((c) => c.id === id);
  if (!target) {
    const matches = claims.filter((c) => c.id.startsWith(id));
    if (matches.length > 1) {
      fail(`error: ambiguous id prefix "${id}" matches ${matches.length} claims`);
      return;
    }
    target = matches[0];
  }
  if (!target) {
    fail(`error: no claim with id "${id}"`);
    return;
  }

  // Already inactive → the desired end state already holds; note and stop.
  if (target.status === "released" || target.status === "expired") {
    const note =
      target.status === "released"
        ? `already released — nothing to do (${shortId(target.id)})`
        : `already expired — nothing to do (${shortId(target.id)})`;
    process.stdout.write(note + "\n");
    process.exit(0);
  }

  const releaser = agent != null && agent.trim().length > 0 ? agent : "unknown";
  const release = appendRecord(path, {
    type: "release",
    claim_id: target.id,
    agent: releaser,
    at: new Date(now).toISOString(),
  });

  if (json) {
    process.stdout.write(JSON.stringify(release) + "\n");
  } else {
    process.stdout.write(`released ${shortId(target.id)} (held by ${target.agent})\n`);
  }
  process.exit(0);
}

// `conformance` subcommand implementation
//
// Load a merges file: if it parses as a JSON array, use it; otherwise treat it
// as JSONL (one merge record per non-empty line). A missing file → [] (total 0).
// A malformed JSON array or unparseable line throws for the caller to report.
function loadMerges(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // missing file → no changes
  }
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l)
    .map((l) => JSON.parse(l));
}

function parseConformanceArgs(args) {
  const positional = [];
  let json = false;
  for (const a of args) {
    if (a === "--json") {
      json = true;
    } else if (a.startsWith("--")) {
      fail(`error: unknown flag: ${a}\n\n` + USAGE);
    } else {
      positional.push(a);
    }
  }
  return { positional, json };
}

function runConformance(args) {
  const { positional, json } = parseConformanceArgs(args);
  const [registryPath, mergesPath] = positional;

  if (!registryPath || !mergesPath) {
    fail("error: `conformance` requires <registry> and <merges> file arguments\n\n" + USAGE);
    return;
  }

  // Reuse the same registry loader `check` uses so the two verbs never disagree
  // on resolution; a missing registry file resolves to an empty claim set.
  const now = Date.now();
  const { claims } = loadRegistry(registryPath, { now });

  let merges;
  try {
    merges = loadMerges(mergesPath);
  } catch (e) {
    fail(`error: ${mergesPath} is not valid merges JSON: ${e.message}`);
    return;
  }

  const result = conformance(claims, merges, {});

  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(
      `coordination score ${result.score.toFixed(2)} — ` +
        `${result.respected}/${result.total} change${result.total === 1 ? "" : "s"} respected\n`
    );
    for (const { agent, file, conflicting_claim: c } of result.violations) {
      process.stdout.write(
        `  ✗ ${agent} edited ${file} under ${c.agent}'s claim — ` +
          `"${c.intent}" (active ${c.created}–${c.expires})\n`
      );
    }
    for (const { agent, file } of result.warnings) {
      process.stdout.write(`  • ${agent} edited ${file} (unclaimed)\n`);
    }
  }

  process.exit(result.violations.length === 0 ? 0 : 1);
}

// Main router
function main(argv) {
  const args = argv.slice(2);
  const command = args[0];

  if (command === "check") {
    runCheck(args.slice(1));
    return;
  }
  if (command === "claim") {
    runClaim(args.slice(1));
    return;
  }
  if (command === "list") {
    runList(args.slice(1));
    return;
  }
  if (command === "release") {
    runRelease(args.slice(1));
    return;
  }
  if (command === "conformance") {
    runConformance(args.slice(1));
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
