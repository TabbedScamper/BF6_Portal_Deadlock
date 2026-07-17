import { Events } from 'bf6-portal-utils/events/index.ts';
import { Timers } from 'bf6-portal-utils/timers/index.ts';
import { MultiClickDetector } from 'bf6-portal-utils/multi-click-detector/index.ts';
import { MapDetector } from 'bf6-portal-utils/map-detector/index.ts';
import { Vectors } from 'bf6-portal-utils/vectors/index.ts';

import { DebugTool } from './debug-tool/index.ts';
import { PLAYERS_PER_TEAM, DEBUG_MODE, DEBUG_TEAM_SIZE } from './config.ts';
import {
    getPlayerStateVectorString,
    getPlayersOnTeam,
    getAlivePlayersOnTeam,
    rejectPlayer,
    clearRejectedPlayers,
    logHelperStats,
    removeAllEquipment,
} from './helpers/index.ts';

// Bot AI system - realistic awareness without omniscience
import { getBotBrain, resetBotBrain, clearAllBotBrains, tickAllBotBrains, logBrainStats } from './bot-ai/index.ts';
import { getRandomLoadout } from './gunfight/loadout.ts';
import { associateBotWithIdentity, deactivateBotIdentity, getAvailableBotIdentity, getBotIdentityByPlayerId, getPlayerStats, initScoreboard, randomizeBotNames, resetBotIdentitiesForRound, updateScoreboard , knownBotIds, setRosterLogger } from './roster.ts';
import type { BotIdentity, PlayerStats } from './roster.ts';

// Structured telemetry -> PortalLog (the "MCP-like" live view). See telemetry/index.ts.
import { Tlm, startPerfHeartbeat } from './telemetry/index.ts';

// Bot line-of-sight (raycast round-robin) so bots don't see through walls. See bot-ai/los.ts.
import { updateLos, onRayHit, onRayMiss, clearLos, getLosCastCount } from './bot-ai/los.ts';

// ========== DEBUG LOGGING FOR MAIN GAME LOOP ==========
const DEBUG_MAIN = false;
let _roundStarts = 0;
let _roundEnds = 0;
let _playerDeaths = 0;
let _playerDeploys = 0;
let _eliminationChecks = 0;
let _botTargetUpdates = 0;

function logMain(msg: string, ...args: any[]): void {
    if (DEBUG_MAIN) console.log(`[MAIN] ${msg}`, ...args);
}

// Call this periodically to see helper call frequency
let _helperStatsInterval: number | null = null;
function startHelperStatsLogging(): void {
    if (_helperStatsInterval) return;
    _helperStatsInterval = Timers.setInterval(() => {
        logHelperStats();
        logBrainStats(); // Log bot brain stats
        logMain('MAIN STATS:', {
            roundStarts: _roundStarts,
            roundEnds: _roundEnds,
            playerDeaths: _playerDeaths,
            playerDeploys: _playerDeploys,
            eliminationChecks: _eliminationChecks,
            botTargetUpdates: _botTargetUpdates,
        });
    }, 5000);
}
// ======================================================
import {
    CountdownUI,
    type Loadout,
    TeamHealthUI,
    showRoundResults,
    showRoundDraw,
    hideAllRoundResults,
    resetScores,
    getScores,
    showEliminationEffect,
    hideEliminationEffect,
    resetEliminationTracking,
    FlagCaptureUI,
} from './gunfight/index.ts';

// ============================================================================
// PRODUCTION MODE - Set to true to disable debug tools
// ============================================================================
const PRODUCTION_MODE = true;

// ============================================================================
// TEAM BALANCING CONFIGURATION
// ============================================================================
// CUSTOM BOT CONFIGURATION
// ============================================================================
// Enable/disable custom backfill bots (set to false to use Portal default bots)
const ENABLE_CUSTOM_BOTS = true;
// PLAYERS_PER_TEAM is imported from config.ts (change it there)
// Targeting update interval (every 500ms for more responsive bots)
const BOT_TARGET_UPDATE_MS = 150; // targeting cadence; snappier reaction (roster is small, ~0.5ms/tick)
// Bot unspawn delay after death (seconds)
const BOT_UNSPAWN_DELAY = 2;
// Delay before bots start chance-based targeting (after initial target)
const BOT_INITIAL_TARGET_DURATION_MS = 4000;
// Chance to retarget nearest enemy each update (40%)
const BOT_RETARGET_CHANCE = 0.4;
// Chance to actively move toward target each update (30%)
const BOT_MOVE_TOWARD_CHANCE = 0.3;
// Chance to move toward flag when it spawns (80%)
const BOT_FLAG_INTEREST_CHANCE = 0.8;
// ============================================================================

let adminDebugTool: DebugTool | undefined;
setRosterLogger((m) => adminDebugTool?.dynamicLog(m));
let telemetryInterval: number | undefined;
let countdownUI: CountdownUI | undefined;
let flagCaptureUI: FlagCaptureUI | undefined;
let roundNumber = 0;
let roundStarted = false;
let currentLoadout: Loadout | undefined;
let resettingRound = false;
let roundEnding = false;
let matchEnding = false; // Prevents any new rounds from starting when match is won
let lastKiller: mod.Player | null = null;

// Custom bot tracking (spawners only - bots found dynamically via getBotsOnTeam)
let botTargetingInterval: number | null = null;
let losInterval: number | null = null;
let team1Spawners: mod.Spawner[] = [];
let team2Spawners: mod.Spawner[] = [];

// Bot AI state
let botInitialTargetPhase = false; // True during first 5 seconds after countdown
let botFlagActive = false; // True when overtime flag is spawned
let botFlagSpawnTime = 0; // Timestamp when flag spawned (for urgency calculation)
let botsInterestedInFlag: Set<number> = new Set(); // Bot IDs that rolled to go to flag (legacy, unused)

// Spawn positions from spatial objects (IDs 1,2 for side 1 and IDs 3,4 for side 2)
// Expanded to 4 positions per side via 1m offsets for 3v3/4v4 support
let side1SpawnPositions: mod.Vector[] = [];
let side2SpawnPositions: mod.Vector[] = [];
let spawnPositionsInitialized = false;
let sidesSwapped = false;

// Offset distance for additional spawn points (meters)
const SPAWN_OFFSET_DISTANCE = 1.0;

// Create an offset position (perpendicular to flag direction)
function createOffsetPosition(basePos: mod.Vector, offsetIndex: number): mod.Vector {
    // Offset perpendicular to the spawn line (X-axis offset)
    // offsetIndex 0 = no offset, 1 = +1m, 2 = -1m, 3 = +2m, etc.
    const offsetDir = offsetIndex % 2 === 0 ? 1 : -1;
    const offsetMag = Math.ceil((offsetIndex + 1) / 2) * SPAWN_OFFSET_DISTANCE * offsetDir;

    return mod.CreateVector(
        mod.XComponentOf(basePos) + offsetMag,
        mod.YComponentOf(basePos),
        mod.ZComponentOf(basePos)
    );
}

// Initialize spawn positions from spatial objects
// Generates up to 4 positions per side by offsetting base positions
function initSpawnPositions(): void {
    if (spawnPositionsInitialized) return;

    try {
        // Side 1 spawn points (spatial IDs 1 and 2)
        const spawn1 = mod.GetSpatialObject(1);
        const spawn2 = mod.GetSpatialObject(2);
        const pos1 = mod.GetObjectPosition(spawn1);
        const pos2 = mod.GetObjectPosition(spawn2);

        // Generate 4 positions: base1, base2, offset1, offset2
        side1SpawnPositions = [
            pos1, // Position 1 (original)
            pos2, // Position 2 (original)
            createOffsetPosition(pos1, 1), // Position 3 (offset from pos1)
            createOffsetPosition(pos2, 1), // Position 4 (offset from pos2)
        ];

        // Side 2 spawn points (spatial IDs 3 and 4)
        const spawn3 = mod.GetSpatialObject(3);
        const spawn4 = mod.GetSpatialObject(4);
        const pos3 = mod.GetObjectPosition(spawn3);
        const pos4 = mod.GetObjectPosition(spawn4);

        // Generate 4 positions: base3, base4, offset3, offset4
        side2SpawnPositions = [
            pos3, // Position 1 (original)
            pos4, // Position 2 (original)
            createOffsetPosition(pos3, 1), // Position 3 (offset from pos3)
            createOffsetPosition(pos4, 1), // Position 4 (offset from pos4)
        ];

        spawnPositionsInitialized = true;
        adminDebugTool?.dynamicLog(`Spawn positions initialized: ${side1SpawnPositions.length} per side`);
    } catch (e) {
        // Spatial objects not found
    }
}

// ============================================================================
// CUSTOM BOT SYSTEM (Backfill)
// ============================================================================
// Bots fill all slots at round start. When a human player deploys,
// a bot from their team is undeployed to make room.
// ============================================================================

// Count human players on a team
function countHumansOnTeam(teamId: number): number {
    const players = getPlayersOnTeam(teamId);
    let count = 0;
    for (const player of players) {
        try {
            if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                count++;
            }
        } catch {}
    }
    return count;
}

// Count bots on a team
function countBotsOnTeam(teamId: number): number {
    const players = getPlayersOnTeam(teamId);
    let count = 0;
    for (const player of players) {
        try {
            if (mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                count++;
            }
        } catch {}
    }
    return count;
}

// Get bots on a team (also tracks bot IDs for sound filtering)
function getBotsOnTeam(teamId: number): mod.Player[] {
    const players = getPlayersOnTeam(teamId);
    const bots: mod.Player[] = [];
    for (const player of players) {
        try {
            if (mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                bots.push(player);
                knownBotIds.add(mod.GetObjId(player)); // Track for sound filtering
            }
        } catch {}
    }
    return bots;
}

