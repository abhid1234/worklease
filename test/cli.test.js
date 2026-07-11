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

// Write a JSONL registry fixture, one record per line.
function registry(name, records) {
  const p = join(dir, name);
  writeFileSync(p, records.map((r) => JSON.stringify(record(r))).join("\n") + "\n");
  return p;
}

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
