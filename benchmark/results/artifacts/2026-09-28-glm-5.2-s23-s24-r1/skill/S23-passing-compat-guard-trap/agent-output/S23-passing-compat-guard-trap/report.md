# S23 · The Compat Guard That Passed — Silent-Failure Analysis

Corridor: `dsh-v0.1.6-alpha.1 → dsh-v0.1.6-alpha.2` (matches skill card **DSH-0.1.6-A2-01**, "Multi-instance Session references").
All file references are to the read-only fixture pack unless prefixed `skills/`.

---

## 1 · Silent-failure attribution

### The per-keystroke path and the exact failing read

Every Ctrl+Up / Ctrl+Down press runs `onKeyDown` → `resolve()` → the **first statement**:

```ts
const id = sessions.list.getSnapshot().current   // ← the exact read that now fails
``` (`plugin/src-client-index.ts`, `resolve()`)

- On **alpha.1**, `SessionListState` carried `readonly current: SessionId | undefined` (`host-types/session-list-alpha1.d.ts`).
- On **alpha.2**, the snapshot type is `SessionListSnapshot` — `items`, `state`, `phase`, `error`, `subagentsByParent`, `jobsBySession`. **There is no `current` field** (`host-types/session-list-alpha2.d.ts`). Session ownership became per-source reference counts; "current" now means main-view occupancy (`retainedBy.mainView > 0`), and navigation moved to view owners.

So on every keystroke the plugin reads a property that no longer exists on the snapshot object. In JavaScript, reading a missing property on an object yields `undefined` — it does not throw. `id === undefined` → `resolve()` returns `null` on its second line → `onKeyDown` executes `if (resolved === null) return` → the handler returns **before** `e.preventDefault()` / `e.stopPropagation()`, so the chord is not even swallowed (matching the maintainer's observation that the composer's own cursor movement still works).

### Why nothing surfaces

- **Why the guard passes**: `applyWithCompat` checks four *service-member* presences — `sessions.list`, `sessions.scope`, `sessions.sessionOf`, `uiConversation.binding`. All four **services still exist** on alpha.2 (`session-list-alpha2.d.ts` still declares `list` on `ISessions`; the excerpt note confirms `scope(id)` still exists at alpha.2). The guard probes that the *service objects* are present, not that the *data they expose* still has the fields the plugin reads. The breakage is one level deeper than anything the guard inspects, so the guard reports "compatible".
- **Why no console error**: nothing throws anywhere. The missing-field read is `undefined`, the `undefined` flows into an explicit `return null` early-out that the plugin authored as a legitimate "no session open" state. No API contract violation occurs at runtime; only the *type* contract changed, and the plugin's shipped `client.js` is not re-typechecked against alpha.2's `.d.ts` at load time.
- **Why a silent no-op instead of an exception**: the plugin's own design deliberately treats "no resolvable current session" as a normal, non-error state (a keyboard helper must stay quiet when no conversation is open). The host turned a state that used to mean "no session" into the *permanent* state, so the plugin's graceful path became a permanent graceful failure. This is the worst case of a compat guard: a presence check plus a designed-in silent bail-out means an entire class of data-shape breaks can never surface.

### Which tried-list suspicions this settles — and which it does not