// Spawn a single custom bot at the given position for the given team
function spawnCustomBot(teamId: number, position: mod.Vector): BotIdentity | null {
    if (!ENABLE_CUSTOM_BOTS) return null;

    // Get an available bot identity for this team
    const identity = getAvailableBotIdentity(teamId);
    if (!identity) {
        adminDebugTool?.dynamicLog(`No available bot identity for team ${teamId}`);
        return null;
    }

    try {
        const team = mod.GetTeam(teamId);

        // Create AI spawner at position (cast to Spawner for API compatibility)
        const spawner = mod.SpawnObject(
            mod.RuntimeSpawn_Common.AI_Spawner,
            position,
            mod.CreateVector(0, 0, 0)
        ) as unknown as mod.Spawner;

        // Configure spawner - don't auto-unspawn on death
        mod.AISetUnspawnOnDead(spawner, false);
        mod.SetUnspawnDelayInSeconds(spawner, BOT_UNSPAWN_DELAY);

        // Spawn AI from spawner with name and team
        mod.SpawnAIFromAISpawner(spawner, mod.SoldierClass.Engineer, mod.Message(identity.name + ' [BOT]'), team);

        // Track spawner for cleanup (bots are found dynamically via getBotsOnTeam)
        if (teamId === 1) {
            team1Spawners.push(spawner);
        } else {
            team2Spawners.push(spawner);
        }

        adminDebugTool?.dynamicLog(`Spawned bot with identity ${identity.id} for team ${teamId}`);
        return identity;
    } catch (e) {
        adminDebugTool?.dynamicLog(`Failed to spawn custom bot for team ${teamId}`);
        return null;
    }
}

// Track pending bot identities to associate after spawn
let pendingBotIdentities: BotIdentity[] = [];

// Spawn bots to fill all empty slots on both teams
function spawnBackfillBots(): void {
    if (!ENABLE_CUSTOM_BOTS) return;

    // Make sure spawn positions are initialized
    initSpawnPositions();

    // Determine spawn positions based on side swap
    const team1Positions = sidesSwapped ? side2SpawnPositions : side1SpawnPositions;
    const team2Positions = sidesSwapped ? side1SpawnPositions : side2SpawnPositions;

    // Count current humans on each team
    const team1Humans = countHumansOnTeam(1);
    const team2Humans = countHumansOnTeam(2);

    // Dynamic team size scales to the human count (bots only fill the short side).
    const targetSize = computeTargetTeamSize();

    // Calculate how many bots needed per team
    const team1BotsNeeded = Math.max(0, targetSize - team1Humans - countBotsOnTeam(1));
    const team2BotsNeeded = Math.max(0, targetSize - team2Humans - countBotsOnTeam(2));

    adminDebugTool?.dynamicLog(`Backfill: Team1 has ${team1Humans} humans, needs ${team1BotsNeeded} bots`);
    adminDebugTool?.dynamicLog(`Backfill: Team2 has ${team2Humans} humans, needs ${team2BotsNeeded} bots`);

    // Clear pending identities
    pendingBotIdentities = [];

    // Spawn bots for team 1 and track identities
    for (let i = 0; i < team1BotsNeeded && i < team1Positions.length; i++) {
        const identity = spawnCustomBot(1, team1Positions[i]);
        if (identity) {
            pendingBotIdentities.push(identity);
        }
    }

    // Spawn bots for team 2 and track identities
    for (let i = 0; i < team2BotsNeeded && i < team2Positions.length; i++) {
        const identity = spawnCustomBot(2, team2Positions[i]);
        if (identity) {
            pendingBotIdentities.push(identity);
        }
    }

    // Associate bots with identities after a short delay (bots spawn asynchronously)
    if (pendingBotIdentities.length > 0) {
        Timers.setTimeout(() => {
            associatePendingBots();
        }, 500);
    }

    adminDebugTool?.dynamicLog(`Backfill: spawned ${pendingBotIdentities.length} bots`);
}

// Associate pending bot identities with spawned bots
function associatePendingBots(): void {
    for (const identity of pendingBotIdentities) {
        const bots = getBotsOnTeam(identity.teamId);
        for (const bot of bots) {
            const botId = mod.GetObjId(bot);
            // Check if this bot is already associated with an identity
            if (!getBotIdentityByPlayerId(botId)) {
                associateBotWithIdentity(bot, identity);
                break; // Found a bot for this identity
            }
        }
    }
    pendingBotIdentities = [];
}

// Undeploy one bot from a team to make room for a human
function undeployBotForTeam(teamId: number): void {
    if (!ENABLE_CUSTOM_BOTS) return;

    // Find a bot on this team to undeploy
    const bots = getBotsOnTeam(teamId);

    if (bots.length === 0) {
        adminDebugTool?.dynamicLog(`No bots to undeploy for team ${teamId}`);
        return;
    }

    // Undeploy the first bot found
    const botToRemove = bots[0];
    const botId = mod.GetObjId(botToRemove);

    try {
        mod.UndeployPlayer(botToRemove);
        adminDebugTool?.dynamicLog(`Undeployed bot ${botId} for team ${teamId}`);
    } catch {
        adminDebugTool?.dynamicLog(`Failed to undeploy bot ${botId}`);
    }
}

// ============================================================================
// DYNAMIC TEAM SIZING + RULE-1 RECONCILE  (see TEAM-SORTING-SPEC.md)
// ============================================================================
// Priority: (1) a human on EACH team "at all cost"; (2) friends stay together
// -- the engine already groups a party onto one team, so we only intervene for
// rule 1; (3) balanced team SIZES with bots filling the short side. Teams scale
// to the human count: 2 humans = 1v1, 3 = 2v2 (+1 bot), up to 4v4.
// ============================================================================

// Seats per team this round = the larger human count, clamped to [1, PLAYERS_PER_TEAM].
// DEBUG: force a full lobby so a solo tester gets a real match (bot teammates + enemies).
function computeTargetTeamSize(): number {
    if (DEBUG_MODE) return DEBUG_TEAM_SIZE;
    const h1 = countHumansOnTeam(1);
    const h2 = countHumansOnTeam(2);
    return Math.max(1, Math.min(PLAYERS_PER_TEAM, Math.max(h1, h2)));
}

// DEBUG: log what the team-sorting WOULD decide for the spec's worked cases, so the human-
// distribution logic can be sanity-checked solo (real multi-human execution still needs a 2nd client).
function debugSimulateTeamSorting(): void {
    if (!DEBUG_MODE) return;
    const size = (h1: number, h2: number) => Math.max(1, Math.min(PLAYERS_PER_TEAM, Math.max(h1, h2)));
    // Each case = the human split the engine+rule-1 would settle on, and the resulting seats/bots.
    const cases = [
        { label: '2friends', h1: 1, h2: 1 }, // 2 friends -> rule1 splits -> 1v1
        { label: '3friends', h1: 2, h2: 1 }, // 3 friends -> split 1 -> 2v2 (+1 bot)
        { label: '3friends+random', h1: 3, h2: 1 }, // random covers rule1 -> 3v3 (+2 bots)
        { label: '4v4', h1: 4, h2: 4 },
    ];
    for (const c of cases) {
        const ts = size(c.h1, c.h2);
        Tlm.event('team.sim', {
            case: c.label,
            humans: `${c.h1}v${c.h2}`,
            seats: ts,
            botsT1: Math.max(0, ts - c.h1),
            botsT2: Math.max(0, ts - c.h2),
        });
    }
}

// Move exactly one human from -> to (to satisfy rule 1). Frees a bot slot on the
// target first, and prefers a NON squad-leader so a party keeps its leader together.
function moveOneHumanToTeam(fromTeamId: number, toTeamId: number): boolean {
    const humans = getPlayersOnTeam(fromTeamId).filter((p) => {
        try {
            return !mod.GetSoldierState(p, mod.SoldierStateBool.IsAISoldier);
        } catch {
            return false;
        }
    });
    if (humans.length <= 1) return false; // never strip the source team of its last human

    // Move someone from the SMALLEST squad group (a solo / non-party player first) so the
    // largest party stays whole (rule 2); tie-break toward a non-squad-leader. GetSquad
    // works since SDK 1.2.1.0; degrades to "last human" if squad data is unavailable.
    const squads: (mod.Squad | null)[] = humans.map((p) => {
        try {
            return mod.GetSquad(p);
        } catch {
            return null;
        }
    });
    const groupSizeFor = (i: number): number => {
        const s = squads[i];
        if (!s) return 1;
        let n = 0;
        for (const other of squads) {
            try {
                if (other && mod.Equals(s, other)) n++;
            } catch {}
        }
        return n;
    };
    let pick = humans[humans.length - 1];
    let bestScore = Infinity;
    for (let i = 0; i < humans.length; i++) {
        let leader = 0;
        try {
            leader = mod.IsSquadLeader(humans[i]) ? 1 : 0;
        } catch {}
        const score = groupSizeFor(i) * 10 + leader; // smallest group first, non-leader first
        if (score < bestScore) {
            bestScore = score;
            pick = humans[i];
        }
    }

    try {
        undeployBotForTeam(toTeamId); // make room on the target team (SetTeam needs a free slot)
        mod.UndeployPlayer(pick); // SetTeam requires an undeployed target
        mod.SetTeam(pick, mod.GetTeam(toTeamId));
        Tlm.event('team.moveHuman', { player: mod.GetObjId(pick), from: fromTeamId, to: toTeamId });
        return true;
    } catch {
        Tlm.event('team.moveHuman.fail', { from: fromTeamId, to: toTeamId });
        return false;
    }
}

// Ensure rule 1 (a human on each team) with the fewest possible human moves.
// The engine keeps parties together; we only split when ALL humans are on one team.
// Bot sizing is done by spawnBackfillBots (computeTargetTeamSize).
function reconcileTeams(): void {
    if (!ENABLE_CUSTOM_BOTS) return;

    let h1 = countHumansOnTeam(1);
    let h2 = countHumansOnTeam(2);

    // Rule 1: 2+ humans present but a team has none -> move a single human over.
    if (h1 + h2 >= 2 && (h1 === 0 || h2 === 0)) {
        const from = h1 > 0 ? 1 : 2;
        const to = from === 1 ? 2 : 1;
        if (moveOneHumanToTeam(from, to)) {
            h1 = countHumansOnTeam(1);
            h2 = countHumansOnTeam(2);
        }
    }

    Tlm.event('team.reconcile', {
        h1,
        h2,
        targetSize: Math.max(1, Math.min(PLAYERS_PER_TEAM, Math.max(h1, h2))),
    });
}

// Find closest enemy player to a bot
function findClosestEnemy(bot: mod.Player): mod.Player | null {
    try {
        const botTeam = mod.GetTeam(bot);
        const botTeamId = mod.GetObjId(botTeam);
        const botPos = mod.GetSoldierState(bot, mod.SoldierStateVector.GetPosition);

        let closestEnemy: mod.Player | null = null;
        let closestDistance = Infinity;

        // Get all players from both teams
        const allPlayers = [...getAlivePlayersOnTeam(1), ...getAlivePlayersOnTeam(2)];

        for (const player of allPlayers) {
            try {
                // Skip if same team
                const playerTeam = mod.GetTeam(player);
                if (mod.GetObjId(playerTeam) === botTeamId) continue;

                // Skip if same player
                if (mod.GetObjId(player) === mod.GetObjId(bot)) continue;

                // Get distance
                const playerPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
                const distance = mod.DistanceBetween(botPos, playerPos);

                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestEnemy = player;
                }
            } catch {}
        }

        return closestEnemy;
    } catch {
        return null;
    }
}

