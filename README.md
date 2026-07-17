# Deadlock

A round-based **gunfight** mode for Battlefield 6 Portal — small-team elimination (1v1 up to 4v4)
with an overtime capture flag, smart backfill bots, and a fully custom UI.

Built on [deluca-mike's bf6-portal-scripting-template](https://github.com/deluca-mike/bf6-portal-scripting-template)
(v1.6.0 base). By TabbedScamper.

## The mode

- **Rounds:** teams fight to elimination; if time runs out, an overtime **capture flag** decides the round.
- **Team size is dynamic** — set `PLAYERS_PER_TEAM` in `src/config.ts` (1–4). With fewer humans the
  mode scales down (2 humans = a true 1v1) and **bots backfill only the odd seat**.
- **Squads stay together:** parties that join together are never split across teams.
  Full rules + edge cases: **`TEAM-SORTING-SPEC.md`** (the living design doc).
- **Loadouts:** pick weapon kits between rounds (loadout UI + full attachment tables).
- **Custom UI suite:** countdown, team health, eliminations feed, round results, flag capture,
  loadout select (`src/gunfight/ui/`).

## The bot AI (`src/bot-ai/`)

Bots are deliberately **not omniscient** — they sense, remember, and forget:

| Module | Role |
|---|---|
| `memory.ts` | TTL-based memory — bots *forget* enemy positions over time |
| `sensors.ts` | Probabilistic detection (range/sensitivity), roam picking, flag awareness |
| `los.ts` | Real line-of-sight via raycasts — throttled to 1 cast/tick, cached with TTL, skipped point-blank |
| `behaviors.ts` | Weighted priority selection: engage > search > patrol > flag push |
| `brain.ts` | The sense–think–act coordinator, one brain per bot |

Based on the bf6-portal-bots-brain pattern; tuned aggressive (guaranteed detection ≤20 m,
always-seen ≤7 m so bots never freeze in your face).

## Config knobs

- `src/config.ts` — `PLAYERS_PER_TEAM`, `DEBUG_MODE` (forces a full bot lobby for solo testing +
  writes `[EVT]`/`[TLM]` telemetry to PortalLog; **set `false` for release**), `DEBUG_TEAM_SIZE`.
- `SENSOR_CONFIG` (`src/bot-ai/sensors.ts`) — detection ranges/rates, memory TTLs, roam distances.
- `BEHAVIOR_CONFIG` / `DEFAULT_WEIGHTS` (`src/bot-ai/behaviors.ts`) — behavior priorities.

## Build & deploy

```bash
npm install
npm run build      # -> dist/bundle.ts + dist/bundle.strings.json
npm run deploy     # build + upload via @bf6mods/portal (needs .env)
```

## Verify in-game (open items from the spec)

Telemetry to watch in PortalLog (`[EVT] team.reconcile`, `[EVT] team.moveHuman`):
1. Does `GetSquad` group real parties (vs synthetic squads)?
2. Does the engine keep a party on one team and auto-balance randoms?
3. Does human `SetTeam` land reliably at match/round start?
4. Do bot backfill counts come out right as humans join/leave?

## Playtest checklist — 2026-07-17 fixes

**Spectator wedge ("waiting for soldier deployment") fix:**
1. Die with teammates alive → spectate a TEAMMATE (never the enemy while the round is live).
2. Your last teammate dies (round over) → spectate falls through to a frozen winner behind the
   result overlay — NO "waiting for soldier deployment", NO deploy screen, NO cursor-lock.
3. New round: everyone force-deploys, teleported + frozen into the countdown; spectate back to team-only.
4. Mutual wipe (grenade trade in 1v1 is the easy repro) → both respawn frozen, round result shows, next round proceeds.
5. Play several full matches — the cursor-locked "UI mode" state should never appear.
   PortalLog markers: `Round transition: spectate pool widened` / `mutual wipe -> force redeploy`.

**Stat-tracking fix (survivor carry-over):**
6. Survive a round with partial HP; next round, your FIRST hit on an enemy should register damage
   on the scoreboard (previously swallowed) and assists should never come from last round's damage.

**Round-teardown consolidation (behavior should be IDENTICAL):**
7. All three round endings look/sound unchanged: elimination result, time-out health-win result
   (isHealthWin), flag-capture result, draws (tied health + mutual wipe), side swaps every 3
   rounds, match end at 6 wins.

**Elimination counter fix:**
8. First kill of a 1v1 round animates 1v1 -> 1v0 (NOT 4v4 -> 1v0); a 3v3 shows 3v3 -> 3v2.
   Spam-kills in quick succession produce no UI errors/stacking.

**Overtime sound fix (was stacking with player count):**
9. With 2+ humans: overtime tick beeps and the "time low" VO play ONCE per player (previously
   N humans = N stacked beeps/VOs — got louder with bigger lobbies).

**Late-joiner UI fix:**
10. A player who deploys DURING the pre-round countdown gets the full HUD for that round
    (team health bars, round timer, score ticks) — previously they had none until next round.

**Audio pass (SFX master volume + VO fixes):**
11. Overall SFX noticeably quieter/leveled (one knob: `SFX_MASTER_VOLUME` in src/config.ts,
    default 0.6) while announcer VO is unchanged — VO should now stand out. Join ping plays
    ONCE per genuinely new player (quieter), NOT a burst at match start / every round.
12. OVERTIME VO BUG: when someone stands on the flag, the capturing team hears "taking the
    objective" and defenders hear "contested" — every player, every time (was silent).
    Both teams hear contested when the flag is disputed.
13. "We're winning/losing" progress VO after each round now follows the MATCH SCORE (a team
    behind 1-4 that wins a round hears LOSING, not winning). Tied score = no progress line.

## Repo notes

- Repo: [TabbedScamper/BF6_Portal_Deadlock](https://github.com/TabbedScamper/BF6_Portal_Deadlock) (`origin`); deluca's template kept as the `template` remote for pulling template updates.
- `spatials/` + `pages/` are template-standard; `Deadlock.png/.jpg` are the mode art/thumbnail.
