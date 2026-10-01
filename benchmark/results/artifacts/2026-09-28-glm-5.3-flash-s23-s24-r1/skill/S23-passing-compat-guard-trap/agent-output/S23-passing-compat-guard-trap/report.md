# S23 · The Compat Guard That Passed — Diagnosis Report

Skill: plugin-upgrade (Mode A · inspect, read-only). Corridor: `dsh-v0.1.6-alpha.1 → dsh-v0.1.6-alpha.2`. Relevant card: **DSH-0.1.6-A2-01** (multi-instance Session references; `SessionListState.current` removed).

---

## 1 · Silent-failure attribution

### The exact read that fails

Walk the plugin's per-keystroke path in `plugin/src-client-index.ts`:

```ts
const onKeyDown = (e: KeyboardEvent): void => {
  if (!e.ctrlKey || ...) return           // filters pass: Ctrl+Up reaches here
  ...
  const resolved = resolve()              // ← this
  if (resolved === null) return           // ← and then THIS line: silent bail-out
  ...
}
```

Inside `resolve()` the first read is:

```ts
const id = sessions.list.getSnapshot().current
if (id === undefined) return null
```

On alpha.2, `SessionListState` was replaced by `SessionListSnapshot`, which has **no `current` field** (it now carries `items`/`state`/`phase`/`error`/`subagentsByParent`/`jobsBySession`). Reading a removed property on a plain object is not an error in JavaScript — it evaluates to `undefined`. So on **every keystroke**:

1. `sessions.list.getSnapshot().current` → `undefined` (field no longer exists);
2. `resolve()` returns `null` at its very first branch;
3. `onKeyDown` hits `if (resolved === null) return` and returns **before** `e.preventDefault()` / `e.stopPropagation()`;
4. the event falls through to the composer, which performs its normal multi-line cursor movement.

This matches the symptom report exactly: the chord is not swallowed (the composer cursor still moves) and no text appears — the handler fires, resolves nothing, and exits. The capture listener itself is healthy; the failure is one field read.

### Why nothing surfaces anywhere

