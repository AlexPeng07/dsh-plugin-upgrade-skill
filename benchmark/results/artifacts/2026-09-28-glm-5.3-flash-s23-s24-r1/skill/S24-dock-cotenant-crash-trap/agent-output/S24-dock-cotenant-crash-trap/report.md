# S24 · The Dock That Vanished Together — Diagnostic Report

Skill: plugin-upgrade, Mode A (read-only inspection and report). Corridor: dsh 0.1.6-alpha.1 → 0.1.6-alpha.2; see skill reference `references/v0.1.6-alpha.2.md` (card: `GlobalStandardProps` swaps `useSessionPendingInteraction` for `useSessionStatus` + `useSessionRetainInfo`, while `useSessions` stays).

## 1. Culprit attribution

**The failing plugin is plugin A (dsh-ui-progress), and the exact failing call is `useSessionPendingInteraction(...)` inside `SessionProgressBar`.**

The console shows exactly one render error:

```
Uncaught TypeError: useSessionPendingInteraction is not a function
    at SessionProgressBar (plugin://dsh-external/dsh-ui-progress/lib/client.js:219:41)
```

That call sits in plugin A's excerpt at the "Attention state" block:

```ts
const pendingBySession = useSessionPendingInteraction(interactions => interactions)
```

**Why now**: the two sealed contracts show the standard-kit reduction. At alpha.1, `SessionStandardProps` carried `useSessionPendingInteraction: SnapshotSelectorHook<ReadonlyMap<SessionId, SessionPendingInteraction>>`. At alpha.2 that hook is **removed from the standard props entirely** and replaced by `useSessionStatus` (per-session status: running, completionUnread, and — importantly — `pendingInteraction`) plus `useSessionRetainInfo`. This is the documented multi-instance-refactor reduction of `GlobalStandardProps`. Plugin A was written against the alpha.1 kit, still destructures `useSessionPendingInteraction` from its props, and on alpha.2 receives `undefined` in its place — calling `undefined(...)` throws during render. The same standard kit still supplies `useSessions` (unchanged card), which is why the rest of plugin A's subagent walk code is unaffected; only the pending-interaction read is broken. Plugin B's excerpt, by contrast, uses **no standard-kit hooks at all** — its dock entry reads only its own injected state, so nothing in the kit reduction can throw in B.

**Why the innocent co-tenant's dock entry disappears with it — the mechanism**: the mount tree shows that `InputDock` wraps **all** `DockEntry` children in a **single shared** `DrawerErrorBoundary name="input.dock"`, and `DockEntry` adds no boundary of its own. Plugin A's throw happens during React's render of the whole slot subtree; React unwinds to the nearest boundary — the shared drawer boundary — which per the render-tree note does `getDerivedStateFromError` → renders `null` as its fallback. One boundary, one fallback: `null` unmounts the **entire input.dock slot contents**, both entries together. The console log confirms it in one line:

```
[dsh:slots] input.dock boundary fallback active (session s-7f3a); unmounted
            entries: dsh-paste-input-dock, progress
```

**Why the attach button survives**: `AttachButton` is registered into a *different* slot, `conversation.input.left`, which has its **own** `DrawerErrorBoundary`. Plugin A's error never renders inside that boundary, so it never trips; the log line `[dsh:slots] input.left: 1 entry mounted (dsh-paste-input-button)` shows that slot stayed mounted. Slot isolation, not plugin resilience, is what saved the button — and the absence of per-entry isolation inside `input.dock` is what took the chips down with the strip.

## 2. The experiment

The maintainer's disable-experiment — **disable plugin A → plugin B's chips return immediately; re-enable A → chips vanish again** — is decisive for attribution:

**What it proves.** Plugin B's dock entry is fully capable of mounting on alpha.2 the moment the shared boundary stops falling back. Combined with the single console error, this isolates the crash to plugin A's render and proves the chips' absence is entirely an artifact of the shared fallback, not of any B-side failure: no reinstall, no B-side change of any kind was involved in restoring it.

**What it does NOT prove.**

