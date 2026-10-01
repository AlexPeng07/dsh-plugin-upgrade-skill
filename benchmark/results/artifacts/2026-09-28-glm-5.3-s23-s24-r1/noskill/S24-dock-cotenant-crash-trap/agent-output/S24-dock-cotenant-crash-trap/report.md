# S24 · The Dock That Vanished Together — Analysis Report

## 1. Culprit attribution

**The failing plugin is plugin A (the session-progress plugin), and the failing call is:**

```
const pendingBySession = useSessionPendingInteraction(interactions => interactions)
```

inside `SessionProgressBar` (plugin://dsh-external/dsh-ui-progress/lib/client.js:219), called during render as a hook.

**Why now.** Comparing the two sealed contracts:

- `slots-contract-alpha1.d.ts` declares `useSessionPendingInteraction: SnapshotSelectorHook<ReadonlyMap<SessionId, SessionPendingInteraction>>` in `SessionStandardProps`.
- `slots-contract-alpha2.d.ts` **removes it**. Its successor is `useSessionStatus: SnapshotSelectorHook<ReadonlyMap<SessionId, SessionStatus>>`, whose doc comment reads "Per-session status: running, completionUnread, **pendingInteraction**" — the pending-interaction data moved into the per-session status map as part of the multi-instance refactor noted in the alpha.2 header.

Plugin A still destructures `useSessionPendingInteraction` from the standard kit. On alpha.2 that property no longer exists, so the destructured binding is `undefined`, and calling it throws exactly the observed error:

```
Uncaught TypeError: useSessionPendingInteraction is not a function
    at SessionProgressBar (plugin://dsh-external/dsh-ui-progress/lib/client.js:219:41)
```

This is the **single** render error F12 shows — nothing in plugin B's code path ever throws.

**Why the innocent co-tenant's dock entry disappears too.** The mechanism is the **shared React error boundary per slot drawer**:

- Per `dock-render-tree.md`, both dock entries — plugin B's `<DockEntry id="dsh-paste-input-dock" />` (order 5) and plugin A's `<DockEntry id="progress" />` (order 20) — mount as siblings **inside one** `<DrawerErrorBoundary name="input.dock">`. `DockEntry` itself adds no boundary of its own.
- `DrawerErrorBoundary` is a standard class boundary whose fallback is `null`. When plugin A's component throws mid-render, the error propagates up to that single boundary, which renders `null` — unmounting the **entire drawer**, including the already-mounted (or about-to-mount) chips entry. The console confirms it: `[dsh:slots] input.dock boundary fallback active … unmounted entries: dsh-paste-input-dock, progress`.
- The attach button survives because it lives in a **different slot with its own boundary**: `<InputLeft><DrawerErrorBoundary name="input.left"><SlotEntry id="dsh-paste-input-button" /></DrawerErrorBoundary></InputLeft>`. The input.dock crash never crosses into that subtree, which is why `[dsh:slots] input.left: 1 entry mounted`.

So plugin B loses only the surface it shares the crashing drawer with — its chips rail — and keeps the surface in the isolated drawer. The disappearance of the chips is collateral damage of plugin A's crash, not a second failure.

## 2. The experiment

The maintainer's experiment (disable plugin A → refresh → **plugin B's chips come back immediately**; re-enable A → chips gone again) is a clean A/B control on the single variable "plugin A loaded". It proves:

- **Causation, not correlation**: plugin A's presence is *sufficient* to break plugin B's dock entry and its absence is sufficient to restore it. Combined with the single stack trace pointing at plugin A's `SessionProgressBar` and the boundary-fallback log, the chain "A throws → shared `input.dock` boundary renders null → B's chips unmount" is established.

What it does **not** prove:

