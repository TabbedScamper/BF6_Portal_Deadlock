# Deadlock — Architecture & Contributor Guide

Deadlock is a Call-of-Duty-MW2019-style **Gunfight** mode for BF6 Portal: two small teams,
a fresh **shared rotating loadout** each round, first team to eliminate the other (or capture
the overtime flag) takes the round, first to the round target takes the match. Built on the
deluca-mike TypeScript scripting template.

This doc is the **map** of the codebase: read it once and you'll know where everything lives.
Two subsystems are complex enough to have their own deep-dive docs — this guide links to them
rather than repeating them:
- **`SPECTATE-FLOW.md`** — the full death/deploy/spectate state machine (every transition, file:line).
- **`TEAM-SORTING-SPEC.md`** — the team/squad sorting rules and the minimal-correction algorithm.

Every file also has a top-of-file header (or is small enough not to need one); this guide is the
*where and how it connects*, the headers are the *why* of each file's tricky parts.

- **Build:** `npm run build` → `bf6-portal-bundler` bundles `src/index.ts` (+ all imports) into
  `dist/bundle.ts` and merges every `strings.json` into `dist/bundle.strings.json`.
- **Deploy:** `npm run deploy` (build + upload).
- **Typecheck gate:** `npx tsc --noEmit` — the bundler does **NOT** typecheck, so run this before every commit.
- **Entry point:** `src/index.ts` — everything is wired up there. Start with `OnGameModeStarted`.

---

## 1. The big ideas (grok these first)

1. **A round is a shared-loadout duel.** Every player (both teams) gets the *same* randomly-picked
   loadout each round (`gunfight/loadout.ts`); the loadout rotates every 2 rounds. Winning is by
   **elimination** (wipe the other team) or, if the round timer runs out, **higher total team health**
   — and if that ties, an **overtime flag** spawns and the first team to capture it wins. First team
   to the match target (a round count) wins the match.

2. **Live-spectate is choreographed around an engine bug.** Dead players watch their teammates via
   `SpawnModes.Spectating`. The engine *wedges* ("waiting for soldier deployment") if the spectate
   pool ever has no valid target. The entire round-transition dance in `index.ts` exists to keep a
   valid target in the pool at every instant. **Do not touch spawn-mode / deploy ordering without
   reading `SPECTATE-FLOW.md`** — it is scar tissue from a real, hard-to-reproduce bug.

3. **Team sorting is *minimal correction*, not reassignment.** The engine already groups a party
   onto one team, and human `SetTeam` is fragile — so we move a human only when "a human on each
   team" (rule 1) is violated, and scale team size to the human count (true 1v1 up to 4v4), bots
   filling only the short side. See `TEAM-SORTING-SPEC.md`.

4. **Bots run a per-tick sense → think → act brain** (`src/bot-ai/`) with **no wallhacks**: a single
   round-robin `RayCast` per tick gates enemy detection (`los.ts`). They chase last-known positions,
   un-jam off walls, and go all-in on the flag in overtime. The brain is shared lineage with
   FFA-Gunmaster — comments tag ported behavior.

5. **Two separate bot switches — never conflate them:**
   - `ENABLE_CUSTOM_BOTS` (`index.ts`) = the named-bot **backfill** (keep **true** for release — it
     puts an opponent on the enemy team so a solo human still gets a 1v1).
   - `DEBUG_MODE` (`config.ts`) = a forced **full** bot lobby for solo testing **plus** all
     `[EVT]/[TLM]` telemetry. Keep **false** for release.

6. **The engine is quirky, and the comments say so.** RayCast hits the caster, VO to a team-object
   goes silent, a 50ms native-throw loop stack-dumps to PortalLog (= real lag), `SetTeam` is
   fragile. When code looks over-engineered, the header almost always names the bug that forced it.

---

## 2. The round lifecycle (the flow)

Follow this in `index.ts` and you understand the whole mode.

```
OnGameModeStarted
  ├─ resetScores · randomizeBotNames · initScoreboard · new FlagCaptureUI
  ├─ reconcileTeams()            seat humans (rule 1) + size teams        (TEAM-SORTING-SPEC.md)
  ├─ SetSpawnMode(AutoSpawn) + team-only spectate filters + DeployAllPlayers
  └─ (first OnPlayerDeployed flips roundStarted → schedules startRound in 500ms)

startRound()                     ← also the per-round entry from the loop below
  ├─ reconcileTeams() + spawnBackfillBots() + freezeBots()
  ├─ every 2nd round: pick a new shared loadout                          (loadout.ts)
  ├─ (every 3rd round: swap sides before deploy)
  └─ countdownUI.start(15s round 1, else 5s)  → teleport to spawn seats, freeze, EQUIP loadout

handleCountdownEnd()  (countdown over → round is LIVE)
  ├─ resetEliminationTracking() · activateBots()
  ├─ SetSpawnMode(Spectating)    ← dead players now spectate teammates
  └─ TeamHealthUI 40s round timer starts ticking

Live round
  ├─ tickAllBotBrains()          sense→think→act per bot                 (bot-ai/brain.ts)
  ├─ OnRayCastHit/Missed         feed bot LOS                            (bot-ai/los.ts)
  ├─ OnPlayerDamaged             damage ledger (for assists) + retaliate hook
  └─ OnPlayerDied / OnMandown    → checkRoundEnd()  (elimination?)

Round timer hits 0
  └─ higher team health wins; exact tie → 10s OVERTIME → raise flag      (flag-capture-ui.ts)
        flag captured → that team wins the round

finishRound()  (all three enders converge here: elimination / timeout / flag)
  ├─ stop bots, heal + disarm survivors, freeze
  ├─ showRoundResults()          win/loss/draw card + authoritative score (round-result-ui.ts)
  ├─ progress VO
  └─ match won (first to the round target)? → endMatchDeployed()
     else after 5s: reviveSequence → deployAllAtStartPositions → resetRound → startRound
```

