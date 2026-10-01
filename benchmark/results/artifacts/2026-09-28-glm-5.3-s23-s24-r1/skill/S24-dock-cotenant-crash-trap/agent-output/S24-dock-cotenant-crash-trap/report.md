# S24 · The Dock That Vanished Together — Diagnosis and Fix

Scenario: dsh 0.1.6-alpha.1 → 0.1.6-alpha.2 (npm global, Windows, web profile, six junction-linked
external client plugins). Two simultaneous symptoms: (1) session-progress strip absent from the
composer dock; (2) paste/attachment chips rail absent, while the attach button in a different slot
still renders. Exactly one render error in F12.

## 1. Culprit attribution

**The failing plugin is A (dsh-ui-progress), not B.** The single console error is:

```
Uncaught TypeError: useSessionPendingInteraction is not a function
    at SessionProgressBar (plugin://dsh-external/dsh-ui-progress/lib/client.js:219:41)
```

**Exact failing call:** in `SessionProgressBar`, the line

```ts
const pendingBySession = useSessionPendingInteraction(interactions => interactions)
```

During render, the component destructures `useSessionPendingInteraction` from its standard-kit
props and calls it as a hook. On alpha.2 the shell no longer supplies that prop, so it is
`undefined`, and calling `undefined(...)` raises the TypeError. This is a render-time crash
inside plugin A's own component — the very first render of the strip after the upgrade.

**Why now — the standard-kit reduction between the two sealed contracts:**

- alpha.1 `SessionStandardProps` (slots-contract-alpha1.d.ts) includes
  `useSessionPendingInteraction: SnapshotSelectorHook<ReadonlyMap<SessionId, SessionPendingInteraction>>`.
- alpha.2 `SessionStandardProps` (slots-contract-alpha2.d.ts) removes it and replaces it with
  `useSessionStatus: SnapshotSelectorHook<ReadonlyMap<SessionId, SessionStatus>>` (per-session
  status: `running`, `completionUnread`, `pendingInteraction`) plus
  `useSessionRetainInfo`. `useConversation`, `useSessions`, `useProjection`, `useInput`,
  and `inputActions` are unchanged.

This matches the alpha.2 migration card: after the multi-instance Session refactor removed
`SessionListState.current`, `GlobalStandardProps` swapped `useSessionPendingInteraction` for
`useSessionStatus` + `useSessionRetainInfo` (`useSessions` stays). The map of pending
interactions by session id is now reachable as the `pendingInteraction` field of each entry's
`SessionStatus`. Plugin A was written against the alpha.1 kit and was never migrated, so on
alpha.2 its strip crashes on first render.

**Why the innocent co-tenant (plugin B) disappears with it — the mechanism:**

Plugin B's chip rail (`dsh-paste-input-dock`, order 5) and plugin A's strip (`progress`,
order 20) are entries of the **same list slot**, `conversation.input.dock`. Per
dock-render-tree.md, the alpha.2 conversation package wraps the *entire dock list* in a single
`DrawerErrorBoundary`:

```
<InputDock>
  <DrawerErrorBoundary name="input.dock">
    <DockEntry id="dsh-paste-input-dock" />   (B, order 5)
    <DockEntry id="progress" />               (A, order 20)
  </DrawerErrorBoundary>
</InputDock>
```

When A's `SessionProgressBar` throws during render, the error propagates up to the nearest
boundary — the one shared by both entries. The boundary's fallback is `null`, so React unmounts
the whole subtree: both dock entries vanish. The console confirms it:
`[dsh:slots] input.dock boundary fallback active … unmounted entries: dsh-paste-input-dock, progress`.
This is **shared-error-boundary blast radius**, not any interaction between the plugins: B's entry
is unmounted as collateral damage of A's crash.

**Why the attach button survives while the chips do not:** the attach button
(`dsh-paste-input-button`) is registered in a *different* slot, `conversation.input.left`,
which has its own `DrawerErrorBoundary` (`<DrawerErrorBoundary name="input.left">` around the
single `SlotEntry`). The alpha.2 boundary granularity is per-slot-list, not per-entry
(`DockEntry` adds no boundary of its own), so A's crash crosses into B's dock entry but cannot
cross into the separate input.left boundary. Hence: button alive, chips gone — one error, two
symptoms, one mechanism.

## 2. The experiment

The maintainer disabled plugin A and refreshed → plugin B's chips came back immediately;
re-enabled A → chips gone again (tried-notes.txt item 3).

**What it proves:**