- **It does not prove plugin B is bug-free on alpha.2.** It only proves B's dock entry renders when A is absent. Plugin B's other behavior on alpha.2 (paste interception edge cases, chip interactions, drop handling, its `conversation.input.left` button semantics under the new kit) is untested by this experiment. B merely *appears* healthy because it uses no standard-kit hooks in the chips path — the removed prop could not have hit it.
- **It does not prove the strip crash is the ONLY dock problem.** The experiment tested only {A on, B on} and {A off, B on}. It says nothing about the *other* entries elided as `...` in the render tree, nor whether B (or any third plugin) would fail under conditions the experiment didn't exercise (e.g. after a session switch, when the boundary resets, or with an empty dock). "Exactly one console error" is evidence about this one paste attempt, not an exhaustive audit of the drawer.

**Why reinstalling plugin B could never help:** plugin B was never broken. Its bits on disk are identical before and after reinstall; the failure lives in plugin A's component crashing against the alpha.2 standard kit, and the blast radius is the shared boundary. Reinstalling the victim does nothing about the grenade.

**What is wrong with the colleague's "both plugins were hit" theory:** it predicts two independent failures from a removed prop. But (a) the console shows exactly **one** error, and its stack names plugin A's component only; (b) per `plugin-b/dock-entry-excerpt.md`, `AttachmentChips` uses **no standard-kit hooks at all** — it reads only its own injected state — so a removed standard prop *cannot* break it by definition; (c) the control experiment shows B renders perfectly the moment A is gone, which is incompatible with "B was also hit". The correct model is one crash with a two-slot blast radius bounded by the shared boundary, not two crashes.

## 3. The fix (plugin A, graceful degradation)

On alpha.2, the pending state is supplied by **`useSessionStatus`** — each `SessionStatus` in the map carries `pendingInteraction`. The fix guards the hook: use whichever seat the host provides, and degrade when neither exists.

```tsx
/**
 * SessionProgressBar — alpha.2-compatible with graceful degradation.
 * Pending data moved from useSessionPendingInteraction (alpha.1) into
 * useSessionStatus's per-session SessionStatus.pendingInteraction (alpha.2).
 * Destructure both optionally; a host that supplies neither still gets the
 * strip, just without attention highlighting.
 */
export type SessionProgressBarProps =
  import('@deepseek-ai/dsh-client-ui-slots').PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'progress'>

export function SessionProgressBar({
  session, sessionId, t, useConversation, useProjection, useSessions,
  useSessionStatus,
  useSessionPendingInteraction,
}: SessionProgressBarProps) {
  if (session === undefined || session === null) return null
  const chat = useConversation(conversation => conversation.views.get('chat'))
  const legacy = chat?.legacy ?? EMPTY_LEGACY
  const todos = useProjection('todos')
  const toolName = runningTool(legacy)
  const running = session.running
  // ... percent / turn / elapsed / eta derivation unchanged ...

  // Attention state: alpha.2 seat is useSessionStatus(status.pendingInteraction);
  // alpha.1 seat is useSessionPendingInteraction. Degrade silently when absent.
  const pendingBySession: ReadonlyMap<SessionId, { kind: unknown }> =
    typeof useSessionStatus === 'function'
      // map statuses to the pending-interaction view the rest of the strip reads
      ? useSessionStatus(byId => {
          const out = new Map<SessionId, { kind: unknown }>()
          for (const [id, status] of byId) {
            const pending = status.pendingInteraction
            if (pending !== undefined) out.set(id, pending)
          }
          return out
        })
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
```

```ts
const EMPTY_PENDING: ReadonlyMap<SessionId, { kind: unknown }> = new Map()
```

