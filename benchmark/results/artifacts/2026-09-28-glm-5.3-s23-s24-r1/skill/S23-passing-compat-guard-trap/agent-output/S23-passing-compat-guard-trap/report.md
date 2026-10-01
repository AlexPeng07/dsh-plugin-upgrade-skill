# S23 · The Compat Guard That Passed — Read-Only Diagnosis

**Edge under diagnosis:** `dsh-v0.1.6-alpha.1 → dsh-v0.1.6-alpha.2` (npm global, Windows web profile).
**Skill card:** DSH-0.1.6-A2-01 (multi-instance Session references; `SessionListState.current` removed).
**Mode:** A · inspect — read-only. Nothing in the fixture was modified; no migration was executed.

---

## 1. Silent-failure attribution

### The per-keystroke path

`onKeyDown` fires (it is registered once at activation via `ctx.effect` on `window` with capture, and
the boot log confirms the plugin entry assembled into the combo). After the modifier/key/target checks
pass, it calls `resolve()`, whose **first statement** is:

```ts
const id = sessions.list.getSnapshot().current
if (id === undefined) return null
```

On alpha.1, `SessionListState` carried `current: SessionId | undefined`. On alpha.2 the snapshot type is
`SessionListSnapshot` (`items`, `state`, `phase`, `error`, `subagentsByParent`, `jobsBySession`) —
**`current` no longer exists**. Reading a absent property on a live object does not throw in JavaScript;
it evaluates to `undefined`. The early return — written as the legitimate "no session open" state —
fires on **every keystroke**. `onKeyDown` gets `null` and returns *before* `e.preventDefault()`, so the
chord is never swallowed, and the composer's own multi-line cursor handling carries on. That matches the
symptom exactly: "the chord is not swallowed either."

**The exact read that fails:** `sessions.list.getSnapshot().current` — always `undefined` on alpha.2.

### Why nothing surfaces

- **Why the guard passes:** `applyWithCompat` checks four *service-member presences*:
  `sessions.list`, `sessions.scope`, `sessions.sessionOf`, `uiConversation.binding`. All of these
  still exist on alpha.2 — the alpha.2 excerpt itself notes `scope(id)` still exists on `ISessions`.
  The breakage is *field-level inside the snapshot value*, one level below every member the guard probes.
  Presence-of-service checks are structurally blind to removals of fields inside observable payloads.
- **Why no console error:** the plugin's own design is a graceful bail. `resolve()` returning `null` is
  its documented "nothing to do" path (no session, not active, no conversation service). No exception is
  thrown because nothing illegal happens at runtime — a missing property read is legal JavaScript, and
  the plugin was compiled against alpha.1 types, so TypeScript never flagged it either (the plugin's
  declared `@deepseek-ai/dsh-api-session-controller` types are baked into its build; the host's newer
  runtime type does not re-check it).
- **Why silent no-op, not a throw:** the failing value flows through exactly one consumer — an early
  return. There is no downstream dereference of `current` that would throw; `scope(id)`, `actx.get()`,
  and the conversation facade are never reached.

### Which suspicions this settles — and which it does not

- **Settled:** the ambiguity in the symptom report — "the capture listener is either not firing or
  firing and bailing out." It is firing and bailing, at the first line of `resolve()`. This also settles
  already-tried item 6 (chord conflict / swallowed by another handler: no — the plugin returns before
  `preventDefault`, and nothing else handles it, hence "does literally nothing") and the colleague's
  re-registration suggestion's causal half: the slot/inject registration is *not* the problem — the
  plugin loads and its services resolve; only the data read rotted.
- **Not addressed:** item 5 (update chip "latest version") — this reading cannot confirm whether a fixed
  plugin release exists upstream; that is an install-channel/version-currency question, orthogonal to
  the mechanism. Items 1–4 are likewise explained but were never competing hypotheses.

---

## 2. Evidence mapping

### What changed in the session-controller snapshot

| | alpha.1 | alpha.2 |
|---|---|---|
| Snapshot type | `SessionListState` | `SessionListSnapshot` |
| Current-session field | `current: SessionId \| undefined` | **removed** |
| Contents | `byId`, `current` | `items`, `state`, `phase`, `error`, `subagentsByParent`, `jobsBySession` |

