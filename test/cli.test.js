import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaim } from "../src/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "bin", "worklease.js");

// Run the CLI as a child process. Returns { status, stdout, stderr }.
function run(args, env = {}) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      status: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
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

function record(o) {
  return {
    id: o.id,
    agent: o.agent,
    globs: o.globs,
    intent: o.intent ?? "work",
    expires: o.expires ?? ACTIVE,
    status: o.status ?? "active",
  };
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

test("latest record per id wins (released supersedes active)", () => {
  const reg = registry("resolve.jsonl", [
    { id: "1", agent: "other", globs: ["src/auth/**"], status: "active" },
    { id: "1", agent: "other", globs: ["src/auth/**"], status: "released" },
  ]);
  const r = run(["check", "src/auth/x.ts", "--registry", reg, "--json"]);
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

// --- conformance ------------------------------------------------------------

// Write a merges fixture (defaults to JSON array). Pass a raw string to control
// the encoding (e.g. JSONL or malformed JSON).
function merges(name, data) {
  return fixture(name, data);
}

test("clean merges (all respected) → readable summary, exit 0; --json empty violations", () => {
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

test("merges with a violation → exit 1; --json lists full conflicting_claim", () => {
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

test("merges with only warnings (no collisions) → exit 0 (advisory), low score", () => {
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

test("merges as a JSON array and as JSONL load equivalently", () => {
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

test("missing registry file → empty registry (all warnings), exit 0", () => {
  const m = merges("conf-noreg.json", [{ agent: "a1", files: ["src/auth/login.ts"] }]);
  const r = run(["conformance", join(dir, "no-registry.jsonl"), m, "--json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.score, 0);
  assert.equal(out.warnings.length, 1);
});

test("missing merges file → total 0, score 1, exit 0", () => {
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

test("malformed merges JSON → clear error, exit 1", () => {
  const reg = registry("conf-bad.jsonl", []);
  const m = merges("conf-bad.json", "[ { not valid ");
  const r = run(["conformance", reg, m]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid merges JSON/);
});

test("missing positional arg → usage, exit 1", () => {
  const reg = registry("conf-missing.jsonl", []);
  const r = run(["conformance", reg]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires <registry> and <merges>/);
});

test("conformance unknown flag → usage, exit 1", () => {
  const reg = registry("conf-flag.jsonl", []);
  const m = merges("conf-flag.json", []);
  const r = run(["conformance", reg, m, "--bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown flag/);
});
