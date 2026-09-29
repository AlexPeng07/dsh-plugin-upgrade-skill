# S24 · The Dock That Vanished Together — Diagnosis Report

**Corridor**: `dsh-v0.1.6-alpha.1 → dsh-v0.1.6-alpha.2` (npm global, in place, Windows web profile).
**Skill mode**: A · inspect (read-only diagnosis; the corrected code below is a proposed patch for plugin A’s repository, not applied here).
**Evidence**: fixture pack only (both plugins’ full repositories unavailable).

---

## 1. Culprit attribution

### Who fails, where, and why now

**Plugin A (the session-progress plugin, `dsh-ui-progress`) fails**, inside its dock entry
component `SessionProgressBar`, at the exact call:

```ts
const pendingBySession = useSessionPendingInteraction(interactions => interactions)
```

The console shows exactly one render error and it names the culprit precisely:

```
Uncaught TypeError: useSessionPendingInteraction is not a function
    at SessionProgressBar (plugin://dsh-external/dsh-ui-progress/lib/client.js:219:41)
```

Why now: comparing the two sealed slot contracts, the standard kit handed to every
+`conversation.input.dock` entry changed between the host versions. At
**alpha.1** (`slots-contract-alpha1.d.ts`) the kit included:

```ts
useSessionPendingInteraction: SnapshotSelectorHook<ReadonlyMap<SessionId, SessionPendingInteraction>>;
```

At **alpha.2** (`slots-contract-alpha2.d.ts`) that hook is gone. The multi-instance
Session refactor replaced it with two successors:

```ts
useSessionStatus: SnapshotSelectorHook<ReadonlyMap<SessionId, SessionStatus>>;   // per-session status: running, completionUnread, pendingInteraction
useSessionRetainInfo: UseSessionRetainInfo;                                     // reference counts, e.g. retainedBy.mainView
```

So on the alpha.2 host, plugin A receives slot props whose destructured
+`useSessionPendingInteraction` is `undefined`; calling it throws a `TypeError`
during render. This matches the skill’s 0.1.6-alpha.2 card set (`GlobalStandardProps`
swaps `useSessionPendingInteraction` for `useSessionStatus` + `useSessionRetainInfo`,
while `useSessions` stays — note plugin A’s other hook, `useSessions`, did *not* break,
which is why the component mounted far enough to crash at this one call).
It is a source-level incompatibility: nothing about plugin A’s *installation* changed.

### Why the innocent co-tenant’s dock entry vanishes with it

**Mechanism: a shared React error boundary at the slot level.** Per
+`dock-render-tree.md`, the alpha.2 conversation package mounts the entire
+`conversation.input.dock` list — plugin B’s `AttachmentChips` (`DockEntry id="dsh-paste-input-dock"`, order 5)
and plugin A’s `SessionProgressBar` (`DockEntry id="progress"`, order 20) — as sibling
children under **one** `DrawerErrorBoundary name="input.dock"`:

```
<InputDock>
  <DrawerErrorBoundary name="input.dock">
    <DockEntry id="dsh-paste-input-dock" />   (plugin B)
    <DockEntry id="progress" />               (plugin A)
```

+`DockEntry` itself "adds no boundary of its own". React error boundaries catch errors
from **all** children in their subtree, not just the offending one, and the boundary’s
+`getDerivedStateFromError` fallback renders `null` — i.e. when plugin A’s component
throws, the boundary unmounts the **whole dock list**, taking plugin B’s perfectly
healthy chips rail down with it. The console confirms this exactly:

```
[dsh:slots] input.dock boundary fallback active (session s-7f3a); unmounted
            entries: dsh-paste-input-dock, progress
```

Both dock entries are listed as unmounted — collateral damage included.

### Why the attach button survives while the chips do not

