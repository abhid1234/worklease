import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaim } from "../src/schema.js";
import { computeRecordId, appendRecord } from "../src/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "bin", "worklease.js");

// Run the CLI as a child process. Returns { status, stdout, stderr }.
function run(args, env = {}) {
  // spawnSync returns both stdout and stderr regardless of exit code, so warnings
  // emitted to stderr on a 0 exit (e.g. `list --all` skip notes) stay observable.
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

const validClaim = {
  id: "abc123",
  agent: "agent-A",
  globs: ["src/auth/**"],
  intent: "add OAuth",
  ttl_seconds: 1800,
  created: "2026-07-11T12:00:00Z",
  expires: "2026-07-11T12:30:00Z",
  status: "active",
};

// Far-future expiry so these claims are always "active" against the real clock.
const ACTIVE = "2099-01-01T00:00:00Z";
const EXPIRED = "2000-01-01T00:00:00Z";

// Build a self-consistent registry claim record: its `id` is its own content
// hash, so it survives `loadRegistry`'s integrity filter (any hand-set `o.id` is
// ignored — the store is content-addressed).
function record(o) {
  const r = {
    agent: o.agent,
    globs: o.globs,
    intent: o.intent ?? "work",
    ttl_seconds: o.ttl_seconds ?? 1200,
    created: o.created ?? "2026-01-01T00:00:00Z",
    expires: o.expires ?? ACTIVE,
    status: o.status ?? "active",
  };
  return { id: computeRecordId(r), ...r };
}

let dir;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), "worklease-check-"));
});
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name, data) {
  const p = join(dir, name);
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
  return p;
}

// Write a JSONL registry fixture, one record per line.
function registry(name, records) {
  const p = join(dir, name);
  writeFileSync(p, records.map((r) => JSON.stringify(record(r))).join("\n") + "\n");
  return p;
}

test("valid claim file → exit 0, ok message", () => {
  const p = fixture("valid-claim.json", validClaim);
  const r = run(["validate", p]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /valid claim/);
});

test("invalid claim file → errors printed, exit 1", () => {
  const p = fixture("invalid-claim.json", { ...validClaim, status: "done" });
  const r = run(["validate", p]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /INVALID_ENUM/);
});

test("valid registry (array) file → exit 0", () => {
  const p = fixture("valid-registry.json", [validClaim, { ...validClaim, id: "other" }]);
  const r = run(["validate", p]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /valid registry/);
});

test("invalid registry file → exit 1", () => {
  const p = fixture("dup-registry.json", [validClaim, validClaim]);
  const r = run(["validate", p]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /DUPLICATE_ID/);
});

test("--json emits parseable { valid, errors }", () => {
  const p = fixture("valid-claim-json.json", validClaim);
  const r = run(["validate", p, "--json"]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed, { valid: true, errors: [] });

  const p2 = fixture("invalid-claim-json.json", { ...validClaim, ttl_seconds: -1 });
  const r2 = run(["validate", p2, "--json"]);
  assert.equal(r2.status, 1);
  const parsed2 = JSON.parse(r2.stdout);
  assert.equal(parsed2.valid, false);
  assert.ok(parsed2.errors.some((e) => e.code === "NOT_POSITIVE_INT"));
});