// Check if any enemy is on the flag capture zone
function isEnemyOnFlag(botTeamId: number): boolean {
    if (!botFlagActive || !flagCaptureUI) return false;

    const flagPos = flagCaptureUI.getFlagPosition();
    if (!flagPos) return false;

    const enemyTeamId = botTeamId === 1 ? 2 : 1;
    const enemyPlayers = getAlivePlayersOnTeam(enemyTeamId);

    for (const enemy of enemyPlayers) {
        try {
            const enemyPos = mod.GetSoldierState(enemy, mod.SoldierStateVector.GetPosition);
            const distance = mod.DistanceBetween(enemyPos, flagPos);
            if (distance <= 3) {
                // FLAG_CAPTURE_RADIUS
                return true;
            }
        } catch {}
    }

    return false;
}

// Update all bot targets based on AI behavior rules
// Now uses the realistic bot brain system with probabilistic detection
// Flag behavior is fully integrated into the brain - no more blind rushing
function updateBotTargets(): void {
    _botTargetUpdates++;

    // Log every 10 updates (~5 seconds at 500ms interval)
    if (_botTargetUpdates % 10 === 0) {
        logMain('BOT TARGETING STATS', { totalUpdates: _botTargetUpdates, botFlagActive, botInitialTargetPhase });
    }

    // During initial 5 second phase, use original targeting (guaranteed initial target)
    if (botInitialTargetPhase) {
        return;
    }

    const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];

    for (const player of allPlayers) {
        try {
            if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) continue;
            if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive)) continue;

            const botTeam = mod.GetTeam(player);
            const team1 = mod.GetTeam(1);
            const botTeamId = mod.GetObjId(botTeam) === mod.GetObjId(team1) ? 1 : 2;

            // Use the brain system for ALL behavior including flag
            // Brain handles: probabilistic detection, memory, patrol, search, AND flag tactics
            const brain = getBotBrain(player);

            // Configure brain with context getters
            brain.setFlagPosGetter(() => flagCaptureUI?.getFlagPosition() ?? null);
            brain.setSpawnPositionsGetter(() => {
                return botTeamId === 1
                    ? sidesSwapped
                        ? side2SpawnPositions
                        : side1SpawnPositions
                    : sidesSwapped
                      ? side1SpawnPositions
                      : side2SpawnPositions;
            });

            // Set flag urgency getter - urgency increases as overtime progresses
            brain.setFlagUrgencyGetter(() => {
                if (!botFlagActive || botFlagSpawnTime === 0) return 0;
                // Calculate time since flag spawned
                const overtimeElapsed = Date.now() - botFlagSpawnTime;
                const overtimeMax = 15000; // 15 second overtime
                // Urgency ramps from 0.3 to 1.0 as overtime progresses
                const urgency = 0.3 + (overtimeElapsed / overtimeMax) * 0.7;
                return Math.min(1.0, urgency);
            });

            // Tick the brain - this runs ALL sensors and selects behavior
            brain.tick();
        } catch {}
    }
}

// Start bot targeting loop
function startBotTargeting(): void {
    if (!ENABLE_CUSTOM_BOTS) return;
    if (botTargetingInterval !== null) return;

    botTargetingInterval = Timers.setInterval(() => {
        updateBotTargets();
    }, BOT_TARGET_UPDATE_MS);

    // Fast LOS loop: exactly one raycast per tick (round-robin across bots) so a bot can
    // only "see" an enemy it has a clear line to. ~10 Hz keeps each engaged bot's LOS fresh
    // (~human reaction latency) without over-leaking casts.
    if (losInterval === null) {
        let losTick = 0;
        losInterval = Timers.setInterval(() => {
            try {
                const bots = [...getBotsOnTeam(1), ...getBotsOnTeam(2)];
                updateLos(bots, 60); // 60m = SENSOR_CONFIG.SIGHT_RANGE
                if (++losTick % 50 === 0) {
                    Tlm.sample('los', { casts: getLosCastCount(), bots: bots.length });
                }
            } catch {}
        }, 100);
    }

    adminDebugTool?.dynamicLog('Bot targeting started');
}

// Stop bot targeting loop
function stopBotTargeting(): void {
    if (botTargetingInterval !== null) {
        Timers.clearInterval(botTargetingInterval);
        botTargetingInterval = null;
    }
    if (losInterval !== null) {
        Timers.clearInterval(losInterval);
        losInterval = null;
    }
    clearLos();
}

// Route raycast LOS-probe results to the bot LOS manager (los.ts).
Events.OnRayCastHit.subscribe((bot: mod.Player, point: mod.Vector, _normal: mod.Vector) => {
    onRayHit(bot, point);
});
Events.OnRayCastMissed.subscribe((bot: mod.Player) => {
    onRayMiss(bot);
});

// ============================================================================
// MATCH END CLEANUP
// ============================================================================
// Called before EndGameMode to ensure all UI/timers are stopped for fresh start
// ============================================================================
function cleanupForMatchEnd(): void {
    // Mark match as ending to prevent any new rounds
    matchEnding = true;

    // Update all player scoreboards with final stats before cleanup
    // This ensures stats persist to the end-of-match scoreboard
    const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];
    for (const player of allPlayers) {
        updateScoreboard(player);
    }

    // Set spawn mode to auto spawn before ending
    mod.SetSpawnMode(mod.SpawnModes.AutoSpawn);

    // Stop all intervals
    stopBotTargeting();
    if (telemetryInterval !== undefined) {
        Timers.clearInterval(telemetryInterval);
        telemetryInterval = undefined;
    }

    // Destroy countdown UI
    if (countdownUI) {
        countdownUI.destroy();
        countdownUI = undefined;
    }

    // Destroy flag capture UI
    if (flagCaptureUI) {
        flagCaptureUI.destroy();
        flagCaptureUI = undefined;
    }

    // Hide all active UIs
    hideEliminationEffect();
    hideAllRoundResults();

    // Reset state
    roundNumber = 0;
    roundStarted = false;
    resettingRound = false;
    roundEnding = false;
    currentLoadout = undefined;
    lastKiller = null;
    botInitialTargetPhase = false;
    botFlagActive = false;
    botFlagSpawnTime = 0;
    botsInterestedInFlag.clear();
    knownBotIds.clear();
    resetEliminationTracking();
    resetScores();
    clearRejectedPlayers();
    clearAllBotBrains(); // Clear all bot AI brains

    adminDebugTool?.dynamicLog('Match cleanup complete');
}

// Deploy EVERY player before ending the match. If a player is left undeployed
// (spectating) when victory is called, the next map inherits that spectator state
// and the player gets stuck spectating their nearest squad. So: stop the match,
// force everyone onto the battlefield, wait a beat for it to apply, THEN end.
function endMatchDeployed(winner: mod.Team): void {
    cleanupForMatchEnd(); // stops timers/UI, sets AutoSpawn, roundStarted=false, countdownUI=undefined

    try {
        mod.SetSpawnMode(mod.SpawnModes.AutoSpawn);
    } catch {}

    // Force any dead/spectating player back onto the battlefield before victory.
    const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];
    for (const p of allPlayers) {
        try {
            mod.EnablePlayerDeploy(p, true);
            if (!mod.GetSoldierState(p, mod.SoldierStateBool.IsAlive)) {
                mod.DeployPlayer(p);
            }
        } catch {}
    }
    try {
        mod.DeployAllPlayers(); // catch-all for anyone still on the deploy screen
    } catch {}
    Tlm.event('match.deployAll', { players: allPlayers.length });

    // Give the deploys a beat to actually take effect, THEN end the game mode.
    Timers.setTimeout(() => {
        Tlm.event('match.end');
        mod.EndGameMode(winner);
    }, 1200);
}

// Set all bots to aggressive battlefield behavior
// Phase 1: Target nearest enemy immediately (guaranteed initial awareness)
// Phase 2: After 5 seconds, brain system takes over with realistic detection
function activateBots(): void {
    if (!ENABLE_CUSTOM_BOTS) return;

    const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];

    // Reset state
    botInitialTargetPhase = true;
    botFlagActive = false;
    botFlagSpawnTime = 0;
    botsInterestedInFlag.clear();

    // Get push targets (toward center/flag area)
    const flagPos = flagCaptureUI?.getFlagPosition();
    const team1EnemySpawns = sidesSwapped ? side1SpawnPositions : side2SpawnPositions;
    const team2EnemySpawns = sidesSwapped ? side2SpawnPositions : side1SpawnPositions;

    for (const player of allPlayers) {
        try {
            if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) continue;
            if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive)) continue;

            // Initialize/reset brain for this bot
            const brain = getBotBrain(player);
            brain.reset();

            // Enable shooting and targeting
            mod.AIEnableShooting(player, true);
            mod.AIEnableTargeting(player, true);

            // Determine bot's team
            const botTeam = mod.GetTeam(player);
            const team1 = mod.GetTeam(1);
            const isTeam1 = mod.GetObjId(botTeam) === mod.GetObjId(team1);

            // Set push target toward flag or enemy spawn
            // Push toward flag (center) with some randomization toward enemy side
            const botPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
            let pushTarget: mod.Vector;

            if (flagPos) {
                // Push toward flag with slight offset toward enemy side
                const enemySpawns = isTeam1 ? team1EnemySpawns : team2EnemySpawns;
                if (enemySpawns.length > 0) {
                    const enemySpawn = enemySpawns[Math.floor(Math.random() * enemySpawns.length)];
                    // Target is 70% toward flag, 30% toward enemy spawn
                    pushTarget = mod.CreateVector(
                        mod.XComponentOf(flagPos) * 0.7 + mod.XComponentOf(enemySpawn) * 0.3,
                        mod.YComponentOf(flagPos),
                        mod.ZComponentOf(flagPos) * 0.7 + mod.ZComponentOf(enemySpawn) * 0.3
                    );
                } else {
                    pushTarget = flagPos;
                }
            } else {
                // No flag - push toward enemy spawn
                const enemySpawns = isTeam1 ? team1EnemySpawns : team2EnemySpawns;
                if (enemySpawns.length > 0) {
                    pushTarget = enemySpawns[Math.floor(Math.random() * enemySpawns.length)];
                } else {
                    // Fallback - push forward from current position
                    pushTarget = mod.CreateVector(
                        mod.XComponentOf(botPos),
                        mod.YComponentOf(botPos),
                        mod.ZComponentOf(botPos) + (isTeam1 ? 20 : -20)
                    );
                }
            }

            // Set push target and sprint flag in brain memory
            brain.setPushTarget(pushTarget);

            // Also set initial target for shooting if they see enemies
            const target = findClosestEnemy(player);
            if (target) {
                mod.AISetTarget(player, target);
            }

            // Start with sprint speed and movement toward push target
            mod.AISetMoveSpeed(player, mod.MoveSpeed.Sprint);
            mod.AIValidatedMoveToBehavior(player, pushTarget);
        } catch {}
    }

    // Start targeting loop
    startBotTargeting();

    adminDebugTool?.dynamicLog('Bots activated with push targets');

    // After 5 seconds, clear push targets if not already cleared (enemies found)
    Timers.setTimeout(() => {
        botInitialTargetPhase = false;

        // Let bot brains take over fully
        const currentPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];
        for (const player of currentPlayers) {
            try {
                if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) continue;
                if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive)) continue;

                // Clear push target if still active - transition to normal behavior
                const brain = getBotBrain(player);
                brain.clearPushTarget();

                // Stop sprinting, return to run speed
                mod.AISetMoveSpeed(player, mod.MoveSpeed.Run);

                // Apply battlefield behavior for continued engagement
                mod.AIBattlefieldBehavior(player);

                // Set target AFTER behavior (to target humans too)
                const target = findClosestEnemy(player);
                if (target) {
                    mod.AISetTarget(player, target);
                    mod.AIEnableShooting(player, true);
                    mod.AIEnableTargeting(player, true);
                }
            } catch {}
        }

        adminDebugTool?.dynamicLog('Bots transitioned to brain-based realistic targeting');
    }, BOT_INITIAL_TARGET_DURATION_MS);
}

