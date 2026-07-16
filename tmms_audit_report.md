# TMMS V2.2 implementation audit

Audit date: 2026-07-10  
Scope: `tmms_audit_prompt.md` and every requested key file; `app/(user)/index.tsx` was reviewed through line 500 as directed. A narrow trace into `hooks/useResyncNotifications.ts` was also used where the requested files explicitly delegate Pending-Negative resolution and community approval.

## Executive summary

The implementation contains much of the intended period arithmetic and UI state machinery, but it is not an end-to-end V2.2 implementation. The largest defects are that a “permanent” branch is automatically deleted after six hours; Period 3 is widened to a one-minute interval and then handled as a community sync rather than an exact Growatt clone; Pending Negative resolution updates only `resync_history`, leaving the operative `user_offsets`/local resync state stale; and a Generated ON does not rebuild the following OFF using the replaced cycle's duration. The code also has no comprehensive rebuild/refresh transaction for all dependents required by T1.

| Result | Count |
|---|---:|
| Total rules | 21 |
| ✅ PASS | 7 |
| ❌ FAIL | 14 |

## Findings by rule

### Phase 1 — Period classification

#### P1-A — Period 1 during Growatt ON: ❌ FAIL — 🟠 High

- Expected: only the exact ON-start instant is Period 3; every later instant during the active Growatt ON is Period 1, with a full-duration replacement and positive `GeneratedONstart - ReplacedONstart` offset.
- Actual: the active ON is found correctly and the full duration/offset are calculated at `hooks/useUtilityReports.ts:335-373`, but every report less than 60 seconds after ON start is classified as Period 3 (`Math.abs(...) < 60_000`) at lines 342-354.
- Root cause: an undocumented one-minute tolerance replaces the spec's exact-instant boundary.
- Responsible: `hooks/useUtilityReports.ts:342-354` (`calculateReporterOffset`).
- Proposed fix: compare against the canonical event timestamp exactly (or use a clearly defined database timestamp precision, e.g. same millisecond/second), and classify every `T > onStart` as Period 1.

#### P1-B — Period 1 in first half of Growatt OFF: ❌ FAIL — 🟠 High

- Expected: at `<50%`, replace the previous ON for its full duration and reproduce the full OFF duration that followed it.
- Actual: `<50%` classification, previous-ON selection, full ON duration, and positive offset are correct (`hooks/useUtilityReports.ts:382-413`). However, no following-OFF reference or duration is captured. The runtime later ends Generated ON and simply stays OFF until the next already-shifted ON (`app/(admin)/tmmsEngine.ts:432-456`), which is not a reconstruction of the replaced ON's original following OFF.
- Root cause: report metadata models the replaced ON but has no `generated_off_duration`/following-OFF identity, and the engine does not splice a replacement ON/OFF pair.
- Responsible: `hooks/useUtilityReports.ts:315-325, 391-413`; `app/(admin)/tmmsEngine.ts:432-456`.
- Proposed fix: capture the immediately following OFF slot and its full duration in the classification result; persist it; splice an explicit Generated ON followed by an explicit OFF with that duration into the personal timeline.

#### P2 — Period 2 in second half of Growatt OFF: ❌ FAIL — 🔴 Critical

- Expected: at 50% or later, create Pending Negative against the next ON; when actual Growatt ON arrives, automatically resolve to `T - ActualGrowattONstart` and make that numeric negative offset operative.
- Actual: `>=50%` is correctly classified and the next ON/full duration are selected (`hooks/useUtilityReports.ts:261-278, 414-443`). Resolution calculates `T-G` and updates `resync_history` (`hooks/useResyncNotifications.ts:258-288`), but it does not update `user_offsets`, `utility_reports`, or the persisted `ResyncPoint`. The production engine is still called with `offsetMinutes` from `user_offsets` (`hooks/useUserPredictions.ts:599-610`); approver Pending rows use `0` as a placeholder (`hooks/useResyncNotifications.ts:614-629`). Metadata may therefore say NEGATIVE while scheduling still runs with zero offset.
- Root cause: Pending resolution is not an atomic update of every source of truth, and the production hook separates metadata state from the numeric value driving the engine.
- Responsible: `hooks/useResyncNotifications.ts:258-288, 614-629`; `hooks/useUserPredictions.ts:599-620`.
- Proposed fix: resolve in one database RPC/transaction that updates the report, all unresolved per-user history rows, and each affected `user_offsets` row; update/replace the local persisted `ResyncPoint`; subscribe/refetch those rows and pass the resolved numeric value into the engine.

#### P3 — Exact Growatt ON start: ❌ FAIL — 🟠 High

