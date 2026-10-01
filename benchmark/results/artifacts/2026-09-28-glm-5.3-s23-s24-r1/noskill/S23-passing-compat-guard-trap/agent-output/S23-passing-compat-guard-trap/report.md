# S23 · Silent Field-Level Break Behind a Passing Compat Guard

Host upgrade: `@deepseek-ai/dsh` 0.1.6-alpha.1 → 0.1.6-alpha.2 (npm global, Windows web
profile). Broken plugin: `dsh-input-history` (Ctrl+Up / Ctrl+Down composer input recall).

---

## 1. Silent-failure attribution

### The exact read that now fails

Per keystroke, `onKeyDown` calls `resolve()`. Its **first read** is:

```ts
const id = sessions.list.getSnapshot().current
if (id === undefined) return null
```

Comparing the two session-controller excerpts:

- **alpha.1** `SessionListState` has `readonly current: SessionId | undefined` — the id
  of the session the main conversation view is bound to.
- **alpha.2** `SessionListSnapshot` is a multi-instance catalog:
  `{ items, state, phase, error, subagentsByParent, jobsBySession }`. **The `current`
  field is gone entirely.** The JSDoc says it explicitly: *"Host catalog and local
  reference-source counts; navigation belongs to view owners."*

So on alpha.2, `sessions.list.getSnapshot().current` evaluates to `undefined` on **every**
keystroke, `resolve()` returns `null` at line one, and `onKeyDown` does
`if (resolved === null) return` — before `preventDefault`, before any service call.
The chord is never captured, and the composer's own multi-line cursor movement still
works, exactly as the maintainer observed.

### Why nothing surfaces

- **Why the guard passes**: `applyWithCompat` probes four *service-member presences* —
  `sessions.list`, `sessions.scope`, `sessions.sessionOf`, `uiConversation.binding`.
  All four still exist on alpha.2 (`scope(id)` still exists per the excerpt note; only
  the *snapshot payload shape* changed). Presence-of-service checks cannot see that a
  **field inside an observable snapshot** was removed. The guard answers "does the
  service exist?", not "does the read I actually perform return what I expect?".
- **Why no console error**: nothing throws. Reading a missing property on a plain
  snapshot object yields `undefined` (no TypeError; the snapshot is not sealed at
  runtime, and the plugin's own compiled types are alpha.1's). `undefined === undefined`
  is a *designed* branch in `resolve()` ("no current session yet"), so the plugin treats
  alpha.2's permanent absence as the benign "no session selected" case. TypeScript would
  have caught this at compile time against alpha.2 types, but the plugin was compiled
  against alpha.1 types and runs untyped at runtime.
- **Why silent no-op, not an exception**: the failure path is an early `return null`
  that the original author wrote deliberately for the "no active session" state. The
  removal of `current` funnels into that pre-existing benign branch. A silent no-op is
  the worst case of defensive `undefined` checks: the plugin can't distinguish
  "legitimately nothing selected" from "the API moved".

### Which earlier suspicions this settles / doesn't

- **Settles**: "the capture listener is either not firing or firing and bailing out" —
  it is firing and bailing out, on the very first read of `resolve()`. Also settles
  item 6 (chords not taken by anything else — correct, the plugin itself declines them)
  and item 4 (other plugins — irrelevant; the break is between the plugin and host types).
- **Does not address**: item 3 (junction / reload — load path is fine; the boot log shows
  `@dsh-external/dsh-input-history/client.js` in the 57-entry combo), item 5 (update
  chip), and the colleague's hypothesis about **re-registering a slot** — this reading
  neither confirms nor refutes any slot-registration issue, because execution never
  reaches any slot code (`uiConversation.binding(id)` is never called). The colleague's
  *second* suggestion (add `uiSession` to inject) is in fact part of the real fix, but
  for a different reason than "re-register the slot".

---

## 2. Evidence mapping

### What changed about the snapshot the plugin reads