// Called when overtime flag spawns - notify all bot brains
// The brain system now handles flag decisions dynamically (no more random 20% chance)
function notifyBotsOfFlagSpawn(): void {
    if (!ENABLE_CUSTOM_BOTS) return;

    botFlagActive = true;
    botFlagSpawnTime = Date.now(); // Track when flag spawned for urgency calculation

    const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];
    let notifiedCount = 0;

    for (const player of allPlayers) {
        try {
            if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) continue;
            if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive)) continue;

            // Notify brain that flag is active
            const brain = getBotBrain(player);
            brain.notifyFlagSpawned();
            notifiedCount++;
        } catch {}
    }

    adminDebugTool?.dynamicLog(`Flag spawned - notified ${notifiedCount} bot brains`);
}

// Set all bots to idle behavior (for freeze period)
function freezeBots(): void {
    if (!ENABLE_CUSTOM_BOTS) return;

    const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];

    for (const player of allPlayers) {
        try {
            if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) continue;
            if (mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive)) {
                mod.AIIdleBehavior(player);
                mod.AIEnableShooting(player, false);
                mod.AIEnableTargeting(player, false);
                mod.AISetStance(player, mod.Stance.Stand);
            }
        } catch {}
    }

    stopBotTargeting();
    adminDebugTool?.dynamicLog('Bots frozen with idle behavior');
}

// Clean up all custom bots and spawners
function cleanupCustomBots(): void {
    stopBotTargeting();

    // Unspawn all spawners
    for (const spawner of [...team1Spawners, ...team2Spawners]) {
        try {
            mod.UnspawnObject(spawner);
        } catch {}
    }

    team1Spawners = [];
    team2Spawners = [];
    knownBotIds.clear();

    adminDebugTool?.dynamicLog('Custom bots cleaned up');
}

// Audio volume config
export const AUDIO_CONFIG = {
    SFX_VOLUME: 0.5, // 50% volume for sound effects
    VO_VOLUME: 1.0, // 100% volume for voice overs
};

// Sound effects
const SOUNDS = {
    ROUND_START: mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_Vendetta_NewHVT_OneShot2D,
    ROUND_LOSS: mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_Rodeo_TankAcquired_OneShot2D,
    ROUND_WIN: mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_EOM_Qualified_OneShot2D,
    PLAYER_LEAVE: mod.RuntimeSpawn_Common.SFX_UI_Gamemode_Shared_CaptureObjectives_CapturingThumpFriendly_OneShot2D,
    PLAYER_JOIN: mod.RuntimeSpawn_Common.SFX_GameModes_BR_UXUI_CircleShrink_Start_OneShot2D,
    FRIENDLY_DEATH: mod.RuntimeSpawn_Common.SFX_UI_Gamemode_Shared_OutOfBounds_Countdown_OneShot2D,
    ENEMY_DEATH: mod.RuntimeSpawn_Common.SFX_Soldier_Events_SoldierDown_DeathStingerSkipRevive_OneShot2D,
};

// Helper to play 2D sound for a player (exported for use in other modules)
export function playSound(player: mod.Player, sound: mod.RuntimeSpawn_Common, duration: number = 5000): void {
    try {
        const sfx = mod.SpawnObject(sound, mod.CreateVector(0, 0, 0), mod.CreateVector(0, 0, 0));
        mod.PlaySound(sfx, AUDIO_CONFIG.SFX_VOLUME, player);
        Timers.setTimeout(() => {
            try {
                mod.StopSound(sfx);
                mod.UnspawnObject(sfx);
            } catch {}
        }, duration);
    } catch {}
}

// Voice over system - spawn VO module per call at player position
export function playVO(event: mod.VoiceOverEvents2D, target?: mod.Player | mod.Team): void {
    try {
        // 2D VO is positionless (same as playSound) — spawn the module at origin.
        // The old code read GetSoldierState() off the target to place it, but its
        // "is this a Player?" check was always true for opaque handles, so when the
        // target was a Team it called GetSoldierState(team, ...) -> NoMatchingOverload,
        // which killed every round-progress VO (16x in the captured PortalLog).
        const voModule = mod.SpawnObject(
            mod.RuntimeSpawn_Common.SFX_VOModule_OneShot2D,
            mod.CreateVector(0, 0, 0),
            mod.CreateVector(0, 0, 0)
        ) as mod.VO;

        if (target) {
            // Native PlayVO accepts Player OR Team; TS can't pick from the union, so cast.
            mod.PlayVO(voModule, event, mod.VoiceOverFlags.Alpha, target as mod.Player);
        } else {
            mod.PlayVO(voModule, event, mod.VoiceOverFlags.Alpha);
        }

        // Free the VO module (the old code leaked one spawned object per call, per match).
        Timers.setTimeout(() => {
            try {
                mod.UnspawnObject(voModule);
            } catch {}
        }, 5000);
    } catch {}
}

// Play round win/loss VOs based on round progress (early/mid/late)
function playRoundProgressVO(winningTeamId: number): void {
    const winningTeam = mod.GetTeam(winningTeamId);
    const losingTeamId = winningTeamId === 1 ? 2 : 1;
    const losingTeam = mod.GetTeam(losingTeamId);

    // Determine progress stage based on round number
    // Early: rounds 1-4, Mid: rounds 5-8, Late: rounds 9-11
    let winningVO: mod.VoiceOverEvents2D;
    let losingVO: mod.VoiceOverEvents2D;

    if (roundNumber <= 4) {
        // Early game
        winningVO = mod.VoiceOverEvents2D.ProgressEarlyWinning;
        losingVO = mod.VoiceOverEvents2D.ProgressEarlyLosing;
    } else if (roundNumber <= 8) {
        // Mid game
        winningVO = mod.VoiceOverEvents2D.ProgressMidWinning;
        losingVO = mod.VoiceOverEvents2D.ProgressMidLosing;
    } else {
        // Late game
        winningVO = mod.VoiceOverEvents2D.ProgressLateWinning;
        losingVO = mod.VoiceOverEvents2D.ProgressLateLosing;
    }

    playVO(winningVO, winningTeam);
    playVO(losingVO, losingTeam);
}

export function getCurrentRoundNumber(): number {
    return roundNumber;
}


// NOTE: the old random-split balanceTeams() + shuffleArray() were removed. They
// called mod.SetTeam on EVERY human (throwing "team input invalid" for anyone
// already on the target team) and forced a fixed split. Replaced by reconcileTeams()
// + computeTargetTeamSize() (dynamic bot sizing) above. See TEAM-SORTING-SPEC.md.

// Initialize game when mode starts
Events.OnGameModeStarted.subscribe(() => {
    logMain('========== GAME MODE STARTED ==========');
    Tlm.event('mode.start');
    startPerfHeartbeat(2);
    debugSimulateTeamSorting();

    // Start helper stats logging (logs every 5 seconds)
    startHelperStatsLogging();

    // Reset round scores
    resetScores();

    // Randomize bot names for this match
    randomizeBotNames();

    // Initialize custom scoreboard
    initScoreboard();

    // Initialize flag capture system
    flagCaptureUI = new FlagCaptureUI();
    flagCaptureUI.init();
    flagCaptureUI.setCallbacks(
        handleFlagCapture,
        handlePauseCountdown,
        handleResumeCountdown,
        handlePlayCaptureVO,
        handlePlayContestedVO
    );

    // Initialize spawn positions early
    initSpawnPositions();

    // Ensure a human on each team (rule 1); bot backfill sizes the teams to the human count.
    reconcileTeams();

    // Set spawn mode to auto spawn (must be done after game mode starts)
    mod.SetSpawnMode(mod.SpawnModes.AutoSpawn);

    // SPECTATOR-BUG FIX (part 1): widen the spectate pool from own-SQUAD to own-TEAM so a
    // dead player falls through to any living TEAMMATE when their spectate target dies
    // (ownTeamOnly=true: NEVER the enemy team — no dead-player intel). Squad-scoped spectate
    // with no target = the engine's "waiting for soldier deployment" UI-lock bug (community
    // bug-report, hi-prio, no engine fix known). Whole-team-dead = elimination, which flips
    // to the deploy screen immediately (part 3), so no-target spectate can't occur mid-round.
    mod.SetSpectatingFiltersForAll(mod.SpectatingGroup.Team, false, true);

    // Deploy all players immediately
    mod.DeployAllPlayers();
});