- Expected: only the exact instant is NEUTRAL/0 and the personal timeline is an exact Growatt clone.
- Actual: a full minute is treated as “exact” (`hooks/useUtilityReports.ts:342-354`). In addition, the report creates a resync point, causing `computeATCMode` to enter `COMMUNITY_SYNCED` and synthesize/hold a Generated ON (`app/(admin)/tmmsEngine.ts:394-430, 860-880`) rather than simply return the raw Growatt timeline.
- Root cause: tolerance-based classification plus a global resync override that does not special-case neutral alignment.
- Responsible: `hooks/useUtilityReports.ts:342-354, 761-777`; `app/(admin)/tmmsEngine.ts:394-430, 860-880`.
- Proposed fix: make the boundary exact and bypass Generated-ON/community-hold behavior for NEUTRAL; return an unshifted copy of the Growatt prediction.

### Phase 2 — Generated ON

#### G1 — Generated ON is permanent: ❌ FAIL — 🔴 Critical

- Expected: the event remains permanently in personal timeline history and is never deleted.
- Actual: history is inserted (`hooks/useUtilityReports.ts:779-815`), but the active persisted branch is discarded after six hours on both load and watchdog (`contexts/ResyncContext.tsx:120-137, 139-176`). Production reads only the latest history row and only overlays Generated ON while it is current (`hooks/useUserPredictions.ts:455-493, 621-627`), so it does not maintain permanent timeline event structure.
- Root cause: temporary resync storage semantics were retained for a permanent-event model.
- Responsible: `contexts/ResyncContext.tsx:101-103, 120-176`; `hooks/useUserPredictions.ts:455-493, 621-627`.
- Proposed fix: remove age-based deletion; store generated timeline events as durable, user-scoped records; query the relevant event history/range and retain completed events in history while only marking the latest applicable branch active.

#### G2 — Generated ON becomes current immediately: ❌ FAIL — 🔴 Critical

- Expected: as one accepted-report operation, end current OFF, create/current the Generated ON, select duration/offset, rebuild today's remainder, and rebuild future schedules.
- Actual: the local self-resync makes ON current immediately (`hooks/useUtilityReports.ts:761-777`; `app/(admin)/tmmsEngine.ts:394-430`), but it does not end/store the current OFF as a durable event or rebuild today/future schedules. It merely overlays the current `daySchedule` (`app/(admin)/tmmsEngine.ts:818-880`).
- Root cause: report acceptance returns a presentation-layer resync object instead of executing the specified timeline mutation pipeline.
- Responsible: `hooks/useUtilityReports.ts:761-836`; `app/(admin)/tmmsEngine.ts:818-880`.
- Proposed fix: make acceptance an atomic server-side command that closes OFF, inserts Generated ON and its following OFF, computes/persists offset, rebuilds all affected personal slots, then publishes invalidation.

#### G3 — Generated ON uses full replaced ON duration: ✅ PASS

The classifier uses the slot's declared full duration or full start/end delta for current, previous, and next ON references (`hooks/useUtilityReports.ts:337-370, 395-410, 429-440`), never remaining duration.

#### G4 — Next OFF uses full original following-OFF duration: ❌ FAIL — 🟠 High

- Expected: create OFF immediately after Generated ON with the full duration of the OFF following the replaced ON.
- Actual: ON→OFF is automatic, but the engine sets OFF until whatever next ON happens to exist in the shifted base schedule (`app/(admin)/tmmsEngine.ts:432-456`). No following-OFF duration is calculated, persisted, or used.
- Root cause: missing replacement-pair model and missing following-OFF metadata.
- Responsible: `hooks/useUtilityReports.ts:315-325, 617-625`; `app/(admin)/tmmsEngine.ts:432-456`.
- Proposed fix: persist the referenced following-OFF duration and inject an explicit OFF slot `[generatedOnEnd, generatedOnEnd + fullOffDuration)` before rebuilding later cycles.

### Phase 3 — Offset behavior

#### O1 — Positive offset pushes all future states without changing duration: ✅ PASS

The engine adds the signed offset to both start and end of every ordinary slot (`app/(admin)/tmmsEngine.ts:288-333`), preserving each duration; the Generated ON itself is deliberately not shifted.

#### O2 — Resolved negative offset pulls all future states without changing duration: ❌ FAIL — 🔴 Critical

- Expected: after resolution, the numeric negative offset becomes the scheduling input and pulls every future ON/OFF earlier.
- Actual: slot arithmetic supports negative values (`app/(admin)/tmmsEngine.ts:313-333`), but the resolution path updates only history, while the engine continues to receive `offsetMinutes` from the stale `user_offsets` value (`hooks/useUserPredictions.ts:599-616`). For Pending approvers that operative value was explicitly stored as zero (`hooks/useResyncNotifications.ts:614-629`).
- Root cause: split, unsynchronized offset sources of truth.
- Responsible: `hooks/useResyncNotifications.ts:258-288, 614-629`; `hooks/useUserPredictions.ts:599-616`.
- Proposed fix: make resolved numeric offset authoritative in `user_offsets` and local resync state, then drive both engine offset and displayed metadata from that same resolved record.

