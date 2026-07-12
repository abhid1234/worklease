# Technical spec — Issue #18: the collision-prevention playground

## Approach
A **zero-build static site** under `site/`: one `index.html`, a stylesheet, a
playground controller in vanilla ES modules, and `site/lib/` holding the real
library. The key move is to run the shipped library **unchanged** in the browser
by resolving its Node built-ins with tiny shims via a native **import map** —
rather than reimplementing overlap/claim/registry logic. Five of the six modules
(`glob.js`, `schema.js`, `check.js`, `conformance.js`, `claim.js`) are already
pure and import nothing from `node:*`, so they are copied verbatim and run
as-is. Only `registry.js` touches Node built-ins (`node:crypto` for the sha256
content hash, `node:fs`/`node:path` for the append-only JSONL store). The import
map aliases those three specifiers to ~40-line browser shims: a synchronous
sha256 `createHash`, and an **in-memory filesystem** (a `Map<path, string>`)
that implements `readFileSync` / `appendFileSync` / `mkdirSync` with the same
append-only, one-line-per-record semantics. With that, `registry.js` is *also*
byte-identical to `src/` and the playground's registry is the real store, just
backed by memory instead of disk. The controller scripts the two-agent scenario
by calling the real `makeClaim` + `appendRecord` (to file A's claim) and the
real `check` (to steer B), and renders the live registry from `loadRegistry` /
`listActive`.

### Module portability (what runs as-is vs. needs a shim)
| Module | Node imports | In browser |
| --- | --- | --- |
| `glob.js` | none | verbatim copy, runs as-is |
| `schema.js` | none | verbatim copy, runs as-is |
| `check.js` | `./glob.js` | verbatim copy, runs as-is |
| `conformance.js` | `./glob.js`, `./schema.js` | verbatim copy (not needed by the demo, but copied for completeness) |
| `claim.js` | `./registry.js` (`computeRecordId`) | verbatim copy, runs as-is once registry's shims resolve |
| `registry.js` | `node:crypto`, `node:fs`, `node:path` | verbatim copy; built-ins resolved by shims via import map |
| `index.js` | the above | verbatim copy (barrel of re-exports) |

`registry.js` also references `process.env` / `process.cwd()` inside
`defaultRegistryPath`. The controller never calls `defaultRegistryPath` (it
passes an explicit in-memory path, e.g. `"registry.jsonl"`), but to keep any
incidental reference safe the page defines a 3-line `globalThis.process =
{ env: {}, cwd: () => "/" }` before the module graph loads. No other `process`
use exists in the copied modules (`WORKLEASE_AGENT`/`WORKLEASE_REGISTRY` reads
live only in `bin/worklease.js`, which is **not** copied).

### The browser shims — `site/lib/shims/`
- **`crypto.js`** — exports `createHash(alg)` returning an object with
  `.update(str).digest("hex")`, a self-contained synchronous SHA-256 (zero
  deps). This is the one real constraint: `computeRecordId` is synchronous and
  the platform `crypto.subtle.digest` is async, so a small sync sha256 is
  required to keep `registry.js`/`claim.js` unchanged. Correctness is pinned by a
  test: for a fixed record, the shim's `computeRecordId` must equal Node's.
- **`fs.js`** — an in-memory store: `readFileSync(path)` (throws an
  `ENOENT`-coded error when absent, matching `loadRegistry`'s missing-file
  branch), `appendFileSync(path, data)` (concatenate — preserves the O_APPEND
  one-line-per-record model), `mkdirSync` (no-op). Backed by a module-level
  `Map`; the controller can reset it between replays.
- **`path.js`** — `join(...parts)` and `dirname(p)` (string ops only).
- **`import-map`** in `index.html`:
  ```html
  <script type="importmap">
  { "imports": {
      "node:crypto": "./lib/shims/crypto.js",
      "node:fs":     "./lib/shims/fs.js",
      "node:path":   "./lib/shims/path.js"
  } }
  </script>
  ```

### The playground controller — `site/app.js`
A small state machine over a scripted timeline; no framework. Responsibilities:
- Hold demo state: the mock repo (tasks + files, hotspot `config.js`), the two
  agents, the worklease OFF/ON mode, the in-memory registry path, and a timeline
  cursor.
- **OFF path:** both agents "choose" `config.js` (scripted), both "write" it →
  render a merge-conflict badge on `config.js` and a duplicated-work flag. No
  registry calls (worklease is off).
- **ON path:** Agent A files a claim — build it with the real
  `makeClaim(["config.js"], { agent:"A", intent:"tune config", ttl_seconds, created })`
  and persist it with the real `appendRecord(path, claim)`. Agent B, before
  starting, calls the real `check(["config.js"], loadRegistry(path).claims,
  { agent:"B", now })`; on `clear:false` it re-picks the first task whose file is
  unclaimed (a second real `check` on that file returns `clear:true`), then
  "writes" it. Render: no conflict, no duplication.
- **Time:** the controller owns a single `now` clock (a scripted, fast-forwarded
  value it also passes as `check`'s `opts.now` and `loadRegistry`'s `now`) so TTL
  expiry in the live view is deterministic and demo-paced, not wall-clock-bound.
- **Live registry panel:** after each step, `loadRegistry(path, { now })` →
  `listActive` (or render all with `formatRelative(expires, now)`), showing
  agent / globs / intent / relative expiry, matching the CLI `list` columns.
- **Call trace:** surface the pivotal `check` input and its returned object
  (`{ clear, conflicts }`) and A's filed claim, so the "real library" claim is
  visible on the page.
- Controls: OFF/ON toggle, Replay (reset the fs Map + cursor, re-run), Step
  (advance one timeline action). Autoplay on load runs OFF then ON.

### Deploy — Vercel static
- The site is fully static (no bundler, no transform); native import maps + ESM
  are supported by current evergreen browsers (the demo's audience).
- Add a `vercel.json` (repo root) pointing the deploy at `site/` as a static
  output with no build command — e.g. `{ "buildCommand": null, "outputDirectory":
  "site" }` (or configure the Vercel project root as `site/`). `.gitignore`
  already ignores `.vercel/`. No env vars, no serverless functions.

## Files / functions to touch
All new; **no `src/` product code is modified** (the copies are additive).
- **`site/index.html`** (new) — page shell, the import map, `globalThis.process`
  shim, and the two-agent + registry layout.
- **`site/styles.css`** (new) — house style matching constraintguard.vercel.app.
- **`site/app.js`** (new) — the scripted controller described above; imports from
  `./lib/index.js`.
- **`site/lib/{glob,schema,check,conformance,claim,registry,index}.js`** (new) —
  copies of `src/*.js`. The pure five are byte-identical; `registry.js` is
  byte-identical and resolves its `node:*` imports through the shims.
- **`site/lib/shims/{crypto,fs,path}.js`** (new) — the three browser shims.
- **`vercel.json`** (new) — static-deploy config for `site/`.
- **`scripts/sync-lib.mjs`** (new, small) — copies `src/*.js` → `site/lib/*.js`,
  the single source of truth for the copy; run at implementation time and
  re-runnable when `src/` changes.
- **`test/site-lib.test.js`** (new) — asserts each `site/lib/<m>.js` is
  byte-identical to `src/<m>.js` (drift guard), and asserts the crypto shim's
  `computeRecordId` for a fixed record equals Node's `src/registry.js`
  `computeRecordId` (shim-correctness guard).
- **`README.md`** (update at implementation time, not in this spec PR) — a short
  "Playground" section linking the deployed URL.

No `package.json` runtime deps are added; `test: node --test` already covers the
new test file.

## Test plan
Run with `npm test` (`node --test`) plus a manual browser smoke check.

**Automated (`node --test`)**
- **Drift guard:** for each of the seven `lib` modules, `readFileSync(site/lib/x)
  === readFileSync(src/x)` (byte-identical). Fails if `src/` changes without a
  re-sync — the honesty guarantee.
- **Shim correctness:** load `site/lib/shims/crypto.js`, feed the same canonical
  pre-image `src/registry.js` uses, and assert the hex digest equals Node
  `crypto.createHash("sha256")` for several fixtures (including a full claim
  record) → `computeRecordId` is identical across shim and Node.
- **In-memory fs semantics:** `appendFileSync` then `readFileSync` returns the
  concatenation; a missing path throws an `ENOENT`-coded error so
  `loadRegistry`'s missing-file branch returns `{ claims: [], notes: [] }`;
  `mkdirSync` is a no-op.
- **End-to-end library-in-browser-shims:** using only `site/lib/*` (with the
  shims wired), reproduce the ON scenario in Node — `makeClaim` + `appendRecord`
  A's claim to the in-memory path, then `check(["config.js"], loadRegistry(path).
  claims, { agent:"B", now })` returns `clear:false` with A's claim in
  `conflicts`; a `check` on the unclaimed file returns `clear:true`. This proves
  the copied graph behaves identically to `src/`.

**Manual browser smoke**
- Open `site/index.html` (or the Vercel preview): autoplay runs OFF → visible
  conflict + duplicated-work, then ON → no conflict, B steers away.
- Toggle OFF/ON manually; Replay resets cleanly (registry empties); Step advances
  one action at a time.
- The live registry panel shows A's claim with a counting-down relative expiry
  and drops it when the scripted clock passes `expires`.
- Console is free of `node:*` resolution errors and `process is not defined`.

## Risks / edge cases / migrations
- **src ↔ site/lib drift.** The biggest risk to the "real library" promise. Two
  mitigations: `scripts/sync-lib.mjs` as the only way copies are made, and the
  byte-identical test that fails CI if they diverge. (An `<script>`-served copy
  can't `import` straight from `../src/` because of the `node:*` specifiers, which
  is exactly why the import-map + shim approach exists.)
- **Synchronous hash requirement.** `computeRecordId` is sync; WebCrypto is
  async. Reimplementing sha256 in ~40 lines is the accepted cost of keeping
  `registry.js` unchanged; pinned by the shim-correctness test. (Alternative —
  making the library async — is rejected: it would change `src/`.)
- **`process` reference in `defaultRegistryPath`.** Guarded by the tiny
  `globalThis.process` shim and by never calling it from the controller; noted so
  an implementer doesn't wire it accidentally.
- **Import-map / ESM support.** Fine for evergreen browsers (the demo audience);
  not a concern for the CLI. No IE/legacy support is a non-goal.
- **House-style fidelity.** "Match constraintguard" is a design bar; if a shared
  design system/tokens exist across the family they should be reused (flagged in
  PRODUCT.md open questions) rather than re-approximated.
- **Scenario realism vs. curation.** The demo is a curated script, but every
  claim/check/registry result must be a **real** library return — the script
  chooses *inputs and timing*, never fakes *outputs*. Keeping that line is what
  makes the demo trustworthy.
- **No migrations / no data.** Greenfield `site/`; no persisted state, no schema
  or CLI change, no effect on the published package (`files` in `package.json`
  ships `bin`/`src` only, so `site/` is not published to npm).

## Alternatives considered
- **Reimplement overlap/claim/registry in browser-friendly JS** — rejected: the
  whole point is that the demo runs the *real* library; a parallel implementation
  could pass while the shipped code fails, destroying the demo's credibility.
- **Bundle the library with a build step (esbuild/rollup + a Node-polyfill
  plugin)** — rejected: adds a toolchain and dependencies to a zero-dep repo for
  no gain; native import maps + three hand-written shims are smaller and keep the
  files byte-identical and auditable.
- **Async WebCrypto for hashing (make the library async)** — rejected: would
  require changing `src/registry.js`/`claim.js` signatures; a sync sha256 shim
  keeps `src/` untouched.
- **Symlink or bundler-alias `src/` into `site/`** — rejected: Vercel static
  serving and the `node:*` specifiers make a served copy + import map the robust
  path; the byte-identical test recovers the "single source" property a symlink
  would give.
- **Manual-drive-first UX (visitor causes the collision)** — recommended
  alternative, not chosen: slower to the payoff for a shareable hook; the same
  controls support it, so it's a one-line default change if the reviewer prefers.
- **A backend that runs the real Node CLI** — rejected: adds hosting/latency and
  breaks the "runs client-side" framing; the library is pure enough to run in the
  browser directly.
