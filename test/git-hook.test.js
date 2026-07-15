import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRecordId } from "../src/registry.js";
import {
  stagedPaths,
  checkStagedPaths,
  renderHookBlock,
  installHook,
} from "../src/adapters/git-hook.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "bin", "worklease.js");
const SAMPLE = join(__dirname, "..", "examples", "pre-commit.sample");

const ACTIVE = "2099-01-01T00:00:00Z";

// A self-consistent, schema-complete claim record (its `id` is its own content
// hash), so it survives loadRegistry's integrity filter AND its record-shape
// validation (a claim needs every CLAIM_FIELD, including created + ttl_seconds).
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

// Run the CLI as a child process from a given cwd.
function run(args, { cwd, env = {} } = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// A throwaway git repo with a configured identity, so commits/hooks work.
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), "worklease-hook-"));
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Tester");
  git("config", "commit.gpgsign", "false");
  return { dir, git };
}

// Write a JSONL registry at the repo's default path and return that path.
function writeRegistry(dir, records) {
  const p = join(dir, ".worklease", "registry.jsonl");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, records.map((r) => JSON.stringify(record(r))).join("\n") + "\n");
  return p;
}

// --- checkStagedPaths (the check-on-staged-paths core) ---------------------

test("checkStagedPaths: no staged paths → clear", () => {
  const out = checkStagedPaths([], {});
  assert.deepEqual(out, { clear: true, conflicts: [], notes: [] });
});

test("checkStagedPaths: staged file under another agent's claim → conflict", () => {
  const { dir } = initRepo();
  const reg = writeRegistry(dir, [
    { agent: "other", globs: ["src/auth/**"], intent: "auth" },
  ]);
  const out = checkStagedPaths(["src/auth/login.ts"], { registry: reg });
  assert.equal(out.clear, false);
  assert.equal(out.conflicts.length, 1);
  assert.deepEqual(out.conflicts[0].overlapping_globs, ["src/auth/**"]);
  rmSync(dir, { recursive: true, force: true });
});

test("checkStagedPaths: own claim (--agent) is clear", () => {
  const { dir } = initRepo();
  const reg = writeRegistry(dir, [
    { agent: "me", globs: ["src/auth/**"] },
  ]);
  const out = checkStagedPaths(["src/auth/login.ts"], { registry: reg, agent: "me" });
  assert.equal(out.clear, true);
  rmSync(dir, { recursive: true, force: true });
});

test("checkStagedPaths: surfaces loadRegistry notes for a dropped line", () => {
  const { dir } = initRepo();
  const reg = writeRegistry(dir, [{ agent: "other", globs: ["src/a/**"] }]);
  writeFileSync(reg, readFileSync(reg, "utf8") + "not json\n");
  const out = checkStagedPaths(["src/z/x.ts"], { registry: reg });
  assert.ok(out.notes.some((n) => /skipped/i.test(n)));
  rmSync(dir, { recursive: true, force: true });
});

// --- stagedPaths -----------------------------------------------------------

test("stagedPaths: lists staged files; empty outside a conflict", () => {
  const { dir, git } = initRepo();
  writeFileSync(join(dir, "a.txt"), "hi");
  writeFileSync(join(dir, "b.txt"), "yo");
  git("add", "a.txt");
  const paths = stagedPaths({ cwd: dir });
  assert.deepEqual(paths.sort(), ["a.txt"]);
  rmSync(dir, { recursive: true, force: true });
});

test("stagedPaths: non-git directory → [] (never throws)", () => {
  const dir = mkdtempSync(join(tmpdir(), "worklease-nogit-"));
  assert.deepEqual(stagedPaths({ cwd: dir }), []);
  rmSync(dir, { recursive: true, force: true });
});

// --- renderHookBlock + committed sample ------------------------------------

test("renderHookBlock: advisory omits --strict, strict includes it", () => {
  const warn = renderHookBlock(false);
  const strict = renderHookBlock(true);
  assert.match(warn, /worklease hook run$/m);
  assert.doesNotMatch(warn, /--strict/);
  assert.match(strict, /worklease hook run --strict/);
});

test("committed sample matches the freshly-created advisory hook", () => {
  const expected = `#!/bin/sh\n${renderHookBlock(false)}\n`;
  assert.equal(readFileSync(SAMPLE, "utf8"), expected);
});

// --- installHook -----------------------------------------------------------