// SPECTATOR-BUG FIX (part 2): the engine wedges ("waiting for soldier deployment" + cursor
// lock) when a spectating player has NO valid spectate target. During the round transition we
// therefore WIDEN the spectate pool to everyone — dead players fall through to the frozen
// winners behind the round-result overlay (round is decided; no live intel). startRound()
// restores team-only spectate before play resumes. NOTE: players never see the deploy screen —
// spawn mode stays Spectating; round start force-deploys via AutoSpawn + DeployAllPlayers.
function enterRoundTransition(): void {
    try {
        mod.SetSpectatingFiltersForAll(mod.SpectatingGroup.All, false, false);

        // Mutual wipe: NOBODY is alive, so even the widened pool has no target — the one
        // case spectate cannot be made safe. Force-redeploy everyone (AutoSpawn — no deploy
        // screen), slightly delayed so the teardown's undeploys settle first; the next
        // round's countdown then teleports + freezes them into position.
        const anyAlive = getAlivePlayersOnTeam(1).length + getAlivePlayersOnTeam(2).length > 0;
        if (!anyAlive) {
            adminDebugTool?.dynamicLog('Round transition: mutual wipe -> force redeploy (AutoSpawn)');
            Timers.setTimeout(() => {
                try {
                    if (matchEnding) return;
                    mod.SetSpawnMode(mod.SpawnModes.AutoSpawn);
                    mod.DeployAllPlayers();
                } catch {}
            }, 600);
            Timers.setTimeout(() => {
                try {
                    if (matchEnding) return;
                    const everyone = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];
                    countdownUI?.freezeAllPlayers(everyone);
                } catch {}
            }, 1200);
        } else {
            adminDebugTool?.dynamicLog('Round transition: spectate pool widened (frozen players only)');
        }
    } catch {}
}


// Shared round teardown — the formerly hand-copied tail of all three round enders
// (flag capture / time-out / elimination). One copy = no more drift between variants.
// Caller must have set roundEnding = true and called enterRoundTransition() first.
function finishRound(isDraw: boolean, winningTeam: number, showResult: () => void): void {
    // Stop bot targeting when round ends
    if (ENABLE_CUSTOM_BOTS) {
        stopBotTargeting();
    }

    // Undeploy dead players; heal, disarm and idle alive players
    const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];
    const alivePlayers: mod.Player[] = [];
    for (const player of allPlayers) {
        try {
            const isAlive = mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive);
            if (isAlive) {
                mod.Heal(player, 1000);
                removeAllEquipment(player);
                if (mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                    mod.AIIdleBehavior(player);
                    mod.AIEnableShooting(player, false);
                    mod.AIEnableTargeting(player, false);
                }
                alivePlayers.push(player);
            } else {
                mod.UndeployPlayer(player);
            }
        } catch {}
    }

    // Freeze all alive players (input restrictions for humans)
    if (alivePlayers.length > 0) {
        countdownUI?.freezeAllPlayers(alivePlayers);
    }

    // Hide round UI, show the result, play progress VO
    countdownUI?.stop();
    hideEliminationEffect();
    flagCaptureUI?.hide();
    showResult();
    if (!isDraw) {
        playRoundProgressVO(winningTeam);
    }

    // Match-win check IMMEDIATELY after score update (draws never end the match)
    if (!isDraw) {
        const scores = getScores();
        const matchWinScore = 6;
        const isMatchWon = scores.team1 >= matchWinScore || scores.team2 >= matchWinScore;
        if (isMatchWon) {
            // Set flag immediately to prevent any new round from starting
            matchEnding = true;
            // Wait for result screen, then cleanup and end game
            Timers.setTimeout(() => {
                const winningTeamObj = mod.GetTeam(scores.team1 >= matchWinScore ? 1 : 2);
                adminDebugTool?.dynamicLog(
                    `Match over! Team ${scores.team1 >= matchWinScore ? 1 : 2} wins ${scores.team1}-${scores.team2}`
                );
                endMatchDeployed(winningTeamObj);
            }, 3000);
            return;
        }
    }

    // Continue to next round after 5 seconds (only if match not won)
    Timers.setTimeout(() => {
        if (matchEnding) return;
        // Swap sides if needed BEFORE deployment so teleport uses correct positions
        const nextRound = roundNumber + 1;
        if (nextRound > 1 && (nextRound - 1) % 3 === 0) {
            sidesSwapped = !sidesSwapped;
            adminDebugTool?.dynamicLog(`Sides swapped before deploy! sidesSwapped=${sidesSwapped}`);
            playVO(mod.VoiceOverEvents2D.RoundSwitchSides);
        }
        deployAllAtStartPositions(() => {
            const allPlayersNow = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];
            countdownUI?.freezeAllPlayers(allPlayersNow);
            Timers.setTimeout(() => {
                resetRound();
            }, 500);
        });
    }, 5000);
}

// Flag capture callbacks
function handleFlagCapture(teamId: number): void {
    if (roundEnding) return;
    roundEnding = true;
    enterRoundTransition();

    adminDebugTool?.dynamicLog(`Team ${teamId} captured the flag!`);

    // Record captures for players on the flag (within capture radius)
    const flagPos = flagCaptureUI?.getFlagPosition();
    if (flagPos) {
        const capturingTeamPlayers = getAlivePlayersOnTeam(teamId);
        for (const player of capturingTeamPlayers) {
            try {
                const playerPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
                const distance = mod.DistanceBetween(playerPos, flagPos);
                if (distance <= 3) {
                    // 3m capture radius (same as FLAG_CAPTURE_RADIUS)
                    const stats = getStatsForPlayer(player);
                    stats.captures++;
                    updateScoreboard(player);
                }
            } catch {}
        }
    }

    // Hide flag UI
    flagCaptureUI?.hide();

    // Shared teardown; isFlagCapture = true for objective captured/lost result screen
    finishRound(false, teamId, () => showRoundResults(teamId, 5000, true));
}

function handlePauseCountdown(): void {
    countdownUI?.pauseAllCountdowns();
}

function handleResumeCountdown(): void {
    countdownUI?.resumeAllCountdowns();
}

function handlePlayCaptureVO(capturingTeamId: number): void {
    // Play ObjectiveCapturing to the capturing team (friendly)
    const capturingTeam = mod.GetTeam(capturingTeamId);
    playVO(mod.VoiceOverEvents2D.ObjectiveCapturing, capturingTeam);

    // Play ObjectiveContested to the other team (enemy)
    const otherTeamId = capturingTeamId === 1 ? 2 : 1;
    const otherTeam = mod.GetTeam(otherTeamId);
    playVO(mod.VoiceOverEvents2D.ObjectiveContested, otherTeam);
}

function handlePlayContestedVO(): void {
    // Play ObjectiveContested to both teams when flag becomes contested
    playVO(mod.VoiceOverEvents2D.ObjectiveContested, mod.GetTeam(1));
    playVO(mod.VoiceOverEvents2D.ObjectiveContested, mod.GetTeam(2));
}

function handleOvertimeStart(): void {
    adminDebugTool?.dynamicLog('Overtime started - raising flag!');
    flagCaptureUI?.raiseFlag();

    // Notify bots about flag spawn (20% chance each bot becomes interested)
    if (ENABLE_CUSTOM_BOTS) {
        notifyBotsOfFlagSpawn();
    }
}

// Inputs to block when freezing players (same as countdown-ui.ts)
const FREEZE_BLOCKED_INPUTS = [
    mod.RestrictedInputs.CycleFire,
    mod.RestrictedInputs.FireWeapon,
    mod.RestrictedInputs.Interact,
    mod.RestrictedInputs.Jump,
    mod.RestrictedInputs.MoveForwardBack,
    mod.RestrictedInputs.MoveLeftRight,
    mod.RestrictedInputs.Reload,
    mod.RestrictedInputs.SelectCharacterGadget,
    mod.RestrictedInputs.SelectMelee,
    mod.RestrictedInputs.SelectOpenGadget,
    mod.RestrictedInputs.SelectThrowable,
    mod.RestrictedInputs.Sprint,
];

function freezePlayer(player: mod.Player): void {
    try {
        const isAI = mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier);

        if (isAI) {
            mod.AISetStance(player, mod.Stance.Stand);
            mod.AIIdleBehavior(player);
            mod.AIEnableShooting(player, false);
            mod.AIEnableTargeting(player, false);
        } else {
            for (const input of FREEZE_BLOCKED_INPUTS) {
                mod.EnableInputRestriction(player, input, true);
            }
        }
    } catch {
        // Player might be invalid
    }
}