- The disappearance of B's chips is *caused by A's presence*, and the causal direction is
  deterministic and reproducible (bidirectional toggle: off → chips back, on → chips gone).
  Since B's entry is only ever removed as part of the shared boundary fallback, A's render crash
  is the trigger that unmounts the dock list. It rules out plugin B's own code, the paste
  interception state, and stale-install corruption of B as the cause of the missing chips.

**What it does NOT prove:**

- **It does not prove plugin B is bug-free on alpha.2.** B's `AttachmentChips` uses no
  standard-kit hooks (dock-entry-excerpt.md), so this particular reduction could not have hit it —
  but "did not crash in this one test path" is not "fully compatible". B could still break on
  other alpha.2 surfaces (other props, events, registration semantics) that this experiment never
  exercised. Absence of this failure ≠ absence of all failures.
- **It does not prove the strip crash is the ONLY dock problem.** It proves A's crash explains
  B's symptom. With A disabled, the strip itself is of course also gone (it was disabled), so
  nothing about A's *other* behavior on alpha.2, or about the remaining dock entries (`...` in
  the render tree), is validated. It also does not prove the boundary-fallback mechanism — that
  comes from the console line naming both unmounted entries.

**Why reinstalling plugin B could never have helped:** the defect is not in B. B registers
successfully, its render path throws nothing, and its entry is removed by the shared
`DrawerErrorBoundary` when A crashes. Reinstalling B replaces identical code with identical
code; the crash source (A) is untouched, so the boundary fallback recurs on every render.
Reinstalling the victim cannot cure the shooter.

**What is wrong with the colleague's "both plugins were hit twice" theory:** the evidence shows
exactly one render error, and it names plugin A's component and the removed hook. B uses no
standard-kit hooks at all, so a slot-prop reduction has no surface to hit in B. The "two hits"
theory predicts two independent errors and predicts that fixing A alone would leave B broken —
the control experiment refutes both predictions: with A disabled, B works with zero changes to B.
One bug, two symptoms, explained by the shared boundary; the theory multiplies causes beyond the
evidence.

## 3. The fix (plugin A, graceful degradation)

Migrate `SessionProgressBar` to the alpha.2 kit: **`useSessionStatus` now supplies the pending
state** — each entry's `SessionStatus.pendingInteraction` replaces the old
`ReadonlyMap<SessionId, SessionPendingInteraction>` value. Degrade gracefully when neither
hook exists so one old host never again kills the whole dock:

```tsx
/**
 * SessionProgressBar (fixed): 'conversation.input.dock' entry, plugin A.
 * Pending state reads useSessionStatus (dsh >= 0.1.6-alpha.2); falls back to
 * the removed useSessionPendingInteraction on alpha.1 hosts; on hosts with
 * neither, the attention (pending) indicator degrades silently and the rest
 * of the strip keeps rendering.
 */
export type SessionProgressBarProps =
  import('@deepseek-ai/dsh-client-ui-slots').PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'progress'>

export function SessionProgressBar({
  session, sessionId, t, useConversation, useProjection, useSessions,
  // alpha.2 kit
  useSessionStatus,
  // alpha.1 kit (removed on alpha.2; undefined there)
  useSessionPendingInteraction,
}: SessionProgressBarProps) {
  if (session === undefined || session === null) return null
  const chat = useConversation(conversation => conversation.views.get('chat'))
  const legacy = chat?.legacy ?? EMPTY_LEGACY
  const todos = useProjection('todos')
  const toolName = runningTool(legacy)
  const running = session.running

  // Attention state. alpha.2: useSessionStatus().pendingInteraction per entry;
  // alpha.1: useSessionPendingInteraction map. Neither present: no pending
  // signal — render without it rather than crash the shared dock boundary.
  const statusById = useSessionStatus?.(s => s) ?? null
  const pendingBySession: ReadonlyMap<SessionId, SessionPendingInteraction> =
    statusById !== null
      ? new Map(
          [...statusById].filter(([, s]) => s.pendingInteraction !== undefined)
            .map(([id, s]) => [id, s.pendingInteraction!]),
        )
      : typeof useSessionPendingInteraction === 'function'
        ? useSessionPendingInteraction(interactions => interactions)
        : EMPTY_PENDING

  const ownPending = pendingKindOf(pendingBySession.get(sessionId)?.kind)
  const subPending = subagentPendingState(
    useSessions(s => s.byId), pendingBySession, sessionId)
  const pending = ownPending !== null || subPending.approvals > 0 || subPending.questions > 0

  const subRunning = subagentRunningCount(useSessions(s => s.byId), sessionId)

  return (
    <div className={css.bar} data-pending={pending || undefined}>
      {/* state text, fill bar, todos percent, token chip, elapsed/eta */}
    </div>
  )
}

const EMPTY_PENDING: ReadonlyMap<SessionId, SessionPendingInteraction> = new Map()
```

