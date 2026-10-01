# S24 · The Dock That Vanished Together — Analysis Report

## 1. Culprit attribution

**The failing plugin is A (the session-progress plugin), at the exact call
`useSessionPendingInteraction(...)` inside `SessionProgressBar`.**

Evidence chain:

- The console shows exactly **one** render error:
  `Uncaught TypeError: useSessionPendingInteraction is not a function`,
  thrown from `SessionProgressBar` (plugin A's `client.js:219`). Plugin B's
  name appears nowhere in the error.
- Comparing the two sealed contracts: alpha.1's `SessionStandardProps`
  includes `useSessionPendingInteraction`; alpha.2's contract **removed** it
  and replaced it with `useSessionStatus` (per-session status including
  `pendingInteraction`) plus a new `useSessionRetainInfo`. This is the
  multi-instance refactor outcome noted in the alpha.2 header.
- Plugin A's component destructures `useSessionPendingInteraction` from the
  standard kit and calls it unconditionally. On alpha.2 the shell no longer
  supplies that prop, so it is `undefined`, and calling `undefined(...)`
  is exactly the TypeError in the console. The call happens during render of
  `<SessionProgressBar>`, before any output — so the entire strip dies, not
  just the attention-state feature that needed the hook.

**Why the innocent co-tenant disappears — the mechanism.** The
`conversation.input.dock` slot is a **list slot**: plugin B's chip rail
(`dsh-paste-input-dock`, order 5) and plugin A's strip (`progress`,
order 20) mount as sibling `<DockEntry>` children **inside one shared
`DrawerErrorBoundary` named "input.dock"**. That boundary is a standard
React class boundary whose fallback is `null` — when any child throws,
React unmounts the **entire subtree under the boundary** and renders the
fallback. One crashing entry therefore takes down every co-tenant in the same
slot drawer. The console confirms it:
`input.dock boundary fallback active …; unmounted entries:
dsh-paste-input-dock, progress`.

**Why the attach button survives while the chips do not.** Plugin B's attach
button lives in a **different slot**, `conversation.input.left`, which the
shell wraps in its **own** `DrawerErrorBoundary` (`name="input.left"`).
Isolation is per boundary, and boundaries are per slot drawer — not per entry
and not per plugin. The crash in `input.dock` never reaches the
`input.left` boundary, so `dsh-paste-input-button` keeps rendering
(`input.left: 1 entry mounted`), while the chips — same plugin, wrong
neighbor — are collateral damage of plugin A's crash in the shared
`input.dock` boundary. Note the asymmetry is not about plugin B at all: it
has two entries, and only the one sharing a drawer with plugin A died.

## 2. The experiment

The maintainer's control experiment (disable plugin A → chips return
immediately; re-enable → chips gone again) is decisive for exactly three
propositions:

1. **Plugin A's presence causes plugin B's dock-entry symptom.** The chips
   render fine on alpha.2 when A is absent, so the host upgrade did not break
   plugin B's dock entry; the disappearance is caused at render time by A's
   crash blowing through the shared `input.dock` error boundary.
2. **The failure is deterministic and correlated**, not a race or flake —
   it toggles perfectly with A's enabled state.
3. **The console's single error is the whole story for the dock**: the stack
   (`SessionProgressBar → DockEntry → DrawerErrorBoundary → InputDock`)
   matches the boundary-unmount mechanism exactly.

What it does **not** prove:

- It does **not** prove plugin B is bug-free on alpha.2 in general. B's
  `AttachmentChips` uses no standard-kit hooks, so the alpha.1→alpha.2 kit
  reduction could not have broken it — but the experiment only exercises
  B's dock entry and paste path. B's other surfaces (the attach button's
  actual pick-a-file flow, upload logic, anything not rendered during the
  experiment) are untested, and B could still carry latent alpha.2
  incompatibilities invisible in this scenario.
- It does **not** prove the strip crash is the *only* dock problem: the
  experiment never verified the remaining `...` dock entries (from the
  render tree) render correctly under alpha.2, nor that A's other
  registrations are fine. It only shows that removing A removes the dock
  symptom observed.

**Why reinstalling plugin B could never help:** plugin B's files were never
the problem. Its dock entry registers successfully (registration code runs,
its own try/catch logged nothing), and its component renders fine the moment
A is gone. Reinstalling re-delivers identical code that was already working;
the breakage enters from outside B — through the shared error boundary — at
render time. No amount of reinstalling B changes what A's component does to
the shared `input.dock` subtree.