Semantics: "current" stopped being a list-state fact and became *main-view occupancy* (a session row
whose `retainedBy.mainView` count is positive — the multi-instance refactor). The implication for the
plugin: on every keystroke it now receives a snapshot in which its key fact simply is not present;
`getSnapshot().current` yields `undefined` forever, regardless of how many sessions are open.

### The canonical replacement read (new-service excerpt)

- **Service:** `UiSession` from `@deepseek-ai/dsh-client-ui-session`, inject name **`uiSession`** —
  registered on *both* tags (not actually new as a service; its `current` field was private on alpha.1,
  so the *public adapter path* is the new thing).
- **Observable:** `uiSession.adapter.current: ObservableSnapshot<SessionBindingValue>` — the binding
  source of the main view's current session.
- **Shape of the value:** `SessionBindingValue` carries `key: SessionId` (the bound session's id;
  `undefined` while no main session is retained — the service publishes an absent value), plus the
  session-scoped `ctx: Context`, `hooks`, `keyedHooks`, and `props`.
- **Field replacing `sessions.scope(id)`:** **`SessionBindingValue.ctx`** — the session-scoped context
  in which session-scoped services (like `conversation`) resolve. On alpha.2 the plugin no longer needs
  `sessions.scope(id)` at all: the binding value *is* the scope. (Fallback fact from the catalog, per
  the card: the same id can also be derived as the row with `retainedBy.mainView > 0`.)

---

## 3. Migration recipe (dual-host, one build)

`uiSession.adapter.current` works on **both** tags, so it can be the primary path; keep the legacy
`sessions.list…current` read as the alpha.1 fallback in case an older host lacks the adapter:

```ts
export const inject = ['sessions', 'uiConversation', 'conversation', 'uiSession']

function applyBody(ctx: ClientContext): void {
  let browse: HistoryBrowse = IDLE
  let lastSessionId: string | undefined

  const sessions: ISessions = ctx.sessions

  const resolve = (): ResolvedSession | null => {
    // alpha.2 (and alpha.1) canonical path: main-view binding from the uiSession adapter.
    const binding = ctx.uiSession?.adapter?.current?.getSnapshot()
    const id: SessionId | undefined = binding?.key
      // legacy fallback for hosts without the adapter surface
      ?? sessions.list.getSnapshot().current
    if (id === undefined) return null
    if (id !== lastSessionId) {
      // Session switch: recall must start fresh on the new session.
      browse = IDLE
      lastSessionId = id
    }
    // Session-scoped context: the binding value carries it on both tags;
    // fall back to the legacy scope resolver when only the id is available.
    const actx: Context | undefined = binding?.ctx ?? sessions.scope(id)
    if (actx === undefined) return null
    const conversation = actx.get('conversation') as IConversation | undefined
    if (conversation === undefined) return null
    const chat = ctx.uiConversation.binding(id).snapshot.getSnapshot().views.get('chat')
    const nodes = chat === undefined ? EMPTY_NODES : chat.legacy.nodes
    return { input: conversation.input.for(actx), nodes }
  }

  // onKeyDown unchanged.
}
```

- **`inject` change:** add **`'uiSession'`** to the declaration so Cordis waits for the service before
  the plugin activates (the colleague's instinct was half right — not to fix registration, but the
  service is indeed the new dependency to declare).
- **How the session-scoped context reaches the conversation service:** on alpha.2 the binding value
  `SessionBindingValue.ctx` *is* the session scope — `actx.get('conversation')` and
  `conversation.input.for(actx)` work directly against it, no `sessions.scope(id)` round-trip needed.
  The legacy `sessions.scope(id)` remains only as the alpha.1 fallback.

---

## 4. Guard hardening

### The class of breakage presence-checks cannot catch

`applyWithCompat` verifies that named services and members *exist on the host*. The alpha.2 breakage
removed a **field inside an observable snapshot's payload** — the service, its members, and even
`scope()`/`sessionOf()` all still exist. Presence probes are blind to:

- removed/renamed fields inside snapshot values (`current`, here);
- type-level contract drift (the plugin is compiled against its own pinned types; the host never
  re-validates them);