- **Why the compat guard passes**: the guard in `apply()` checks four *service members*: `sessions.list`, `sessions.scope`, `sessions.sessionOf`, `uiConversation.binding`. All four still exist on alpha.2 — `ISessions` kept `list` (as a differently-shaped snapshot) and `scope(id)` (still present per the alpha.2 excerpt's own NOTE). The guard verifies that *services and methods exist*, never that the *data inside a snapshot* has the fields the plugin reads. A field-level removal inside an observable's payload is invisible to a presence-check of the observable itself.
- **Why there is no console error**: no code path throws. `undefined.current`-style failure does not happen here — the plugin reads `snapshot.current` (a missing property, `undefined`), not a property *of* the missing value. Every subsequent step is guarded by early `return null`/`return` statements, so control flow exits cleanly, deliberately, silently.
- **Why a silent no-op and not an exception**: the plugin was written defensively — each resolution step returns `null`/`undefined` on a "session not ready" condition, and the keydown handler treats `null` as "nothing to do". On alpha.1 that design was correct (transient states genuinely occur). On alpha.2 the same graceful-degradation branch becomes a *permanent* no-op, indistinguishable from "no session open". Defensive early-returns are exactly the construct that converts a breaking API change into a silent one.

### Which already-tried suspicions this settles — and which it does not

- **Settles**: #1 (console clean — expected; nothing ever throws) and #2 (banner absent — expected; all four probed members exist). Also #3 and #4 (re-linking the junction and disabling other plugins cannot help — the plugin loads and runs fine; the host API changed underneath it), and #5 (the plugin *is* the latest version — it was simply written against the alpha.1 type surface).
- **Does not address**: #6 ("with the junction removed, the chords still do nothing — no other handler"). That observation is consistent with this diagnosis (no other handler exists to handle the chord) but it does not by itself locate the break; it only eliminates an alternative suspect. The colleague's suggestion (add `uiSession` to `inject`) points in the right direction — see §3 — but adding it to `inject` alone is not sufficient without rewiring `resolve()` to the new binding value.

---

## 2 · Evidence mapping

### What changed about the snapshot (session-controller excerpts)

| | alpha.1 `SessionListState` | alpha.2 `SessionListSnapshot` |
|---|---|---|
| Current/main session | `current: SessionId | undefined` — **the session the main conversation view is bound to** | **field removed**. "Current" became main-view occupancy, owned by view owners; the list now publishes a catalog (`items`, `state`, `phase`, `error`) plus per-session maps (`subagentsByParent`, `jobsBySession`) |
| Comment delta | *"The session the main conversation view is currently bound to"* | *"Host catalog and local reference-source counts; navigation belongs to view owners"* |

Implication: the ownership of "which session am I looking at" moved from the session controller's list snapshot to the UI session service. The plugin's read now yields `undefined` **on every keystroke, unconditionally** — not transiently. `resolve()` never reaches `sessions.scope(id)`, `actx.get('conversation')`, or the `uiConversation` binding; the entire downstream chain is dead code at runtime even though every service it touches still exists.

### The canonical replacement read (ui-session-service-alpha2.d.ts)

- **Service**: `uiSession` (`UiSession` from `@deepseek-ai/dsh-client-ui-session`, client bundle export `UiSession`, inject name `"uiSession"`).
- **Observable**: `uiSession.adapter.current` — an `ObservableSnapshot<SessionBindingValue>`, "binding source of the main view's current session".
- **Value shape**: `SessionBindingValue` with:
  - `key: SessionId` — the bound session's id (**this replaces `sessions.list.getSnapshot().current`**; `undefined` while no main session is retained);
  - `ctx: Context` — the **session-scoped context** (services registered under this session resolve here — **this replaces `sessions.scope(id)`** for session-scoped service resolution);
  - `hooks` / `keyedHooks` / `props` — standard-source contributions for the binding (not needed by this plugin).

So one snapshot supplies both facts the plugin resolved separately before: the id (`binding.key`) and the scope (`binding.ctx`).

---

## 3 · Migration recipe (one build, both hosts)

### Changes

1. **`inject` declaration**: add `uiSession`:

   ```ts
   export const inject = ['sessions', 'uiConversation', 'conversation', 'uiSession']
   ```

   (`uiSession` is registered by `@deepseek-ai/dsh-client-ui-session` on both alpha.1 and alpha.2, so injecting it is safe across the corridor.)

2. **`resolve()` rewrite**: prefer the `uiSession.adapter.current` binding; fall back to the alpha.1 legacy field when the binding value carries no `key` (older host). The session-scoped context comes from `binding.ctx` on alpha.2 and from `sessions.scope(id)` on alpha.1; either way it feeds `actx.get('conversation')` and `conversation.input.for(actx)` exactly as before — that is how the session-scoped context reaches the conversation service.

```ts
interface ResolvedSession {
  readonly id: string
  readonly actx: Context            // session-scoped context
  readonly input: SessionInput
  readonly nodes: readonly ConversationNode[]
}

const resolve = (): ResolvedSession | null => {
  // alpha.2 path: main-view binding from the ui-session service.
  const binding = uiSession?.adapter?.current?.getSnapshot?.() as
    | { key?: string; ctx?: Context } | undefined
  let id: string | undefined
  let actx: Context | undefined

  if (binding !== undefined && binding.key !== undefined) {
    id = binding.key
    actx = binding.ctx               // replaces sessions.scope(id)
  } else {
    // alpha.1 fallback: legacy current field on the session-list snapshot.
    const legacy = (sessions.list.getSnapshot() as { current?: string }).current
    if (legacy === undefined) return null
    id = legacy
    actx = sessions.scope(id)
    if (actx === undefined) return null
  }

  if (id !== lastSessionId) {
    browse = IDLE                    // session switch: recall restarts fresh
    lastSessionId = id
  }

  const conversation = actx.get('conversation') as IConversation | undefined
  if (conversation === undefined) return null
  const chat = ctx.uiConversation.binding(id).snapshot.getSnapshot().views.get('chat')
  const nodes = chat === undefined ? EMPTY_NODES : chat.legacy.nodes
  return { id, actx, input: conversation.input.for(actx), nodes }
}
```

(with `const uiSession = ctx.uiSession` captured alongside `const sessions = ctx.sessions` in `applyBody`).

Notes:

- On alpha.2 the branch is stable: `binding.key` is defined whenever a main session is retained and `undefined` otherwise — the fallback then also returns `null` because alpha.1's `current` does not exist there, so "no session open" still resolves to `null` rather than throwing.
- If the plugin wants reactivity (not required for a per-keystroke resolution), subscribe via `uiSession.adapter.current.subscribe(...)` to invalidate a cached id.
- Slot components with `scope: 'session'` are unaffected by this card — they receive the session context through their Provider. This plugin resolves at event time outside any slot, which is exactly why it must use the service path.

---

## 4 · Guard hardening

### The class of breakage presence-checks cannot catch

The shipped guard checks *existence of service members on the injected context*. The break was *removal of a field inside a snapshot value published by an existing member*. Generally: any breakage **below the service-member level** — renamed/removed fields in snapshot payloads, changed value types, changed semantics of a retained field — passes a presence guard, because `ctx.sessions.list` is still truthy while the data contract it carries has silently changed. TypeScript does not catch it either at runtime, and it did not catch it at build time because the plugin typechecks against the alpha.1 `.d.ts` cohort it declares.

### Hardened guard

Probe the **actual data contract end-to-end**, not service presence:

1. Probe the discriminating field of each version's snapshot, at the value level:
   - alpha.1 signature: `'current' in sessions.list.getSnapshot()`;
   - alpha.2 signature: `uiSession.adapter.current.getSnapshot()` has a `'key' in snapshot` binding value.
2. If **neither** signature is present, render the remediation banner (and report which signatures were tried) instead of calling `applyBody`.
3. Probe the full resolution once: attempt `resolve()`-equivalent reads at activation and treat an all-undefined outcome *with an open session* as incompatible. (A cheap deterministic form is the field-presence check in 1; the deep form requires a live session and belongs in verification, not the guard.)

**Lifecycle timing**: the probe must run inside `apply(ctx)` — at **activation**, after injection — not lazily at the first keystroke. At activation all injected services and their initial snapshots are materialized, so the field check is decidable; a lazy probe would defer detection until a human presses a chord and would have no banner surface left. It must also run on every (re)activation, so a host upgrade + restart re-evaluates it.

```ts
const listSnap = ctx?.sessions?.list?.getSnapshot?.() as object | undefined
const bindSnap = ctx?.uiSession?.adapter?.current?.getSnapshot?.() as object | undefined
const alpha1 = listSnap !== undefined && 'current' in listSnap
const alpha2 = bindSnap !== undefined && 'key' in bindSnap
if (!alpha1 && !alpha2) {
  // render the remediation banner; do not applyBody()
}
```

---

## 5 · Verification and prevention

### Verifying on both hosts without a full migration

1. Build once from the patched source (dual-host build; no per-host forks).
2. Mount the same build on an alpha.1 host and an alpha.2 host (two profiles / two global installs; no host modification, no migration scripts).
3. Per host, exercise the card's verification triple:
   - with one session open, press Ctrl+Up → the composer draft becomes the last sent message; Ctrl+Down walks back; `preventDefault` fires (composer cursor does not move);
   - switch the main-view session → the next Ctrl+Up recalls from the *new* session's history (`browse` reset via `lastSessionId`);
   - with no session open, pressing the chords is a silent no-op and **logs nothing** — resolution returned `null` by design, not by breakage.
4. Cross-check the guard: on both hosts no banner appears; on a hypothetical host with neither signature the banner appears (force it by stubbing in a dev harness).
5. Static: typecheck the plugin against *alpha.2* declarations as well (the declared peer cohort), confirming the legacy path's cast is the only escape hatch. Per the skill's validation ladder, a cold-start of a real profile with the entry activated and no pending services completes the runtime layer.

### The single host-side change that would have made this loud

Turn the field-level removal into a **loud read**: keep a `current` accessor on the new `SessionListSnapshot` (or on a compatibility façade) that **throws a migration-pointing error on first read** — e.g. `get current(): never { throw new Error('SessionListState.current was removed in 0.1.6-alpha.2; read uiSession.adapter.current instead') }`. Then the plugin's very first keystroke produces a console error naming the replacement, an activation-time probe fails loudly instead of resolving `undefined`, and the type declaration (`never`) makes any consumer that typechecks against alpha.2 declarations a compile-time error. The quiet alternative — a deprecation warning logged on read — surfaces in the console but still passes presence guards; the throwing accessor is the version that converts this specific silent no-op into a failure at the earliest resolvable point, matching the "misconfiguration fails loud" rule.

### Prevention going forward

- Declare the exact DSH host cohort in the plugin's `package.json` peer range and typecheck against each corridor edge's packed declarations (the skill's precision checklist); building against alpha.2 `.d.ts` makes `snapshot().current` a type error immediately.
- Compat guards must assert **value-level signatures**, not service presence (§4), and re-probe at every activation.
- Any plugin that resolves state at event time (keyboard/paste/drop handlers) rather than inside a scoped slot should treat release-note lines like "相关 API 及 slot 有变化" as mandatory corridor-card reads — DSH-0.1.6-A2-01 describes this exact failure and its first-hand fleet evidence.