**What is wrong with the colleague's "both plugins were hit" theory:** it
predicts two independent breakages from a slot-prop change. But the console
shows exactly **one** error, in plugin A only; the diff between the
contracts removed one hook that only A uses (`useSessionPendingInteraction`);
B's dock entry consumes **no** standard-kit props, so no prop removal could
touch it; and the experiment shows B's symptom vanishes when A is disabled —
a dependent, not independent, failure. "Hit twice by the same reduction" is
falsified by all three signals. The correct model is one breakage (A) plus
one blast radius (B's co-tenant entry).

## 3. The fix

Plugin A must stop calling the removed hook unconditionally and derive the
pending state from the alpha.2 replacement. On alpha.2, **`useSessionStatus`**
supplies the pending state: it maps `SessionId → SessionStatus`, where each
status carries `pendingInteraction`. Graceful degradation: if the host
supplies **neither** `useSessionStatus` (older/future host) **nor**
`useSessionPendingInteraction` (alpha.1-era host), the strip still renders —
running state, todos percent, token chip, elapsed/ETA, subagent running
count all keep working — but the **attention/pending indicator** (the
`data-pending` highlight and pending-kind text driven by own pending waits
and subagent approvals/questions) degrades to "never pending".

```tsx
export function SessionProgressBar({
  session, sessionId, t, useConversation, useProjection, useSessions,
  // alpha.2 standard kit (successor to useSessionPendingInteraction)
  useSessionStatus,
  // alpha.1 kit, kept only as a fallback for older hosts
  useSessionPendingInteraction,
}: SessionProgressBarProps) {
  if (session === undefined || session === null) return null
  const chat = useConversation(conversation => conversation.views.get('chat'))
  const legacy = chat?.legacy ?? EMPTY_LEGACY
  const todos = useProjection('todos')
  const toolName = runningTool(legacy)
  const running = session.running

  // Pending map source differs by host generation: alpha.2 folds pending
  // waits into per-session status; alpha.1 exposed them directly. Absent
  // both, attention state degrades to none — never throw from a dock entry.
  let pendingBySession: ReadonlyMap<SessionId, SessionPendingInteraction> = EMPTY_PENDING
  if (typeof useSessionStatus === 'function') {
    const status = useSessionStatus(m => m.get(sessionId))
    if (status?.pendingInteraction) pendingBySession = new Map([[sessionId, status.pendingInteraction]])
  } else if (typeof useSessionPendingInteraction === 'function') {
    pendingBySession = useSessionPendingInteraction(interactions => interactions)
  }
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
```

(One refinement for full parity: on the alpha.2 branch, subagent pending
counts would ideally walk `useSessionStatus` for all sessions rather than a
single-session lookup; the excerpt's `subagentPendingState` signature is
kept above so degradation is contained to the map's source. The essential
points are: prefer `useSessionStatus`, fall back to
`useSessionPendingInteraction`, and default to an empty map.)

**Why the degradation must be silent rather than throwing:** this component
renders inside a **shared** drawer error boundary whose fallback is `null`.
A throw here does not just blank the strip — it unmounts every co-tenant in
`conversation.input.dock` (as this incident proved). A dock tenant's
failure mode must be "my least-critical feature is absent", never "the whole
drawer is gone"; a missing pending highlight is cosmetic, a vanished drawer
is a multi-plugin outage. Guarded `typeof` checks make the component
forward- and backward-compatible without any throw.

## 4. Multi-tenant hygiene

**What a dock tenant should do:**

- Never call a standard-kit hook unconditionally; feature-detect props that
  came from a newer or older host generation and degrade silently (as above).
- Wrap its own entry body in a **local error boundary** (or keep its render
  total) so its own crashes render `null` for *itself* instead of reaching
  the shared drawer boundary. At minimum: derive before render, guard every
  optional-kit call, and treat "render nothing" as the terminal failure mode.
- Keep registrations resilient: a registration-time failure should disable
  its own entry only.

**What the host could change:** insert an **error boundary per
`DockEntry`** (or per entry group) inside each list-slot drawer, instead of
one boundary around the whole `InputDock` list. Then an entry's throw
isolates to that entry: React unmounts only the failing `DockEntry` and
renders its per-entry fallback (`null` or a small placeholder), while
siblings keep mounting. `DockEntry` "adds no boundary of its own" today —
that is the one-line structural fix.

**The trade-off for the host:** granularity vs. failure visibility and layout
semantics. Per-entry boundaries mean one broken entry no longer hides its
neighbors, but also that a crash can go *partially* unnoticed — the drawer
still looks healthy minus one widget, and silent `null` fallbacks make
broken plugins harder to spot than an entire (obviously missing) drawer.
Per-entry boundaries also add wrapper components (slight overhead, more
DevTools noise), and the host must decide whether a crashing entry should
render a placeholder (preserving layout/order) or nothing (risking layout
shift). Boundary-per-drawer fails loud and fails big; boundary-per-entry
fails small and fails quiet. A reasonable middle ground: per-entry boundary
plus a host-side log/telemetry line (like the existing `[dsh:slots]` lines)
naming the isolated entry.

## 5. Verification

**Restore both entries without a host restart:** external client plugins are
hot-reloadable through the client-plugin channel. Disable → re-enable plugin
A in the plugin list (or touch its junction / save its manifest so the HMR
receiver picks it up), then hard-refresh the page. The already-running host
does not need a restart — only the client bundle changes. Check, in order:

1. **Console clean**: no `TypeError`; `[dsh:slots] input.dock: 2 entries
   mounted (dsh-paste-input-dock, progress)` (or equivalent) — both entries
   mounted, no `boundary fallback active` line.
2. **Plugin A's strip** renders: running state, todos percent, token chip,
   elapsed/ETA — and, on alpha.2, the pending indicator lights up while a
   session awaits approval (exercising the `useSessionStatus` path).
3. **Plugin B's chips**: paste a file → chip rail renders above the composer;
   attach button still present; remove-chip still works. Confirm this
   **with plugin A enabled** — that is the configuration that previously
   killed the chips.
4. **Cross-host degradation check for A**: if an alpha.1 host (or a host
   stub without both hooks) is available, confirm the strip renders minus
   the pending highlight and throws nothing.

**The plugin-B-specific regression to cover:** plugin B was never broken, so
the regression is *collateral-susceptibility*, not function. Verify that when
**any** dock co-tenant throws (simulate by temporarily mounting a throwing
test entry into `conversation.input.dock`), plugin B's chips are **not**
lost while the attach button keeps working — i.e., re-test B under the exact
failure class that hid it. On the current host this documents the known
shared-boundary limitation (chips will vanish — record it as the reason to
push for per-entry boundaries); once per-entry boundaries exist, this test
must pass with chips surviving a neighbor's crash. Additionally confirm B's
own entry still renders when plugin A is absent (the experiment's state) so
the fix's verification matrix is: {A enabled, A disabled} × {B chips, B
button, A strip} all as expected.