test("missing file → clear error, exit 1", () => {
  const r = run(["validate", join(dir, "does-not-exist.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read file/);
});

test("malformed JSON → clear parse error, exit 1", () => {
  const p = fixture("bad.json", "{ not valid json ");
  const r = run(["validate", p]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
});

test("auto-detection routes object→claim, array→registry", () => {
  const objP = fixture("obj.json", validClaim);
  assert.match(run(["validate", objP]).stdout, /claim/);
  const arrP = fixture("arr.json", [validClaim]);
  assert.match(run(["validate", arrP]).stdout, /registry/);
});

test("clear check → readable output, exit 0", () => {
  const reg = registry("clear.jsonl", [
    { id: "1", agent: "other", globs: ["src/api/**"] },
  ]);
  const r = run(["check", "src/auth/**", "--registry", reg]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /clear/);
});

test("clear check --json parses to { clear: true, conflicts: [] }", () => {
  const reg = registry("clear2.jsonl", [
    { id: "1", agent: "other", globs: ["src/api/**"] },
  ]);
  const r = run(["check", "src/auth/**", "--registry", reg, "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { clear: true, conflicts: [] });
});

test("conflicting check → exit 1, --json lists the conflict", () => {
  const reg = registry("conflict.jsonl", [
    { id: "1", agent: "other", globs: ["src/auth/**"], intent: "auth work" },
  ]);
  const r = run(["check", "src/**/*.ts", "--registry", reg, "--json"]);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.clear, false);
  assert.equal(out.conflicts.length, 1);
  assert.deepEqual(out.conflicts[0].overlapping_globs, ["src/auth/**"]);
});

test("conflicting check human output names the agent + overlap", () => {
  const reg = registry("conflict2.jsonl", [
    { id: "1", agent: "agent-x", globs: ["src/auth/**"], intent: "auth work" },
  ]);
  const r = run(["check", "src/auth/login.ts", "--registry", reg]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /agent-x/);
  assert.match(r.stdout, /src\/auth\/\*\*/);
});

test("--agent filters own claims (clear, exit 0)", () => {
  const reg = registry("own.jsonl", [
    { id: "1", agent: "me", globs: ["src/auth/**"] },
  ]);
  const r = run(["check", "src/auth/x.ts", "--registry", reg, "--agent", "me"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /clear/);
});

test("WORKLEASE_AGENT env has the same effect as --agent", () => {
  const reg = registry("own2.jsonl", [
    { id: "1", agent: "me", globs: ["src/auth/**"] },
  ]);
  const r = run(["check", "src/auth/x.ts", "--registry", reg], {
    WORKLEASE_AGENT: "me",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /clear/);
});

test("a release record supersedes its claim (check sees it as clear)", () => {
  const claim = record({ agent: "other", globs: ["src/auth/**"], status: "active" });
  const release = {
    type: "release",
    claim_id: claim.id,
    agent: "other",
    at: "2026-07-11T12:00:00Z",
  };
  release.id = computeRecordId(release);
  const p = join(dir, "resolve.jsonl");
  writeFileSync(p, [claim, release].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = run(["check", "src/auth/x.ts", "--registry", p, "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { clear: true, conflicts: [] });
});

test("expired-by-time claim is treated as clear", () => {
  const reg = registry("expired.jsonl", [
    { id: "1", agent: "other", globs: ["src/auth/**"], expires: EXPIRED },
  ]);
  const r = run(["check", "src/auth/x.ts", "--registry", reg]);
  assert.equal(r.status, 0);
});

test("missing registry file → treated as empty (clear), exit 0", () => {
  const r = run([
    "check",
    "src/auth/**",
    "--registry",
    join(dir, "does-not-exist.jsonl"),
  ]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /clear/);
});

test("no globs → usage, exit 1", () => {
  const reg = registry("empty.jsonl", []);
  const r = run(["check", "--registry", reg]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires one or more globs/);
});

test("unknown flag → usage, exit 1", () => {
  const r = run(["check", "src/auth/**", "--bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown flag/);
});

test("unknown subcommand → usage, exit 1", () => {
  const r = run(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage/);
});

test("validate without a file → error, exit 1", () => {
  const r = run(["validate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires a file/);
});

// --- claim -----------------------------------------------------------------

// Read a JSONL registry file into an array of parsed records.
function readRegistry(p) {
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test("claim writes one valid line and exits 0", () => {
  const reg = join(dir, "claim1.jsonl");
  const r = run([
    "claim", "src/auth/**",
    "--intent", "add OAuth", "--ttl", "20m", "--agent", "a1",
    "--registry", reg,
  ]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /filed/);

  const records = readRegistry(reg);
  assert.equal(records.length, 1);
  const claim = records[0];
  assert.equal(validateClaim(claim).valid, true);
  assert.equal(claim.status, "active");
  assert.equal(claim.agent, "a1");
  assert.deepEqual(claim.globs, ["src/auth/**"]);
  assert.equal(claim.ttl_seconds, 1200);
  assert.equal(Date.parse(claim.expires), Date.parse(claim.created) + 1200 * 1000);
});

test("a second claim appends (existing line preserved, append-only)", () => {
  const reg = join(dir, "claim-append.jsonl");
  run(["claim", "src/a/**", "--intent", "one", "--agent", "a1", "--registry", reg]);
  const firstLine = readFileSync(reg, "utf8").split("\n")[0];
  run(["claim", "src/b/**", "--intent", "two", "--agent", "a1", "--registry", reg]);

  const raw = readFileSync(reg, "utf8");
  assert.equal(raw.split("\n")[0], firstLine, "first line unchanged");
  const records = readRegistry(reg);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((c) => c.globs[0]), ["src/a/**", "src/b/**"]);
});

test("claim --json prints the claim object, matching the written line", () => {
  const reg = join(dir, "claim-json.jsonl");
  const r = run([
    "claim", "src/x/**", "--intent", "work", "--agent", "a1",
    "--registry", reg, "--json",
  ]);
  assert.equal(r.status, 0);
  const printed = JSON.parse(r.stdout);
  assert.deepEqual(printed, readRegistry(reg)[0]);
});

test("default ttl is 1800 (30m) when --ttl omitted", () => {
  const reg = join(dir, "claim-default-ttl.jsonl");
  run(["claim", "src/**", "--intent", "work", "--agent", "a1", "--registry", reg]);
  assert.equal(readRegistry(reg)[0].ttl_seconds, 1800);
});

test("--agent resolves from WORKLEASE_AGENT env", () => {
  const reg = join(dir, "claim-env-agent.jsonl");
  const r = run(
    ["claim", "src/**", "--intent", "work", "--registry", reg],
    { WORKLEASE_AGENT: "env-agent" }
  );
  assert.equal(r.status, 0);
  assert.equal(readRegistry(reg)[0].agent, "env-agent");
});

test("missing --intent → error, exit 1, nothing appended", () => {
  const reg = join(dir, "claim-no-intent.jsonl");
  const r = run(["claim", "src/**", "--agent", "a1", "--registry", reg]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /intent/);
  assert.equal(existsSync(reg), false);
});

test("missing agent (no flag, no env) → error, exit 1, nothing appended", () => {
  const reg = join(dir, "claim-no-agent.jsonl");
  const r = run(
    ["claim", "src/**", "--intent", "work", "--registry", reg],
    { WORKLEASE_AGENT: "" }
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /agent/);
  assert.equal(existsSync(reg), false);
});

test("invalid --ttl → error, exit 1, nothing appended", () => {
  const reg = join(dir, "claim-bad-ttl.jsonl");
  const r = run([
    "claim", "src/**", "--intent", "work", "--agent", "a1",
    "--ttl", "20x", "--registry", reg,
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid --ttl/);
  assert.equal(existsSync(reg), false);
});

test("no globs → error, exit 1", () => {
  const reg = join(dir, "claim-no-globs.jsonl");
  const r = run(["claim", "--intent", "work", "--agent", "a1", "--registry", reg]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /one or more globs/);
  assert.equal(existsSync(reg), false);
});

test("invalid glob → INVALID_GLOB reported, exit 1, nothing appended", () => {
  const reg = join(dir, "claim-bad-glob.jsonl");
  const r = run([
    "claim", "src/**/*.ts?", "--intent", "work", "--agent", "a1",
    "--registry", reg,
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /INVALID_GLOB/);
  assert.equal(existsSync(reg), false);
});

test("registry parent dir is auto-created when missing", () => {
  const reg = join(dir, "nested", "deep", "registry.jsonl");
  const r = run(["claim", "src/**", "--intent", "work", "--agent", "a1", "--registry", reg]);
  assert.equal(r.status, 0);
  assert.equal(existsSync(reg), true);
});

test("a filed claim is immediately visible to check (round-trip)", () => {
  const reg = join(dir, "claim-check.jsonl");
  run(["claim", "src/auth/**", "--intent", "auth", "--agent", "a1", "--registry", reg]);

  // A different agent planning an overlapping edit sees a conflict.
  const other = run(["check", "src/auth/login.ts", "--registry", reg, "--agent", "a2"]);
  assert.equal(other.status, 1);
  assert.match(other.stdout, /a1/);

  // The claiming agent is clear on their own claim.
  const self = run(["check", "src/auth/login.ts", "--registry", reg, "--agent", "a1"]);
  assert.equal(self.status, 0);
  assert.match(self.stdout, /clear/);
});

// --- list ------------------------------------------------------------------

// File a claim via the CLI and return its parsed record (via --json).
function fileClaim(reg, globs, opts = {}) {
  const args = [
    "claim", globs,
    "--intent", opts.intent ?? "work",
    "--agent", opts.agent ?? "a1",
    "--registry", reg, "--json",
  ];
  if (opts.ttl) args.push("--ttl", opts.ttl);
  const r = run(args);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("list on a missing registry → 'no active claims', exit 0", () => {
  const r = run(["list", "--registry", join(dir, "list-missing.jsonl")]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no active claims/);
});

test("list --json on empty registry → []", () => {
  const r = run(["list", "--registry", join(dir, "list-empty.jsonl"), "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test("list shows active claims sorted by soonest expiry", () => {
  const reg = join(dir, "list-sorted.jsonl");
  const later = fileClaim(reg, "src/a/**", { ttl: "1h", intent: "slow" });
  const sooner = fileClaim(reg, "src/b/**", { ttl: "5m", intent: "fast" });

  const r = run(["list", "--registry", reg]);
  assert.equal(r.status, 0);
  // Soonest expiry first: the 5m claim's short id appears before the 1h claim's.
  const idxSooner = r.stdout.indexOf(sooner.id.slice(0, 8));
  const idxLater = r.stdout.indexOf(later.id.slice(0, 8));
  assert.ok(idxSooner !== -1 && idxLater !== -1);
  assert.ok(idxSooner < idxLater, "5m claim should list before 1h claim");
});

test("list --json returns the resolved active claim array", () => {
  const reg = join(dir, "list-json.jsonl");
  fileClaim(reg, "src/a/**", { agent: "a1" });
  const r = run(["list", "--registry", reg, "--json"]);
  assert.equal(r.status, 0);
  const arr = JSON.parse(r.stdout);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].status, "active");
  assert.equal(arr[0].agent, "a1");
});

test("list --agent filters to one holder", () => {
  const reg = join(dir, "list-agent.jsonl");
  fileClaim(reg, "src/a/**", { agent: "a1" });
  fileClaim(reg, "src/b/**", { agent: "a2" });
  const r = run(["list", "--registry", reg, "--agent", "a2", "--json"]);
  assert.equal(r.status, 0);
  const arr = JSON.parse(r.stdout);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].agent, "a2");
});

test("list default hides expired; --all shows it labeled", () => {
  const reg = join(dir, "list-expired.jsonl");
  // Directly append an already-expired claim (past expires) via the store.
  appendRecord(reg, {
    agent: "a1", globs: ["src/x/**"], intent: "old",
    ttl_seconds: 60, created: "2000-01-01T00:00:00Z", expires: EXPIRED, status: "active",
  });
  assert.match(run(["list", "--registry", reg]).stdout, /no active claims/);
  const all = run(["list", "--registry", reg, "--all"]);
  assert.equal(all.status, 0);
  assert.match(all.stdout, /expired/);
});

// A dropped (corrupt/tampered/stale) line must not vanish silently: the promised
// warning is the only mitigation, else two agents can both be told a path is clear.
test("list --all warns to stderr about a skipped unparseable line", () => {
  const reg = join(dir, "list-warn-all.jsonl");
  fileClaim(reg, "src/a/**", { agent: "a1" });
  appendFileSync(reg, "this is not json\n");
  const r = run(["list", "--registry", reg, "--all"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /warning:.*skipped/i);
});

test("list --verbose warns even without --all", () => {
  const reg = join(dir, "list-warn-verbose.jsonl");
  fileClaim(reg, "src/a/**", { agent: "a1" });
  appendFileSync(reg, "{ broken\n");
  const r = run(["list", "--registry", reg, "--verbose"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /warning:.*skipped/i);
});

test("plain list stays quiet on stderr (warnings gated behind --all/--verbose)", () => {
  const reg = join(dir, "list-warn-plain.jsonl");
  fileClaim(reg, "src/a/**", { agent: "a1" });
  appendFileSync(reg, "not json\n");
  const r = run(["list", "--registry", reg]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("check warns to stderr about a skipped line so a dropped claim is visible", () => {
  const reg = join(dir, "check-warn.jsonl");
  fileClaim(reg, "src/a/**", { agent: "a1" });
  appendFileSync(reg, "garbage line\n");
  // A different path, so the surviving claim doesn't conflict — the point is the
  // warning fires regardless of the clear/conflict verdict.
  const r = run(["check", "src/z/**", "--registry", reg, "--agent", "a2"]);
  assert.match(r.stderr, /warning:.*skipped/i);
});

// --- release ---------------------------------------------------------------

test("release <full id> appends a release; the claim leaves the active list", () => {
  const reg = join(dir, "release-full.jsonl");
  const claim = fileClaim(reg, "src/a/**", { agent: "a1" });
  const before = readFileSync(reg, "utf8").split("\n").filter((l) => l.trim()).length;

  const r = run(["release", claim.id, "--registry", reg, "--agent", "a1"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /released/);
  assert.match(r.stdout, new RegExp(claim.id.slice(0, 8)));

  // Append-only: exactly one new line, none removed.
  const after = readFileSync(reg, "utf8").split("\n").filter((l) => l.trim()).length;
  assert.equal(after, before + 1);

  // No longer active.
  assert.match(run(["list", "--registry", reg]).stdout, /no active claims/);
});

test("release by unambiguous prefix works", () => {
  const reg = join(dir, "release-prefix.jsonl");
  const claim = fileClaim(reg, "src/a/**", { agent: "a1" });
  const r = run(["release", claim.id.slice(0, 8), "--registry", reg]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /released/);
});

test("release --json emits the appended release record", () => {
  const reg = join(dir, "release-json.jsonl");
  const claim = fileClaim(reg, "src/a/**", { agent: "a1" });
  const r = run(["release", claim.id, "--registry", reg, "--agent", "a1", "--json"]);
  assert.equal(r.status, 0);
  const rel = JSON.parse(r.stdout);
  assert.equal(rel.type, "release");
  assert.equal(rel.claim_id, claim.id);
  assert.equal(rel.agent, "a1");
  assert.ok(rel.id);
});

test("release of an unknown id → error, exit 1", () => {
  const reg = join(dir, "release-unknown.jsonl");
  fileClaim(reg, "src/a/**", { agent: "a1" });
  const r = run(["release", "deadbeefdeadbeef", "--registry", reg]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no claim/);
});

test("release with an ambiguous prefix → error, exit 1", () => {
  const reg = join(dir, "release-ambig.jsonl");
  // Append claims until two share a leading hex char (pigeonhole: ≤17 needed).
  const seen = new Set();
  let prefix = null;
  for (let i = 0; i < 40 && prefix == null; i++) {
    const rec = appendRecord(reg, {
      agent: "a1", globs: [`src/x${i}/**`], intent: "w",
      ttl_seconds: 3600, created: "2099-01-01T00:00:00Z",
      expires: "2099-01-01T01:00:00Z", status: "active",
    });
    const head = rec.id[0];
    if (seen.has(head)) prefix = head;
    else seen.add(head);
  }
  assert.ok(prefix, "expected a colliding leading hex char");
  const r = run(["release", prefix, "--registry", reg]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ambiguous/);
});

test("release of an already-released claim → note, no new line, exit 0", () => {
  const reg = join(dir, "release-twice.jsonl");
  const claim = fileClaim(reg, "src/a/**", { agent: "a1" });
  run(["release", claim.id, "--registry", reg, "--agent", "a1"]);
  const lines = readFileSync(reg, "utf8").split("\n").filter((l) => l.trim()).length;

  const r = run(["release", claim.id, "--registry", reg, "--agent", "a1"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /already released/);
  const after = readFileSync(reg, "utf8").split("\n").filter((l) => l.trim()).length;
  assert.equal(after, lines, "no new line appended for a no-op release");
});

test("release records who released it, noting a non-holder", () => {
  const reg = join(dir, "release-other.jsonl");
  const claim = fileClaim(reg, "src/a/**", { agent: "a1" });
  const r = run(["release", claim.id, "--registry", reg, "--agent", "a2", "--json"]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).agent, "a2");
  // The claim was held by a1 — still resolvable as released.
  const all = run(["list", "--registry", reg, "--all", "--json"]);
  const arr = JSON.parse(all.stdout);
  assert.equal(arr[0].status, "released");
  assert.equal(arr[0].released_by, "a2");
});

// --- conformance ------------------------------------------------------------

// Write a merges fixture (defaults to JSON array). Pass a raw string to control
// the encoding (e.g. JSONL or malformed JSON).
function merges(name, data) {
  return fixture(name, data);
}

test("conformance: clean merges (all respected) → readable summary, exit 0; --json empty violations", () => {
  const reg = registry("conf-clean.jsonl", [
    { id: "1", agent: "a1", globs: ["src/auth/**"] },
  ]);
  const m = merges("conf-clean.json", [{ agent: "a1", files: ["src/auth/login.ts"] }]);

  const r = run(["conformance", reg, m]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /coordination score 1\.00/);
  assert.match(r.stdout, /1\/1 change respected/);

  const j = run(["conformance", reg, m, "--json"]);
  assert.equal(j.status, 0);
  const out = JSON.parse(j.stdout);
  assert.equal(out.score, 1);
  assert.deepEqual(out.violations, []);
});

test("conformance: merges with a violation → exit 1; --json lists full conflicting_claim", () => {
  const reg = registry("conf-viol.jsonl", [
    { id: "1", agent: "a2", globs: ["src/auth/**"], intent: "auth" },
  ]);
  const m = merges("conf-viol.json", [{ agent: "a1", files: ["src/auth/login.ts"] }]);

  const r = run(["conformance", reg, m]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /a1 edited src\/auth\/login\.ts under a2's claim/);

  const j = run(["conformance", reg, m, "--json"]);
  assert.equal(j.status, 1);
  const out = JSON.parse(j.stdout);
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].conflicting_claim.agent, "a2");
  assert.deepEqual(out.violations[0].conflicting_claim.globs, ["src/auth/**"]);
});

test("conformance: merges with only warnings (no collisions) → exit 0 (advisory), low score", () => {
  const reg = registry("conf-warn.jsonl", [
    { id: "1", agent: "a1", globs: ["src/auth/**"] },
  ]);
  const m = merges("conf-warn.json", [{ agent: "a1", files: ["docs/README.md"] }]);
  const r = run(["conformance", reg, m, "--json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.score, 0);
  assert.equal(out.warnings.length, 1);
  assert.equal(out.violations.length, 0);
});

test("conformance: past-TTL active claim + no-`at` cross-agent merge → violation, exit 1", () => {
  // The claim's `expires` is already in the past relative to the real clock, so
  // `loadRegistry` would resolve it to `expired` under wall-clock TTL decay.
  // conformance must load WITHOUT that decay and honor the stored active state:
  // a timestamp-less merge under another agent's claim is a real collision, not
  // a warning. (Before the fix this reported an all-clear exit 0.)
  const reg = registry("conf-past-ttl.jsonl", [
    { id: "1", agent: "a2", globs: ["src/auth/**"], intent: "auth", expires: EXPIRED },
  ]);
  const m = merges("conf-past-ttl.json", [{ agent: "a1", files: ["src/auth/login.ts"] }]);

  const r = run(["conformance", reg, m]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /a1 edited src\/auth\/login\.ts under a2's claim/);

  const j = run(["conformance", reg, m, "--json"]);
  assert.equal(j.status, 1);
  const out = JSON.parse(j.stdout);
  assert.equal(out.violations.length, 1);
  assert.equal(out.warnings.length, 0);
  assert.equal(out.violations[0].conflicting_claim.agent, "a2");
});

test("conformance: merges as a JSON array and as JSONL load equivalently", () => {
  const reg = registry("conf-fmt.jsonl", [
    { id: "1", agent: "a1", globs: ["src/auth/**"] },
  ]);
  const rec = { agent: "a1", files: ["src/auth/login.ts"] };
  const asArray = merges("conf-array.json", [rec]);
  const asJsonl = merges("conf-jsonl.json", JSON.stringify(rec) + "\n");

  const a = JSON.parse(run(["conformance", reg, asArray, "--json"]).stdout);
  const b = JSON.parse(run(["conformance", reg, asJsonl, "--json"]).stdout);
  assert.deepEqual(a, b);
});

test("conformance: missing registry file → empty registry (all warnings), exit 0", () => {
  const m = merges("conf-noreg.json", [{ agent: "a1", files: ["src/auth/login.ts"] }]);
  const r = run(["conformance", join(dir, "no-registry.jsonl"), m, "--json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.score, 0);
  assert.equal(out.warnings.length, 1);
});

test("conformance: missing merges file → total 0, score 1, exit 0", () => {
  const reg = registry("conf-nomerges.jsonl", [
    { id: "1", agent: "a1", globs: ["src/auth/**"] },
  ]);
  const r = run(["conformance", reg, join(dir, "no-merges.json"), "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    score: 1,
    total: 0,
    respected: 0,
    violations: [],
    warnings: [],
  });
});

test("conformance: malformed merges JSON → clear error, exit 1", () => {
  const reg = registry("conf-bad.jsonl", []);
  const m = merges("conf-bad.json", "[ { not valid ");
  const r = run(["conformance", reg, m]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid merges JSON/);
});

test("conformance: missing positional arg → usage, exit 1", () => {
  const reg = registry("conf-missing.jsonl", []);
  const r = run(["conformance", reg]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires <registry> and <merges>/);
});

test("conformance: unknown flag → usage, exit 1", () => {
  const reg = registry("conf-flag.jsonl", []);
  const m = merges("conf-flag.json", []);
  const r = run(["conformance", reg, m, "--bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown flag/);
});
