import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "bin", "worklease.js");

// Run the CLI as a child process. Returns { status, stdout, stderr }.
function run(args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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

let dir;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), "worklease-cli-"));
});
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name, data) {
  const p = join(dir, name);
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
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

test("unknown subcommand → usage, exit 1", () => {
  const r = run(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage:/);
});

test("validate without a file → error, exit 1", () => {
  const r = run(["validate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires a file/);
});