Notes on the degraded host: on a host supplying **neither** pending hook (older than alpha.1's
kit, or a future kit that renames again), only the **attention/pending indicator** is lost:
`pending` is always false and `data-pending` never set. Everything else — running state, fill
bar, todos percent, token chip, elapsed/eta, subagent running count — still renders, because
those derive from `session`, `useConversation`, `useProjection`, and `useSessions`, which
are present in both sealed contracts.

**Why the degradation must be silent rather than throwing:** this component renders inside a
shared `DrawerErrorBoundary` with co-tenants. A thrown error does not remove only the strip —
the boundary's `null` fallback unmounts *every* entry in `conversation.input.dock`, which is
exactly the S24 incident: A's crash deleted B's chips. A dock tenant must never turn a
feature-level gap (missing optional hook) into a slot-level outage. Silent degradation keeps the
strip's remaining features and keeps co-tenants mounted; the missing pending dot is a strictly
smaller failure than a vanished dock.

## 4. Multi-tenant hygiene

**Tenant-side (what plugin A should do):**

- Treat every standard-kit prop as possibly absent across host versions: feature-detect hooks
  (`typeof hook === 'function'`) before calling, and degrade features rather than throwing —
  the shared boundary makes any throw a denial of service against co-tenants.
- Keep the crash surface small: compute derived state lazily and guard host-version-sensitive
  calls first, so an absent API fails one feature, not the whole render.
- Prefer version-corridor migration (track the host's slot-contract changes, like the
  alpha.2 `useSessionStatus` swap) so graceful degradation is a safety net, not the plan.

**Host-side (what the shell could change):** wrap *each* `DockEntry` in its own error boundary
(per-entry isolation) instead of one boundary per slot list. Then A's crash would render only
A's entry's fallback, and B's chips would survive. **The trade-off:** per-entry boundaries
(a) change the visual/layout contract — a failed entry's fallback (`null`) collapses the space
it occupied or needs a per-entry error affordance, whereas today the whole drawer fails as one
unit; (b) cost one boundary component instance per entry (rendering overhead in a hot composer
path); (c) reduce blast radius *and* observability — with one shared boundary a single console
error names the culprit and one fallback state is obvious, while N isolated boundaries can fail
independently and silently, making "which entries are down?" harder for users and maintainers to
see. The host must choose between fail-together-visibility and fail-isolated-availability.

## 5. Verification

Without a host restart (client plugins reload via the HMR/reload path while `dsh web` keeps
running — refresh the page after replacing plugin A's client bundle):

1. **Reload and watch the console**: the
   `useSessionPendingInteraction is not a function` error at
   `SessionProgressBar` is gone; no `[dsh:slots] input.dock boundary fallback active` line.
2. **Plugin A restored**: the session-progress strip renders above the composer — running state,
   todos percent, token chip, elapsed/eta all present; with a pending interaction (e.g. an
   approval request in a subagent), `data-pending` attributes set correctly, proving the
   `useSessionStatus` migration actually feeds the attention state.
3. **Plugin B restored (the co-tenant regression)**: paste a file → the chip rail renders above
   the composer (`dsh-paste-input-dock` mounted), chips removable, and the attach button
   (`input.left`) still present. In React DevTools both `DockEntry id="dsh-paste-input-dock"`
   and `DockEntry id="progress"` are mounted under `DrawerErrorBoundary name="input.dock"`.
4. **Regression plugin B specifically must cover**: B was only ever "proven fine" by the disable
   experiment, which exercised just its render path on alpha.2. Verify B end-to-end on alpha.2:
   paste AND file-drop paths produce chips; chips remove correctly; the attach button's picker
   flow still works; repeated paste while a session is running (concurrent with A's strip
   re-rendering on status changes) does not re-trigger any boundary fallback. I.e., confirm B is
   genuinely bug-free on alpha.2, not merely crash-free in the one path the experiment exercised.
5. **Degradation test (optional but recommended)**: temporarily strip both pending hooks from the
   props (or run against the oldest supported host) and confirm the strip still renders minus the
   pending dot, silently, with no console error and no unmounted dock entries.
