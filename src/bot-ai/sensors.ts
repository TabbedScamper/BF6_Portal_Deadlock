/**
 * Bot Sensor System - Probabilistic detection for realistic awareness
 * Based on bf6-portal-bots-brain sensor patterns
 */

import { BotMemory } from './memory.ts';
import { getAlivePlayersOnTeam } from '../helpers/index.ts';
import { canSeeEnemy } from './los.ts';

// ========== CONFIGURATION ==========
export const SENSOR_CONFIG = {
    // Enemy detection - AGGRESSIVE settings
    SIGHT_RANGE: 60, // Max detection range (meters)
    DETECTION_SENSITIVITY: 2.5, // Higher = easier to detect (was 1.0, now very aggressive)
    DETECTION_BASE_PROB: 0.06, // Lower = higher probability (was 0.12)
    GUARANTEED_DETECTION_RANGE: 20, // Guaranteed detection within this range (was 5)
    POINT_BLANK: 7, // <= this range an enemy is ALWAYS seen (skip the LOS ray) so bots never freeze in your face

    // Memory TTLs
    ENEMY_MEMORY_TTL: 10000, // How long to remember enemy position (10s)
    VISIBLE_ENEMY_TTL: 2000, // How long enemy stays "visible" in memory (2s - keeps targeting)
    BATTLE_TTL: 8000, // How long "in battle" state lasts (8s)
    ROAM_TTL: 15000, // How long to pursue a roam point (15s)
    SEARCH_TTL: 5000, // How long to search an area (5s)

    // Roaming
    ROAM_MIN_DIST: 8, // Minimum roam distance
    ROAM_PREFERRED_MIN: 12, // Preferred range start
    ROAM_PREFERRED_MAX: 25, // Preferred range end
    ROAM_MAX_DIST: 35, // Maximum roam distance

    // Arrival
    ARRIVAL_THRESHOLD: 2.5, // Distance to consider "arrived"

    // Update rates (ms) - FAST reaction times
    ENEMY_SENSOR_RATE: 100, // Check for enemies every 100ms (was 300ms - now 3x faster)
    ROAM_SENSOR_RATE: 1000, // Check for new roam point every 1s
    FLAG_SENSOR_RATE: 150, // Check flag situation every 150ms (urgent!)

    // Flag/Overtime settings
    FLAG_CAPTURE_RADIUS: 3.0, // Distance to be "on" flag
    FLAG_CLOSE_RADIUS: 10.0, // Distance to be "close" to flag
    FLAG_ENGAGE_RADIUS: 15.0, // Engage enemies within this range of flag
    FLAG_TTL: 500, // Flag memory refresh rate
    FLAG_URGENCY_BASE: 0.3, // Base urgency when flag spawns
    FLAG_URGENCY_MAX: 1.0, // Max urgency (time running out)
    // OVERTIME AGGRESSION: at/above this urgency the flag outranks everything — every bot
    // commits to the point, ignores the ally-is-capturing "provide cover" branch, sprints
    // the approach, and won't peel off to fight a distant enemy. Overtime is a race, not a
    // firefight: sitting off-point trading shots loses the round.
    FLAG_URGENCY_ALL_IN: 0.55,
};

/**
 * Check if bot can potentially see an enemy (distance + probability check)
 * AGGRESSIVE: High detection rates, guaranteed detection at close-medium range
 */
export function canDetectEnemy(
    botPos: mod.Vector,
    enemyPos: mod.Vector,
    sensitivity: number = SENSOR_CONFIG.DETECTION_SENSITIVITY
): boolean {
    const distance = mod.DistanceBetween(botPos, enemyPos);

    // Out of range = no detection
    if (distance > SENSOR_CONFIG.SIGHT_RANGE) return false;

    // Within guaranteed range = ALWAYS detect (20m default)
    if (distance < SENSOR_CONFIG.GUARANTEED_DETECTION_RANGE) return true;

    // Beyond guaranteed range: still high probability detection
    // Formula: P = e^(-0.06 * distance / sensitivity) with high sensitivity
    const probability = Math.exp(-SENSOR_CONFIG.DETECTION_BASE_PROB * distance * (1.0 / sensitivity));

    // Minimum 50% chance even at max range
    return Math.random() < Math.max(0.5, probability);
}