The attach button lives in a **different slot with its own separate boundary**:
+`conversation.input.left` renders under `DrawerErrorBoundary name="input.left"`,
a sibling subtree of the dock (`<InputLeft>` vs `<InputDock>` under `<Composer>`).
Plugin A’s crash is contained inside the `input.dock` boundary and never reaches the
+`input.left` subtree, so `dsh-paste-input-button` keeps mounting:

```
[dsh:slots] input.left: 1 entry mounted (dsh-paste-input-button)
```

The isolation boundary is the per-slot `DrawerErrorBoundary`, not the per-entry level —
same plugin (B), different slot, different fate. That asymmetry (button alive, chips dead)
is itself diagnostic: it rules out plugin B failing as a whole and points at the one slot
it shares with plugin A.

---

## 2. The experiment

### What the disable-experiment proves

With plugin A disabled and the page refreshed, plugin B’s chips render immediately;
re-enabling A removes them again. This is a clean A/B control on the single variable
"plugin A present":

1. **It proves plugin A’s presence is sufficient to suppress plugin B’s dock entry** on
   the alpha.2 host — and, combined with the single console error inside plugin A’s
   component, that the causal chain is: A’s `useSessionPendingInteraction` call throws →
   the shared `input.dock` `DrawerErrorBoundary` falls back to `null` → every entry in
   that slot, including B’s chips, unmounts.
2. It also proves plugin B’s dock registration and render *do work* on alpha.2 when the
   slot is healthy (the entry mounts and renders chips) — the paste toast and attach
   button already showed B’s non-dock logic works.

### What it does NOT prove

- **It does not prove plugin B is fully bug-free on alpha.2.** It only exercises B’s dock
  entry render in A’s absence. B’s other surfaces (the attach button slot, paste
  interception, chip *removal* actions, its injector wiring under concurrent sessions)
  are untouched by this experiment, and silent (non-throwing) misbehavior would not be
  caught either way. "Renders once with A off" ≠ "migrated and verified".
- **It does not prove the strip crash is the ONLY dock problem.** It proves A is the only
  *error-throwing* problem currently observed. The boundary masks everything beneath it:
  any second dock entry that fails *silently* (renders `null`, mis-renders, or fails
  without throwing — like B’s own try/catch swallowing its fold scan) would be invisible
  both with and without A. "Exactly one F12 error" counts throwing crashes, not all
  defects. Only a check with the fixed plugin A — every dock entry expected to be
  present actually visible — can close that.

### Why reinstalling plugin B could never have helped