async function spawnVehicle(player: mod.Player, vehicleType: mod.VehicleList): Promise<void> {
    const playerPosition = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
    const playerFacingDirection = mod.GetSoldierState(player, mod.SoldierStateVector.GetFacingDirection);

    // Create position 20 meters in front of player (facing direction).
    const position = mod.CreateVector(
        mod.XComponentOf(playerPosition) + mod.XComponentOf(playerFacingDirection) * 20,
        mod.YComponentOf(playerPosition),
        mod.ZComponentOf(playerPosition) + mod.ZComponentOf(playerFacingDirection) * 20
    );

    adminDebugTool?.dynamicLog(`Spawning vehicle spawner at ${Vectors.getVectorString(position)}`);

    const spawner = mod.SpawnObject(
        mod.RuntimeSpawn_Common.VehicleSpawner,
        position,
        mod.CreateVector(0, 0, 0)
    ) as mod.VehicleSpawner;

    // Need to wait a bit before setting the vehicle spawner settings.
    await mod.Wait(1);

    adminDebugTool?.dynamicLog(`Setting vehicle spawner settings.`);

    mod.SetVehicleSpawnerVehicleType(spawner, vehicleType);
    mod.SetVehicleSpawnerAutoSpawn(spawner, true);
    mod.SetVehicleSpawnerRespawnTime(spawner, 1);

    adminDebugTool?.dynamicLog(`Spawning vehicle in 1 second.`);

    // We do not want the vehicle spawner to spawn another vehicle after the first one has been destroyed, and if we
    // simply set the auto spawn to false, the vehicle will still exist as an object, which is a waste of resourced.
    // Instead, we subscribe to the OnVehicleSpawned event to know when a vehicle has spawned, determine if it is the
    // vehicle we're looking for (based on its proximity to this spawner), and if it is, we disable automatic vehicle
    // respawning from the vehicle spawner. Then, we subscribe to the OnVehicleDestroyed event to know when a vehicle]
    // has been destroyed, and if it is the vehicle we're looking for (the one we just spawned), we can safely unspawn
    // the spawner. This block shows the power of the `Events` module, and how it can be used to subscribe to and
    // unsubscribe from events dynamically and in a specific context, to isolate and modularize code.
    const unsubscribeFromOnVehicleSpawned = Events.OnVehicleSpawned.subscribe((vehicle) => {
        const vehiclePosition = mod.GetVehicleState(vehicle, mod.VehicleStateVector.VehiclePosition);

        // If the vehicle is not within 10 meters of the spawner, ignore it as it's not the vehicle we're looking for.
        if (mod.DistanceBetween(vehiclePosition, position) > 10) return;

        // Unsubscribe from the OnVehicleSpawned event as this context no longer needs to know when a vehicle has spawned.
        unsubscribeFromOnVehicleSpawned();

        adminDebugTool?.dynamicLog(`Vehicle spawned.`);

        // Disable automatic vehicle respawning for the spawner as we're going to unspawn it once the vehicle's destroyed.
        mod.SetVehicleSpawnerAutoSpawn(spawner, false);

        const unsubscribeFromOnVehicleDestroyed = Events.OnVehicleDestroyed.subscribe((destroyedVehicle) => {
            // If the destroyed vehicle is not the specific vehicle we're looking for, ignore it.
            if (mod.GetObjId(destroyedVehicle) !== mod.GetObjId(vehicle)) return;

            // Unsubscribe from the OnVehicleDestroyed event as this context no longer needs to know when the vehicle is destroyed.
            unsubscribeFromOnVehicleDestroyed();

            adminDebugTool?.dynamicLog(`Vehicle destroyed.`);

            // Unspawn the vehicle spawner.
            mod.UnspawnObject(spawner);

            adminDebugTool?.dynamicLog(`Vehicle spawner unspawned.`);
        });
    });
}

function createAdminDebugTool(player: mod.Player): void {
    // Skip debug tool in production mode
    if (PRODUCTION_MODE) return;

    // The admin player is player id 0 for non-persistent test servers,
    // so don't do the rest of this unless it's the admin player.
    if (mod.GetObjId(player) != 0) return;

    // Create a debug tool with a static logger visible by default.
    const debugToolOptions: DebugTool.Options = {
        staticLogger: {
            visible: true,
        },
        dynamicLogger: {
            visible: false,
        },
        debugMenu: {
            visible: false,
        },
    };

    adminDebugTool = new DebugTool(player, debugToolOptions);

    // Create a multi-click detector to open the debug menu when the player triple-clicks the interact key.
    new MultiClickDetector(player, () => {
        adminDebugTool?.showDebugMenu();
    });

    // Add a debug menu button to spawn an AH64 helicopter.
    adminDebugTool?.addDebugMenuButton(mod.Message(mod.stringkeys.template.debug.buttons.spawnHelicopter), () =>
        spawnVehicle(player, mod.VehicleList.AH64)
    );

    // Add a debug menu button to spawn a golf cart.
    adminDebugTool?.addDebugMenuButton(mod.Message(mod.stringkeys.template.debug.buttons.spawnGolfCart), () =>
        spawnVehicle(player, mod.VehicleList.GolfCart)
    );

    // Log a message to the static logger.
    adminDebugTool?.staticLog(`Triple-click interact key to open debug menu.`, 0);
}

function destroyAdminDebugTool(playerId: number): void {
    // If the player is not the admin player, then we know the admin is still in the game, so we can exit this function.
    if (playerId !== 0) return;

    // Clear the telemetry interval so it doesn't continue to log the admin's position and facing direction, and
    // destroy the debug tool.
    Timers.clearInterval(telemetryInterval);
    adminDebugTool?.destroy();
    countdownUI?.destroy();
    flagCaptureUI?.destroy();
    cleanupCustomBots(); // Clean up custom bots
    telemetryInterval = undefined;
    adminDebugTool = undefined;
    countdownUI = undefined;
    flagCaptureUI = undefined;
}

function showTelemetry(player: mod.Player): void {
    // The admin player is player id 0 for non-persistent test servers,
    // so don't do the rest of this unless it's the admin player.
    if (mod.GetObjId(player) != 0) return;

    // Log the admin's position and facing direction to the static logger, in rows 1 and 2, every second.
    telemetryInterval = Timers.setInterval(() => {
        adminDebugTool?.staticLog(
            `Position: ${getPlayerStateVectorString(player, mod.SoldierStateVector.GetPosition)}`,
            1
        );

        adminDebugTool?.staticLog(
            `Facing: ${getPlayerStateVectorString(player, mod.SoldierStateVector.GetFacingDirection)}`,
            2
        );
    }, 1000);
}

function stopTelemetry(player: mod.Player): void {
    // The admin player is player id 0 for non-persistent test servers,
    // so don't do the rest of this unless it's the admin player.
    if (mod.GetObjId(player) != 0) return;

    // Clear the telemetry interval so it doesn't continue to log the admin's position and facing direction.
    Timers.clearInterval(telemetryInterval);
}

function handlePlayerDeployed(player: mod.Player): void {
    // Match is ending: endMatchDeployed() force-deploys everyone so the next map
    // loads cleanly and nobody is stuck spectating. Do NO round logic in that state.
    if (matchEnding) return;

    const playerId = mod.GetObjId(player);

    // NOTE: a former `resettingRound` teleport branch lived here — dead code (resetRound()
    // is fully synchronous, so no deploy event can ever observe resettingRound === true;
    // round-start teleporting is owned by countdownUI.start()). Removed 2026-07-17.

    // Block spawns during active round (after countdown ends).
    // NOT during the round transition (roundEnding) — that's the legit redeploy of everyone for
    // the next round; rejecting it here undeploys the player and flashes them into spectator.
    if (roundStarted && countdownUI && !countdownUI.isRunning && !roundEnding) {
        adminDebugTool?.dynamicLog(`Blocking mid-round spawn for player ${playerId}`);
        rejectPlayer(playerId); // Mark as rejected to exclude from health calculations
        try {
            mod.UndeployPlayer(player);
        } catch (e) {
            // Player might be invalid
        }
        return;
    }

    // Log a message to the dynamic logger that the player has deployed.
    adminDebugTool?.dynamicLog(`Player ${playerId} deployed.`);

    // Handle human player deployment
    const isHuman = !mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier);

    if (isHuman) {
        // Play player join sound for all human players
        const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];
        for (const p of allPlayers) {
            try {
                if (mod.IsPlayerValid(p) && !mod.GetSoldierState(p, mod.SoldierStateBool.IsAISoldier)) {
                    playSound(p, SOUNDS.PLAYER_JOIN);
                }
            } catch {}
        }

        // Undeploy a bot from this player's team to make room
        if (ENABLE_CUSTOM_BOTS) {
            try {
                const playerTeam = mod.GetTeam(player);
                const team1 = mod.GetTeam(1);
                const teamId = mod.GetObjId(playerTeam) === mod.GetObjId(team1) ? 1 : 2;

                // Check if there are too many players on the team (humans + bots > max)
                const totalOnTeam = getPlayersOnTeam(teamId).length;
                if (totalOnTeam > PLAYERS_PER_TEAM) {
                    adminDebugTool?.dynamicLog(`Team ${teamId} has ${totalOnTeam} players, undeploying a bot`);
                    undeployBotForTeam(teamId);
                }
            } catch {}
        }
    }

    // Start the round countdown (only once per round, triggered by first deploy)
    if (!roundStarted) {
        roundStarted = true;
        roundNumber++;

        // Wait briefly for all players to deploy before starting the round
        Timers.setTimeout(() => {
            startRound();
        }, 500);
    } else if (countdownUI?.isRunning && currentLoadout) {
        // Late-deploying player during countdown - apply restrictions and loadout
        adminDebugTool?.dynamicLog(`Late deploy during countdown - applying loadout to player ${playerId}`);
        countdownUI.addLatePlayer(player, currentLoadout);
    } else if (roundStarted && !roundEnding) {
        // Player deployed during the waiting period before countdown starts
        // Freeze them immediately - they'll be processed when countdown starts
        adminDebugTool?.dynamicLog(`Player ${playerId} deployed during pre-countdown wait - freezing`);
        freezePlayer(player);
    }
}

function startRound(): void {
    _roundStarts++;
    logMain('========== START ROUND ==========', { roundNumber, totalRoundStarts: _roundStarts });

    // Don't start a new round if match is ending (team reached 6 wins)
    if (matchEnding) {
        logMain('startRound SKIPPED - match ending');
        return;
    }

    // Clear any rejected players from previous round
    clearRejectedPlayers();

    // Reset round ending flag
    roundEnding = false;

    // SPECTATOR-BUG FIX: restore team-only spectate for live play (transition widened it to
    // All so dead players always had a target; live rounds must never show the enemy team).
    try {
        mod.SetSpectatingFiltersForAll(mod.SpectatingGroup.Team, false, true);
    } catch {}

    // Initialize spawn positions from spatial objects
    initSpawnPositions();

    // STAT-TRACKING FIX: survivors never redeploy, so their damage-tracking state persisted
    // across rounds — first-hit damage was swallowed (stale healthBefore) and stale assist
    // contributors could leak into next-round kills. Reset both for the new round; players
    // who deploy fresh get seeded by the OnPlayerDeployed tracker as before.
    damageContributors.clear();
    for (const p of [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)]) {
        try {
            playerHealth.set(mod.GetObjId(p), 100);
        } catch {}
    }

    // Spawn backfill bots to fill empty slots
    if (ENABLE_CUSTOM_BOTS) {
        spawnBackfillBots();
        freezeBots(); // Start frozen until countdown ends
    }

    // Get all players on each team (includes bots)
    const team1 = getPlayersOnTeam(1);
    const team2 = getPlayersOnTeam(2);

    adminDebugTool?.dynamicLog(`Starting round ${roundNumber} with ${team1.length} vs ${team2.length} players`);

    // Create countdown UI if it doesn't exist (shown to all players)
    if (!countdownUI) {
        countdownUI = new CountdownUI();
    }

    // Get random loadout every 2 rounds (rounds 1-2 share loadout, 3-4 share, etc.)
    // Change loadout on odd rounds: 1, 3, 5, 7...
    if (roundNumber % 2 === 1 || !currentLoadout) {
        currentLoadout = getRandomLoadout();
        adminDebugTool?.dynamicLog(`New loadout for rounds ${roundNumber}-${roundNumber + 1}`);
    } else {
        adminDebugTool?.dynamicLog(`Keeping same loadout from round ${roundNumber - 1}`);
    }

    // First round: 15 seconds, subsequent rounds: 5 seconds
    const countdownTime = roundNumber === 1 ? 15 : 5;

    // Check for match point (5 wins = one round away from winning)
    const scores = getScores();
    if (scores.team1 === 5 || scores.team2 === 5) {
        // Play match point VO for the team that's at match point
        const matchPointTeam = mod.GetTeam(scores.team1 === 5 ? 1 : 2);
        playVO(mod.VoiceOverEvents2D.RoundLastRound, matchPointTeam);
        adminDebugTool?.dynamicLog(`Match point for team ${scores.team1 === 5 ? 1 : 2}!`);
    }

    // Prepare spawn positions based on side swap
    // Team 1 normally uses side 1, Team 2 normally uses side 2
    // When swapped, teams use opposite sides
    const spawnPositions = {
        team1: sidesSwapped ? side2SpawnPositions : side1SpawnPositions,
        team2: sidesSwapped ? side1SpawnPositions : side2SpawnPositions,
    };

    adminDebugTool?.dynamicLog(
        `Spawn positions: team1=${spawnPositions.team1.length}, team2=${spawnPositions.team2.length}, sidesSwapped=${sidesSwapped}`
    );

    // Reset flag capture UI for new round (hide flag underground)
    flagCaptureUI?.resetForRound();

    // Set flag position for player facing direction
    const flagPos = flagCaptureUI?.getFlagPosition();
    if (flagPos) {
        countdownUI.setFlagPosition(flagPos);
    }

    // Start countdown with spawn positions - countdown UI handles teleporting and freezing
    // Pass callback to activate bots when countdown ends
    countdownUI.start(
        countdownTime,
        team1,
        team2,
        currentLoadout,
        spawnPositions,
        handleRoundTimeEnd,
        handleOvertimeStart,
        handleCountdownEnd
    );
}