- It does **not** prove plugin B is bug-free on alpha.2. It proves `AttachmentChips` renders without throwing *with the current standard kit as delivered to its props* — and since B uses none of the changed hooks, this is strong but still bounded evidence. B could still have latent alpha.2 issues in paths the paste flow hasn't exercised (e.g. its `inject`-supplied state on a different session shape).
- It does **not** prove the strip crash is the only dock problem. React stops at the first uncaught render error, and the boundary fallback masks any subsequent mount attempts while plugin A stays enabled. A second, independent dock error (from B or another tenant) would be invisible until A is fixed and the boundary stops falling back — the console line "(no further errors)" only covers this render pass. Verification after fixing A must therefore re-check every dock entry individually.

**Why reinstalling plugin B could never have helped.** B's code is not the failure. The crash occurs inside plugin A's component while React renders the shared `input.dock` subtree; B's entry is merely a sibling under the same boundary. Reinstalling B replaces bits that were already correct — the error is thrown before B's entry ever gets a chance to render, and the fallback would null the slot again regardless of which build of B is on disk. The maintainer's own notes corroborate: B's registration succeeds and its try/catch logs nothing.

**What is wrong with the colleague's "both plugins were hit" theory.** It treats the two symptoms as two independent failures. They are one failure with two visible effects: a single console error (not two), both unmounted entries named in **one** boundary-fallback log line, and a disable-experiment showing B recovers without any B-side change. The colleague's prediction also fails on the sealed contracts: the removed hook (`useSessionPendingInteraction`) is used only by plugin A's excerpt; plugin B's excerpt uses no standard-kit hook at all, so no removed prop "hit" B. Alpha.2 did change slot props — but for exactly one of the two plugins.

## 3. The fix

The alpha.2 kit supplies pending state through **`useSessionStatus`** — its `SessionStatus` carries `pendingInteraction` per session id (plus `running`/`completionUnread`). Corrected component with graceful degradation:

```tsx
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

  // alpha.2 kit: pendingInteraction moved into per-session status
  // (useSessionStatus). Optional chaining keeps this component loadable on
  // hosts that supply the hook, and non-fatal on hosts that supply neither
  // the alpha.1 nor the alpha.2 hook.
  const statusById = useSessionStatus?.(statuses => statuses) ?? EMPTY_STATUSES
  const pendingBySession = useMemo(
    () => collectPending(statusById),
    [statusById],
  )
  const ownPending = pendingKindOf(pendingBySession.get(sessionId)?.kind)
  const subPending = subagentPendingState(
    useSessions(s => s.byId), pendingBySession, sessionId)
  const pending = ownPending !== null || subPending.approvals > 0 || subPending.questions > 0

  // Background state: main conversation idle while descendant subagent
  // sessions keep executing - must not read as done-green.
  const subRunning = subagentRunningCount(useSessions(s => s.byId), sessionId)

  return (
    <div className={css.bar} data-pending={pending || undefined}>
      {/* state text, fill bar, todos percent, token chip, elapsed/eta */}
    </div>
  )
}

function collectPending(
  statusById: ReadonlyMap<SessionId, SessionStatus>,
): ReadonlyMap<SessionId, SessionPendingInteraction> {
  const out = new Map<SessionId, SessionPendingInteraction>()
  for (const [id, status] of statusById) {
    if (status.pendingInteraction !== undefined) out.set(id, status.pendingInteraction)
  }
  return out
}

const EMPTY_STATUSES: ReadonlyMap<SessionId, SessionStatus> = new Map()
```

**Which hook supplies the pending state on alpha.2**: `useSessionStatus` (a `SnapshotSelectorHook<ReadonlyMap<SessionId, SessionStatus>>`; the per-session `pendingInteraction` inside `SessionStatus` replaces the removed top-level `useSessionPendingInteraction` map). The subagent-subtree aggregation is preserved by re-deriving the pending map from the status snapshot; `useSessions` is unchanged between the two contracts, so the `subagentPendingState` / `subagentRunningCount` walks keep working as-is.

**What degrades on a host that supplies neither hook**: with `useSessionStatus` absent (or `undefined`), `statusById` resolves to `EMPTY_STATUSES`, so the **pending/attention highlight degrades** — the strip can no longer surface its own or its subagent subtree's pending approvals/questions, and `data-pending` will not be set from that source. **What keeps working**: the entire resident strip itself — session running state, the derived percent/turn/elapsed/eta, the todos percent projection, the token chip, and the subagent running count (fed by the unchanged `useSessions`). The component renders a normal, slightly less-informative bar instead of crashing.

