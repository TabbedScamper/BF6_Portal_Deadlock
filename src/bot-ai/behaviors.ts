/**
 * Bot Behavior System - Weight-based behavior selection
 * Based on bf6-portal-bots-brain BehaviorSelector pattern
 */

import { BotMemory } from './memory.ts';
import type { BotMemoryFields } from './memory.ts';
import { SENSOR_CONFIG } from './sensors.ts';

// ========== CONFIGURATION ==========
export const BEHAVIOR_CONFIG = {
    // Position comparison threshold (avoid redundant commands)
    POS_EPSILON: 0.5,

    // Defend position radii
    DEFEND_MIN_RADIUS: 2.0,
    DEFEND_MAX_RADIUS: 8.0,

    // Push forward settings
    PUSH_ARRIVAL_DIST: 3.0, // Distance to consider "arrived" at push target
    // --- OVERTIME ALL-IN (flag urgency >= SENSOR_CONFIG.FLAG_URGENCY_ALL_IN) ---
    ALL_IN_FIGHT_RADIUS: 6.0, // Only a threat THIS close stops the run for the flag (else 15m)
    ALL_IN_SPRINT_DIST: 8.0, // Beyond this range, sprint straight at the point
    ALL_IN_REFEED_MS: 1000, // Re-issue the approach this often so a stale path can't park a bot
};

// Behavior weights (higher = higher priority)
// Note: Flag weights are DYNAMIC - they increase based on urgency and situation
export const DEFAULT_WEIGHTS: Partial<Record<keyof BotMemoryFields, number>> = {
    enemyOnFlag: 150, // CRITICAL: Enemy capturing = drop everything
    visibleEnemy: 100, // Highest: actively engage visible enemy
    shouldPushFlag: 90, // Very high: push flag when decided
    isInBattle: 80, // High: battlefield behavior when in combat
    pushTarget: 70, // High: push forward at round start (before roam)
    lastKnownEnemyPos: 60, // Medium: search last known position
    searchPos: 50, // Medium-low: search around area
    flagPos: 40, // Medium-low: move toward flag area
    roamPos: 30, // Low: patrol to roam point
    arrivedAtDest: 10, // Lowest: defend when arrived
};

// OVERTIME ALL-IN WEIGHTS — swapped in by the brain once flag urgency crosses
// FLAG_URGENCY_ALL_IN. The only change that matters: the flag keys now outrank
// visibleEnemy, so a bot that spots an enemy anywhere KEEPS RUNNING FOR THE POINT and
// fights on the move, instead of stopping to duel while the clock runs out. Everything
// below visibleEnemy is untouched (search/roam still work when there's no flag intent).
export const OVERTIME_WEIGHTS: Partial<Record<keyof BotMemoryFields, number>> = {
    enemyOnFlag: 200, // still the top priority: contest the capture itself
    shouldPushFlag: 160, // > visibleEnemy: commit to the point
    flagPos: 120, // > visibleEnemy: even general flag awareness beats free-roam combat
    visibleEnemy: 100,
    isInBattle: 80,
    pushTarget: 70,
    lastKnownEnemyPos: 60,
    searchPos: 50,
    roamPos: 30,
    arrivedAtDest: 10,
};

export type BehaviorKind = 'battlefield' | 'defend' | 'moveto' | 'search' | 'flagpush' | 'flagengage' | 'push' | 'reposition';

/**
 * Maps memory keys to behavior types
 */
function getBehaviorForKey(key: keyof BotMemoryFields): BehaviorKind | null {
    switch (key) {
        // Flag behaviors - highest priority
        case 'enemyOnFlag':
            return 'flagengage'; // Rush to flag AND fight

        case 'shouldPushFlag':
            return 'flagpush'; // Push to flag with combat awareness

        // Combat behaviors
        case 'visibleEnemy':
        case 'isInBattle':
            return 'battlefield';

        // Push forward at round start
        case 'pushTarget':
            return 'push';

        case 'arrivedAtDest':
            return 'defend';

        case 'lastKnownEnemyPos':
        case 'searchPos':
            return 'search';

        // Movement behaviors
        case 'flagPos':
            return 'flagpush'; // General flag awareness

        case 'roamPos':
            return 'moveto';

        default:
            return null;
    }
}