#### O3 — Pending Negative auto-resolves: ❌ FAIL — 🔴 Critical

- Expected: sign is known, exact value remains pending until Growatt ON, then resolves automatically with no user action.
- Actual: the realtime watcher and arithmetic exist (`hooks/useResyncNotifications.ts:218-239, 258-288`), but resolution is partial as described above. It also depends on a mounted client subscription rather than a durable server-side transition handler; a Growatt ON while no client is subscribed can leave rows pending.
- Root cause: client-only, non-transactional resolution and incomplete persistence targets.
- Responsible: `hooks/useResyncNotifications.ts:218-239, 258-288`; `hooks/useUserPredictions.ts:499-509`.
- Proposed fix: resolve Pending Negative server-side when the `UTILITY_ON` event is committed, transactionally update all affected state, and use realtime only to refresh the UI.

#### O4 — Neutral clones Growatt with no special state: ❌ FAIL — 🟠 High

- Expected: exact unshifted clone, no Pending, uncertainty, verification, or special branch.
- Actual: the ordinary zero-offset ATC branch avoids uncertainty/verification (`app/(admin)/tmmsEngine.ts:630-635, 673-691`), but a Period-3 report supplies a resync point and is intercepted earlier as `COMMUNITY_SYNCED`, with a validation window and synthetic Generated ON (`app/(admin)/tmmsEngine.ts:394-430, 860-880`).
- Root cause: community/resync priority ignores `offsetState === NEUTRAL`.
- Responsible: `app/(admin)/tmmsEngine.ts:394-430, 860-880`.
- Proposed fix: before the community override, return the unmodified Growatt-derived timeline for neutral Period 3, or avoid creating a resync override for this case.

### Phase 4 — Verification and transition behavior

#### V1 — Positive-only short verification/countdown: ✅ PASS

Positive gaps hold the opposite state until the next shifted slot and expose the exact scheduled transition (`app/(admin)/tmmsEngine.ts:483-514`). The home screen renders an OFF/ON countdown (`app/(user)/index.tsx:328-371`), and a precise timeout forces recomputation at the boundary (`hooks/useUserPredictions.ts:832-840`). Neutral explicitly skips the validation window (`app/(admin)/tmmsEngine.ts:653-691`).

#### V2 — Negative UNCERTAIN_ZONE waits OFF, shows elapsed time, then enters ON: ✅ PASS

After a negative-shifted OFF ends, the engine holds OFF through GRACE/UNCERTAIN/WAITING indefinitely (`app/(admin)/tmmsEngine.ts:538-627`). The home screen derives a live elapsed clock (`app/(user)/index.tsx:144-178, 494-496`). Growatt ON triggers immediate ON synthesis (`hooks/useUserPredictions.ts:668-776`).

#### V3 — Deduct UNCERTAIN waiting from next ON duration: ❌ FAIL — 🟠 High

- Expected: displayed ON duration is exactly expected ON duration minus measured wait.
- Actual: the standard path keeps the selected ON end and moves its start to Growatt ON (`hooks/useUserPredictions.ts:183-274`), but only if an ON slot is already active at `now` (lines 193-200). The immediate path chooses the first ON with a start within a broad two-hour lookback and falls back to an arbitrary 120 minutes (`hooks/useUserPredictions.ts:699-735`); it can choose the wrong slot or produce zero duration if the original end is already past.
- Root cause: reconciliation is inferred from the current schedule rather than tied to the exact replaced ON and its persisted full duration.
- Responsible: `hooks/useUserPredictions.ts:183-216, 699-735`.
- Proposed fix: persist/reference the exact upcoming ON duration and calculate `remaining = max(0, fullDuration - (G - uncertainEntry))`; create `[G, G + remaining)` deterministically, then leave subsequent slots anchored consistently.

#### V4 — Neutral has no special behavior: ❌ FAIL — 🟠 High

- Expected: no verification or uncertainty behavior; direct Growatt clone.
- Actual: plain zero-offset slots behave correctly, but Period-3 neutral resyncs enter `COMMUNITY_SYNCED` with `inValidationWindow` lasting the generated cycle (`app/(admin)/tmmsEngine.ts:394-430`).
- Root cause: neutral reports use the same resync override as non-neutral generated events.
- Responsible: `app/(admin)/tmmsEngine.ts:394-430`; `hooks/useUtilityReports.ts:761-777`.
- Proposed fix: bypass resync hold/validation for neutral and derive state directly from Growatt.

### Phase 5 — Timeline rebuild

#### T1 — Full rebuild and refresh of all dependents: ❌ FAIL — 🔴 Critical