`ISessions.list` changed from an `ObservableSnapshot<SessionListState>` whose payload
answers "which session is the main view on?" (`byId` + `current`) to an
`ObservableSnapshot<SessionListSnapshot>` that is a *host catalog* (items, loading
state, subagent catalog, background jobs). **Selection/navigation was moved out of the
session controller** ("navigation belongs to view owners"). Consequently the value the
plugin receives on every keystroke has **no `current` key at all** —
`getSnapshot().current` is `undefined` forever, and `resolve()` can never get past
its first line. Note this is *not* `current === undefined because no session is open*;
it is `current` never existing.

### The canonical replacement read (new service)

The selection observable moved to the new **`UiSession`** service from
`@deepseek-ai/dsh-client-ui-session` (client bundle export `UiSession`, **inject name
`"uiSession"`**):

- **Service**: `ctx.uiSession` (class `UiSession`).
- **Observable it exposes**: `uiSession.adapter.current` — an
  `ObservableSnapshot<SessionBindingValue>`, the binding source of the main view's
  current session.
- **Shape of the value** — `SessionBindingValue`:
  - `key: SessionId` — the bound session's id (replaces `current`);
  - `ctx: Context` — **the session-scoped context**; this field **replaces
    `sessions.scope(id)`** for session-scoped service resolution (services registered
    under the session resolve there);
  - `hooks`, `keyedHooks`, `props` — per-binding contributed sources.
  - The service publishes an **absent value** (`key` undefined) while no main session is
    retained — the plugin must treat that as its "no current session" branch.

So the migration is:
`sessions.list.getSnapshot().current` → `uiSession.adapter.current.getSnapshot()?.key`,
and `sessions.scope(id)` → `uiSession.adapter.current.getSnapshot()?.ctx` (same snapshot
read yields both the id and the scope; no separate scope lookup needed).

---

## 3. Migration recipe (dual-host, one build)

Corrected `resolve()` plus wiring:

```ts
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { UiSession } from '@deepseek-ai/dsh-client-ui-session/client'

// inject must now declare the new service:
export const inject = ['uiSession', 'uiConversation', 'conversation']