// Called when countdown ends and players are unfrozen
function handleCountdownEnd(): void {
    // Activate custom bots - set aggressive behavior and start targeting
    if (ENABLE_CUSTOM_BOTS) {
        activateBots();
    }
}

function handleRoundTimeEnd(): void {
    // Time ran out - determine winner by total team health
    if (roundEnding || !roundStarted || resettingRound) return;

    // Stop bot targeting when round ends
    if (ENABLE_CUSTOM_BOTS) {
        stopBotTargeting();
    }

    adminDebugTool?.dynamicLog('Round time ended - determining winner by health');

    // Get team health totals
    const team1Players = getAlivePlayersOnTeam(1);
    const team2Players = getAlivePlayersOnTeam(2);

    let team1Health = 0;
    let team2Health = 0;

    for (const player of team1Players) {
        try {
            team1Health += mod.GetSoldierState(player, mod.SoldierStateNumber.NormalizedHealth) * 100;
        } catch {
            // Player invalid
        }
    }

    for (const player of team2Players) {
        try {
            team2Health += mod.GetSoldierState(player, mod.SoldierStateNumber.NormalizedHealth) * 100;
        } catch {
            // Player invalid
        }
    }

    adminDebugTool?.dynamicLog(`Time up! Team1 health: ${team1Health}, Team2 health: ${team2Health}`);

    // Check for tied health (round draw). Epsilon absorbs float noise from summing
    // NormalizedHealth*100 — exact-equality could miss a true tie by 1e-13.
    const isHealthTied = Math.abs(team1Health - team2Health) < 0.01;

    // Trigger round end
    roundEnding = true;
    enterRoundTransition();

    if (isHealthTied) {
        adminDebugTool?.dynamicLog('Health tied - round draw!');
    }
    const healthWinner = team1Health > team2Health ? 1 : 2;
    // Shared teardown; health-based win (timer ran out) passes isHealthWin: true
    finishRound(isHealthTied, healthWinner, () => {
        if (isHealthTied) {
            showRoundDraw();
        } else {
            showRoundResults(healthWinner, 5000, false, true);
        }
    });
}

function resetRound(): void {
    // Don't reset if match is ending
    if (matchEnding) return;

    // Players are already deployed and frozen from the round end sequence
    // Just need to clear states and start the next round countdown

    // Prevent handlePlayerDeployed from interfering during reset
    resettingRound = true;

    // Stop the countdown UI (hides team health, etc.)
    countdownUI?.stop();

    // Reset elimination tracking for new round
    resetEliminationTracking();

    // Reset bot identity active states (stats are preserved)
    if (ENABLE_CUSTOM_BOTS) {
        resetBotIdentitiesForRound();
    }

    // Reset last killer tracking
    lastKiller = null;

    // Increment round number and start the countdown
    // Note: Side swap is handled in endRound BEFORE deployment so teleport uses correct positions
    roundNumber++;

    roundStarted = true;
    resettingRound = false;

    startRound();
}

function checkRoundEnd(): void {
    _eliminationChecks++;
    // Don't check if already ending, not started, or countdown still running
    if (roundEnding || !roundStarted || resettingRound) {
        logMain('checkRoundEnd SKIPPED', { roundEnding, roundStarted, resettingRound });
        return;
    }
    if (countdownUI?.isRunning) {
        logMain('checkRoundEnd SKIPPED - countdown running');
        return;
    }

    const team1Alive = getAlivePlayersOnTeam(1);
    const team2Alive = getAlivePlayersOnTeam(2);

    logMain('checkRoundEnd', {
        team1Alive: team1Alive.length,
        team2Alive: team2Alive.length,
        totalChecks: _eliminationChecks,
    });
    adminDebugTool?.dynamicLog(`Round check: Team1=${team1Alive.length} Team2=${team2Alive.length}`);

    // Check if a team has been eliminated
    if (team1Alive.length === 0 || team2Alive.length === 0) {
        // Prevent duplicate round end processing
        _roundEnds++;
        logMain('========== ROUND ENDING ==========', {
            roundNumber,
            totalRoundEnds: _roundEnds,
            team1Alive: team1Alive.length,
            team2Alive: team2Alive.length,
        });
        roundEnding = true;
        enterRoundTransition();

        // Check for mutual elimination (both teams wiped out at the same time)
        const isMutualElimination = team1Alive.length === 0 && team2Alive.length === 0;

        if (isMutualElimination) {
            adminDebugTool?.dynamicLog('Mutual elimination - round draw!');
        } else {
            const winningTeam = team1Alive.length > 0 ? 1 : 2;
            adminDebugTool?.dynamicLog(`Team ${winningTeam} wins the round!`);
        }

        // Shared teardown; mutual elimination = draw
        const elimWinner = team1Alive.length > 0 ? 1 : 2;
        finishRound(isMutualElimination, elimWinner, () => {
            if (isMutualElimination) {
                showRoundDraw();
            } else {
                showRoundResults(elimWinner);
            }
        });
    }
}

function deployAllAtStartPositions(callback: () => void): void {
    // Don't deploy if match is ending
    if (matchEnding) return;

    // Set spawn mode, reconcile teams (rule 1 + backfill leavers next round), then deploy.
    mod.SetSpawnMode(mod.SpawnModes.AutoSpawn);
    reconcileTeams();
    mod.DeployAllPlayers();

    // Wait for players to deploy, then call callback
    // Note: Teleporting is handled by countdownUI.start() which assigns positions
    Timers.setTimeout(() => {
        callback();
    }, 500);
}

function handlePlayerDeath(eventPlayer: mod.Player): void {
    // Don't process during round reset or if round hasn't started
    if (resettingRound || !roundStarted) {
        logMain('handlePlayerDeath SKIPPED - resetting or not started', { resettingRound, roundStarted });
        return;
    }
    if (countdownUI?.isRunning) {
        logMain('handlePlayerDeath SKIPPED - countdown running');
        return;
    }
    if (roundEnding) {
        logMain('handlePlayerDeath SKIPPED - round already ending');
        return;
    }

    // Validate dead player reference before accessing
    let playerId = -1;
    let deadTeamId = -1;
    try {
        if (!mod.IsPlayerValid(eventPlayer)) {
            // Player reference invalid - still show elimination effect
            showEliminationEffect();
            checkRoundEnd();
            return;
        }
        playerId = mod.GetObjId(eventPlayer);
        const deadPlayerTeam = mod.GetTeam(eventPlayer);
        deadTeamId = mod.GetObjId(deadPlayerTeam);
    } catch {
        // Failed to get dead player info - still show elimination
        showEliminationEffect();
        checkRoundEnd();
        return;
    }

    adminDebugTool?.dynamicLog(`Player ${playerId} died`);

    // Play death sounds to all players
    try {
        const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];

        for (const p of allPlayers) {
            try {
                if (!mod.IsPlayerValid(p)) continue;
                if (mod.GetSoldierState(p, mod.SoldierStateBool.IsAISoldier)) continue;
                if (mod.GetObjId(p) === playerId) continue; // Skip the dead player

                const playerTeam = mod.GetTeam(p);
                const isTeammate = mod.GetObjId(playerTeam) === deadTeamId;

                // Play friendly death to teammates, enemy death to enemies
                playSound(p, isTeammate ? SOUNDS.FRIENDLY_DEATH : SOUNDS.ENEMY_DEATH);
            } catch {}
        }
    } catch {}

    // Show elimination effect (X v Y) - returns true if this is final elimination
    const isFinalElimination = showEliminationEffect();

    if (isFinalElimination) {
        // SPECTATOR-BUG FIX (part 3): the round is over but checkRoundEnd waits 1600ms for
        // the elimination animation. The just-killed player's spectate engages in this window
        // with (potentially) nobody on their team left to watch — the exact engine-wedge
        // trigger. Widen the spectate pool NOW (and handle mutual wipes) so a target exists
        // by the time spectate engages; checkRoundEnd's teardown follows after the animation.
        enterRoundTransition();

        // Delay round end check to allow final elimination animation to play
        // Animation takes ~1600ms (shrink 200 + delay 300 + hold 800 + fade 300)
        Timers.setTimeout(() => {
            checkRoundEnd();
        }, 1600);
    } else {
        // Check round end immediately for non-final eliminations
        checkRoundEnd();
    }
}

