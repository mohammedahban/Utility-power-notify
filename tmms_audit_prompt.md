# TMMS V2.2 Full Code Audit

You are auditing the Utility Power Notify app's TMMS V2.2 implementation against the specification below. 

## Your Task

1. Read every key file listed below
2. Compare the implementation against EVERY rule in the TMMS V2.2 spec
3. For every mismatch, identify:
   - The expected TMMS behavior
   - The actual application behavior  
   - The suspected root cause
   - The files/functions likely responsible
   - A proposed fix
4. Classify each issue: 🔴 Critical / 🟠 High / 🟡 Medium / 🔵 Low
5. List rules that ARE correctly implemented

## Key Files to Read (in order)

1. `app/(admin)/tmmsEngine.ts` — Main TMMS engine (computeATCMode, applyOffsetToPrediction)
2. `hooks/useUtilityReports.ts` — Report submission with Period 1/2/3 offset calculation
3. `hooks/useUserPredictions.ts` — Production hook feeding home screen
4. `hooks/useUserOffset.ts` — Offset persistence
5. `contexts/ResyncContext.tsx` — Community sync point storage
6. `app/(user)/index.tsx` — Home screen (first 500 lines for state display logic)
7. `hooks/useTransitionMode.ts` — AUTO/MANUAL mode

## TMMS V2.2 Specification — Rules to Verify

### PHASE 1: Period Classification

**Rule P1-A: Period 1 = During Growatt ON**
Reports created while Growatt is ON belong to Period 1.
Generated ON replaces the CURRENT Growatt ON.
Duration = FULL duration of the current Growatt ON.
OFF that follows = same duration as the OFF that follows the replaced ON.
Offset = GeneratedONstart - ReplacedONstart (positive).

**Rule P1-B: Period 1 = First Half of Growatt OFF (<50%)**  
Reports created during the first half of Growatt OFF (<50% consumed) belong to Period 1.
Generated ON replaces the PREVIOUS Growatt ON.
Duration = FULL duration of previous Growatt ON.
OFF that follows = same duration as the OFF that followed the replaced ON.
Offset = GeneratedONstart - PreviousONstart (positive).

**Rule P2: Period 2 = Second Half of Growatt OFF (>50%)**
Reports created during the second half of Growatt OFF (>50%) belong to Period 2.
Generated ON replaces the NEXT upcoming Growatt ON.
Duration = FULL duration of next Growatt ON.
OFF that follows = same duration as OFF after the replaced next ON.
Offset State = PENDING_NEGATIVE initially.
Offset auto-resolves to NEGATIVE when Growatt ON begins.
Offset Value = GeneratedONstart - ActualGrowattONstart.

**Rule P3: Period 3 = Exact Growatt ON Start Instant**
Reports created exactly at Growatt ON start belong to Period 3.
Offset State = NEUTRAL.
Offset Value = 0.
Personal Timeline = exact clone of Growatt.

### PHASE 2: Generated ON Rules

**Rule G1: Generated ON is permanent**
Generated ON is a permanent timeline event. Never temporary. Never deleted.
It becomes part of the user's timeline history.

**Rule G2: Generated ON becomes current state immediately**
When a user reports ON:
1. End current OFF
2. Create Generated ON
3. Make Generated ON the current state
4. Choose its duration
5. Calculate Offset
6. Rebuild today's remaining timeline
7. Rebuild future schedules

**Rule G3: Generated ON duration = FULL replaced Growatt ON duration**
Always the full duration of the replaced Growatt ON, never the remaining duration.

**Rule G4: Next OFF after Generated ON**
Immediately after Generated ON ends, the next OFF begins automatically.
Duration = FULL duration of the OFF that originally followed the replaced Growatt ON.

### PHASE 3: Offset Behavior

**Rule O1: Positive Offset (Period 1)**
Meaning: User's Personal Timeline is LATER than Growatt.
Pushes every future ON and OFF later by the offset value.
Durations never change.

**Rule O2: Negative Offset (Period 2 resolved)**
Meaning: User's Personal Timeline is EARLIER than Growatt.
Pulls every future ON and OFF earlier by the offset value.
Durations never change.

**Rule O3: Pending Negative**
Offset sign is known (Negative). Exact value unknown.
Stays PENDING until Growatt ON begins.
Automatically resolves when Growatt ON starts.
No user interaction required.

**Rule O4: Neutral Offset (Period 3)**
Offset = 0.
Personal Timeline clones Growatt completely.
No shifting. No Pending state. No UNCERTAIN_ZONE.

### PHASE 4: Verification / Transition Behavior

**Rule V1: Short Verification Window (Positive Offset only)**
When Growatt turns ON but user timeline is still in OFF (due to positive offset):
Home Page displays OFF with countdown.
Only when countdown reaches 0 does Personal Timeline switch OFF→ON.
Transition is automatic.

**Rule V2: UNCERTAIN_ZONE (Negative Offset)**
When predicted OFF finishes before Growatt turns ON:
State changes OFF → UNCERTAIN_ZONE (stays OFF).
Home Page displays "Electricity OFF / Waiting for Growatt ON…"
Displays elapsed waiting time.
System waits until Growatt changes from OFF to ON.
When Growatt turns ON:
1. Measure actual waiting time
2. Deduct wait time from next ON duration
3. User immediately enters ON state

**Rule V3: ON Duration Reconciliation for UNCERTAIN_ZONE**
Expected ON Duration − UNCERTAIN_ZONE waiting time = Displayed ON Duration.
Preserves correct cycle timing.

**Rule V4: Neutral offset — no special behavior**
Neutral users clone Growatt exactly. No verification window. No UNCERTAIN_ZONE.

### PHASE 5: Timeline Rebuild

**Rule T1: Full timeline rebuild on every accepted ON report**
1. Replace appropriate Growatt ON with Generated ON
2. Replace following OFF
3. Calculate new Offset
4. Recalculate today's remaining timeline
5. Recalculate all future predicted days
6. Refresh Home Page
7. Refresh Notifications
8. Refresh Remaining Time
9. Refresh Widgets
10. Refresh every dependent schedule

### PHASE 6: Community Approval

**Rule C1: Approver clones Reporter's state**
When another user approves a report:
Approver does NOT calculate a new Offset.
Approver clones the Reporter's:
- Offset State
- Offset Value (or Pending Negative if unresolved)
- Timeline Alignment
- Personal Timeline structure

### PHASE 7: Edge Cases

**Rule E1: Reports during Growatt ON but at different points**
If user reports ON at 11:20 and Growatt ON is 10:00→12:00:
Generated ON = 11:20→13:20 (full 2h duration, not 40min remaining).
This is Period 1, Positive offset.

**Rule E2: Multiple reports in same cycle**
Each new accepted ON report replaces the previous Generated ON.
Latest report wins.

**Rule E3: Report at exact boundary of Period 1 and Period 2 (50.0%)**
50.0% is Period 2 (>50% threshold).

## Output Format

For each rule, state: ✅ PASS or ❌ FAIL
For failures, provide:
- Expected behavior (from spec)
- Actual behavior (from code)
- Root cause
- File(s) and line number(s)
- Proposed fix

Then provide a summary:
- Total rules: X
- ✅ PASS: Y
- ❌ FAIL: Z
- Critical issues: list
- High issues: list
- Medium issues: list
- Low issues: list