- **Which hook supplies pending on alpha.2:** `useSessionStatus` — `SessionStatus` carries `pendingInteraction` per the alpha.2 contract ("running, completionUnread, pendingInteraction").
- **What degrades on a host supplying neither pending hook:** only the *attention/pending highlight* — the `data-pending` indicator and the subagent approval/question surfacing (the strip's reason for surfacing what the sidebar hides). Everything else keeps working: running state, fill bar, todos percent, token chip, elapsed/ETA — none of those depend on the pending map.
- **Why the degradation must be silent rather than throwing:** this component renders inside a **shared** error boundary (`DrawerErrorBoundary name="input.dock"`) whose fallback is `null`. A throw does not blank one strip — it unmounts every co-tenant entry in the drawer (as this very incident proved with plugin B's chips). A slot tenant must treat "host feature absent" as "render without that feature", never as an exception; the whole point of the fix is to shrink the blast radius of a missing seat to zero.

## 4. Multi-tenant hygiene

**What a dock tenant should do (defense in depth, its own crash must not eat co-tenants):**

1. **Never call destructured standard-kit props unguarded.** Any hook/prop from the host kit can be removed by a host upgrade; guard with `typeof x === 'function'` (or feature-detect the seat) and degrade gracefully, as in §3.
2. **Wrap its own entry render in a local error boundary** (component-level boundary inside the registered component, falling back to `null` or a minimal degraded UI) so its own residual bugs stop at its own `DockEntry` instead of reaching the drawer's shared boundary.
3. Keep render logic pure and side-effect-light; validate assumptions about host state (e.g. `session` null) early and return `null`, not throw.

**What the HOST could change:** give **each `DockEntry` its own error boundary** (wrap each entry individually inside the dock list), so one entry's render failure unmounts only that entry; the drawer and its co-tenants keep rendering. Optionally log per-entry failures so a silent per-entry fallback is still diagnosable (a single console line like the existing `[dsh:slots]` messages).

**The host's trade-off:** per-entry isolation buys fault isolation (one bad plugin cannot take down the whole composer dock) at the cost of **failure visibility and layout semantics**. With one shared boundary, a crash is loud and obvious — the whole drawer vanishes, guaranteeing the maintainer notices; with per-entry boundaries, a crashing entry quietly disappears among healthy siblings and can go unnoticed (or be mistaken for "the plugin was removed"). The host must compensate with explicit per-entry error reporting, and accepts N boundaries' worth of state/reset complexity (boundary resets on session switch, retry semantics) instead of one. There is also a semantic question: a dock whose entries fail independently may render a half-broken composer (e.g. chips gone but strip alive), which can be more confusing than an all-or-nothing drawer.

## 5. Verification

**Restoring both entries without a host restart** — client plugins are junction-linked external plugins; on the web profile a rebuild + hard refresh of the page suffices (no `dsh` host restart needed, since the fix is in plugin A's client bundle, not host code):

1. Apply the §3 fix to plugin A's source and rebuild its client bundle (the junction link picks it up).
2. Hard-refresh the web GUI (the client re-resolves `plugin://dsh-external/...` bundles).
3. Confirm **both** symptoms are gone: (a) the session-progress strip renders in the dock (with running state, todos percent, tokens); (b) paste a file and confirm the chips rail renders above the composer.
4. Confirm the console is clean: no `useSessionPendingInteraction is not a function`, and `[dsh:slots]` logs show `input.dock` mounting **both** `dsh-paste-input-dock` and `progress` (no "boundary fallback active").
5. Check attention highlighting specifically: trigger a pending interaction (e.g. an approval request) in this session and in a subagent, and confirm the strip's `data-pending` still lights — this proves the alpha.2 `useSessionStatus` seat actually supplies the pending data, not just that the crash is gone.
6. Optional negative check: temporarily point plugin A at a stub host kit with neither pending hook and confirm the strip still renders, minus the pending highlight (the degradation path).

**Regression coverage required for plugin B specifically:** the chips rail never had a code fix — its loss and recovery were entirely mediated by plugin A and the shared boundary. So the verification must pin B's *collateral* behavior as a regression guard:

- **The co-tenancy regression:** with plugin A enabled (fixed) AND pasting a file, B's chips render. This is the case that was broken; a future regression of plugin A (or of the host boundary layout) would silently re-break B while B's own code and tests stay green.
- **Cross-slot independence:** the attach button in `conversation.input.left` keeps rendering in both states (A enabled/disabled), pinning the isolation boundary between the two drawers.
- **Boundary-fallback recovery:** if any dock entry still crashes (e.g. inject a deliberate throw in a test plugin), verify what unmounts — today the whole drawer — so the host's isolation semantics are covered by a test rather than discovered in production.
- B's own paste→chip flow (intercept, chip render, remove) on alpha.2, since the disable-experiment never validated B beyond "entry mounts".
