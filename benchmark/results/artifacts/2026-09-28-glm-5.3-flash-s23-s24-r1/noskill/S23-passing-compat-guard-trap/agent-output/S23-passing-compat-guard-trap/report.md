# S23 - The Compat Guard That Passed: Failure Attribution, Migration, and Guard Hardening

## 1. Silent-failure attribution

### The exact read that now fails

Walk the per-keystroke resolution path in `plugin/src-client-index.ts`:

```ts
const resolve = (): ResolvedSession | null => {
  const id = sessions.list.getSnapshot().current        // <-- THE FAILING READ
  if (id === undefined) return null                     // <-- bails here, every keystroke
  ...
}
```

The plugin reads the global session-list snapshot and pulls its `current` field to learn which session the main view is bound to. On alpha.1 that snapshot is `SessionListState { byId, current }` and `current` is the live session id. On alpha.2 the snapshot type was replaced wholesale by `SessionListSnapshot { items, state, phase, error, subagentsByParent, jobsBySession }` - `current` no longer exists on the object. Reading a missing property in JavaScript yields undefined without throwing, so `id` is undefined on every press, the very next line returns null, and `onKeyDown` returns before doing anything.

### Why nothing surfaces anywhere

- **Why the compat guard passes.** The guard probes four *service members*: `ctx?.sessions?.list`, `ctx?.sessions?.scope`, `ctx?.sessions?.sessionOf`, `ctx?.uiConversation?.binding`. All four still exist at alpha.2 - `scope(id)` still exists on `ISessions` (the alpha.2 excerpt explicitly notes it was only omitted from the excerpt, not removed), `sessionOf` was untouched, and `list` still exists physically even though its semantics changed. The guard never opens the snapshot to ask whether the fields it *reads from the snapshot value* exist. The breakage is a field-level removal inside the value returned by a still-present accessor, which a presence-check on accessors cannot see.
- **Why there is no console error.** Nothing throws. A missing property read is undefined; `if (id === undefined) return null` is a normal early return. No exception, no rejection, no unhandled path - the browser console stays clean and the host boot log stays clean ("no pending entries, no duplicate loader ids, host up").
- **Why the failure mode is a silent no-op, not a swallowed exception.** `onKeyDown` is registered and firing; it exits at `if (resolved === null) return`, *before* the `preventDefault()`/`stopPropagation()` calls. That precisely matches the symptom: the chord is "not swallowed either - the composer's own multi-line cursor movement still works". The capture listener runs and bails; it never claims the key.

### What this settles, and what it does not

**Settled:** suspicion that the plugin failed to load, register, or bind its listener (the boot log shows it assembled; the listener demonstrably fires and bails inside `resolve`), and the implication of item #2 - the guard's silence does not mean compatibility; the guard is a **false negative**. Items #3 (junction re-link / hard refresh) and #4 (disable other plugins) are also settled: the fault is in the plugin's host-API read, not in loading, caching, or plugin interference.

**Not addressed:** item #6 (chords taken by another handler) is consistent with this reading - with the junction removed nothing fires - but that check could not have distinguished "no handler at all" from "handler bails", and it did not point at the cause. The attribution also says nothing about whether *other* plugins that read the old list snapshot fields (anything rendering from `byId`) are silently degraded the same way. The same guard-blind field-removal class may be latent in the other five plugins; that needs a separate audit of each plugin's snapshot-field reads.

## 2. Evidence mapping

### What changed about the snapshot

| | alpha.1 `SessionListState` | alpha.2 `SessionListSnapshot` |
|---|---|---|
| Selection | `current: SessionId or undefined` - the session the main conversation view is bound to | **none** - "navigation belongs to view owners"; the list is a pure catalog |
| Contents | `byId: Record<SessionId, SessionSummary>` | `items: readonly SessionListEntry[]` plus `state`/`phase`/`error`, per-session `subagentsByParent`, `jobsBySession` |

The multi-instance refactor moved "which session is the main view on" out of the session-list controller into a per-binding owner. **Implication for the plugin:** on alpha.2, `sessions.list.getSnapshot().current` is undefined on *every* keystroke, forever - not merely when no session is open. The plugin concludes "no current session" unconditionally and no-ops.

