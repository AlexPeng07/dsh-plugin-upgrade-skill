# S23 · The Compat Guard That Passed — Report

Host: dsh web, 0.1.6-alpha.1 → 0.1.6-alpha.2, Windows, npm global, six external client plugins.
Broken plugin: `dsh-input-history` (Ctrl+Up / Ctrl+Down composer input recall).
Evidence: symptom-report.md, plugin/src-client-index.ts, host-types/{session-list-alpha1,session-list-alpha2,ui-session-service-alpha2}.d.ts, upgrade-notes.txt.

---

## 1. Silent-failure attribution

### The per-keystroke path

Every chord press runs `onKeyDown` → `resolve()`:

1. `const id = sessions.list.getSnapshot().current` ← **the read that fails**
2. `if (id === undefined) return null`
3. `sessions.scope(id)` → `actx.get('conversation')` → `input.for(actx)`
4. `uiConversation.binding(id).snapshot…views.get('chat').legacy.nodes`

At alpha.2 the multi-instance Session refactor replaced the `SessionListState` snapshot
(`{ byId, current }`) with `SessionListSnapshot`
(`{ items, state, phase, error, subagentsByParent, jobsBySession }`). The `current`
field is gone — deliberately: the alpha.2 `ISessions.list` JSDoc says "navigation
belongs to view owners". So on alpha.2:

```ts
sessions.list.getSnapshot().current   // → undefined (field removed), every keystroke
```

`resolve()` hits its own `id === undefined → return null` branch, `onKeyDown` gets
`null` and returns **before** `preventDefault()`. The chord therefore falls through
untouched to the composer's native multi-line cursor movement — exactly the
"capture listener fires and bails out" hypothesis in the symptom report. The plugin's
state machine, history extraction, and draft write are never reached.

### Why nothing surfaces

- **Why the compat guard passes**: `applyWithCompat` checks *service-member presence* —
  `ctx?.sessions?.list`, `ctx?.sessions?.scope`, `ctx?.sessions?.sessionOf`,
  `ctx?.uiConversation?.binding`. On alpha.2 the `sessions` service still exists, still
  exposes `list` and `scope` (the alpha.2 excerpt confirms `scope(id)` survives), and
  `uiConversation.binding` still exists. All four presence probes are truthy, so the
  guard declares the host compatible. The guard never inspects the *value* any of these
  members yields — it cannot see that `list.getSnapshot()` no longer has a `current`
  field.
- **Why no console error**: reading a missing property on a plain snapshot object is
  `undefined`, not a throw. The plugin's own `id === undefined` early return converts
  that into a deliberate, silent no-op. No API contract was violated at runtime — the
  plugin read a field that simply isn't there anymore.
- **Why a no-op instead of a thrown exception**: nothing in the path dereferences
  `id` while it is `undefined`; the guard was designed to *avoid* thrown activation
  errors, and the same defensive-return style is used inside `resolve()`. The failure is
  by construction silent: a presence-typed guard + optional-field read + early return.

### Which suspicions this settles / doesn't

- **Settles — the colleague's "re-register the slot / re-declare inject / add
  `uiSession`" theory as the *cause of death***: it is not a loading or injection
  problem. The boot log shows `@dsh-external/dsh-input-history/client.js` in the
  assembled combo, the capture listener is registered (`ctx.effect` ran — guard passed
  means `applyBody` ran), and the handler fires (chords reach the composer's own
  movement because the plugin declines to swallow them). The plugin dies on a data read,
  not on registration. It also settles already-tried item 6 conclusively: with the
  junction removed the chords do nothing because *nothing else* handles them — the
  plugin's handler is running but returning null.
- **Does not address**: whether the *deeper* reads in `resolve()` —
  `actx.get('conversation')`, `conversation.input.for(actx)`, and
  `uiConversation.binding(id).snapshot…views.get('chat').legacy.nodes` — still work on
  alpha.2 once the `current` read is fixed. The multi-instance refactor note says
  "相关 API 及 slot 有变化" (APIs *and slots* changed); execution never gets past line 1,
  so this evidence pack cannot confirm the rest of the chain survives. The legacy
  `chat.legacy.nodes` name itself is a red flag for a future break.

## 2. Evidence mapping

### What changed about the snapshot the plugin reads