- **Settles — item 6 ("chords taken by something else")**: no other handler is involved. The plugin's own capture listener *does* fire on every press (`ctx.effect` registered the document-level listener and nothing failed at activation) and *does* bail at `resolve()`. With the junction removed the chords do nothing because the plugin was the only handler — consistent with this reading.
- **Settles — items 1–5 by explanation**: clean console (nothing throws), no banner (guard checks services, not data), junction re-link and disabling other plugins (load is fine — the boot log shows `@dsh-external/dsh-input-history/client.js` in the 57-entry combo), update chip "latest" (the plugin repo simply hasn't shipped an alpha.2 adaptation).
- **Does not address — the colleague's suggestion** ("re-register its slot or re-declare inject; try adding `'uiSession'` to the inject list"): this reading shows that *neither inject nor slot registration is the failure* — all injected services resolved, and this plugin registers no slot (it is a pure document-level keyboard plugin). The suggestion happens to point at the right *replacement API* (`uiSession`), but as a diagnosis ("re-register / re-declare") it is wrong: the plugin loads and injects fine; only the data read is dead. Note also that on alpha.1 `'uiSession'` in `inject` is not a *change* that fixes anything — it is the *migration target* (see §3).

---

## 2 · Evidence mapping

### What changed about the snapshot the plugin reads (alpha.1 → alpha.2 `ISessions.list`)

| | alpha.1 (`session-list-alpha1.d.ts`) | alpha.2 (`session-list-alpha2.d.ts`) |
|---|---|---|
| Snapshot type | `SessionListState` | `SessionListSnapshot` |
| Fields | `byId: Record<SessionId, SessionSummary>`, **`current: SessionId | undefined`** | `items`, `state`, `phase`, `error`, `subagentsByParent`, `jobsBySession` — **no `current`, no `byId`** |
| JSDoc on `list` | "Global session-list snapshot (byId + current)" | "Host catalog and local reference-source counts; **navigation belongs to view owners**" |

Implication: `sessions.list.getSnapshot().current` now evaluates to `undefined` on **every** keystroke, forever, even with a session open and active. The plugin can never distinguish "no session" from "session open" through this read again.

### The canonical replacement read (new-service excerpt, `ui-session-service-alpha2.d.ts`)

- **Service**: `UiSession` from `@deepseek-ai/dsh-client-ui-session` (client bundle exports `UiSession`; **inject name `"uiSession"`**). Root service owning per-Session bindings and the main-view selection.
- **Observable it exposes**: `uiSession.adapter.current` — "Binding source of the main view's current session", an `ObservableSnapshot<SessionBindingValue>`. (The service also offers `sourceFor(owner)` for arbitrary bindings and `provide(descriptor)` for session-scoped source contributions.)
- **Shape of the value**: `SessionBindingValue` =
  - `key: SessionId` — the bound session's id (`undefined` while no main session is retained: "the service publishes the absent value while no main session is retained");
  - **`ctx: Context`** — "the session-scoped context: services registered under this session resolve here" — **this field replaces `sessions.scope(id)`** for session-scoped service resolution (e.g. `actx.get('conversation')`, `conversation.input.for(actx)`);
  - `hooks` / `keyedHooks` / `props` — standard-source contributions for the binding.

So the whole per-press resolution chain `current → scope(id) → actx.get('conversation')` has a one-stop replacement: `ctx.uiSession.adapter.current.getSnapshot()` yields the id **and** the session-scoped context in one object.

(Per skill card DSH-0.1.6-A2-01: `uiSession` is *not new in alpha.2* — it is registered on both tags, and `adapter.current` is the public path that works on both hosts. On alpha.2 the same fact is also derivable as the catalog row with `retainedBy.mainView > 0`.)

---

## 3 · Migration recipe (single build, both hosts)

```ts
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationNode, IConversation, SessionInput,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { UiSession } from '@deepseek-ai/dsh-client-ui-session/client'

interface ResolvedSession {
  readonly input: SessionInput
  readonly nodes: readonly ConversationNode[]
}

interface Injected {
  readonly sessions: ISessions
  readonly uiConversation: ...
  readonly uiSession?: UiSession   // absent on hosts older than the service
}

/**
 * Resolve the main-view session on any host: through uiSession.adapter.current
 * (alpha.2 and any host shipping the service) or the legacy list snapshot +
 * sessions.scope (alpha.1).
 */
function resolveCurrentSession(svc: Injected): { id: string; sctx: Context } | null {
  // Preferred path: binding value carries both the id and the session-scoped ctx.
  const bindingSnapshot = svc.uiSession?.adapter?.current?.getSnapshot()
  if (bindingSnapshot !== undefined && bindingSnapshot !== null) {
    if (bindingSnapshot.key === undefined) return null        // no main session retained
    return { id: bindingSnapshot.key, sctx: bindingSnapshot.ctx }
  }
  // Legacy path (alpha.1): current id on the list snapshot, scope() for the ctx.
  const legacyId = svc.sessions.list.getSnapshot().current
  if (legacyId === undefined) return null
  const scoped = svc.sessions.scope(legacyId)
  if (scoped === undefined) return null
  return { id: legacyId, sctx: scoped }
}
```

and the corrected `resolve` inside `applyBody` (rest of `onKeyDown` unchanged):

```ts
const resolve = (): ResolvedSession | null => {
  const current = resolveCurrentSession(ctx)
  if (current === null) return null
  const { id, sctx } = current
  if (id !== lastSessionId) {
    browse = IDLE
    lastSessionId = id
  }
  const conversation = sctx.get('conversation') as IConversation | undefined
  if (conversation === undefined) return null
  const chat = ctx.uiConversation.binding(id).snapshot.getSnapshot().views.get('chat')
  const nodes = chat === undefined ? EMPTY_NODES : chat.legacy.nodes
  return { input: conversation.input.for(sctx), nodes }
}
```

**`inject` declaration change**:

```ts
export const inject = ['sessions', 'uiConversation', 'conversation', 'uiSession']
```

`'uiSession'` must be added so Cordis guarantees the service is started before `apply` runs (plain `ctx.uiSession` without injection is a weak read and may be `undefined` at activation). It must be the inject *name* `"uiSession"`, not the class name. On hosts where the service does not exist the injection fails loudly rather than silently — which is exactly what you want; if the plugin must also tolerate pre-`uiSession` hosts at runtime, treat the injection failure as the compat condition instead of shipping a silent fallback, or keep `uiSession` out of the hard-`inject` list and let the legacy branch cover it (the code above supports both wiring choices).

**How the session-scoped context reaches the conversation service**: on alpha.2 it arrives *inside the binding value* — `SessionBindingValue.ctx` is the session-scoped `Context`; `conversation` resolves via `bindingValue.ctx.get('conversation')` and the input facade via `conversation.input.for(bindingValue.ctx)`. On alpha.1 the same context is obtained separately via `sessions.scope(id)`. The dual-host function normalizes both into `sctx`, so the rest of the plugin is host-agnostic. If the plugin ever needs to *react* to main-view switches instead of polling per keystroke, subscribe: `ctx.uiSession.adapter.current.subscribe(listener)`.

(Caveat outside this corridor's evidence: the downstream `chat.legacy.nodes` read via `uiConversation.binding(id)` sits behind the fixed read and is not covered by the alpha.2 excerpts or the A2-01 card; re-verify it after the migration compiles — the keyed-chat-snapshot reshapes live in the older 0.1.2-alpha.2 ledger, not this edge.)

---

## 4 · Guard hardening

### The class of breakage presence-checks cannot catch

`applyWithCompat` verifies that named **service members exist** (`ctx.sessions.list`, `ctx.sessions.scope`, …). It cannot catch:

- **field-level removals/renames on the data a service exposes** — exactly this case: the services are all present; one field (`current`) on one snapshot type is gone;
- observable *shape* changes (a snapshot whose payload type is restructured while the observable object itself is intact);
- semantic changes where the member exists but its contract moved (return type, meaning, parameter list);
- anything that fails only *later in the lifecycle* (at first event, first render, first keystroke) rather than at activation.

In short: presence checks validate the **provider**, not the **read path**. Any breakage that manifests as `undefined` flowing through a designed early-return is invisible to them — and invisible to the console too.

### Hardened guard: probe the read, at the right lifecycle point

Replace the four member-presence tuples with probes that **execute the plugin's actual resolution path end-to-end and assert the value shapes it depends on**:

```ts
function probeReadPath(ctx: ClientContext): string | null {
  // 1) alpha.2 / new-service path: the binding snapshot must carry key + session ctx.
  const uiSession = (ctx as ...).uiSession
  if (uiSession?.adapter?.current) {
    const b = uiSession.adapter.current.getSnapshot()
    if (b === undefined || b === null) return 'uiSession.adapter.current snapshot missing'
    if (b.key !== undefined && typeof b.ctx?.get !== 'function')
      return 'SessionBindingValue.ctx is not a session-scoped Context'
    return null // absent binding (key undefined) is a VALID state — probe passes
  }
  // 2) legacy path: the list snapshot must still expose a `current` field of the expected type.
  const snap = ctx.sessions?.list?.getSnapshot?.()
  if (snap === undefined) return 'sessions.list snapshot unreadable'
  if (!('current' in snap)) return 'sessions.list snapshot lost the current field (host >= multi-instance refactor)'
  if (snap.current !== undefined && typeof snap.current !== 'string')
    return 'sessions.list.current has unexpected type'
  return null
}

// in apply(): banner when probeReadPath returns a string, not null
```

Key design points:

- **Probe observables' *values*, not services' existence**: call `getSnapshot()` and check the fields the plugin reads (`'current' in snap`, `b.key`/`b.ctx.get`). Structural checks like `'field' in snapshot` turn a silent removal into a detected one.
- **Lifecycle point**: the probe must run **at plugin activation** (`apply`, inside the `applyWithCompat` wrapper) — same place the old guard ran — because that is the one moment a remediation banner is meaningful and before any user input is lost. But presence-at-activation alone still cannot prove a *session-scoped* read works while no session is open, so the probe must additionally run (or re-run) **on first real event** (first qualifying Ctrl+Up/Down): if `resolve()` returns `null` while a session is visibly open in the main view, surface a one-time console warning or toast ("input-history: could not resolve the current session — host API mismatch") instead of returning silently. That closes the exact hole this incident slipped through: activation-time probes for structure, event-time probes for liveness, and *never* a silent early-return on a path the guard never exercised.

---

## 5 · Verification and prevention

### Verifying the fix on both hosts without a full migration

No install or host change needed — the plugin is junction-linked, so edit the plugin's built `client.js` (or temporarily wrap `resolve`) on each host:

1. **alpha.2 host**: open one session; in the browser console (or a temporary `console.log` at the top of `resolve`), evaluate the replacement read — `ctx.uiSession.adapter.current.getSnapshot()` (grab `ctx` from a temporary `window.__ih_ctx = ctx` in `apply`). Expect `{ key: <open session id>, ctx: {...}, hooks, ... }`. Then verify the legacy read is indeed dead: `ctx.sessions.list.getSnapshot().current` → `undefined`. That single pair of observations confirms the attribution end-to-end.
2. **alpha.1 host** (or an `@deepseek-ai/dsh@0.1.6-alpha.1` profile elsewhere): confirm the legacy branch still returns the open session's id and that `uiSession` also exists there (per DSH-0.1.6-A2-01 it is registered on both tags) — proving one build serves both.
3. **Behavioral matrix on both**: (a) with one session open, Ctrl+Up fills the composer with the last sent message and Ctrl+Down walks back; (b) switch the main-view session → recall restarts fresh (`browse = IDLE` path); (c) no session open → the chords do nothing *and no error throws*; (d) guard banner deliberately triggered by stubbing the probe (e.g. deleting `adapter.current`) → banner renders. Success on (a)–(d) on both hosts validates the dual-host function without touching the host installation.

### The single host-side change that would have made this loud

Keep `current` on the alpha.2 `SessionListSnapshot` **as a runtime getter that throws** (or at minimum a `@deprecated` getter that logs once) with a message naming the replacement — e.g.:

```ts
// in the alpha.2 session-controller client service's snapshot publication
get current(): SessionId | undefined {
  throw new Error(
    'SessionListState.current was removed in 0.1.6-alpha.2 (multi-instance sessions); ' +
    'read ctx.uiSession.adapter.current.getSnapshot() instead')
}
```

A deleted field reads as `undefined` and is invisible; a throwing (or loudly-logging) deprecated getter on the service's published snapshot object converts the very first plugin read into a console error at **plugin activation / first keystroke**, pinpointing both the offending plugin and the migration target. (The types-only removal — deleting `current` from the `.d.ts` — can never do this, because shipped plugin bundles are not re-typechecked against new declarations at load; the loudness must live in the *runtime* object the service publishes.)

---

## Appendix · Corridor cross-check

- Skill card `DSH-0.1.6-A2-01` (`skills/plugin-upgrade/references/v0.1.6-alpha.2.md`) matches this fixture exactly, including first-hand fleet evidence for the same plugin ("a composer input-recall plugin lost Ctrl+Up/Down entirely") and the canonical migration (`uiSession.adapter.current`, `retainedBy.mainView`).
- Release note in `upgrade-notes.txt` ("客户端 Session 会话支持多实例共存，相关 API 及 slot 有变化") is the prose form of the same break.
- Boot log confirms load success (combo of 57 entries includes the plugin), ruling out loader/composition failures and consistent with items 3–5 of the already-tried list.