function applyBody(ctx: ClientContext): void {
  let browse: HistoryBrowse = IDLE
  let lastSessionId: string | undefined

  // Legacy (alpha.1) path: session id + scope from the sessions controller.
  const legacyCurrent = (): { id: string; actx: ClientContext } | null => {
    const sessions = ctx.sessions as {
      list: { getSnapshot(): { current?: string } }
      scope(id: string): ClientContext | undefined
    } | undefined
    const id = sessions?.list.getSnapshot().current
    if (id === undefined) return null
    const actx = sessions.scope(id)
    if (actx === undefined) return null
    return { id, actx }
  }

  const resolve = (): ResolvedSession | null => {
    // alpha.2: selection + session scope come from uiSession.adapter.current.
    const binding = (ctx as { uiSession?: UiSession }).uiSession
      ?.adapter.current.getSnapshot()
    let id: string | undefined
    let actx: ClientContext | undefined
    if (binding !== undefined && binding.key !== undefined) {
      id = binding.key
      actx = binding.ctx           // SessionBindingValue.ctx replaces sessions.scope(id)
    } else {
      // alpha.1 host: uiSession is absent (or publishes the absent value) —
      // fall back to the legacy sessions-controller reads.
      const legacy = legacyCurrent()
      if (legacy === null) return null
      id = legacy.id
      actx = legacy.actx
    }
    if (id !== lastSessionId) {
      // Session switch: recall must start fresh on the new session.
      browse = IDLE
      lastSessionId = id
    }
    const conversation = actx.get('conversation') as IConversation | undefined
    if (conversation === undefined) return null
    const chat = ctx.uiConversation.binding(id).snapshot.getSnapshot().views.get('chat')
    const nodes = chat === undefined ? EMPTY_NODES : chat.legacy.nodes
    return { input: conversation.input.for(actx), nodes }
  }
  // ... onKeyDown unchanged
}
```

**What must change and how context reaches the conversation service:**

1. **`inject` declaration**: add `'uiSession'`. Keep `'uiConversation'` and
   `'conversation'`; `'sessions'` can be dropped if no other code path uses it, or kept
   for the alpha.1 fallback — but note that on alpha.1 `uiSession` does not exist, so
   the plugin must not make injection of it *required* if it still supports alpha.1.
   Read it defensively (`ctx.uiSession` may be undefined) as above, and mirror that in
   the guard (§4).
2. **Session-scoped context**: on alpha.2 the scope no longer comes from
   `sessions.scope(id)` by id lookup — the `SessionBindingValue.ctx` *is* the
   session-scoped Context, delivered atomically with the id by
   `uiSession.adapter.current`. The conversation service is still resolved from that
   scope (`actx.get('conversation')`) and the input facade still binds with
   `conversation.input.for(actx)` — same pattern, different source of `actx`. On
   alpha.1, `actx` still comes from `sessions.scope(id)` after reading
   `sessions.list.getSnapshot().current`.
3. The fallback is *value-driven*, not version-driven: if `uiSession` exists and
   publishes a binding with a defined `key`, use it; otherwise try the legacy reads.
   One build runs on both hosts.

---

## 4. Guard hardening

### Why the shipped guard cannot catch this

`applyWithCompat` checks **service presence**: `ctx?.sessions?.list`,
`ctx?.sessions?.scope`, `ctx?.sessions?.sessionOf`, `ctx?.uiConversation?.binding`.
The failure class it cannot catch is **field-level / payload-level breakage**: a service
and all its methods can remain present while the data inside an observable snapshot is
restructured, renamed, or removed — exactly the multi-instance refactor removing
`SessionListState.current`. Presence checks validate the *door*, not the *room*.
Equally invisible to them: renamed snapshot fields, changed value types
(`current` becoming a binding object), changed return shapes, and semantic moves
(selection now owned by another service). They also run **once at activation**, so even a
perfect probe would only help if it sampled live data — which at activation time it can,
because the services exist before `apply` runs.

### Hardened guard: probe the actual observable reads, at activation

Replace service-member checks with **end-to-end value probes** that exercise the exact
reads `resolve()` performs, run inside `apply()` at activation (services are injected
and live by then; a snapshot read is synchronous and side-effect-free):

```ts
/** Probe the exact observable reads applyBody depends on; returns failure labels. */
function probeClientApi(ctx: ClientContext): string[] {
  const missing: string[] = []
  const binding = (ctx as { uiSession?: UiSession }).uiSession
    ?.adapter.current.getSnapshot()
  const legacy = (ctx as { sessions?: ... }).sessions
  if (binding?.key !== undefined) {
    // alpha.2 path must yield a usable session-scoped ctx.
    if (binding.ctx?.get('conversation') === undefined) {
      missing.push('uiSession.adapter.current → ctx.get("conversation")')
    }
  } else if (legacy?.list?.getSnapshot().current !== undefined) {
    if (legacy.scope(legacy.list.getSnapshot().current!) === undefined) {
      missing.push('sessions.scope(current)')
    }
  } else {
    // Neither host provides a resolvable current session at activation.
    missing.push('current session resolution (uiSession.adapter.current.key / sessions.list.current)')
  }
  return missing
}
```

Key properties:

- Probe the **observable payload** (`getSnapshot()` contents), not service presence:
  check that *some* path yields a concrete current session id and a session scope that
  can resolve `'conversation'`. If both paths come up empty on a host where a session is
  visibly open, the API contract broke — show the remediation banner.
- Probe **both host paths** so the guard matches the dual-host resolve().
- Run **at plugin activation** (`apply`), before installing the keyboard listener — this
  is the only point where the plugin can loudly decline instead of silently no-oping.
  (A periodic or first-press re-probe is optional belt-and-braces; activation is the
  minimum.)

---

## 5. Verification and prevention

### Verifying the fix on both hosts without a full migration

- **alpha.2 (current install)**: reload the web client, open a session, press Ctrl+Up —
  composer should fill with the last sent message; Ctrl+Down walks forward. Instrument
  `resolve()` temporarily (`console.debug` of `binding.key` and
  `binding.ctx !== undefined`) to confirm the `uiSession` branch is taken and returns
  non-null. Also confirm the absent-binding case: with no session retained, chords do
  nothing and log the absent value.
- **alpha.1**: keep (or reinstall) a 0.1.6-alpha.1 global, junction-link the *same*
  built plugin, verify recall still works and the debug log shows the legacy
  `sessions.list.current` / `sessions.scope` branch. Because the fallback is
  value-driven, the one build is the artifact under test on both — no forked migration.
- **Guard test on both**: temporarily break one path (e.g. stub out `uiSession` via a
  test client or rename the legacy read) and confirm the hardened guard renders the
  banner instead of silently no-oping — proving the guard now catches the S23 class.

### Single host-side change that would have made this loud

Mark the removal of `current` in the observable's **runtime payload contract**: i.e.
have `SessionListSnapshot` (or the service/types) **fail loudly on unknown/removed key
reads** — concretely, the cheapest sufficient change is to make `ISessions.list`'s
snapshot an object whose removed `current` accessor **throws** (or the service emits a
one-time deprecation warning logged at plugin activation) instead of being simply
absent. In TypeScript terms: `@deprecated` alone is silent at runtime; the host change
that turns removal into a loud failure is a runtime guard — e.g. the alpha.2 snapshot
object defines `get current()` { throw new Error('SessionListState.current was removed in 0.1.6-alpha.2; use uiSession.adapter.current') }` — or, at minimum, the session-controller service detects plugins whose `inject` includes
`'sessions'` and logs a structured deprecation/error event at their activation. Either
way the plugin's first keystroke (or activation) produces a visible error naming the
replacement, instead of `undefined` swallowed by a defensive branch.

---

**Bottom line**: alpha.2's multi-instance session refactor moved main-view selection out
of `ISessions.list` (dropping `current`) into the new `uiSession` service's
`adapter.current` `SessionBindingValue` (`key` + session-scoped `ctx`). The plugin's
first read per keystroke became permanently `undefined`, funneling into its own benign
"no session" branch — invisible to presence-based compat guards, the console, and the
banner alike.