`endMatchDeployed()` force-deploys everyone (out of Spectating) **before** `EndGameMode`, or the
spectator state carries into the next map — another face of the spectate bug.

---

## 3. Spatial-object ID contract (set these on the LEVEL)

Bots and rounds read fixed spatial ObjIds placed in the Godot level. Get these wrong and spawns
land at world origin or the flag never appears. This is the single map that was previously scattered
across three files:

| ObjId(s) | Meaning | Read in |
|---|---|---|
| **1–4** | Team spawn seats (players teleported here at countdown) | `index.ts` (`initSpawnPositions`) |
| **5** | Overtime flag object (raised only in overtime) | `gunfight/ui/flag-capture-ui.ts` |
| **10–20** | Death-zone area triggers (instant-kill volumes) | `index.ts` (`OnPlayerEnterAreaTrigger`) |

---

## 4. Directory / file map

### Core / entry
| File | What it does |
|---|---|
| `index.ts` | **Entry point / orchestrator.** Every `Events.*` handler, the round state machine, custom-bot backfill + team sorting, the spectate choreography, sounds/VO, damage/assist tracking, death zones. Exports `playSound`, `playVO`, `getCurrentRoundNumber`, `ensureLiveSpawnMode`. Read `OnGameModeStarted` first. |
| `config.ts` | **The control panel.** `PLAYERS_PER_TEAM`, `MIN_TEAM_SIZE`, `LIVE_SPECTATE`, `DEBUG_MODE`, `SFX_MASTER_VOLUME`/`sfxVol()`. Change mode feel here first. |
| `helpers/index.ts` | Shared utilities: player/team enumeration, the rejected-player set (mid-round-spawn exclusion), equipment removal, event-message UI. |

### Bot AI (`src/bot-ai/`) — a portable sense→think→act module (see its `index.ts` header)
| File | What it does |
|---|---|
| `brain.ts` | Per-bot **BotBrain**: runs sensors, holds memory, ticks the selector, humanized movement, retaliation lock, overtime weight-swap. The **stuck watchdog / wall-jam un-stick** is here. |
| `memory.ts` | `BotMemory` — TTL key/value store so bots "forget" (defines `BotMemoryFields`). |
| `sensors.ts` | Reads the world into memory: probabilistic `senseEnemy` (+ LOS gate), roam scoring, arrival, flag tactics. `SENSOR_CONFIG` tunables. |
| `behaviors.ts` | **Weight-based selector.** Maps memory keys → behaviors and executes the `mod.AI*` call. `DEFAULT_WEIGHTS` vs `OVERTIME_WEIGHTS` (flag beats combat in OT). |
| `los.ts` | Line-of-sight: one round-robin `RayCast`/tick → `canSeeEnemy()`. The best-documented engine quirk in the repo (`EYE_FORWARD`, TTL ceiling). |
| `index.ts` | Barrel + module architecture note. |

### Progression / roster
| File | What it does |
|---|---|
| `gunfight/loadout.ts` | The shared-loadout data + randomizer: stock/custom pools, per-weapon stock attachment tables, signature themed kits, shuffle-bag picker. |
| `roster.ts` | The custom scoreboard (damage/kills/deaths/assists/captures) **and** the persistent bot-identity system (names + stats that survive respawns; survivor-aware round reconcile — the "duplicate bot name" fix). |

### UI (`src/gunfight/ui/`) — persistent widgets, per-player
| File | What it does |
|---|---|
| `countdown-ui.ts` | Round-start countdown **plus** teleport-to-seats, freeze/input-lock, weapon equip, bot spacing, and the countdown→live spawn-mode handoff. Outsized responsibility — treat as its own module. |
| `round-result-ui.ts` | Win/loss/draw result cards **and the authoritative match score** (`team1Score`/`team2Score`). Score source of truth. |
| `team-health-ui.ts` | Top-center team health bars, alive dots, score ticks, **and the 40s round + 10s overtime timer** the whole mode depends on. |
| `flag-capture-ui.ts` | Overtime flag (ObjId 5) raise/hide, beacon FX, 3s capture detection, per-player capture bar. The OT win condition. |
| `loadout-ui.ts` | The "NEW LOADOUT" card **and the actual weapon/gadget equip path**; defines the `Loadout` interface. |
| `elimination-ui.ts` | The "X v Y" alive-count transition on each kill; reports whether a kill was the final elimination. |

