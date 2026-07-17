# Deadlock — Team / Squad Sorting Spec (DRAFT 2026-07-14)

## ✅ IMPLEMENTED 2026-07-14 (src/index.ts — compiles green on 1.3.3.0)
Approach = **minimal correction, not full reassignment** (the engine already groups parties onto
one team, and human `SetTeam` is fragile — so we touch humans as little as possible):
- `computeTargetTeamSize()` — seats/team = `clamp(max(h1,h2), 1, PLAYERS_PER_TEAM)` → scales to humans.
- `spawnBackfillBots()` — now targets that dynamic size (was hardcoded 4v4). Bots fill only the short side.
- `reconcileTeams()` — enforces rule 1: if ≥2 humans but a team has none, move exactly ONE human over.
- `moveOneHumanToTeam()` — squad-group-aware: moves someone from the SMALLEST squad (a solo first) so the
  largest party stays whole (rule 2), tie-break non-leader; frees a bot slot + undeploys before `SetTeam`.
- Wired at **match start** (`OnGameModeStarted`, replacing the old buggy `balanceTeams`) and **each round**
  (`deployAllAtStartPositions`). Deleted `balanceTeams`/`shuffleArray`/`EVEN_SPLIT_MODE` (the SetTeam-on-every-
  human random split that threw "team input invalid").
- Telemetry: `[EVT] team.reconcile {h1,h2,targetSize}`, `[EVT] team.moveHuman {...}` → watch it live in PortalLog.
- Worked cases verified by logic (2 friends→1v1, 3 friends→2v2+bot, 3 friends+random→3v3).