/**
 * BotBehaviorSelector
 *
 * Selects and executes the appropriate behavior based on memory state.
 * Uses weight-based priority to determine which behavior to run.
 */
export class BotBehaviorSelector {
    private weights: Partial<Record<keyof BotMemoryFields, number>>;
    private currentBehavior: BehaviorKind | null = null;
    private lastMoveToPos: mod.Vector | null = null;
    private lastDefendPos: mod.Vector | null = null;
    private lastSearchPos: mod.Vector | null = null;
    private lastFlagPos: mod.Vector | null = null;
    private lastPushPos: mod.Vector | null = null;
    private lastFlagPushAt: number = 0; // all-in approach re-feed clock (see executeFlagPush)
    // Reposition override (ported from FFA-Gunmaster): the stuck watchdog briefly forces a jammed
    // bot to shove off a wall, beating normal pursuit so it doesn't instantly re-issue a MoveTo
    // straight back into the wall. Ends on arrival or timeout.
    private repositionPos: mod.Vector | null = null;
    private repositionUntil: number = 0;

    constructor(weights: Partial<Record<keyof BotMemoryFields, number>> = DEFAULT_WEIGHTS) {
        this.weights = weights;
    }

    /**
     * Update weights at runtime
     */
    setWeights(weights: Partial<Record<keyof BotMemoryFields, number>>): void {
        this.weights = weights;
    }

    /**
     * Reset state (call on bot death/respawn)
     */
    reset(): void {
        this.currentBehavior = null;
        this.lastMoveToPos = null;
        this.lastDefendPos = null;
        this.lastSearchPos = null;
        this.lastFlagPos = null;
        this.lastPushPos = null;
        this.repositionPos = null;
    }

    /** Forget cached movement so the next tick RE-ISSUES its MoveTo — the skip-guards
     *  (lastMoveToPos/lastSearchPos ≈ target -> return) otherwise suppress the re-issue
     *  forever after a failed/blocked path. Called by the brain's stuck watchdog.
     *  (Ported from FFA-Gunmaster.) */
    resetMovement(): void {
        this.currentBehavior = null;
        this.lastMoveToPos = null;
        this.lastSearchPos = null;
        this.lastDefendPos = null;
        this.lastPushPos = null;
        // NOTE: lastFlagPos is deliberately kept — flag intent is objective state, not a
        // movement cache, and the watchdog never fires while a flag behavior is active.
    }

    /** Stuck-watchdog hook (ported from FFA-Gunmaster): shove a jammed bot toward `pos` for
     *  `durationMs`, overriding pursuit so it un-jams off a wall (and moves far enough that the
     *  close-range LOS ray stops false-clearing THROUGH the wall). Keeps the bot's target. */
    forceReposition(pos: mod.Vector, durationMs: number): void {
        this.repositionPos = pos;
        this.repositionUntil = Date.now() + durationMs;
        this.currentBehavior = null;
        this.lastMoveToPos = null;
        this.lastSearchPos = null;
        this.lastDefendPos = null;
    }