**Why the degradation must be silent rather than throwing**: this component mounts inside the shared `DrawerErrorBoundary` of the `input.dock` slot, whose fallback is `null` for the *whole* slot. A throw here — even a defensive "unsupported host version" error — would not fail loudly at plugin A's boundary; it would null the entire dock and drag every co-tenant (plugin B's chips rail, and any other dock entry) down with it, reproducing the exact incident. A missing optional capability is a degradation of one feature of one entry, not a slot-level fault, and the kit's contract treats standard props as best-effort surfaces hosts evolve; silent degradation with reduced functionality is the only outcome that keeps the failure isolated to the tenant that owns it.

## 4. Multi-tenant hygiene

**What a dock tenant should do.**

- Wrap its own slot-entry component in its **own React error boundary** (per plugin, ideally per entry), so its render failure collapses to its own fallback instead of unwinding to the host's drawer boundary.
- Treat standard-kit props as an evolving surface: destructure optional hooks defensively and degrade features silently (as in §3), never throw on a missing capability inside a shared slot.
- Keep slot-entry render paths free of side effects and heavy assertions; anything that can throw during mount belongs behind the entry's own boundary.

**What the host could change so one entry's failure isolates to that entry**: move (or add) the error boundary from the drawer level to the **per-entry** level — each `DockEntry` renders inside its own small boundary whose fallback is `null` (or a minimal placeholder), so `progress` crashing unmounts only `progress` while `dsh-paste-input-dock` keeps rendering. The shared drawer boundary remains as a last resort.

**The trade-off the host faces.** Per-entry isolation costs one extra boundary component (and its reconciliation overhead) per dock entry, and it fragments the failure surface: a systemic error — e.g. a host kit change that breaks *every* tenant's entry — now presents as N independent silent blanks instead of one visible fallback, making "the dock is broken" harder to notice and diagnose. A single drawer boundary gives one loud, obvious signal at the cost of collective punishment for innocent co-tenants. Hosts choose between loud-but-broad and quiet-but-precise failure; per-entry boundaries with a diagnostic log line (like the existing `[dsh:slots]` output, emitted per entry) are the usual compromise.

## 5. Verification

**Restoring both dock entries without a host restart.** The client plugin bundles reload on page refresh — disable/re-enable or hot-swap plugin A's build and hard-refresh the browser; no host restart is needed for client-plugin changes. Then:

1. With all plugins enabled, verify the dock renders **both** entries: the progress strip (plugin A, order 20) and, after pasting a file, the chips rail (plugin B, order 5).
2. Verify F12 shows **zero** render errors, and the log does *not* contain `input.dock boundary fallback active`.
3. Re-run the maintainer's experiment in reverse as a regression guard: with plugin A's fixed build enabled, paste a file — chips must render (they previously vanished whenever A was enabled).
4. Cross-check the fix compiles against the sealed alpha.2 contract (`slots-contract-alpha2.d.ts`): `useSessionPendingInteraction` no longer referenced; `useSessionStatus` consumed.

**Regression the verification must cover for plugin B specifically.** B was never broken in its own right, but its dock entry was the crash's collateral victim, so the verification must prove B's dock entry survives a hostile neighbor:

1. Paste/drop a file **while plugin A (fixed) is enabled** — chips render, chips can be dismissed via B's own `remove` action, and a second paste adds another chip (B's full `add`/`remove` path, not just first render).
2. **Fault-injection regression**: temporarily reintroduce a throw in plugin A's dock entry and confirm B's chips still render under per-entry isolation (if the host change from §4 is applied) — or at minimum that B recovers immediately once A's entry is fixed, with no reinstall of B.
3. Session switch: the boundary note says fallbacks reset on the next session switch — verify a session switch with plugin A enabled does not blank B's chips rail in the new session.
4. Confirm B's other surface is untouched: the attach button on `input.left` still renders (it did throughout, but it belongs in the pass criteria).

---

*Report produced read-only under the plugin-upgrade skill (Mode A). The fixture directory was not modified; no migrations or installs were executed.*