Plugin B was never failing. Its dock entry registers, its code path throws nothing, and
it uses **no standard-kit hooks at all** ("It reads only its own injected state … uses NO
standard-kit hooks"). The alpha.2 contract change is therefore orthogonal to B: no matter
how many times B is reinstalled, plugin A still crashes on the removed
+`useSessionPendingInteraction` prop and the shared boundary still unmounts B’s entry.
Reinstalling B changes the victim, not the shooter.

### What is wrong with the colleague’s "both plugins were hit" theory

The theory predicts two independent failures from the props change. The evidence
contradicts every prediction:

- **One error, not two.** F12 shows exactly one render error and it is inside plugin A’s
  component; plugin B logs nothing (its try/catch caught nothing).
- **B does not consume the changed surface.** B’s dock entry uses none of the standard
  kit, so no removed prop can hit it — there is nothing in B to "get hit twice" with.
- **The dependency is causal, not coincidental.** Disabling A *alone* restores B — two
  independent breakages would both persist independently of each other. Disabling one
  victim’s "failure" cannot repair a genuinely broken second plugin.
- The observation "the attach button still renders" further shows B’s code runs fine on
  alpha.2 wherever it isn’t sharing A’s boundary.

"Fix both plugins’ slot registrations" would waste effort on B and, worse, leave the real
defect (A’s crash and the shared-boundary blast radius) "fixed" only by luck of ordering.

---

## 3. The fix (plugin A source, graceful degradation)

Corrected `SessionProgressBar`: resolve the pending state from the alpha.2 hook
(`useSessionStatus` — its `SessionStatus` carries `pendingInteraction`), degrade
gracefully when the host supplies neither hook, and never throw from a prop-shaped
mismatch.

```tsx
/**
 * SessionProgressBar (fixed): alpha.2 host compatibility with graceful
 * degradation of the pending-attention feature only.
 */
export type SessionProgressBarProps =
  import('@deepseek-ai/dsh-client-ui-slots').PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'progress'>

export function SessionProgressBar({
  session, sessionId, t, useConversation, useProjection, useSessions,
  useSessionStatus,
}: SessionProgressBarProps) {
  if (session === undefined || session === null) return null
  const chat = useConversation(conversation => conversation.views.get('chat'))
  const legacy = chat?.legacy ?? EMPTY_LEGACY
  const todos = useProjection('todos')
  const toolName = runningTool(legacy)
  const running = session.running
  // ... percent / turn / elapsed / eta derivation unchanged ...

  // Attention state. alpha.2 supplies per-session status whose SessionStatus
  // carries `pendingInteraction`; alpha.1 supplied the dedicated
  // useSessionPendingInteraction map. Resolve whichever the host provides and
  // degrade to "no pending signal" on hosts that supply neither.
  const statusBySession = useSessionStatus
    ? useSessionStatus(s => s)
    : EMPTY_MAP
  const pendingBySession: ReadonlyMap<SessionId, SessionPendingInteraction> =
    useSessionStatus
      ? /* derive the legacy view from the status map */
        derivePendingFromStatus(statusBySession)
      : EMPTY_MAP
  const ownPending = pendingKindOf(pendingBySession.get(sessionId)?.kind)
  const subPending = subagentPendingState(
    useSessions(s => s.byId), pendingBySession, sessionId)
  const pending = ownPending !== null || subPending.approvals > 0 || subPending.questions > 0

  // Background state (unchanged; useSessions exists on both hosts):
  const subRunning = subagentRunningCount(useSessions(s => s.byId), sessionId)

  return (
    <div className={css.bar} data-pending={pending || undefined}>
      {/* state text, fill bar, todos percent, token chip, elapsed/eta */}
    </div>
  )
}
```

(If the corridor must run on both tags from one build, the alpha.1 prop
+`useSessionPendingInteraction` is destructured too and selected as the fallback:
+`useSessionStatus ? deriveFromStatus(...) : (useSessionPendingInteraction ? useSessionPendingInteraction(m => m) : EMPTY_MAP)`.
At runtime the props object carries one or the other; feature-detect, don’t version-sniff.)

**Which hook supplies the pending state on alpha.2**: `useSessionStatus` — per its
contract comment, `SessionStatus` includes `pendingInteraction` alongside `running`
and `completionUnread`. `useSessionRetainInfo` is for reference counts
(`retainedBy.mainView`) and plays no part here.

**What degrades on a host supplying neither pending hook**: only the
*pending-attention* feature — the `data-pending` highlight, the own-session pending
kind, and the subagent-subtree pending approvals/questions surfacing (which the strip
exists to surface because the sidebar hides subagent rows). Everything else keeps
working: running state, subagent background-running count (via `useSessions`, present on
both hosts), todos percent, token chip, elapsed/ETA, and the whole strip’s render.

**Why the degradation must be silent rather than throwing**: this component renders
inside a **shared** slot boundary. A throw does not fail one strip — `DrawerErrorBoundary
name="input.dock"` falls back to `null` and unmounts **every co-tenant** of the dock
(this incident’s second symptom). A missing optional capability in the kit is not an
exceptional condition worth destroying the drawer for; rendering the strip without one
feature is strictly better than rendering nothing at all for every dock entry. (If
absence must be observable, log once via a non-rendering channel — never throw from
render.)

---

## 4. Multi-tenant hygiene

### What a dock tenant should do

1. **Never assume optional standard-kit members exist.** Feature-detect hooks on the
   props object (`if (props.useX)`) and degrade per-feature, as in §3. Treat the kit as
   merge-extensible: members come and go across host versions.
2. **Wrap your own entry in an error boundary.** Before registering into a *list* slot
   shared with strangers, mount a small boundary around your own subtree so your crash
   renders your fallback (or `null`) without invoking the slot-level boundary.
3. **Never throw from render for missing data/capabilities** — render a reduced UI.
   Reserve throwing for genuine invariant violations, and even then prefer logging.
4. **Keep render robust against props you don’t control**; a crash in a list-slot
   entry is a cross-tenant outage by default.
5. **Smoke-test against the newest host corridor cards** (here: the alpha.2
   `GlobalStandardProps` swap) before upgrading a production profile — the removal was
   documented in the corridor reference; the crash was preventable.

### What the host could change

Mount an error boundary **per `DockEntry`** (inside the entry wrapper), so one entry’s
failure falls back to `null` for that entry alone; keep the per-slot
+`DrawerErrorBoundary` as a last-resort outer layer. `dock-render-tree.md` explicitly
notes "DockEntry itself adds no boundary of its own" — adding one localizes the blast
radius to the offending tenant.

**The trade-off the host faces**: per-entry isolation buys fault isolation (one bad
plugin can no longer vanish its co-tenants — exactly this incident) at the cost of
(a) **observability and UI coherence**: a crashed entry silently becomes `null`, so a
broken plugin is easier to miss and the dock silently loses furniture, whereas a
whole-drawer fallback is loud and obvious; (b) **more components/state and render
overhead** — one boundary class instance per entry in every hot list slot; and
(c) losing the current simple, coordinated fallback semantics ("reset the whole drawer
on session switch"). The host can mitigate (a) by emitting a telemetry/console event
naming the failed entry when a boundary engages — but the fundamental tension is
isolation granularity vs. visibility and per-entry overhead.

---

## 5. Verification

The fix is entirely in plugin A’s **client** bundle, so **no host restart is needed**:
rebuild plugin A’s client artifact, make sure the junction-linked profile tree picks it
up, then hard-refresh the browser. Confirm the served
+`plugin://dsh-external/dsh-ui-progress/lib/client.js` carries the new code (DevTools
sources) before judging the result.

1. **Plugin A restored**: with BOTH plugins enabled, hard-refresh. The progress strip
   renders in the dock; F12 shows **zero** render errors; the
   `[dsh:slots] input.dock boundary fallback active` line does not appear.
2. **Plugin B restored in the same pass** (the co-tenant regression): paste/drop a file →
   the chip rail renders above the composer — B’s recovery is the direct proof that
   A’s crash, not B, caused the vanished chips. Confirm all three entries mount:
   `dsh-paste-input-button` (input.left), `dsh-paste-input-dock` and `progress`
   (input.dock).
3. **Degradation path**: on the alpha.2 host the pending highlight should now derive
   from `useSessionStatus` — trigger a pending interaction (e.g. an approval request) in
   the main session and in a subagent and confirm `data-pending` lights up; on a host
   supplying neither pending hook, confirm the strip still renders minus the pending
   highlight, with no console error.

**Regression coverage required for plugin B specifically**: B was the collateral victim,
so the regression is "B’s dock entry survives a co-tenant’s crash": (a) with A enabled
and *fixed* — paste shows chips (step 2); (b) re-introduce a deliberately throwing entry
into `conversation.input.dock` (a scratch test plugin) and confirm that, on the current
host, B’s chips again disappear with it — documenting that until the host adopts
per-entry isolation, any dock co-tenant’s crash still takes B’s rail down (the §4
hazard); after such a host change, the same test must show only the bad entry vanish
while B’s chips and A’s strip stay mounted. Also re-verify B’s own flows on alpha.2
(paste interception, chip add/remove actions, toast), since §2 established those were
never actually exercised under the broken state.