test("installHook: creates an executable hook when none exists", () => {
  const { dir } = initRepo();
  const res = installHook({ cwd: dir });
  assert.equal(res.action, "created");
  assert.equal(existsSync(res.path), true);
  const body = readFileSync(res.path, "utf8");
  assert.match(body, /^#!\/bin\/sh/);
  assert.match(body, /worklease hook run/);
  // Owner-executable bit set.
  assert.ok(statSync(res.path).mode & 0o100);
  rmSync(dir, { recursive: true, force: true });
});

test("installHook: idempotent — re-install updates the one block, no dupes", () => {
  const { dir } = initRepo();
  installHook({ cwd: dir });
  const res = installHook({ cwd: dir, strict: true });
  assert.equal(res.action, "updated");
  const body = readFileSync(res.path, "utf8");
  assert.equal(body.match(/# >>> worklease >>>/g).length, 1);
  assert.equal(body.match(/# <<< worklease <<</g).length, 1);
  assert.match(body, /--strict/);
  rmSync(dir, { recursive: true, force: true });
});

test("installHook: preserves an existing hook by appending the block", () => {
  const { dir } = initRepo();
  const hookFile = join(dir, ".git", "hooks", "pre-commit");
  mkdirSync(dirname(hookFile), { recursive: true });
  writeFileSync(hookFile, "#!/bin/sh\necho custom-check\n");
  const res = installHook({ cwd: dir });
  assert.equal(res.action, "appended");
  const body = readFileSync(res.path, "utf8");
  assert.match(body, /echo custom-check/); // existing content preserved
  assert.match(body, /worklease hook run/); // block added
  rmSync(dir, { recursive: true, force: true });
});

test("installHook: outside a git repo → throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "worklease-nogit2-"));
  assert.throws(() => installHook({ cwd: dir }), /not a git repository/);
  rmSync(dir, { recursive: true, force: true });
});

// --- CLI: hook install -----------------------------------------------------

test("CLI hook install: writes the hook, reports the action + mode", () => {
  const { dir } = initRepo();
  const r = run(["hook", "install"], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /created pre-commit hook/);
  assert.match(r.stdout, /advisory/);
  assert.equal(existsSync(join(dir, ".git", "hooks", "pre-commit")), true);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI hook install --strict: reports strict mode + bakes --strict", () => {
  const { dir } = initRepo();
  const r = run(["hook", "install", "--strict"], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /strict/);
  const body = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(body, /worklease hook run --strict/);
  rmSync(dir, { recursive: true, force: true });
});

// --- CLI: hook run ---------------------------------------------------------

test("CLI hook run: no staged files → clear, exit 0", () => {
  const { dir } = initRepo();
  const r = run(["hook", "run"], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /clear/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI hook run: staged conflict warns but exits 0 (advisory default)", () => {
  const { dir, git } = initRepo();
  writeRegistry(dir, [{ agent: "other", globs: ["src/auth/**"], intent: "auth" }]);
  mkdirSync(join(dir, "src", "auth"), { recursive: true });
  writeFileSync(join(dir, "src", "auth", "login.ts"), "x");
  git("add", "src/auth/login.ts");
  const r = run(["hook", "run"], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /conflict/);
  assert.match(r.stdout, /other/);
  assert.match(r.stdout, /advisory/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI hook run --strict: staged conflict exits 1 (blocks the commit)", () => {
  const { dir, git } = initRepo();
  writeRegistry(dir, [{ agent: "other", globs: ["src/auth/**"], intent: "auth" }]);
  mkdirSync(join(dir, "src", "auth"), { recursive: true });
  writeFileSync(join(dir, "src", "auth", "login.ts"), "x");
  git("add", "src/auth/login.ts");
  const r = run(["hook", "run", "--strict"], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /conflict/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI hook run: own claim is clear even in --strict", () => {
  const { dir, git } = initRepo();
  writeRegistry(dir, [{ agent: "me", globs: ["src/auth/**"] }]);
  mkdirSync(join(dir, "src", "auth"), { recursive: true });
  writeFileSync(join(dir, "src", "auth", "login.ts"), "x");
  git("add", "src/auth/login.ts");
  const r = run(["hook", "run", "--strict", "--agent", "me"], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /clear/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI hook run --json: emits { clear, conflicts }", () => {
  const { dir, git } = initRepo();
  writeRegistry(dir, [{ agent: "other", globs: ["src/auth/**"], intent: "auth" }]);
  mkdirSync(join(dir, "src", "auth"), { recursive: true });
  writeFileSync(join(dir, "src", "auth", "login.ts"), "x");
  git("add", "src/auth/login.ts");
  const r = run(["hook", "run", "--json"], { cwd: dir });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.clear, false);
  assert.equal(out.conflicts.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// --- CLI: hook argument handling -------------------------------------------

test("CLI hook without a subcommand → usage, exit 1", () => {
  const r = run(["hook"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires a subcommand/);
});

test("CLI hook with an unknown subcommand → error, exit 1", () => {
  const r = run(["hook", "frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown hook subcommand/);
});

test("CLI hook install with an unknown flag → error, exit 1", () => {
  const r = run(["hook", "install", "--bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown flag/);
});

// --- end-to-end: the hook actually gates `git commit` ----------------------

// Prove the installed hook fires from a real `git commit`. The generated hook
// calls `worklease` off PATH, so we drop a tiny shim that execs this CLI.
test("e2e: strict hook blocks a conflicting commit; advisory lets it through", () => {
  const { dir, git } = initRepo();
  const bin = join(dir, "shimbin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "worklease");
  writeFileSync(shim, `#!/bin/sh\nexec node "${CLI}" "$@"\n`);
  spawnSync("chmod", ["+x", shim]);
  const env = { PATH: `${bin}:${process.env.PATH}` };

  writeRegistry(dir, [{ agent: "other", globs: ["src/auth/**"], intent: "auth" }]);
  mkdirSync(join(dir, "src", "auth"), { recursive: true });
  writeFileSync(join(dir, "src", "auth", "login.ts"), "x");

  // Strict: the commit is aborted by the hook.
  run(["hook", "install", "--strict"], { cwd: dir });
  git("add", "src/auth/login.ts");
  const strict = spawnSync("git", ["commit", "-m", "should-block"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ...env },
  });
  assert.notEqual(strict.status, 0, "strict hook should abort the commit");

  // Advisory: the same staged change commits cleanly.
  run(["hook", "install"], { cwd: dir });
  const warn = spawnSync("git", ["commit", "-m", "should-pass"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ...env },
  });
  assert.equal(warn.status, 0, warn.stderr);

  rmSync(dir, { recursive: true, force: true });
});
