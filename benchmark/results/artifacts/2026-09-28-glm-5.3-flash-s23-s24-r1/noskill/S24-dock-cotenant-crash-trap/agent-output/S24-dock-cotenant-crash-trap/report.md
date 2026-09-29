# S24 · The Dock That Vanished Together — Diagnostic Report

## 1. Culprit attribution

**The failing plugin is plugin A (dsh-ui-progress), not plugin B.** The single console error pins it:

```
Uncaught TypeError: useSessionPendingInteraction is not a function
    at SessionProgressBar (plugin://dsh-external/dsh-ui-progress/lib/client.js:219:41)
```

The exact failing call is `useSessionPendingInteraction(interactions => interactions)` in
`SessionProgressBar` (plugin-a/SessionProgressBar-excerpt.tsx, the "Attention state" block).
It destructures that hook from the slot's standard props and calls it unconditionally.

**Why now** — the standard kit was reduced between the two sealed contracts. Comparing
`slots-contract-alpha1.d.ts` with `slots-contract-alpha2.d.ts`:

- Removed from `SessionStandardProps`: `useSessionPendingInteraction`
  (the per-session pending-interaction map hook).
- Added in its place: `useSessionStatus` ("Per-session status: running, completionUnread,
  **pendingInteraction**") and `useSessionRetainInfo` — the multi-instance refactor merged the
  session kit with `GlobalStandardProps` and folded pending-interaction data into a wider
  `SessionStatus` record.

Plugin A still destructures the removed name. On alpha.2 the prop simply does not exist, so the
destructured value is `undefined`, and calling `undefined` throws `TypeError` during render.
TypeScript would catch this if the plugin were recompiled against alpha.2 types, but the plugin's
built `client.js` predates the host change — the standard-kit reduction shipped as a host update
and only surfaces at runtime.

**Why the innocent co-tenant's dock entry disappears — the mechanism:**

The render tree (`dock-render-tree.md`) shows both plugin B's `AttachmentChips` (order 5) and
plugin A's `progress` entry (order 20) mounted as siblings inside ONE
`<DrawerErrorBoundary name="input.dock">`:

```
<InputDock>
  <DrawerErrorBoundary name="input.dock">
    <DockEntry id="dsh-paste-input-dock" />   (plugin B)
    <DockEntry id="progress" />               (plugin A — throws)
```

A React error boundary has one fallback for its entire subtree; it cannot discard only the child
that threw. When `SessionProgressBar` throws during mount, React unwinds the whole
`input.dock` subtree and the boundary's `getDerivedStateFromError` renders `null`.
Both dock entries unmount together — exactly what the slot log records:
`input.dock boundary fallback active; unmounted entries: dsh-paste-input-dock, progress`.

**Why the attach button survives:** plugin B registers its attach button into a *different slot*,
`conversation.input.left`, under its own boundary
(`<DrawerErrorBoundary name="input.left">`). The tree shows it as a sibling of `InputDock`,
not a descendant, so the crash in the dock subtree never propagates to it — confirmed by
`input.left: 1 entry mounted (dsh-paste-input-button)`. Slot membership, not plugin membership,
is the isolation unit here. Plugin B's chips die only because they share the *dock slot's*
boundary with plugin A, and plugin B's code never even runs (or never throws) — its try/catch
log is silent because the failure is elsewhere in the tree.

## 2. The experiment

The maintainer's disable-experiment — disable plugin A → plugin B's chips instantly return;
re-enable → chips vanish again — is decisive causal evidence:

**What it proves:**
- Plugin A's presence is necessary and sufficient for plugin B's dock entry to disappear.
  The biconditional (off → healthy, on → broken) rules out plugin B regression, host config
  drift, and coincidence.
- Combined with the single console error naming `SessionProgressBar`, the causal chain is
  complete: plugin A throws in the shared `input.dock` boundary; the boundary blanks the whole
  dock list; plugin B's chips are collateral of the boundary reset, not independently broken.

**What it does NOT prove:**
- It does **not** prove plugin B is bug-free on alpha.2. While A is disabled, B's
  `AttachmentChips` renders and shows chips, so its dock path works with *its current inputs*.
  But B uses no standard-kit hooks at all (it reads only its own injected state), so it happens
  to be insulated from the kit reduction — the experiment shows it renders, not that it is
  contractually future-proof against further kit changes.
- It does **not** prove the strip crash is the only dock problem. It proves that fixing A's
  crash restores the dock *as currently exercised* (one paste attempt). Any second,
  latent dock issue would be masked exactly as it is now; the log line shows only this crash and
  this fallback activation. Verification after the fix must still exercise the dock fully.

**Why reinstalling plugin B could never help:** plugin B was never broken. Reinstalling it
changes nothing about plugin A's throw inside the shared dock boundary — the crash recurs on the
next render regardless of which copy of B is on disk. The symptom (chips gone) is caused by
B's *neighbor*, so any B-side action (reinstall, config, cache clear) is orthogonal. The only
B-side "fix" that ever could have worked is the one accidentally discovered: removing A.

**What is wrong with the colleague's "both plugins were hit" theory:** the theory assumes the
symptom count equals the defect count. But the alpha.2 contract removed exactly one hook
(`useSessionPendingInteraction`) and only plugin A consumes it — plugin B uses none of the
standard kit, so there is nothing for the reduction to hit in B. The colleague's proposed remedy
("fix both plugins' slot registrations") is also mechanically wrong: both registrations are fine
and both entries appear in the slot registry (the slot log lists both as unmounted *by the
boundary*, not rejected at registration). One defect + one shared error boundary = two visible
symptoms. "Hit twice" misreads an isolation failure as two regressions.

## 3. The fix

On alpha.2 the pending state is supplied by **`useSessionStatus`** — the replacement hook whose
`SessionStatus` record includes `pendingInteraction` (per the alpha.2 contract comment:
"Per-session status: running, completionUnread, pendingInteraction"). Plugin A should select
`status.pendingInteraction` per session instead of a map keyed by session id.

Graceful degradation: the component must tolerate a host that supplies **neither**
`useSessionPendingInteraction` (old name, gone) **nor** `useSessionStatus` (a hypothetical
older/newer host), keeping the rest of the strip alive.

```tsx
/**
 * SessionProgressBar: session-progress strip for the 'conversation.input.dock' slot.
 * Graceful degradation for the pending-interaction seat, which moved from the
 * dedicated useSessionPendingInteraction hook (alpha.1) into useSessionStatus's
 * SessionStatus.pendingInteraction (alpha.2).
 */
export type SessionProgressBarProps =
  import('@deepseek-ai/dsh-client-ui-slots').PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'progress'>

/** Neutral "no pending data" value shared by every degraded path. */
const NO_PENDING: ReadonlyMap<SessionId, SessionPendingInteraction> = new Map()

function readPendingBySession(
  props: SessionProgressBarProps,
): ReadonlyMap<SessionId, SessionPendingInteraction> {
  // alpha.2 standard kit: pending interaction lives on the SessionStatus record.
  if (typeof props.useSessionStatus === 'function') {
    return props.useSessionStatus(statuses => {
      const map = new Map<SessionId, SessionPendingInteraction>()
      for (const [id, status] of statuses) {
        if (status.pendingInteraction !== undefined) map.set(id, status.pendingInteraction)
      }
      return map
    })
  }
  // alpha.1 standard kit: dedicated hook (host older than the multi-instance refactor).
  if (typeof props.useSessionPendingInteraction === 'function') {
    return props.useSessionPendingInteraction(pending => pending)
  }
  // Host supplies neither: the strip degrades silently — the attention ring and
  // pending text disappear, but running state, todos percent, token usage, and
  // elapsed/eta keep rendering.
  return NO_PENDING
}

export function SessionProgressBar(props: SessionProgressBarProps) {
  const { session, sessionId, t, useConversation, useProjection, useSessions } = props
  if (session === undefined || session === null) return null
  const chat = useConversation(conversation => conversation.views.get('chat'))
  const legacy = chat?.legacy ?? EMPTY_LEGACY
  const todos = useProjection('todos')
  const toolName = runningTool(legacy)
  const running = session.running
  // ... percent / turn / elapsed / eta derivation unchanged ...

  const pendingBySession = readPendingBySession(props)
  const ownPending = pendingKindOf(pendingBySession.get(sessionId)?.kind)
  const subPending = subagentPendingState(useSessions(s => s.byId), pendingBySession, sessionId)
  const pending = ownPending !== null || subPending.approvals > 0 || subPending.questions > 0

  const subRunning = subagentRunningCount(useSessions(s => s.byId), sessionId)

  return (
    <div className={css.bar} data-pending={pending || undefined}>
      {/* state text, fill bar, todos percent, token chip, elapsed/eta */}
    </div>
  )
}
```

**Which hook supplies pending state on alpha.2:** `useSessionStatus` — select
`SessionStatus.pendingInteraction` out of the per-session status map.

**What degrades when the host supplies neither pending hook:** the attention/pending surface of
the strip — `ownPending`, `subPending`, and therefore the `data-pending` attribute and its
attention styling/text — renders as "no pending". **What keeps working:** everything derived from
surviving kit members — running state, tool name, fill bar, todos percent, token usage, elapsed
and eta — plus the subagent running count via `useSessions`. The strip stays visible and
informative; only the "needs your attention" indication is absent.

**Why the degradation must be silent rather than throwing:** this component is a dock tenant
inside a shared `DrawerErrorBoundary` whose fallback renders `null` for the entire
`input.dock` subtree. Throwing again would blank not only the strip but also plugin B's chips
rail — the exact co-tenant outage being fixed — and would do so on every future kit reduction,
converting a missing optional feature into a multi-plugin outage. A missing pending hook costs
one visual cue; a throw costs the whole composer dock. Silent degradation is the only failure
mode whose blast radius matches the actual loss.

## 4. Multi-tenant hygiene

**What a dock tenant should do:**
- Treat standard-kit props as an evolving surface: feature-detect hooks (`typeof === 'function'`)
  before destructuring-and-calling, and degrade the dependent feature instead of failing render.
- Keep each injected component's render path defensive at its own root: guard optional context
  (`session == null → null`, as the excerpt already does) and never call a prop unconditionally
  that a host version may not supply.
- Keep heavy/fragile logic out of the synchronous render of a shared slot; precompute and pass
  safe fallbacks so a data problem cannot become a render throw.
- Ideally render through an internal try/catch-safe wrapper or a tiny local error boundary of its
  own, so its own bug renders nothing (or a stub) instead of unwinding siblings.
- Pin/verify the host contract at build time: typecheck against the *shipped host's* slots
  package, and treat removed names as a build error before the plugin ever reaches a host.

**What the HOST could change so one entry isolates:** wrap each `DockEntry` individually in its
own boundary — move `DrawerErrorBoundary` (or a lightweight per-entry boundary) from the slot
list level to inside every `DockEntry`, so a throw in entry N unmounts only entry N while the
rest of the list stays mounted. The slot log could then report "entry 'progress' failed; 1 entry
degraded" instead of a whole-slot fallback.

**The trade-off the host faces:** isolation versus overhead and coherent fallback UX. Per-entry
boundaries mean one error boundary per slot entry (six plugins, possibly several entries each) —
more class instances, more retained state, and each boundary must decide its fallback (null,
stub, or retry) — fragmenting the "drawer error" presentation that today is one consistent,
session-switch-reset surface. Slot-level boundaries are cheaper and give one predictable
fallback, at the cost of one tenant's crash taking down all co-tenants (this bug). A middle
ground (per-entry boundary with a shared fallback component) recovers isolation but still pays
the per-entry cost. The host must choose between minimal machinery with correlated failures, and
finer machinery with per-entry cost and more fallback states to design and test.

## 5. Verification

**Restore both dock entries without a host restart:** both plugins are junction-linked client
plugins; the fix is plugin-side, so:

1. Apply the fix to plugin A's client bundle (rebuild `lib/client.js` for
   `dsh-ui-progress` against the alpha.2 slots types).
