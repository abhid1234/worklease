# Product spec — Issue #18: the collision-prevention playground

## Problem / motivation
worklease's pitch is invisible on the page: "parallel agents collide on hotspot
files; a claim lets them steer clear." A reader has to *imagine* the collision
and *trust* that a claim prevents it. The playground makes it visceral. It runs
the **real** library in the browser — the same `check` / `claim` / registry code
that ships in `src/` — and stages the exact failure the vision describes: two
agents pick work in a repo with a shared hotspot file. With worklease **off**,
both edit `config.js` and collide (merge conflict + duplicated work). With
worklease **on**, agent B's `check` sees agent A's live claim, picks different
work, and the collision never happens — with a live registry view updating as
claims are filed and expire. This is the roadmap's "community hook — priority"
and part of the v0.1 done-definition ("a live playground where you watch two
agents *avoid* a collision"). It must land in the same house style as
[constraintguard.vercel.app](https://constraintguard.vercel.app).

## Desired behavior
A single static page at `site/` (deployed to Vercel) that a first-time visitor
understands in seconds:

1. **The setup, shown once.** A tiny repo with three tasks and a shared hotspot
   file `config.js`. Two agents — **Agent A** and **Agent B** — each need to do
   work; both are eligible to touch `config.js`.
2. **A prominent worklease OFF / ON toggle** — the primary control, the thing the
   whole page turns on.
3. **worklease OFF → the collision.** Both agents independently decide to edit
   `config.js`. The page shows them both writing it, then the payoff: a **merge
   conflict** on `config.js` and a "**duplicated work**" flag (both did the same
   task). The registry view is empty/greyed — nobody declared intent.
4. **worklease ON → the collision prevented.** Agent A files a claim on
   `config.js` (`worklease claim`), which appears live in the registry view.
   Agent B, before starting, runs `check config.js` against the **real**
   registry — sees A's active claim — and **steers to different work** (a task on
   an unclaimed file). Both agents finish; **no conflict, no duplication**. The
   registry view shows A's claim active (and counting down / expiring).
5. **A live registry panel** rendered from the real resolved registry (`list` /
   `listActive`): agent, globs, intent, relative expiry — updating as claims are
   filed, checked against, and expire.
6. **The "this is the real library" proof.** The page surfaces the actual calls
   it makes — e.g. `check("config.js") → { clear: false, conflicts: [...] }` and
   `claim("config.js", …)` — so a technical visitor sees these are genuine
   library results, not a canned animation.

### Locked product decision — auto-run first, manual controls available
The issue flags one open question: *lead with the auto-running collision
scenario, or let the user drive the two agents manually?*

**Chosen: auto-run is the default.** On load, the page auto-plays a scripted
timeline — it leads with worklease **OFF** so the visitor *feels the pain* (both
agents grab `config.js` → conflict + duplicated work), then flips to **ON** and
replays, so agent B's `check` steers it clear and the collision is prevented. A
persistent **OFF/ON toggle** and a **Replay** control let the visitor re-run
either mode themselves; a **Step** control lets the curious advance the timeline
one action at a time. So the hero moment is delivered in the first few seconds
with zero interaction (the community-hook requirement), while the toggle keeps
the core interaction — *OFF collides, ON prevents* — genuinely in the visitor's
hands. Rationale: a shareable hook must pay off before a visitor learns any
controls, but the toggle is what makes the prevention feel real rather than
watched. See Open questions — a reviewer may prefer manual-first.

## Acceptance criteria
- [ ] A static site under `site/` (HTML + CSS + browser ES modules, **zero
      runtime dependencies**, no build step) deploys to Vercel and renders the
      two-agent playground.
- [ ] `site/lib/` contains the **real** library as browser ES modules: the pure
      modules (`glob.js`, `schema.js`, `check.js`, `conformance.js`, `claim.js`)
      are byte-identical copies of `src/`, and `registry.js` runs unchanged via
      thin browser shims for its Node built-ins (see TECH.md). The demo's
      overlap / claim / registry logic is the shipped code, not a reimplementation.
- [ ] The **OFF** scenario shows both agents editing `config.js` and ends in a
      visible **merge conflict** on `config.js` **and** a **duplicated-work**
      indicator; the registry view is empty in this mode.
- [ ] The **ON** scenario: Agent A files a real claim (appended to an in-memory
      registry via the real `claim`/registry code); Agent B runs the real
      `check("config.js")`, receives `clear: false` with A's claim in
      `conflicts`, and visibly **picks a different, unclaimed task**; the run ends
      with **no conflict and no duplication**.
- [ ] A **live registry panel** renders active claims from the real resolved
      registry (agent, globs, intent, relative expiry) and updates as claims are
      filed and as TTLs expire.
- [ ] The page **auto-plays on load** (OFF → collision, then ON → prevented) and
      exposes a persistent **OFF/ON toggle**, a **Replay**, and a **Step**
      control; nothing requires the visitor to read instructions to see the
      payoff.
- [ ] The page shows the **actual library calls and their return values** for at
      least the pivotal `check` (the one that steers Agent B) and the claim A
      files, so a technical visitor can see they are real results.
- [ ] Visual **house style matches constraintguard.vercel.app** (layout, type,
      colour, motion feel) — a recognizable sibling in the family, not a
      re-theme.
- [ ] Vercel static-deploy config is committed so a push deploys the `site/`
      directory with no build.
- [ ] A guard keeps `site/lib/` honest: a test (or a documented sync script)
      asserts the copied pure modules match `src/` byte-for-byte, so the
      playground can't silently drift from the shipped library.

## Non-goals
- **Not** a rewrite or fork of the library. The playground **consumes** the real
  `src/` modules; it does not reimplement overlap, claim construction, or the
  registry fold. Any browser-only code is a thin shim/adapter around them.
- **Not** a real filesystem or git registry in the browser. The registry is an
  in-memory JSONL store driven through the real registry code (append-only
  semantics preserved); no disk, no `git`, no network.
- **Not** a multi-user or persisted demo — no backend, no accounts, no shared
  state across visitors. Each page load is a self-contained scripted run.
- **Not** a general worklease UI or dashboard (that's roadmap #8 `watch`); the
  playground is one hard-coded, curated scenario tuned for the hook.
- **Not** extending the library's behavior, CLI, glob syntax, or schema. If the
  demo needs something the library can't do, that's a signal — not a
  browser-only patch.
- **Not** the launch video/posts kit (separate roadmap item) — just the page the
  video will point at.
- **Not** publishing to npm or wiring CI/deploy secrets beyond the Vercel static
  config committed here.

## Open questions (for the human gate)
Written around the recommended answers; a reviewer may overrule:
- **Auto-run first (chosen) vs. manual-drive first.** Chosen: auto-play the
  OFF→ON story on load, with toggle/replay/step for manual control. A reviewer
  who wants the visitor to *cause* the collision themselves (more interactive,
  slower to the payoff) can flip the default to manual-first — the same controls
  support it; only the initial autoplay changes.
- **Lead the autoplay with OFF (chosen) or ON.** Chosen: show the collision
  first (feel the pain), then the prevention. Alternative: lead with ON (the
  win), then reveal OFF as "here's what you avoided." Chosen order maximizes the
  contrast.
- **House-style sourcing.** constraintguard.vercel.app is the reference. If its
  current CSS/design tokens are available to copy directly (shared design system
  across the family), the implementer should reuse them; otherwise match by eye.
  Flag if a shared style package is expected.