- semantic moves — a fact relocating from one service to another ("current" → main-view occupancy).

Anything one or more levels *below* the probed member, or anything about the *values* those members
yield, passes the guard by construction. Worse, the guard's success is actively misleading: it certifies
"host compatible" while the plugin's data path is dead.

### Hardened guard: probe the value, at the right lifecycle moment

Probe the **actual resolution path end-to-end**, not member existence — i.e. run `resolve()` itself (or
a minimal equivalent: read `uiSession.adapter.current.getSnapshot()` and assert a usable
`{ key, ctx }` / legacy `current` + `scope(id)` chain) and check the *result*, not the inputs.

**When:** the probe cannot run meaningfully at bare activation — at that moment "no session retained" is
a *legitimate* state (`key === undefined`, `current === undefined`), so a fail-loud check there would
false-positive on every cold start. The probe must run **deferred, on first evidence of a live main
session**: subscribe to `ctx.uiSession.adapter.current` at activation, and the first time the snapshot
yields a defined `key` (or the legacy path yields a defined `current`), execute the full resolution
chain once. If it returns `null` or throws while a session is observably present, *that* is the moment
to render the remediation banner / `console.error` — the plugin then reports the exact broken read
instead of certifying compatibility. Optionally keep a bounded per-press watchdog (N consecutive
`null` resolves while the adapter says a session is retained → warn once).

---

## 5. Verification and prevention

### Verifying the fix on both hosts (no full migration)

- **Install the patched build side-by-side:** junction-link the dual-host build into an alpha.1 host and
  an alpha.2 host (two profiles / two pinned global installs in the disposable environment). No host
  change, no migration tooling — the plugin alone changes.
- **Per the card's verification contract:** with one session open, Ctrl+Up fills the composer with the
  last sent message on *both* hosts; switching the main-view session resets the browse state (fresh
  recall on the new session); with no session open the resolution returns `undefined` and the plugin
  no-ops without throwing. Also press the chords with the F12 console open on alpha.2 — still zero
  errors, but now text appears.
- **Static/unit layer (no host needed):** feed `resolve()` mocked snapshots of both shapes — an
  alpha.2-style `SessionListSnapshot` (no `current`) with a `SessionBindingValue` present, and an
  alpha.1-style `SessionListState` with `current` set and no adapter — and assert non-null resolution
  in both cases, plus null when both sources are absent.

### The single host-side change that would have made this loud

Make the removed field **fail loud at first read for one release** instead of vanishing: on the alpha.2
client runtime, define `current` on the `sessions.list` snapshot as a **getter that throws** (or logs a
one-time deprecation error naming the replacement):

```ts
Object.defineProperty(snapshot, 'current', {
  get() {
    throw new Error(
      'SessionListState.current was removed in 0.1.6-alpha.2 (multi-instance sessions); ' +
      'read the main session through ctx.uiSession.adapter.current',
    )
  },
})
```

Any plugin that still reads `current` then throws inside its own keydown handler — a visible console
error with the remediation in the message — at plugin activation / first event rather than a silent
no-op. (Type-only `@deprecated` markers would not have helped: this plugin's build compiled against
alpha.1 declarations and never sees the new types.) After one release the getter can be dropped, or
replaced by explicit client-API contract negotiation at plugin mount (plugin declares required API
coordinates; host refuses or warns at activation) for the general class of field-level removals.

---

## Summary

| Question | Answer |
|---|---|
| Exact failing read | `sessions.list.getSnapshot().current` → always `undefined` on alpha.2 (`SessionListState.current` removed) |
| Why silent | Field-level removal is a legal `undefined` read; the plugin's early return treats it as "no session"; guard only checks service-member presence, all of which survive |
| Replacement | `uiSession.adapter.current` → `SessionBindingValue` with `key` (id) and `ctx` (the session scope replacing `sessions.scope(id)`) |
| Fix | Dual-host `resolve()` above; add `'uiSession'` to `inject` |
| Guard flaw | Presence checks can't see below the probed member; harden by probing the resolution *value* deferred to first live session |
| Prevention | Throwing/deprecated `current` getter (or activation-time API contract check) for one release |