/**
 * Find a visible enemy for this bot (probabilistic)
 * Returns the enemy player if detected, null otherwise
 */
export function senseEnemy(bot: mod.Player, memory: BotMemory): mod.Player | null {
    try {
        const botTeam = mod.GetTeam(bot);
        const botTeamId = mod.GetObjId(botTeam);
        const team1Id = mod.GetObjId(mod.GetTeam(1));
        const enemyTeamId = botTeamId === team1Id ? 2 : 1;

        const botPos = mod.GetSoldierState(bot, mod.SoldierStateVector.GetPosition);
        const enemies = getAlivePlayersOnTeam(enemyTeamId);

        // Find closest DETECTABLE enemy, with priority to firing enemies
        let closestEnemy: mod.Player | null = null;
        let closestDistance = Infinity;
        let closestFiringEnemy: mod.Player | null = null;
        let closestFiringDistance = Infinity;

        for (const enemy of enemies) {
            try {
                if (!mod.IsPlayerValid(enemy)) continue;

                const enemyPos = mod.GetSoldierState(enemy, mod.SoldierStateVector.GetPosition);
                const distance = mod.DistanceBetween(botPos, enemyPos);

                // Check if enemy is firing - they get priority detection!
                const isFiring = mod.GetSoldierState(enemy, mod.SoldierStateBool.IsFiring);

                if (isFiring && distance < SENSOR_CONFIG.SIGHT_RANGE) {
                    // Firing enemies are ALWAYS detected within sight range
                    if (distance < closestFiringDistance) {
                        closestFiringDistance = distance;
                        closestFiringEnemy = enemy;
                    }
                }

                // Check if we can detect this enemy (normal detection)
                if (distance < closestDistance && canDetectEnemy(botPos, enemyPos)) {
                    closestDistance = distance;
                    closestEnemy = enemy;
                }
            } catch {}
        }

        // No wallhacks: only lock onto an enemy we have a clear LINE OF SIGHT to.
        // (LOS is tracked per bot to its closest enemy via the raycast round-robin in los.ts.)
        const botId = mod.GetObjId(bot);
        const PB = SENSOR_CONFIG.POINT_BLANK;
        let targetEnemy: mod.Player | null = null;
        // Point-blank enemies are always seen; beyond that, require a clear raycast LOS (no wallhacks).
        if (
            closestFiringEnemy &&
            (closestFiringDistance < PB || canSeeEnemy(botId, mod.GetObjId(closestFiringEnemy)))
        ) {
            targetEnemy = closestFiringEnemy; // firing + visible = highest priority
        } else if (closestEnemy && (closestDistance < PB || canSeeEnemy(botId, mod.GetObjId(closestEnemy)))) {
            targetEnemy = closestEnemy;
        }

        if (targetEnemy) {
            // Store in memory (we actually saw them, so this last-known position is real).
            const enemyPos = mod.GetSoldierState(targetEnemy, mod.SoldierStateVector.GetPosition);
            memory.set('visibleEnemy', targetEnemy, SENSOR_CONFIG.VISIBLE_ENEMY_TTL);
            memory.set('lastKnownEnemyPos', enemyPos, SENSOR_CONFIG.ENEMY_MEMORY_TTL);
            memory.set('isInBattle', true, SENSOR_CONFIG.BATTLE_TTL);

            return targetEnemy;
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Generate a roam/patrol position for the bot
 * Uses direction-driven selection to avoid backtracking
 */
export function senseRoamPosition(
    bot: mod.Player,
    memory: BotMemory,
    flagPos: mod.Vector | null,
    spawnPositions: mod.Vector[]
): mod.Vector | null {
    // Don't generate new roam if we have one
    if (memory.has('roamPos')) return null;

    try {
        const botPos = mod.GetSoldierState(bot, mod.SoldierStateVector.GetPosition);

        // Get bot's forward direction (velocity or facing)
        let forward: mod.Vector;
        try {
            const velocity = mod.GetSoldierState(bot, mod.SoldierStateVector.GetLinearVelocity);
            // Use dot product to get squared magnitude (more efficient than sqrt)
            const speedSq = mod.DotProduct(velocity, velocity);

            if (speedSq > 0.09) {
                // 0.3^2 = 0.09
                forward = mod.Normalize(velocity);
            } else {
                // Use facing direction if not moving
                forward = mod.GetSoldierState(bot, mod.SoldierStateVector.GetFacingDirection);
                forward = mod.Normalize(forward);
            }
        } catch {
            // Fallback to direction toward flag or default
            try {
                forward = mod.DirectionTowards(botPos, flagPos || mod.CreateVector(0, 0, 0));
            } catch {
                forward = mod.CreateVector(0, 0, 1);
            }
        }

        // Collect candidate waypoints
        const candidates: { pos: mod.Vector; score: number }[] = [];

        // Add flag position as high-priority candidate
        if (flagPos) {
            candidates.push({ pos: flagPos, score: 1.5 });
        }

        // Add spawn positions as candidates
        for (const pos of spawnPositions) {
            candidates.push({ pos, score: 1.0 });
        }

        // Add some random positions around the bot
        for (let i = 0; i < 4; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist =
                SENSOR_CONFIG.ROAM_MIN_DIST +
                Math.random() * (SENSOR_CONFIG.ROAM_MAX_DIST - SENSOR_CONFIG.ROAM_MIN_DIST);

            const randomPos = mod.CreateVector(
                mod.XComponentOf(botPos) + Math.cos(angle) * dist,
                mod.YComponentOf(botPos),
                mod.ZComponentOf(botPos) + Math.sin(angle) * dist
            );
            candidates.push({ pos: randomPos, score: 0.8 });
        }

        // Score candidates based on distance and direction
        let bestCandidate: mod.Vector | null = null;
        let bestScore = -Infinity;

        for (const candidate of candidates) {
            const dist = mod.DistanceBetween(botPos, candidate.pos);

            // Skip if too close or too far
            if (dist < SENSOR_CONFIG.ROAM_MIN_DIST || dist > SENSOR_CONFIG.ROAM_MAX_DIST) {
                continue;
            }

            // Distance score (prefer 12-25m range)
            let distScore: number;
            if (dist < SENSOR_CONFIG.ROAM_PREFERRED_MIN) {
                distScore = dist / SENSOR_CONFIG.ROAM_PREFERRED_MIN;
            } else if (dist <= SENSOR_CONFIG.ROAM_PREFERRED_MAX) {
                distScore = 1.0;
            } else {
                const excess = dist - SENSOR_CONFIG.ROAM_PREFERRED_MAX;
                distScore = Math.max(0, 1 - excess / 15);
            }

            // Direction score (prefer forward movement)
            const toCandidate = mod.DirectionTowards(botPos, candidate.pos);
            const dirScore = Math.max(0, mod.DotProduct(forward, toCandidate));

            // Combined score with jitter
            const jitter = Math.random() * 0.4;
            const totalScore = distScore * 0.5 + dirScore * 0.3 + candidate.score * 0.2 + jitter;

            if (totalScore > bestScore) {
                bestScore = totalScore;
                bestCandidate = candidate.pos;
            }
        }

        if (bestCandidate) {
            memory.set('roamPos', bestCandidate, SENSOR_CONFIG.ROAM_TTL);
        }

        return bestCandidate;
    } catch {
        return null;
    }
}

/**
 * Check if bot has arrived at its destination
 */
export function senseArrival(bot: mod.Player, memory: BotMemory): boolean {
    const roamPos = memory.get('roamPos');
    if (!roamPos) return false;

    try {
        const botPos = mod.GetSoldierState(bot, mod.SoldierStateVector.GetPosition);
        const distance = mod.DistanceBetween(botPos, roamPos);

        if (distance < SENSOR_CONFIG.ARRIVAL_THRESHOLD) {
            // Clear roam position so we can get a new one
            memory.clear('roamPos');
            memory.set('arrivedAtDest', true, 2000);
            return true;
        }

        return false;
    } catch {
        return false;
    }
}

/**
 * Trigger battle state when bot takes damage
 */
export function onBotDamaged(memory: BotMemory, attackerPos?: mod.Vector): void {
    memory.set('isInBattle', true, SENSOR_CONFIG.BATTLE_TTL);

    // If we know where the attack came from, remember it
    if (attackerPos) {
        memory.set('lastKnownEnemyPos', attackerPos, SENSOR_CONFIG.ENEMY_MEMORY_TTL);
    }
}

/**
 * Trigger battle state when bot is firing
 */
export function onBotFiring(memory: BotMemory): void {
    memory.set('isInBattle', true, SENSOR_CONFIG.BATTLE_TTL);
}

// ========== FLAG/OVERTIME SENSORS ==========

export interface FlagContext {
    flagPos: mod.Vector;
    urgency: number; // 0-1, how urgent is flag capture
    allyCount: number; // Alive allies (including this bot)
    enemyCount: number; // Alive enemies
    botDistToFlag: number; // This bot's distance to flag
    enemyOnFlag: boolean; // Is any enemy on/near flag
    allyOnFlag: boolean; // Is any ally on/near flag (excluding this bot)
    closestEnemyToFlag: number; // Closest enemy distance to flag
}

/**
 * Evaluate the flag situation and decide if bot should push
 * Returns detailed context for decision making
 */
export function senseFlagContext(bot: mod.Player, flagPos: mod.Vector, urgency: number): FlagContext | null {
    try {
        const botTeam = mod.GetTeam(bot);
        const botTeamId = mod.GetObjId(botTeam);
        const team1Id = mod.GetObjId(mod.GetTeam(1));
        const enemyTeamId = botTeamId === team1Id ? 2 : 1;
        const allyTeamId = botTeamId === team1Id ? 1 : 2;

        const botPos = mod.GetSoldierState(bot, mod.SoldierStateVector.GetPosition);
        const botDistToFlag = mod.DistanceBetween(botPos, flagPos);

        const enemies = getAlivePlayersOnTeam(enemyTeamId);
        const allies = getAlivePlayersOnTeam(allyTeamId);

        let enemyOnFlag = false;
        let closestEnemyToFlag = Infinity;

        for (const enemy of enemies) {
            try {
                const enemyPos = mod.GetSoldierState(enemy, mod.SoldierStateVector.GetPosition);
                const dist = mod.DistanceBetween(enemyPos, flagPos);
                if (dist < closestEnemyToFlag) closestEnemyToFlag = dist;
                if (dist <= SENSOR_CONFIG.FLAG_CAPTURE_RADIUS) {
                    enemyOnFlag = true;
                }
            } catch {}
        }

        let allyOnFlag = false;
        for (const ally of allies) {
            try {
                // Skip self
                if (mod.GetObjId(ally) === mod.GetObjId(bot)) continue;
                const allyPos = mod.GetSoldierState(ally, mod.SoldierStateVector.GetPosition);
                const dist = mod.DistanceBetween(allyPos, flagPos);
                if (dist <= SENSOR_CONFIG.FLAG_CAPTURE_RADIUS) {
                    allyOnFlag = true;
                    break;
                }
            } catch {}
        }

        return {
            flagPos,
            urgency,
            allyCount: allies.length,
            enemyCount: enemies.length,
            botDistToFlag,
            enemyOnFlag,
            allyOnFlag,
            closestEnemyToFlag,
        };
    } catch {
        return null;
    }
}

/**
 * Decide if this bot should push the flag based on context
 * Uses tactical reasoning, not just random chance
 */
export function shouldBotPushFlag(bot: mod.Player, memory: BotMemory, ctx: FlagContext): boolean {
    // ALWAYS push if enemy is capturing - this is urgent!
    if (ctx.enemyOnFlag) {
        return true;
    }

    // OVERTIME ALL-IN: once urgency crosses the threshold EVERY bot commits, before any
    // of the situational branches below. Checked ahead of the ally-on-flag branch on
    // purpose — late in overtime a lone capturer needs bodies on the point, not a cordon.
    if (ctx.urgency >= SENSOR_CONFIG.FLAG_URGENCY_ALL_IN) {
        return true;
    }

    // If ally is already on flag and no enemies nearby, provide cover instead
    if (ctx.allyOnFlag && ctx.closestEnemyToFlag > SENSOR_CONFIG.FLAG_ENGAGE_RADIUS) {
        return false;
    }

    // Numbers advantage - be aggressive
    if (ctx.allyCount > ctx.enemyCount) {
        // 80% chance to push with advantage
        return Math.random() < 0.8;
    }

    // Numbers disadvantage - be more defensive, but still contest
    if (ctx.allyCount < ctx.enemyCount) {
        // Only push if urgency is building or we're already close
        if (ctx.urgency > 0.5 || ctx.botDistToFlag < SENSOR_CONFIG.FLAG_CLOSE_RADIUS) {
            return Math.random() < 0.5;
        }
        return false;
    }

    // Even numbers - moderate aggression based on distance and urgency
    const distanceFactor = Math.max(0, 1 - ctx.botDistToFlag / 30); // Closer = more likely
    const urgencyFactor = ctx.urgency;
    const pushChance = 0.3 + distanceFactor * 0.3 + urgencyFactor * 0.4;

    return Math.random() < pushChance;
}

/**
 * Update flag-related memory based on current situation
 */
export function senseFlagSituation(
    bot: mod.Player,
    memory: BotMemory,
    flagPos: mod.Vector | null,
    urgency: number
): void {
    // No flag = clear flag memory
    if (!flagPos) {
        memory.clear('flagPos');
        memory.clear('shouldPushFlag');
        memory.clear('enemyOnFlag');
        memory.clear('flagUrgency');
        return;
    }

    const ctx = senseFlagContext(bot, flagPos, urgency);
    if (!ctx) return;

    // Update flag memory
    memory.set('flagPos', flagPos, SENSOR_CONFIG.FLAG_TTL);
    memory.set('flagUrgency', urgency, SENSOR_CONFIG.FLAG_TTL);
    memory.set('enemyOnFlag', ctx.enemyOnFlag, SENSOR_CONFIG.FLAG_TTL);

    // Decide if we should push
    const shouldPush = shouldBotPushFlag(bot, memory, ctx);
    memory.set('shouldPushFlag', shouldPush, SENSOR_CONFIG.FLAG_TTL);

    // If enemy is on flag, this is a battle situation
    if (ctx.enemyOnFlag) {
        memory.set('isInBattle', true, SENSOR_CONFIG.BATTLE_TTL);
    }
}

/**
 * Check if bot has an enemy between them and the flag
 * Used to decide whether to engage or bypass
 */
export function hasEnemyBlockingFlag(bot: mod.Player, memory: BotMemory, flagPos: mod.Vector): boolean {
    const visibleEnemy = memory.get('visibleEnemy');
    if (!visibleEnemy) return false;

    try {
        const botPos = mod.GetSoldierState(bot, mod.SoldierStateVector.GetPosition);
        const enemyPos = mod.GetSoldierState(visibleEnemy, mod.SoldierStateVector.GetPosition);

        const botToFlag = mod.DistanceBetween(botPos, flagPos);
        const enemyToFlag = mod.DistanceBetween(enemyPos, flagPos);
        const botToEnemy = mod.DistanceBetween(botPos, enemyPos);

        // Enemy is "blocking" if they're between us and the flag
        // and within engagement range
        return enemyToFlag < botToFlag && botToEnemy < SENSOR_CONFIG.FLAG_ENGAGE_RADIUS;
    } catch {
        return false;
    }
}