// Check for round end when a player dies or is downed
Events.OnPlayerDied.subscribe((eventPlayer: mod.Player) => {
    _playerDeaths++;
    const playerId = mod.GetObjId(eventPlayer);
    logMain('OnPlayerDied', { playerId, totalDeaths: _playerDeaths });
    adminDebugTool?.dynamicLog('OnPlayerDied event fired');
    handlePlayerDeath(eventPlayer);

    // Reset bot brain on death (clear memory for respawn)
    if (mod.GetSoldierState(eventPlayer, mod.SoldierStateBool.IsAISoldier)) {
        resetBotBrain(eventPlayer);
    }

    // SPECTATOR-BUG FIX (part 4): the old 2s DeployPlayer->UndeployPlayer "spectator kick"
    // is REMOVED. It fired at unpredictable times (incl. mid-transition/countdown), ghost-
    // spawned the player for a frame (also tripping the mid-round spawn blocker), and under
    // SpawnModes.Spectating couldn't reach the deploy screen anyway. Team-wide spectate
    // filters (part 1) + Deploy-mode transitions (parts 2/3) make the kick unnecessary.
});

Events.OnMandown.subscribe((eventPlayer: mod.Player) => {
    adminDebugTool?.dynamicLog('OnMandown event fired');
    handlePlayerDeath(eventPlayer);

    // SPECTATOR-BUG FIX (part 4): the old 2s DeployPlayer->UndeployPlayer "spectator kick"
    // is REMOVED. It fired at unpredictable times (incl. mid-transition/countdown), ghost-
    // spawned the player for a frame (also tripping the mid-round spawn blocker), and under
    // SpawnModes.Spectating couldn't reach the deploy screen anyway. Team-wide spectate
    // filters (part 1) + Deploy-mode transitions (parts 2/3) make the kick unnecessary.
});

// Helper to get stats for a player (bot or human)
function getStatsForPlayer(player: mod.Player): PlayerStats {
    const botIdentity = getBotIdentityByPlayerId(mod.GetObjId(player));
    if (botIdentity) {
        return botIdentity.stats;
    }
    return getPlayerStats(player);
}

// Track kills for scoreboard and round end
Events.OnPlayerEarnedKill.subscribe((killer: mod.Player, victim: mod.Player) => {
    lastKiller = killer;
    adminDebugTool?.dynamicLog(`Last killer set to player ${mod.GetObjId(killer)}`);

    // Update scoreboard stats (uses bot persistent stats for bots)
    const killerStats = getStatsForPlayer(killer);
    killerStats.kills++;
    updateScoreboard(killer);

    const victimStats = getStatsForPlayer(victim);
    victimStats.deaths++;
    updateScoreboard(victim);
});

// ============================================================================
// DAMAGE & ASSIST TRACKING SYSTEM
// ============================================================================
// Tracks damage dealt to each player and awards assists on kill
// Damage is capped to actual health remaining (no overkill counting)
// ============================================================================

// Track current health of each player
const playerHealth: Map<number, number> = new Map();

// Track damage contributors for each victim: victimId -> Map<attackerId, totalDamage>
const damageContributors: Map<number, Map<number, number>> = new Map();

// Track player objects by ID for assist attribution
const playerObjects: Map<number, mod.Player> = new Map();

// Initialize health tracking when player deploys
Events.OnPlayerDeployed.subscribe((player: mod.Player) => {
    try {
        const playerId = mod.GetObjId(player);
        const currentHealth = mod.GetSoldierState(player, mod.SoldierStateNumber.CurrentHealth);
        playerHealth.set(playerId, currentHealth);
        damageContributors.set(playerId, new Map());
        playerObjects.set(playerId, player);

        // Ensure player has stats entry
        const stats = getStatsForPlayer(player);
        adminDebugTool?.dynamicLog(`Deploy: Player ${playerId} health=${currentHealth}, dmg=${stats.damage}`);
    } catch {}
});

// Track damage for scoreboard - accumulate damage per attacker
Events.OnPlayerDamaged.subscribe((victim: mod.Player, attacker: mod.Player) => {
    try {
        const attackerId = mod.GetObjId(attacker);
        const victimId = mod.GetObjId(victim);

        // Don't track self-damage
        if (attackerId === victimId) return;

        // Check if this is friendly fire (same team) - don't track
        try {
            const attackerTeam = mod.GetTeam(attacker);
            const victimTeam = mod.GetTeam(victim);
            if (mod.GetObjId(attackerTeam) === mod.GetObjId(victimTeam)) return;
        } catch {}

        // Notify bot brain of damage (triggers battle state)
        // If victim is a bot, it now knows it's under attack AND targets the attacker
        if (mod.GetSoldierState(victim, mod.SoldierStateBool.IsAISoldier)) {
            try {
                const attackerPos = mod.GetSoldierState(attacker, mod.SoldierStateVector.GetPosition);
                const brain = getBotBrain(victim);
                brain.onDamaged(attacker, attackerPos);

                // IMMEDIATELY snap to the attacker and open fire - trigger-happy retaliation.
                mod.AISetTarget(victim, attacker);
                mod.AIEnableShooting(victim, true);
                mod.AIEnableTargeting(victim, true);
                mod.AIForceFire(victim, 2);
                mod.AISetMoveSpeed(victim, mod.MoveSpeed.Run);

                // Human panic reaction while returning fire: 50% jump-juke away, 10% drop prone,
                // ~40% just keep doing what they were (still shooting back at the attacker).
                const react = Math.random();
                if (react < 0.5) {
                    mod.SetAiInput(victim, mod.AiInput.Jump, 0.3);
                    mod.SetAiInput(victim, mod.AiInput.Strafe, 0.6);
                } else if (react < 0.6) {
                    mod.SetAiInput(victim, mod.AiInput.Prone, 1.5);
                }

                // Clear push target - we're in combat now
                brain.clearPushTarget();
            } catch {}
        }

        // Get tracked health before this damage (default 100)
        const healthBefore = playerHealth.get(victimId) ?? 100;

        // Read current health immediately - damage should already be applied
        const healthAfter = mod.GetSoldierState(victim, mod.SoldierStateNumber.CurrentHealth);

        // Calculate actual damage (capped to health they actually had)
        const actualDamage = Math.max(0, healthBefore - healthAfter);

        // Update health tracking IMMEDIATELY to prevent race conditions
        playerHealth.set(victimId, Math.max(0, healthAfter));

        if (actualDamage > 0) {
            // Track this attacker's contribution to this victim
            let contributors = damageContributors.get(victimId);
            if (!contributors) {
                contributors = new Map();
                damageContributors.set(victimId, contributors);
            }
            const previousDamage = contributors.get(attackerId) ?? 0;
            contributors.set(attackerId, previousDamage + actualDamage);

            // Update attacker's damage stat
            const stats = getStatsForPlayer(attacker);
            stats.damage += Math.round(actualDamage);
            updateScoreboard(attacker);

            adminDebugTool?.dynamicLog(
                `DMG: Player ${attackerId} dealt ${Math.round(actualDamage)} to ${victimId}. Total: ${stats.damage}`
            );
        }
    } catch {}
});

// On kill, award assists to other players who damaged the victim
Events.OnPlayerEarnedKill.subscribe((killer: mod.Player, victim: mod.Player) => {
    try {
        const killerId = mod.GetObjId(killer);
        const victimId = mod.GetObjId(victim);

        // Get all damage contributors for this victim
        const contributors = damageContributors.get(victimId);
        if (contributors) {
            // Award assists to anyone who damaged the victim (except the killer)
            for (const [attackerId, _damage] of contributors) {
                if (attackerId !== killerId) {
                    // Find the player object for this attacker
                    const assisterPlayer = playerObjects.get(attackerId);
                    if (assisterPlayer) {
                        const stats = getStatsForPlayer(assisterPlayer);
                        stats.assists++;
                        updateScoreboard(assisterPlayer);
                    }
                }
            }
            // Clear damage tracking for this victim
            contributors.clear();
        }

        // Reset victim's health tracking for next spawn
        playerHealth.delete(victimId);
    } catch {}
});

// Clean up tracking on undeploy
Events.OnPlayerUndeploy.subscribe((player: mod.Player) => {
    try {
        const playerId = mod.GetObjId(player);
        playerHealth.delete(playerId);
        damageContributors.delete(playerId);
        // Don't delete from playerObjects - we need it for assist attribution
    } catch {}
});

// Track bot undeployment to deactivate identities
Events.OnPlayerUndeploy.subscribe((player: mod.Player) => {
    try {
        const playerId = mod.GetObjId(player);
        // Check if this is a bot with an identity
        const identity = getBotIdentityByPlayerId(playerId);
        if (identity) {
            deactivateBotIdentity(playerId);
        }
    } catch {}
});

// ============================================================================
// DEATH ZONE AREA TRIGGERS (IDs 10-20)
// ============================================================================
// Players entering these area triggers are killed instantly
// ============================================================================

// Configure which area trigger IDs are death zones (10-20)
const DEATH_ZONE_START_ID = 10;
const DEATH_ZONE_END_ID = 20;

// Kill players who enter death zone triggers
Events.OnPlayerEnterAreaTrigger.subscribe((player: mod.Player, trigger: mod.AreaTrigger) => {
    const triggerId = mod.GetObjId(trigger);
    // Check if this trigger ID is in our death zone range
    if (triggerId >= DEATH_ZONE_START_ID && triggerId <= DEATH_ZONE_END_ID) {
        mod.Kill(player);
    }
});

// Event subscriptions for the admin debug tool.
Events.OnPlayerJoinGame.subscribe(createAdminDebugTool);
Events.OnPlayerDeployed.subscribe(showTelemetry);
Events.OnPlayerUndeploy.subscribe(stopTelemetry);
Events.OnPlayerLeaveGame.subscribe(destroyAdminDebugTool);

// Play leave sound when a human player leaves (not bots)
Events.OnPlayerLeaveGame.subscribe((playerId: number) => {
    // Skip sound for bots
    if (knownBotIds.has(playerId)) {
        knownBotIds.delete(playerId); // Clean up tracking
        return;
    }

    const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];
    for (const p of allPlayers) {
        try {
            if (mod.IsPlayerValid(p) && !mod.GetSoldierState(p, mod.SoldierStateBool.IsAISoldier)) {
                playSound(p, SOUNDS.PLAYER_LEAVE);
            }
        } catch {}
    }
});

// Event subscriptions for notifying players of their name and the current map.
Events.OnPlayerDeployed.subscribe(handlePlayerDeployed);