2. Hard-refresh the web client (reload re-evaluates plugin modules; no host process restart is
   needed since the slot runtime re-injects and re-renders on page load).
3. With plugin A re-enabled, confirm the dock renders **both** entries: React DevTools shows
   `<DockEntry id="dsh-paste-input-dock">` and `<DockEntry id="progress">` as mounted
   siblings, and the slot log reads `input.dock: 2 entries mounted` with **no**
   "boundary fallback active" line; the strip is visible.
4. Paste a file: the chip rail appears above the composer (and re-paste/remove cycles keep it
   rendered), while the attach button stays in `input.left`.
5. Negative check: F12 console shows zero render errors after paste and after a session switch
   (the boundary resets on session switch — confirm no stale fallback state).

**Regression the verification must cover for plugin B specifically:** plugin B must work in both
co-tenancy states, proving the original failure was neighbor-induced and stays fixed:

- With plugin A **enabled**: chips render, add/remove chip works, and no A-side error blanks the
  dock (this is the regression that occurred — B's dock entry silently unmounting due to a
  co-tenant crash).
- With plugin A **disabled** again (or after a future A-side regression): chips still render —
  confirming B has no hidden dependency on A and that B's chips disappearing is never again the
  first symptom of someone else's bug.
- B's chip rail across a session switch (its slot scope is session), and B's own
  try/catch in the fold scan logging nothing unexpected.

Since B uses no standard-kit hooks, its regression suite needs no alpha.2 contract changes — but
the verification must assert that fact stays true (its dock component imports no
`useSession*` kit member), otherwise B inherits exposure to the next kit reduction.