### Dev-only
| File | What it does |
|---|---|
| `debug-tool/index.ts` | Admin-only triple-click debug menu (SDK-template boilerplate). Gated by `PRODUCTION_MODE`. |
| `telemetry/index.ts` | Structured `[EVT]/[TLM]` → PortalLog + native perf heartbeat. Gated by `DEBUG_MODE`. |
| `spectate-track.ts` | `[SPEC]` diagnostic tracer for the death/deploy/spectate machine. Gated by `SPEC_TRACK`. |

---

## 5. Round state-flag glossary (`index.ts`)

The round loop is driven by a handful of module-level booleans. Reading them wrong is the easiest
way to break the mode:

| Flag | Meaning |
|---|---|
| `roundStarted` | A round is live (set on the first deploy; gates mid-round-spawn rejection). |
| `roundEnding` | The round is being torn down (suppresses the mid-round spawn-reject so the transition can redeploy). |
| `matchEnding` | The match is over / world tearing down — every loop must stand down (crash-on-exit guard). |
| `inRoundTransition` | Between rounds: spectate filters widened to All so dead players fall through to winners. |
| `sidesSwapped` | Tracks the every-3rd-round side swap (`(nextRound-1) % 3 === 0`). |

---

## 6. "I want to change X" — where to go

| Goal | Where |
|---|---|
| Mode size (1v1–4v4), min team size, spectate mode, SFX volume, debug | **`config.ts`** — start here |
| Which weapons/kits rotate, signature loadouts, rotation cadence | `gunfight/loadout.ts` |
| Bot aggression / priorities | `bot-ai/behaviors.ts` (`DEFAULT_WEIGHTS`/`OVERTIME_WEIGHTS`) + `bot-ai/sensors.ts` (`SENSOR_CONFIG`) |
| Bot vision range / wall behavior | `bot-ai/los.ts` (`EYE_FORWARD`, TTL) + `sensors.ts` |
| Team seating / how bots backfill | `index.ts` (`reconcileTeams`, `spawnBackfillBots`) + `TEAM-SORTING-SPEC.md` |
| Anything about death/respawn/spectate | `SPECTATE-FLOW.md` first, then `index.ts` + `countdown-ui.ts` |
| Round timer / overtime length | `gunfight/ui/team-health-ui.ts` (see the timing caveat below) |
| Result cards / match-win target | `gunfight/ui/round-result-ui.ts` |
| Spawn seats / flag / death zones | the **spatial-ID contract** (section 3) — set on the level |

---

## 7. Timing couplings to keep in sync (not yet centralized)

A few gameplay constants live as bare literals and are coupled across files — noted here so a change
in one place doesn't silently desync the mode:

- **Elimination delay** (`index.ts`, ~1600ms) must cover the elimination animation total defined in
  `elimination-ui.ts`.
- **Round 40s + overtime 10s** live only in `team-health-ui.ts`.
- **Match-win target** and **countdown 15s/5s** are literals in `index.ts`.
- A few `MIN_DISTANCE = 0.5` comments say "1 meter" — the unit comment is off; the value is meters.
- Some fields are legacy/unused (`botsInterestedInFlag`, `BOT_RETARGET_CHANCE` /
  `BOT_MOVE_TOWARD_CHANCE` / `BOT_FLAG_INTEREST_CHANCE`) — the bot-brain system superseded them; they
  don't drive behavior anymore.

---

## 8. Engine gotchas baked into this code (don't "fix" these)

- **Sticky spectator session** ("waiting for soldier deployment") → the whole live-spectate
  choreography (`SPECTATE-FLOW.md`); never reorder spawn-mode/deploy calls blindly.
- **`RayCast` hits the caster** → LOS ray starts `EYE_FORWARD` in front; too large punches through a
  hugged wall (`los.ts`).
- **VO to a team-object is silent / `PlayVO` has no volume** → VO is targeted per-player and its
  loudness is engine-fixed (lower `SFX_MASTER_VOLUME` to make VO stand out).
- **A 50ms loop that lets a native throw stack-dumps to PortalLog** = real lag → dead/invalid players
  are pruned from the freeze lists (`countdown-ui.ts`).
- **`SetTeam` on a human is fragile** → minimal-correction sorting, undeploy before `SetTeam`
  (`TEAM-SORTING-SPEC.md`).
- **Bots multi-spawned in one frame get culled / stale brains leak** → backfill is measured and
  `removeBotBrainById` frees a brain after the engine body is already gone (`roster.ts`/`brain.ts`).

---

*Every file's top-of-file header goes deeper on its own tricky parts, and `SPECTATE-FLOW.md` /
`TEAM-SORTING-SPEC.md` are the deep dives for the two hardest subsystems. When something looks weird,
read the header before changing it — it almost certainly explains why.*