### The canonical replacement read

The alpha.2 excerpt ships `@deepseek-ai/dsh-client-ui-session`, client bundle export **UiSession**, inject name **"uiSession"**:

- **Service:** `UiSession` - "root service owning per-Session bindings and the main-view selection".
- **Observable it exposes:** `uiSession.adapter.current: ObservableSnapshot<SessionBindingValue>` - "binding source of the main view's current session".
- **Value it yields:** `SessionBindingValue { key: SessionId; ctx: Context; hooks; keyedHooks; props }`. `key` is the bound session's id - the replacement for `current`. While no main session is retained, the service publishes the *absent* value whose `key` is undefined, so the plugin's "no current session" branch survives as `key === undefined`.
- **The field replacing `sessions.scope(id)`:** `SessionBindingValue.ctx` - "the session-scoped context: services registered under this session resolve here". The old two-step `sessions.scope(id) then actx.get("conversation")` becomes a single step reading `bindingValue.ctx`.

## 3. Migration recipe

### Constraints that shape the fix

- The plugin must run from **one build on both hosts**. A hard `'uiSession'` entry in `inject` would make activation fail on alpha.1 (no such service) - the opposite regression. So: **do not add uiSession to the inject declaration**; read it lazily off the context at resolve time. The existing `inject = ['sessions', 'uiConversation', 'conversation']` stays unchanged. (If the framework supports optional/weak inject entries, declaring uiSession optional is the tidier equivalent; a required entry is what must not happen.)
- The session-scoped context reaches the conversation service through the binding value: `bindingValue.ctx.get('conversation')` on alpha.2, `sessions.scope(id)?.get('conversation')` on alpha.1. `conversation.input.for(actx)` and `uiConversation.binding(id)` keep working as before, fed with whichever context the active branch produced.

### Corrected resolution function (dual-host, one build)

```ts
interface HostBinding {
  readonly id: SessionId
  readonly actx: Context
}

/**
 * Resolve the main view's current session on both hosts.
 * - alpha.2+: uiSession.adapter.current yields SessionBindingValue { key, ctx, ... }.
 * - alpha.1:  the sessions.list snapshot carries current, and sessions.scope(id)
 *             yields the session-scoped context.
 * Returns null when no main session is bound (legitimate) or on an unknown host.
 */
function resolveBinding(ctx: ClientContext, sessions: ISessions): HostBinding | null {
  const uiSession: UiSession | undefined =
    (ctx as unknown as Record<string, unknown>).uiSession as UiSession | undefined
  if (uiSession !== undefined) {
    const binding = uiSession.adapter.current.getSnapshot()
    if (binding === undefined || binding.key === undefined) return null
    return { id: binding.key, actx: binding.ctx }
  }
  // Legacy alpha.1 path.
  const state = sessions.list.getSnapshot() as unknown as { current?: SessionId }
  const id = state?.current
  if (id === undefined) return null
  const actx = sessions.scope(id)
  if (actx === undefined) return null
  return { id, actx }
}
```

And `resolve()` in `applyBody` becomes:

```ts
const resolve = (): ResolvedSession | null => {
  const binding = resolveBinding(ctx, sessions)
  if (binding === null) return null
  const { id, actx } = binding
  if (id !== lastSessionId) {
    browse = IDLE               // session switch: recall restarts fresh
    lastSessionId = id
  }
  const conversation = actx.get('conversation') as IConversation | undefined
  if (conversation === undefined) return null
  const chat = ctx.uiConversation.binding(id).snapshot.getSnapshot().views.get('chat')
  const nodes = chat === undefined ? EMPTY_NODES : chat.legacy.nodes
  return { input: conversation.input.for(actx), nodes }
}
```

Optionally subscribe to `uiSession.adapter.current` inside `ctx.effect` to reset `browse` proactively on session switch; the per-keystroke `getSnapshot()` shown above is already correct and stateless-safe.

## 4. Guard hardening

### The class of breakage presence-checks cannot catch

