# Deadlock/Gunfight — Spectate / Death / Spawn state machine (traced 2026-07-19)

Every state transition with file:line references. ENGINE RULE driving everything:
under `SpawnModes.Spectating`, a dead/undeployed player is put into spectate; if the
active spectate-filter pool contains NO valid target, the engine WEDGES ("waiting for
soldier deployment" + cursor lock — community bug, no engine fix).

## Timeline

### MATCH START — `OnGameModeStarted` (index ~1120)
1. `initSpawnPositions` (spatial ObjIds 1–4), `reconcileTeams`
2. `SetSpawnMode(AutoSpawn)` (index:1131)
3. **[FIX part 1]** `SetSpectatingFiltersForAll(Team, false, true)` (index:1139) — team-only pool
4. `DeployAllPlayers` (index:1142)
5. `countdownUI.start()` (countdown-ui:269): `SetSpawnMode(AutoSpawn)` again, teleport to
   spawn positions + freeze, 5-second countdown
6. Countdown end (countdown-ui:385): **`SetSpawnMode(Spectating)`**, unfreeze → LIVE ROUND

### LIVE ROUND — SpawnMode = **Spectating**, filters = **Team-only**
- **Death** (`OnPlayerDied` / `OnMandown` → `handlePlayerDeath`): engine flips the dead
  player to spectate immediately. Pool = living TEAMMATES only (never enemies).
- **Mid-round deploys are BLOCKED** (index:1537-1545): `roundStarted && !countdown.isRunning
  && !roundEnding` → `rejectPlayer` + `UndeployPlayer` → that player lands in spectate.
- Non-final elimination → `checkRoundEnd()` immediately; round continues.

### ROUND END — three enders, ALL call `enterRoundTransition()` first
- Flag capture (index:1271) · Time-out (index:1773) · Elimination (index:1856/1961)
- **[FIX part 3]** elimination widens BEFORE the 1600ms animation window (index:1956-66)
- `enterRoundTransition()` **[FIX part 2]** (index:1151): `SetSpectatingFiltersForAll(All)`
  — dead players fall through to the frozen winners. MUTUAL WIPE: +600ms
  `SetSpawnMode(AutoSpawn)+DeployAllPlayers`, +1200ms freeze.
- `finishRound` teardown (index:1185+): dead → `UndeployPlayer` (they spectate, pool=All ✓);
  alive → heal/disarm/idle + freeze. Result screen. SpawnMode is STILL Spectating here.
- +5s: `deployAllAtStartPositions` (index:1880): `SetSpawnMode(AutoSpawn)`, `reconcileTeams`,
  `DeployAllPlayers` → +500ms freeze all → +500ms `resetRound` → `startRound` (index:1615):
  `roundEnding=false`, **restore Team-only filters** (index:1628), countdown → Spectating…

### MATCH END — `endMatchDeployed` (index ~694-771)
`matchEnding=true`, `SetSpawnMode(AutoSpawn)`, `EnablePlayerDeploy(all)`, deploy everyone —
because ending while anyone spectates CARRIES the spectator state into the NEXT MAP
(documented index:750-752).

## CONFIRMED ROOT CAUSE (two 2026-07-20 SPEC logs, live repros)

**Log 1 (pre-fix):** victim id=0: death t=23.4 → DEPLOY t=34.1 (~10s respawn timer)
→ mid-round blocker UndeployPlayer → DEPLOY/UNDEPLOY fight every ~1.1s — each
scripted undeploy of a LIVE soldier under Spectating leaks a spectator session.
Final deploy landed t=41.3 while mode still Spectating; at the next countdown-end
`SetSpawnMode(Spectating)` (t=50.8) a dangling session re-bound → "waiting for
soldier deployment" UI + input lock on a walking soldier. KEY DETAIL: the other
dead human (18s dead) was NEVER respawned — so the engine does NOT auto-respawn
under Spectating; it honors a PLAYER-PRESSED deploy (~10s timer). Only pressers
started the fight.

**Log 2 (build B: EnablePlayerDeploy(false) on death + unlock loop + latch): WORSE —
a human hit almost every round, ZERO blocker cycles.**
**Log 3 (build C: SetRedeployTime(600) on death + reset loop + latch): still worse —
same frequency.** NOTE: `SetRedeployTime` is officially clamped to 0–60s, so C's
on-death arm may have been a no-op — meaning the frequent bug does NOT need the
on-death touch. The factors common to B/C and absent from clean build A:
(1) a deploy-state loop touching STILL-SPECTATING dead players at the transition,
(2) the latch removed build A's accidental second filter-widen, which used to land
at the same tick as the teardown undeploys.

**LAW: never call any deploy-state API (EnablePlayerDeploy / SetRedeployTime /
UndeployPlayer) on a player who is currently in death-spectate.** Build A — dead
players completely untouched — was clean except for the one player whose pressed
deploy started the blocker's undeploy cycle.

**Build D result: STILL occurred — including for a player whose entire history was
death → 31s untouched death-spectate → teardown → AutoSpawn mass-deploy (the pure
"clean" path).** Final conclusion: the sticky lock is triggered by the countdown-end
`SetSpawnMode(Spectating)` call itself for players who death-spectated the previous
round. No scripted handling of the dead avoids it. ENGINE BUG, no workaround within
Spectating mode.

**Build E (superseded): live rounds in `SpawnModes.Deploy`** — structurally immune
but no spectating; user requires spectate for this mode. Kept as fallback via
`LIVE_SPECTATE=false`. Also fixed the 50ms freeze-enforcement stack-dump storm
(28k PortalLog lines/match from EnableInputRestriction InvalidPlayer throws on
stale frozen-list entries) — that was the in-match lag.

**Build F (superseded): deploy-the-dead under Spectating, Deploy held through countdown,
Spectating re-set at countdown end.** First variant flipped Deploy before the async
revives landed; user redirected to build G before further testing.

**BUILD G — CONFIRMED FIXED IN LIVE TEST (2026-07-20): the live Spectating mode is set
mid-transition at the one moment ZERO spectator sessions exist.** Core invariant:
`SetSpawnMode(Spectating)` is ONLY ever called while every player is alive+deployed.
The countdown-end Spectating flip is a guarded NO-OP for rounds 2+ (fires only round 1,
where no spectate history exists). NO undeploys once roundEnding is set.

**BUILD H (CURRENT): G + transition polish (user-directed).** The win/loss card plays
out FULLY first — dead players spectate the frozen winners (pool=All) through the card;
nothing touches them. Then the +5s next-round flow runs `reviveSequence(sidesSwapped)`:
`SetSpawnMode(Deploy)` → spam force-deploys every 300ms until every human reads alive
(3s cap) → `ensureLiveSpawnMode()` sets Spectating (zero sessions exist) → teleport
EVERYONE (winners included) to their round-start seats → then the countdown flow
(deployAllAtStartPositions catch-all → freeze → resetRound → startRound). MUTUAL WIPE
exception: nobody alive = no card spectate targets, so reviveSequence runs early
(+600ms); the +5s pass re-runs it as a fast no-op. Blocker uses UndeployPlayer
mid-round; no AutoSpawn anywhere in the round cycle (match start/end only).

**Build D changes (kept in build E):** exact build-A semantics for the dead + two changes:
- Blocker uses `mod.Kill(player)` instead of `UndeployPlayer` on a slip-through
  mid-round spawn: a real death re-enters spectate via the engine's own clean path
  (spawn-die flicker for deploy-spammers; never state-corrupting).
- `finishRound` re-applies `SetSpectatingFiltersForAll(All)` right after the
  teardown undeploys — deterministic replacement for build A's accidental second
  widen (a filters call refreshes spectate-session targets).
- No on-death touch, no transition deploy-state loop. `enterRoundTransition`
  stays latched (admin-flush quota).

## Suspected interruption windows (sim targets)

- **W1 — late joiner onto a dead/empty team mid-round.** Mode=Spectating → they never
  deploy; pool=Team-only; if their team is wiped (or they're alone), pool is EMPTY →
  wedge until the round ends. NOTHING handles a joiner's spectate pool mid-round.
- **W2 — mid-round spawn blocker** (index:1541): any deploy slipping through mid-round is
  undeployed into team-only spectate; same empty-pool risk as W1 late in a round.
- **W3 — OnMandown vs OnPlayerDied double-processing**: both call `handlePlayerDeath` for
  the same player (mandown → bleed-out). If elimination math counts them at different
  times (downed body still IsAlive=true), final-elimination detection (and thus the part-3
  widen) can fire early/late relative to the engine's spectate engage.
- **W4 — the Team-only restore at `startRound`** (index:1628) happens while players from
  `DeployAllPlayers` (+0…500ms earlier) may still be materializing. A straggler who
  hasn't deployed when filters narrow, on a team with nobody alive-yet, wedges until
  their own deploy lands. (Probably self-heals in <1s; verify.)
- **W5 — death DURING the countdown** (fall/OOB while frozen): filters already Team-only,
  teammates alive+frozen → should be safe; verify freeze can't be escaped into a death
  with zero deployed teammates.

## Sim plan (harness wedge-detector)
Record a timeline of `SetSpectatingFiltersForAll/ForPlayer`, `SetSpawnMode`,
`Deploy*/Undeploy*`, freezes. Every 300ms of sim time, for each dead/undeployed human,
compute the pool under current filters; empty pool for >300ms = WEDGE, dump the
surrounding timeline. Scenarios: normal elimination round, mutual wipe, mid-transition
death, W1 late-join-onto-dead-team, W3 mandown-then-die.