- Expected: every accepted ON report atomically replaces the relevant ON/OFF pair, rebuilds today and all future days, and refreshes home, notifications, remaining time, widgets, and every dependent schedule.
- Actual: submission inserts report/history, invokes distribution, and returns a local resync (`hooks/useUtilityReports.ts:681-836`). The engine shifts the currently supplied `daySchedule` and conditionally prepends a synthetic slot (`app/(admin)/tmmsEngine.ts:818-880`). There is no all-future rebuild, no explicit following-OFF replacement, no widget/notification schedule refresh, and no transaction coordinating dependents.
- Root cause: V2.2 is implemented as a presentation-time overlay rather than a durable timeline rebuild pipeline.
- Responsible: `hooks/useUtilityReports.ts:681-836`; `app/(admin)/tmmsEngine.ts:818-880`; `hooks/useUserPredictions.ts:598-643`.
- Proposed fix: introduce a server-side `accept_on_report` transaction/job that stores the replacement pair, regenerates all future personal slots, versions the schedule, and emits one invalidation event consumed by home, notifications, remaining-time, and widgets.

### Phase 6 — Community approval

#### C1 — Approver clones reporter state: ❌ FAIL — 🟠 High

- Expected: clone the reporter's complete offset/alignment/timeline without calculating a new approver offset.
- Actual: approval initially copies state, value, alignment, and Generated-ON metadata correctly (`hooks/useResyncNotifications.ts:547-629`). However, when no frozen cache exists, the engine independently finds a reference slot, computes `syncMs - refStartMs`, and invokes `onOffsetCalculated` (`app/(admin)/tmmsEngine.ts:884-904`). The production hook then freezes this newly calculated value/state/alignment (`hooks/useUserPredictions.ts:532-546`), so the cloned reporter snapshot can be replaced by an approver-side recomputation.
- Root cause: legacy “community offset calculation” remains active even when the resync already carries authoritative reporter fields.
- Responsible: `app/(admin)/tmmsEngine.ts:884-904`; `hooks/useUserPredictions.ts:532-546`.
- Proposed fix: if `resyncPoint.offsetState`, `offsetValue`, and `timelineAlignment` are present, use them directly and never call `onOffsetCalculated`; retain calculation only as a clearly isolated legacy migration fallback.

### Phase 7 — Edge cases

#### E1 — Report at a later point during Growatt ON uses full duration: ✅ PASS

For the example-style report well after the first minute, active-ON classification calculates `T - onStart` and copies the full ON duration (`hooks/useUtilityReports.ts:335-373`). A 10:00–12:00 ON reported at 11:20 therefore produces an 11:20–13:20 Generated ON with a positive offset.

#### E2 — Multiple reports in one cycle; latest wins: ✅ PASS

Cooldown is zero (`hooks/useUtilityReports.ts:109-115`), each accepted report creates a new self-resync, and `applyResync` replaces the single current resync point (`contexts/ResyncContext.tsx:178-196`). Production selects the newest history row (`hooks/useUserPredictions.ts:455-460`), while older rows remain as history.

#### E3 — Exactly 50.0% is Period 2: ✅ PASS

`calculateOffProgress` defines first half as `<50` and second half as `>=50` (`hooks/useUtilityReports.ts:261-278`), and the classifier sends the latter to Pending Negative (`hooks/useUtilityReports.ts:382-443`).

## Severity summary

### 🔴 Critical

- G1: permanent Generated ON/personal branch is automatically cleared after six hours.
- G2: acceptance does not perform the required durable timeline mutation/rebuild sequence.
- P2, O2, O3: Pending Negative resolution does not update the operative offset sources and relies on a mounted client.
- T1: no durable, comprehensive timeline/dependent-schedule rebuild exists.

### 🟠 High

- P1-A and P3: “exact instant” is incorrectly widened to one minute.
- P1-B and G4: following OFF duration is neither captured nor reconstructed.
- O4 and V4: Period-3 neutral reports enter a special community-synced branch.
- V3: wait deduction is not deterministically tied to the referenced ON duration.
- C1: cloned community state can be overwritten by a fresh local offset calculation.

### 🟡 Medium

- None independently; the observable UI inconsistencies are consequences of the High/Critical source-of-truth defects above.

### 🔵 Low

- None.

## Recommended remediation order

1. Consolidate report acceptance and Pending resolution into server-side transactions with one authoritative personal-timeline/offset record.
2. Implement explicit ON+following-OFF replacement slots and regenerate future personal schedules.
3. Remove the six-hour deletion of permanent branches/events.
4. Correct Period 3 to an exact boundary and bypass all special resync behavior for neutral.
5. Tie uncertainty reconciliation to the persisted referenced ON duration, then invalidate every downstream consumer from one schedule-version event.