| | alpha.1 `SessionListState` | alpha.2 `SessionListSnapshot` |
|---|---|---|
| session summaries | `byId: Record<SessionId, SessionSummary>` | `items: readonly SessionListEntry[]` |
| **current selection** | **`current: SessionId | undefined`** | **removed** — "navigation belongs to view owners" |
| new | — | `state`, `phase`, `error`, `subagentsByParent`, `jobsBySession` |

Implication: on every keystroke the plugin now receives a snapshot whose `current`
field is `undefined` — permanently, regardless of which session is open. The plugin can
never resolve a session id this way again on alpha.2.

### The canonical replacement (new-service excerpt)

- **Service**: `UiSession` from `@deepseek-ai/dsh-client-ui-session` (client bundle
  export `UiSession`; **inject name `uiSession`**). Root service owning per-Session
  bindings and the main-view selection — i.e. it *is* the "view owner" the navigation
  moved to.
- **Observable**: `uiSession.adapter.current` — an
  `ObservableSnapshot<SessionBindingValue>`; "binding source of the main view's
  current session". It publishes an absent value (whose `key` is `undefined`) while no
  main session is retained.
- **Shape of the value** — `SessionBindingValue`:
  - `key: SessionId` — replaces `SessionListState.current` as the current-session id.
  - `ctx: Context` — **the field that replaces `sessions.scope(id)`**: "the
    session-scoped context: services registered under this session resolve here."
    Session-scoped service resolution (e.g. `actx.get('conversation')`,
    `input.for(actx)`) now goes through `binding.ctx`.
  - `hooks`, `keyedHooks`, `props` — standard-source contributions for the binding
    (not needed for this plugin's read path).

## 3. Migration recipe (dual-host, one build)

**`inject` change**: add `uiSession` as an *optional* injection so the same build
still loads on alpha.1, which does not ship the service:

```ts
export const inject = ['sessions', 'uiConversation', 'conversation', 'uiSession?']
```

The session-scoped context now reaches the conversation service via
`binding.ctx.get('conversation')` and `conversation.input.for(binding.ctx)` on
alpha.2, and via the legacy `sessions.scope(id)` context on alpha.1.

Corrected `resolve()`:

```ts
/** Minimal structural knowledge of uiSession on hosts that ship it (alpha.2+). */
interface UiSessionLike {
  readonly adapter: {
    readonly current: ObservableSnapshot<
      { readonly key: SessionId | undefined; readonly ctx: Context }
    >
  }
}

function resolve(): ResolvedSession | null {
  // alpha.2+: main-view selection and the session-scoped ctx live on uiSession.
  const uiSession = (ctx as ClientContext & { uiSession?: UiSessionLike }).uiSession
  if (uiSession !== undefined) {
    const binding = uiSession.adapter.current.getSnapshot()
    const id = binding.key
    if (id === undefined) return null            // no main session retained
    if (id !== lastSessionId) {
      // Session switch: recall must start fresh on the new session.
      browse = IDLE
      lastSessionId = id
    }
    const conversation = binding.ctx.get('conversation') as IConversation | undefined
    if (conversation === undefined) return null
    const chat = ctx.uiConversation.binding(id).snapshot.getSnapshot().views.get('chat')
    const nodes = chat === undefined ? EMPTY_NODES : chat.legacy.nodes
    return { input: conversation.input.for(binding.ctx), nodes }
  }

  // alpha.1 legacy path: selection on the session-list snapshot, scope via sessions.
  const id = sessions.list.getSnapshot().current
  if (id === undefined) return null
  if (id !== lastSessionId) {
    browse = IDLE
    lastSessionId = id
  }
  const actx = sessions.scope(id)
  if (actx === undefined) return null
  const conversation = actx.get('conversation') as IConversation | undefined
  if (conversation === undefined) return null
  const chat = ctx.uiConversation.binding(id).snapshot.getSnapshot().views.get('chat')
  const nodes = chat === undefined ? EMPTY_NODES : chat.legacy.nodes
  return { input: conversation.input.for(actx), nodes }
}
```

Notes:
- The alpha.2 branch keys the switch-reset on `binding.key` (same `lastSessionId`
  semantics) and resolves the session scope from `binding.ctx` — no `sessions.scope`
  call needed on alpha.2, though `scope` still exists there.
- `uiSession?` optional inject means alpha.1 loads with `ctx.uiSession === undefined`
  and takes the legacy branch; alpha.2 takes the new branch. One build, both hosts.
- Caveat from §1: if the alpha.2 slot changes also moved the conversation service or
  `chat.legacy.nodes`, the deeper reads need the same treatment; verify per §5.

## 4. Guard hardening

### The class of breakage presence-checks cannot catch

The shipped guard probes **that services and members exist** (`ctx.sessions.list`,
`ctx.sessions.scope`, …). This breakage was **field-level removal inside the value an
existing member yields**: the service was present, the member was present, the call
succeeded — only the *data* behind it changed shape. Presence checks are blind to:

- removed/renamed fields on observable snapshots (`current` here);
- changed member signatures or return types (`byId` → `items` restructure);
- semantic moves between services (navigation moving from `sessions` to `uiSession`)
  where every old member still resolves;
- values that are now permanently `undefined`/absent-by-contract.

Any of these turns a "compatible" verdict into a silent no-op if the plugin's read path
uses optional-field reads with early returns — precisely this plugin's style.

### Hardened guard

Probe **the data path the plugin actually executes**, not the services that carry it —
and run the probe at the right lifecycle point:

1. **Field-shape probe at activation** (cheap, catches the `current` removal
   immediately): read the live snapshot and assert the fields the plugin depends on:

   ```ts
   const snap = ctx.sessions.list.getSnapshot()
   if (!('current' in snap) && (ctx as ClientContext & { uiSession?: unknown }).uiSession === undefined) {
     // incompatible: neither the legacy selection field nor its replacement exists
     renderBanner(/* remediation copy */)
   }
   ```

   On alpha.2 this fails `'current' in snap`, sees `uiSession` exists, and can assert
   the replacement chain instead (`uiSession.adapter.current` is an observable whose
   snapshot has `key`/`ctx`).

2. **Value-materialization probe at first use, not at activation**: an absent main
   session is *legitimate* at startup (`SessionBindingValue.key === undefined` "while
   no main session is retained"), so "snapshot currently has no current session" must
   not be treated as incompatibility. The guard must subscribe (or check lazily on the
   first chord press) and validate the full chain — current id present →
   `binding.ctx` present → `ctx.get('conversation')` resolvable →
   `input` facade present — the **first time a session is actually retained**, then
   report once. This catches breakage in the deeper reads (§1's open question) that an
   activation-time probe still cannot see.

In short: probe *observable values and their fields along the executed read path*, at
activation for shape and at first materialized use for value; never probe bare service
presence.

## 5. Verification and prevention

### Verifying on both hosts without a full migration

- Keep alpha.1 in its own install location (scratch npm prefix or a copy of the cached
  package) and alpha.2 in another (e.g. the global prefix); junction-link the same
  rebuilt plugin into both and point two browser profiles at the two hosts. No
  migration tooling needed — the plugin build is the same artifact.
- On each host: open a session with prior sent messages, focus the composer, press
  Ctrl+Up → the draft must fill with the last sent message; Ctrl+Down walks forward;
  switching sessions resets recall. Confirm the chord is *swallowed* (cursor does not
  move) — on broken alpha.2 the cursor still moved, which is the telling symptom.
- Temporary one-line instrumentation of `resolve()` (log which branch ran and the
  resolved id) distinguishes "wrong branch" from "deeper read failed", and directly
  tests the §1 caveat (`conversation`, `input.for`, `chat.legacy.nodes` on alpha.2).
- Optionally use the host's read-only inspect tooling (cordis inspect providers) to
  query the live `uiSession.adapter.current` value and confirm the `key`/`ctx`
  shapes match the type excerpt.

### The single host-side change that would have made this loud

Replace the silent removal of `current` with an **explicit failing read**: have the
session controller's alpha.2 `SessionListSnapshot` still expose `current` as a
getter that throws (or, less loudly, `console.error`s) a descriptive error —
"`SessionListState.current` was removed in 0.1.6-alpha.2; read the main-view selection from
`uiSession.adapter.current` (`SessionBindingValue.key`)". Equivalently, type `list` so the
old field is a `@deprecated` never-typed getter rather than absent. A property that
*throws on read* turns the plugin's very first keystroke (or a guard that touches the
field) into a console-visible stack trace at/after activation, instead of
`undefined` → silent early return. A types-only change cannot help runtime JS plugins
that don't typecheck against the new host; the getter must ship in the runtime
snapshot object, with the type declaring it deprecated/throwing.