    /**
     * Select and execute the best behavior for this tick
     */
    update(player: mod.Player, memory: BotMemory): void {
        if (!mod.IsPlayerValid(player)) return;
        if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive)) return;

        // REPOSITION OVERRIDE (ported from FFA-Gunmaster): briefly forced by the stuck watchdog to
        // shove a jammed bot off a wall. Beats normal target-selection so the bot actually un-jams
        // instead of the battlefield behavior instantly re-issuing a MoveTo straight back into the
        // wall. Ends on arrival or timeout.
        if (this.repositionPos && Date.now() < this.repositionUntil) {
            try {
                const bp = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
                if (mod.DistanceBetween(bp, this.repositionPos) < 3) {
                    this.repositionPos = null; // arrived — hand back to normal behavior
                } else {
                    if (this.currentBehavior !== 'reposition') {
                        mod.AISetMoveSpeed(player, mod.MoveSpeed.Run);
                        mod.AIValidatedMoveToBehavior(player, this.repositionPos);
                        this.currentBehavior = 'reposition';
                    }
                    return;
                }
            } catch { this.repositionPos = null; }
        } else if (this.repositionPos) {
            this.repositionPos = null; // window elapsed
        }

        // Find highest-weight memory key that is currently set
        const winnerKey = this.getWinnerKey(memory);
        if (!winnerKey) return;

        const behavior = getBehaviorForKey(winnerKey);
        if (!behavior) return;

        this.executeBehavior(player, memory, behavior, winnerKey);
    }

    /**
     * Find the highest-weight memory key that is currently set
     */
    private getWinnerKey(memory: BotMemory): keyof BotMemoryFields | null {
        let bestKey: keyof BotMemoryFields | null = null;
        let bestScore = -Infinity;

        for (const key of Object.keys(this.weights) as Array<keyof BotMemoryFields>) {
            if (!memory.has(key)) continue;

            const score = this.weights[key] ?? 0;
            if (score > bestScore) {
                bestScore = score;
                bestKey = key;
            }
        }

        return bestKey;
    }

    /**
     * Execute the selected behavior
     */
    private executeBehavior(
        player: mod.Player,
        memory: BotMemory,
        behavior: BehaviorKind,
        memoryKey: keyof BotMemoryFields
    ): void {
        switch (behavior) {
            case 'flagengage':
                this.executeFlagEngage(player, memory);
                break;

            case 'flagpush':
                this.executeFlagPush(player, memory);
                break;

            case 'battlefield':
                this.executeBattlefield(player, memory);
                break;

            case 'push':
                this.executePush(player, memory);
                break;

            case 'defend':
                this.executeDefend(player, memory);
                break;

            case 'search':
                this.executeSearch(player, memory, memoryKey);
                break;

            case 'moveto':
                this.executeMoveTo(player, memory);
                break;
        }
    }

    /**
     * Battlefield behavior - AGGRESSIVE engagement
     * Always re-target visible enemies and ensure shooting is enabled
     */
    private executeBattlefield(player: mod.Player, memory: BotMemory): void {
        const visibleEnemy = memory.get('visibleEnemy');
        if (!visibleEnemy) {
            // LOST SIGHT (the visibleEnemy TTL lapsed with no fresh LOS). Don't idle in
            // 'battlefield' with no target: if we still remember WHERE we last saw them, CHASE
            // that spot (executeSearch); once we arrive (it clears lastKnownEnemyPos) or the
            // trail goes cold, drop the battle flag so we resume roaming instead of statue-ing
            // out the isInBattle TTL. Fully INTERRUPTIBLE — re-spotting any enemy re-sets
            // visibleEnemy (weight 100 > isInBattle 80) and a hit arms the retaliate lock; either
            // yanks us straight back into the fight next tick. (Chase ported from FFA-Gunmaster.)
            if (memory.has('lastKnownEnemyPos')) {
                this.executeSearch(player, memory, 'lastKnownEnemyPos');
            } else {
                memory.clear('isInBattle');
            }
            return;
        }

        // WON-THE-FIGHT FIX (from FFA-Gunmaster): target dead or gone -> drop the WHOLE battle
        // state NOW. Leaving isInBattle up blocked the roam sensor for its full TTL (and
        // lastKnownEnemyPos for longer), so a bot that had just WON a fight stood frozen on the
        // spot — a big share of the "bots stand around" reports.
        let gone = false;
        try {
            gone =
                !mod.IsPlayerValid(visibleEnemy) ||
                !mod.GetSoldierState(visibleEnemy, mod.SoldierStateBool.IsAlive);
        } catch {
            gone = true;
        }
        if (gone) {
            memory.clear('visibleEnemy');
            memory.clear('isInBattle');
            memory.clear('lastKnownEnemyPos');
            return;
        }

        // LIVE visible enemy — ENGAGE. Apply the engine battlefield behavior (fight-while-moving)
        // when first entering combat, then (re)assert OUR target on top of it each tick. Applying
        // this AFTER the sight/gone checks means a lost-sight bot chases instead of standing in
        // AIBattlefieldBehavior with no target (the old order re-applied it before the checks).
        if (this.currentBehavior !== 'battlefield') {
            try {
                mod.AISetMoveSpeed(player, mod.MoveSpeed.Run); // stop sprinting when engaging
            } catch {}
            mod.AIBattlefieldBehavior(player);
            this.currentBehavior = 'battlefield';
            this.lastMoveToPos = null;
            this.lastDefendPos = null;
            this.lastSearchPos = null;
        }

        try {
            mod.AISetTarget(player, visibleEnemy);
            mod.AIEnableShooting(player, true);
            mod.AIEnableTargeting(player, true);
        } catch {}
    }

    /**
     * Defend behavior - hold position after arrival
     */
    private executeDefend(player: mod.Player, memory: BotMemory): void {
        const botPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);

        // Skip if already defending nearby position
        if (
            this.currentBehavior === 'defend' &&
            this.lastDefendPos &&
            mod.DistanceBetween(this.lastDefendPos, botPos) <= BEHAVIOR_CONFIG.POS_EPSILON
        ) {
            return;
        }

        mod.AIDefendPositionBehavior(
            player,
            botPos,
            BEHAVIOR_CONFIG.DEFEND_MIN_RADIUS,
            BEHAVIOR_CONFIG.DEFEND_MAX_RADIUS
        );

        this.currentBehavior = 'defend';
        this.lastDefendPos = botPos;
        this.lastMoveToPos = null;
        this.lastSearchPos = null;
    }

    /**
     * Search behavior - investigate last known enemy position
     */
    private executeSearch(player: mod.Player, memory: BotMemory, memoryKey: keyof BotMemoryFields): void {
        let targetPos: mod.Vector | null = null;

        if (memoryKey === 'lastKnownEnemyPos') {
            targetPos = memory.get('lastKnownEnemyPos');
        } else if (memoryKey === 'searchPos') {
            targetPos = memory.get('searchPos');
        }

        if (!targetPos) return;

        // ARRIVED at the search point? Clear the memory key so the bot falls through to roaming
        // instead of standing on the spot until the TTL expires. This is ALSO what hands the chase
        // back: once lastKnownEnemyPos is cleared here, executeBattlefield drops isInBattle next
        // tick and the bot resumes roaming. (Arrival-clear ported from FFA-Gunmaster — without it
        // the chase would statue at the last-known position.)
        try {
            const botPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
            if (mod.DistanceBetween(botPos, targetPos) < 4) {
                memory.clear(memoryKey);
                return;
            }
        } catch {}

        // Skip if already searching nearby position
        if (
            this.currentBehavior === 'search' &&
            this.lastSearchPos &&
            mod.DistanceBetween(this.lastSearchPos, targetPos) <= BEHAVIOR_CONFIG.POS_EPSILON
        ) {
            return;
        }

        // Move to search position — sprint the long legs, run the approach (stay combat-ready:
        // this is hunting a last-known enemy position). (Speed ramp ported from FFA-Gunmaster.)
        try {
            const botPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
            const far = mod.DistanceBetween(botPos, targetPos) > 20;
            mod.AISetMoveSpeed(player, far ? mod.MoveSpeed.Sprint : mod.MoveSpeed.Run);
        } catch {}
        mod.AIValidatedMoveToBehavior(player, targetPos);

        this.currentBehavior = 'search';
        this.lastSearchPos = targetPos;
        this.lastMoveToPos = null;
        this.lastDefendPos = null;

        // Mark search position for arrival check
        memory.set('searchPos', targetPos, SENSOR_CONFIG.SEARCH_TTL);
    }

    /**
     * MoveTo behavior - patrol to roam position
     */
    private executeMoveTo(player: mod.Player, memory: BotMemory): void {
        const roamPos = memory.get('roamPos');
        if (!roamPos) return;

        // Skip if already moving to nearby position
        if (
            this.currentBehavior === 'moveto' &&
            this.lastMoveToPos &&
            mod.DistanceBetween(this.lastMoveToPos, roamPos) <= BEHAVIOR_CONFIG.POS_EPSILON
        ) {
            return;
        }

        mod.AIValidatedMoveToBehavior(player, roamPos);

        this.currentBehavior = 'moveto';
        this.lastMoveToPos = roamPos;
        this.lastDefendPos = null;
        this.lastSearchPos = null;
    }

    /**
     * Push behavior - aggressive forward movement at round start
     * Moves toward enemy side until reaching target or seeing enemy
     */
    private executePush(player: mod.Player, memory: BotMemory): void {
        const pushTarget = memory.get('pushTarget');
        if (!pushTarget) return;

        const botPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
        const distToTarget = mod.DistanceBetween(botPos, pushTarget);

        // Check if we've arrived at push target
        if (distToTarget < BEHAVIOR_CONFIG.PUSH_ARRIVAL_DIST) {
            // Clear push target - we've arrived, switch to normal roaming
            memory.clear('pushTarget');
            this.lastPushPos = null;
            // Switch back to normal run speed
            try {
                mod.AISetMoveSpeed(player, mod.MoveSpeed.Run);
            } catch {}
            return;
        }

        // Skip if already pushing to same position
        if (
            this.currentBehavior === 'push' &&
            this.lastPushPos &&
            mod.DistanceBetween(this.lastPushPos, pushTarget) <= BEHAVIOR_CONFIG.POS_EPSILON
        ) {
            return;
        }

        // Sprint toward push target
        try {
            mod.AISetMoveSpeed(player, mod.MoveSpeed.Sprint);
        } catch {}
        mod.AIValidatedMoveToBehavior(player, pushTarget);

        this.currentBehavior = 'push';
        this.lastPushPos = pushTarget;
        this.lastMoveToPos = null;
        this.lastDefendPos = null;
        this.lastSearchPos = null;
    }

    // ========== FLAG BEHAVIORS ==========

    /**
     * FlagEngage behavior - URGENT rush to flag while fighting
     * Used when enemy is capturing the flag
     */
    private executeFlagEngage(player: mod.Player, memory: BotMemory): void {
        const flagPos = memory.get('flagPos');
        if (!flagPos) return;

        // ALWAYS ensure shooting is enabled during flag engagement
        try {
            mod.AIEnableShooting(player, true);
            mod.AIEnableTargeting(player, true);
        } catch {}

        // Set target if we have a visible enemy
        const visibleEnemy = memory.get('visibleEnemy');
        if (visibleEnemy && mod.IsPlayerValid(visibleEnemy)) {
            try {
                mod.AISetTarget(player, visibleEnemy);
            } catch {}
        }

        // Use battlefield behavior (will fight while moving)
        // but with flag as the destination focus
        const botPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
        const distToFlag = mod.DistanceBetween(botPos, flagPos);

        if (distToFlag > SENSOR_CONFIG.FLAG_CAPTURE_RADIUS) {
            // Not on flag yet - move toward it with combat awareness
            // Skip if already doing this for same position
            if (
                this.currentBehavior === 'flagengage' &&
                this.lastFlagPos &&
                mod.DistanceBetween(this.lastFlagPos, flagPos) <= BEHAVIOR_CONFIG.POS_EPSILON
            ) {
                return;
            }

            // Use DefendPosition with wide radius - this makes bot move to flag
            // while still engaging enemies along the way
            mod.AIDefendPositionBehavior(player, flagPos, 1.0, 15.0);

            this.currentBehavior = 'flagengage';
            this.lastFlagPos = flagPos;
        } else {
            // On flag - defend it aggressively
            mod.AIDefendPositionBehavior(
                player,
                flagPos,
                SENSOR_CONFIG.FLAG_CAPTURE_RADIUS,
                SENSOR_CONFIG.FLAG_ENGAGE_RADIUS
            );

            this.currentBehavior = 'flagengage';
            this.lastFlagPos = flagPos;
        }

        this.lastMoveToPos = null;
        this.lastDefendPos = null;
        this.lastSearchPos = null;
    }

    /**
     * FlagPush behavior - move toward flag with combat awareness
     * Less urgent than FlagEngage, but still prioritizes the objective
     */
    private executeFlagPush(player: mod.Player, memory: BotMemory): void {
        const flagPos = memory.get('flagPos');
        if (!flagPos) return;

        // ALWAYS ensure shooting is enabled
        try {
            mod.AIEnableShooting(player, true);
            mod.AIEnableTargeting(player, true);
        } catch {}

        const botPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
        const distToFlag = mod.DistanceBetween(botPos, flagPos);

        // OVERTIME ALL-IN: the flag outranks the firefight. Bots still shoot (targeting
        // stays on and they fire while moving), but they do NOT stop to duel — the old
        // "any enemy within 15m -> switch to battlefield" bail is what left bots trading
        // shots in a corridor while the overtime clock ran out. Only a point-blank threat
        // (<= ALL_IN_FIGHT_RADIUS) or a low-urgency flag still earns a full stop.
        const urgency = memory.get('flagUrgency') ?? 0;
        const allIn = urgency >= SENSOR_CONFIG.FLAG_URGENCY_ALL_IN;
        const breakOffDist = allIn ? BEHAVIOR_CONFIG.ALL_IN_FIGHT_RADIUS : 15;

        const visibleEnemy = memory.get('visibleEnemy');
        if (visibleEnemy && mod.IsPlayerValid(visibleEnemy)) {
            try {
                const enemyPos = mod.GetSoldierState(visibleEnemy, mod.SoldierStateVector.GetPosition);
                const enemyDist = mod.DistanceBetween(botPos, enemyPos);

                // ALWAYS engage visible enemy
                mod.AISetTarget(player, visibleEnemy);

                // Stop and fight only if they're inside the break-off radius AND we aren't
                // already on the point (on the point, holding it IS the job).
                if (enemyDist < breakOffDist && distToFlag > SENSOR_CONFIG.FLAG_CAPTURE_RADIUS) {
                    mod.AIBattlefieldBehavior(player);
                    this.currentBehavior = 'battlefield';
                    return;
                }
            } catch {}
        }

        // Skip if already pushing to same flag position. The flag NEVER moves, so this
        // guard would otherwise issue the approach exactly once — and a move-to that
        // fails or goes stale would leave the bot parked (the stuck watchdog deliberately
        // stands down during flag behaviors). While all-in, re-feed on a cadence instead.
        const nowMs = Date.now();
        const sameFlag =
            this.currentBehavior === 'flagpush' &&
            this.lastFlagPos &&
            mod.DistanceBetween(this.lastFlagPos, flagPos) <= BEHAVIOR_CONFIG.POS_EPSILON;
        if (sameFlag && !(allIn && nowMs - this.lastFlagPushAt >= BEHAVIOR_CONFIG.ALL_IN_REFEED_MS)) {
            return;
        }
        this.lastFlagPushAt = nowMs;

        if (distToFlag > SENSOR_CONFIG.FLAG_CAPTURE_RADIUS) {
            if (allIn && distToFlag > BEHAVIOR_CONFIG.ALL_IN_SPRINT_DIST) {
                // OVERTIME: SPRINT the approach. AIDefendPositionBehavior moves on a leash
                // (it wants to hold ground near the point) which made bots amble in from
                // range; a validated move-to at Sprint is a direct run for the flag.
                try {
                    mod.AISetMoveSpeed(player, mod.MoveSpeed.Sprint);
                } catch {}
                mod.AIValidatedMoveToBehavior(player, flagPos);
            } else {
                // Close in / normal urgency: DefendPosition allows engaging while moving.
                try {
                    mod.AISetMoveSpeed(player, mod.MoveSpeed.Run);
                } catch {}
                mod.AIDefendPositionBehavior(player, flagPos, 2.0, 12.0);
            }
        } else {
            // On flag - hold position and watch for enemies
            mod.AIDefendPositionBehavior(
                player,
                flagPos,
                SENSOR_CONFIG.FLAG_CAPTURE_RADIUS,
                SENSOR_CONFIG.FLAG_CLOSE_RADIUS
            );
        }

        this.currentBehavior = 'flagpush';
        this.lastFlagPos = flagPos;
        this.lastMoveToPos = null;
        this.lastDefendPos = null;
        this.lastSearchPos = null;
    }

    /**
     * Get current behavior label (for debugging)
     */
    getCurrent(): BehaviorKind | null {
        return this.currentBehavior;
    }
}