**VERIFY IN-GAME (can't test from here):** (1) does `GetSquad` group real parties vs synthetic squads;
(2) does the engine actually put a party on one team + auto-balance a random to the other; (3) does the
human `SetTeam` move land reliably at match/round start; (4) do the bot counts come out right. The telemetry
above shows all four.

---


Living design doc for the roster/team system. Rules come from the author; mechanism + risks
are grounded in the 1.3.3.0 API and the Discord corpus. Sections marked ⚠ need in-game verification
(some engine behavior is undocumented). Do NOT touch UI/animations (author: perfect as-is).

## Rules (author intent)
1. **Capacity:** up to 8 players, max **4v4**. Lobby caps at **4 to START a match**; **+4 more can join after** it starts.
2. **Squad cohesion:** players who **joined together stay on the same team** (don't split a party).
3. **Dynamic sizing by human count** (teams stay even; bots even out odd counts):
   - 2 humans → **1v1**
   - 3 humans → **2v1 + 1 bot = 2v2**
   - 4 humans → **2v2**
   - 5 → 3v3 (+1 bot), 6 → 3v3, 7 → 4v4 (+1 bot), 8 → 4v4
   - **DECIDED: scale-to-humans, no floor** — 2 humans = literal 1v1 (zero bots). Bots only ever fill the odd slot.
   - **Mid-match growth (author example):** started 4 (2v2), a 5th joins → next round becomes **3v3** (5th on the short team, +1 backfill bot on the other). 6th replaces that bot; 7th → 4v4 (+1 bot); 8th → 4v4 all-human.
4. **Bots = backfill; humans replace bots.** A bot exists only to fill an empty slot. When a human takes a slot, a bot leaves it.
5. **Stability, not shuffling:** as the match progresses, keep teams balanced **without randomly swapping humans between teams** and **without re-dispersing them on the next map**. Keep the same squad together across maps.
6. **Leave → backfill next ROUND:** if a human leaves, replace them with a bot at the **next round boundary** (NOT deferred to the next map).
7. **Join timing (engine-forced):** a human who joins mid-match is QUEUED by the engine and can only actually enter at the **next MAP load** (EA lobby limitation — "only ~2-4 can start; extras wait for next map"), taking a bot's seat. This is asymmetric with rule 6 (leavers → bot next ROUND) because we control bot removal but NOT when the engine admits a queued human. ⚠ verify current start-cap (was 2 in Mar-2026; community reports verified-mode min dropped to ~4 by mid-2026 — author says lobby caps at 4).

## Timing model (when the roster is (re)evaluated)
- **Mid-round:** roster FROZEN. No team changes, no bot add/remove. Late joiners wait; leavers leave a temporary gap.
- **Round boundary (every round):** reconcile roster — remove bots whose slot a human now holds; **spawn bots to backfill any slot a human vacated** (rule 6); keep teams even (rule 3).
- **Map boundary (OnGameModeStarted / next map):** re-assert full roster — humans on their existing teams (rule 5), backfill bots to match. Re-run squad cohesion.

## Mechanism mapping (grounded API, 1.3.3.0)
| Need | Native / approach | Notes |
|---|---|---|
| Detect who's partied/grouped | `GetSquad(player)` → Squad; `GetSquadName`; `IsSquadLeader(player)` | ⚠ verify GetSquad reflects *queued-together* party vs engine-assigned in-game squad |
| Balance while keeping squads | **`AutoBalanceTeams()`** — "balances Team1/Team2 while maintaining squad compositions, requires matching team & squad capacities" | ⚠ the headline native for rule 2; verify it works + when to call (round/map start) |
| Place a BOT on a team | `SpawnAIFromAISpawner(spawner, team)` (per-team spawner) | `SetTeam` DOES work on AISpawner bots |
| Remove a backfill bot | existing `undeployBotForTeam` / `UnspawnAllAIsFromAISpawner`; `AISetUnspawnOnDead` | humans replacing bots (rule 4) — code already half-does this |
| React to engine team change | `OnPlayerSwitchTeam(player, team)` | detect if engine moved someone |
| Human joins / leaves | `OnPlayerJoinGame` / `OnPlayerLeaveGame` (leave passes a NUMBER id) | mark slot for next-round reconcile |
| Even-team swap | `SwitchTeams(teamA, teamB)` | needs equal human+bot counts; **`SwitchTeams(1,2)` is BROKEN (visual-only)** per DICE testers — avoid |

## Hard engine constraints (from Discord — the walls we design around)
- **Humans can't be freely reassigned.** `SetTeam(human)` forces them to the deploy screen and throws `"team input invalid"` if already on that team (this is the current `balanceTeams()` crash). Only reliable on **AISpawner bots**, only when **undeployed** and **not already on the target team**.
- **`SwitchTeams(GetTeam(1), GetTeam(2))` is broken** (visual refresh only, players don't swap). `SwitchTeams(0,1)` works. Needs matching human+bot counts.
- **Players auto-join team 1 on connect.**
- **`DisablePlayerJoin()` is one-way** — cannot re-enable without a server restart. So can't use it to hold the lobby and later reopen.
- **"Only 2 can start the match"** is an EA lobby limitation (author-documented); extras queue until next map load.

## The pivotal question — RESOLVED (Discord research 2026-07-14)
**Humans DO keep their team across a map reload.** Players are NOT reset to team 1 or reshuffled on a
map change — team assignment persists (source: _akroma_, connorjc, mikedeluca). So rule 5 (cross-map
squad stability) IS achievable; we mostly just re-backfill bots each map. Caveats to design around:
- **Default engine side-swap each game:** the engine flips everyone Team1↔Team2 at end-of-game, with
  FACTIONS pinned to the team SLOT (not the players). Set team faction settings to NOT "map default,"
  and either lean into the swap (symmetric spawns — Deadlock already swaps sides mid-match) or override
  team state right before `EndGameMode` (it carries into the next map).
- **You can carry team state forward:** manually rebalance right before ending the game and it persists.
- Returning/disconnected-human reclaim of prior team on rejoin is NOT spec'd (anecdotally sticky).

## Resolved decisions (2026-07-14)
- **Sizing:** scale-to-humans, no floor (Q1). 2→1v1, arena grows to 4v4; bots even the odd slot only.
- **Squad source:** real game party via `GetSquad(player)` (Q3). ⚠ verify GetSquad exposes queued-together parties.
- **Cohesion vs balance:** **whole-up-to-cap, overflow spills** (Q2) — fill a party's team to cap, spill extras to the other team. Keep as many together as fit; keep human counts even.

## PRIORITY ORDER (author 2026-07-14 — the governing ruleset; supersedes earlier sizing text)
1. **A HUMAN ON EACH TEAM — "at all cost."** Whenever ≥2 humans are present, BOTH teams must hold ≥1
   human. Never all-friends-vs-all-bots — there must always be a human to fight. This can FORCE splitting
   a friend group when it is the ONLY human group.
2. **Friends stay together — when possible.** Keep a friend-group on ONE team so a team is homogeneous
   (all-friends OR non-friends), never friends + a random. Purpose: no cross-team friend collusion / no
   "calling out" a non-friend teammate. Applies once rule 1 is already satisfied by OTHER humans.
3. **Balanced team SIZES.** Equal seats per team; fill the short side with bots. Human counts may be
   uneven — "3 friends vs 1 random + 2 bots" IS balanced (3v3 seats).
4. **Reconcile at round boundaries.** A leaver → rebalance next ROUND, keeping the started/joined-together
   groups intact. A joiner → enters at next MAP load into a bot's seat, assigned to their friend group,
   or to the enemy side to satisfy rule 1.

## Worked cases (these RESOLVE the old "start vs map-reload" question — it was never timing, but whether another human exists to cover the enemy side)
- 2 friends, nobody else → **1v1** (must split — only way each side gets a human).
- 3 friends, nobody else → **2v1 + 1 bot** (split 1 off → 2v2 seats).
- 3 friends + 1 random → **3 friends vs (1 random + 2 bots) = 3v3** (random covers rule 1 → friends reunite). ← "3v1+2bots".
- N friends alone → split off exactly 1 → (N-1) vs (1 + bots), capped at 4/team.

## Assignment algorithm (to build)
At each round boundary / map start: detect humans + friend-groups (`GetSquad` + join-proximity heuristic) →
1. If only ONE human group exists (all friends): split off exactly 1 member to the enemy team (rule 1); keep the rest together.
2. If ≥2 groups/humans exist: largest group on team A, remaining human(s) on team B → both teams have a human AND groups stay whole (rule 1 + 2).
3. `teamSize = min(4, max(humansA, humansB))`; backfill each team to `teamSize` with bots (`SpawnAIFromAISpawner(spawner, team)`).
4. Leaver → rebalance next ROUND keeping groups. Joiner → next MAP load into a bot seat, per rule 1/2.
⚠ Splitting/moving a HUMAN across teams is the fragile `SetTeam` path (undeploy-first, needs a free slot) — only at round/map boundaries when players are undeployed. `AutoBalanceTeams()` can help even seats but won't enforce rule 1, so we drive the group logic ourselves.

## Squad detection — RESOLVED approach
`GetSquad(player)` works since SDK 1.2.1.0 (compare squads, `GetSquadName`, `IsSquadLeader`), BUT there is
**no API for who QUEUED TOGETHER as a party** (no party-id; squads may be engine-synthetic). The engine
auto-drops a real party onto the host's team (team 1) by default. Field-proven approach: **join-time
proximity heuristic** (humans who join within a short window = treat as one party) cross-checked with
`GetSquad`. Also: NO per-squad script variables; `AutoBalanceTeams()` still occasionally splits squads
(use a +/-2 threshold, don't split a 2-stack).

## Bot backfill — RESOLVED approach
Use **scripted AI_Spawner bots** (`SpawnAIFromAISpawner(spawner, class, team)`), NOT the native "Bot
Backfill" team setting (native backfill forces a min-human start floor and can't do 1v1/2v2/2v1 sizing;
scripted bots have no start floor in custom experiences and are the ONLY bots you can `SetTeam`/command).
Deadlock already does this ("custom backfill AI"). Manage bot lifecycle yourself — `AISetUnspawnOnDead(false)`
does NOT reliably keep a bot across death. Any human `SetTeam`/`SwitchTeams`/`AutoBalanceTeams` needs an
EMPTY slot to move through (fails on full teams) → keep a free slot or a scratch team; undeploy before
`SetTeam`; NEVER `SetTeam` inside `OnPlayerJoinGame`.

## Still open (minor)
- Q-cap: confirm the CURRENT start-cap (2 vs 4) live — affects how many can seed a match.
- Whether queued joiners enter on the smaller team or by capacity order at map-load (undocumented).