The shipped guard verifies that four *accessors exist on the service objects*. It cannot catch **structural drift inside the values those accessors return**: a snapshot whose field set was replaced (`current` -> `items`), a return type reshaped, or a member renamed within a payload. Presence of `sessions.list` says nothing about the presence of `sessions.list.getSnapshot().current`. Every guard item passed while the plugin was already dead because the guard inspects the doors and the room was emptied.

### A hardened guard

Probe *behavior and payload structure*, not member existence:

1. **Probe the snapshot's field set at activation.** Take one real snapshot and check the fields the plugin actually reads, using `in` (not truthiness - `current` is legitimately undefined with no session open):

```ts
const snap = ctx.sessions.list.getSnapshot()
const legacyList = snap !== null && typeof snap === 'object' && 'current' in snap
const modernList = snap !== null && typeof snap === 'object' && 'items' in snap
if (!legacyList && !modernList) {
  fail('sessions.list snapshot has neither current (alpha.1) nor items (alpha.2)')
}
```

2. **Probe the modern service's payload, not its existence.** When `ctx.uiSession` exists, take `uiSession.adapter.current.getSnapshot()` and require the fields the plugin consumes: `'key' in value && 'ctx' in value`. An accessor that exists but returns an unexpected value shape fails the guard.
3. **Probe a resolution round-trip.** The strongest check: run the plugin's own `resolveBinding` against a known-active session (if one exists) and require a non-null result with `input` and `nodes`. That exercises exactly the code path the keystrokes will take.

### Lifecycle point

The probe must run **inside apply, before the keydown listener is registered** - inside the guarded callback of `applyWithCompat` - so a probe failure renders the remediation banner instead of installing a dead listener. A field-level break cannot be caught by "does the service exist" at any time, and the shape probe needs no open session (`in` checks work on the absent state). If the round-trip probe is used it must tolerate "no session open yet"; in that case arm a **first-use watchdog**: if `resolve()` returns null on N consecutive presses while the host reports at least one active session, log one console warning naming the failing read (e.g. "sessions.list.getSnapshot().current is missing - host API drift"). That converts any recurrence of this failure mode into a visible signal at or immediately after activation instead of never.

## 5. Verification and prevention

### Verifying the fix on both hosts without a full migration

- **Structural dual-host unit tests.** Mock the two contexts from the sealed type excerpts: an alpha.1 context whose `list.getSnapshot()` returns `{ byId, current: 's1' }` with `scope('s1')` yielding a stub context carrying `conversation`; an alpha.2 context exposing `uiSession.adapter.current` yielding `{ key: 's1', ctx: stubCtx, hooks: {}, keyedHooks: {}, props: {} }` and no `current` on the list snapshot. Assert `resolveBinding` returns `{ id: 's1', actx }` on both, and null on each host's absent-binding state (`current: undefined` / `key: undefined`). Assert the hardened guard fails when the snapshot has *neither* `current` nor `items`.
- **Per-host smoke without migration:** install the same one-file build against an alpha.1 host and an alpha.2 host, open a session, send one message, press Ctrl+Up - the draft must refill on both. On alpha.2 additionally press Ctrl+Up with no session open: expect a clean no-op (null path), not an error.
- **Regression tripwire:** the first-use watchdog above - on alpha.2 with the *old* build it would print the drift warning on the first Ctrl+Up, turning this bug into a one-keystroke diagnosis.

### The single host-side change that would have made this loud

Keep the removed field as a **deprecated throwing stub on the snapshot object**: ship the alpha.2 `SessionListSnapshot` with a non-enumerable `current` getter that throws "SessionListSnapshot.current was removed in 0.1.6-alpha.2 - read uiSession.adapter.current (SessionBindingValue.key/ctx) instead", and at the type level keep it only under a deprecated-marked legacy interface so TypeScript consumers fail to compile. Then the plugin's very first `getSnapshot().current` read throws inside `onKeyDown` - a console error naming the exact replacement appears on the first keystroke, and an activation-time shape probe (section 4) catches it even earlier. General rule: when the host removes a published field, deprecate-and-throw rather than delete - silent undefined is the one failure mode that defeats both console monitoring and accessor presence guards.
