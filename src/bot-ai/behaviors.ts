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

export type BehaviorKind = 'battlefield' | 'defend' | 'moveto' | 'search' | 'flagpush' | 'flagengage' | 'push';

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
    }

    /**
     * Select and execute the best behavior for this tick
     */
    update(player: mod.Player, memory: BotMemory): void {
        if (!mod.IsPlayerValid(player)) return;
        if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive)) return;

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
        // Apply battlefield behavior first (if not already in it)
        if (this.currentBehavior !== 'battlefield') {
            // Stop sprinting when engaging - use run speed for combat
            try {
                mod.AISetMoveSpeed(player, mod.MoveSpeed.Run);
            } catch {}
            mod.AIBattlefieldBehavior(player);
            this.currentBehavior = 'battlefield';
            this.lastMoveToPos = null;
            this.lastDefendPos = null;
            this.lastSearchPos = null;
        }

        // ALWAYS set target AFTER behavior (to override any default targeting)
        const visibleEnemy = memory.get('visibleEnemy');
        if (visibleEnemy && mod.IsPlayerValid(visibleEnemy)) {
            try {
                mod.AISetTarget(player, visibleEnemy);
                mod.AIEnableShooting(player, true);
                mod.AIEnableTargeting(player, true);
            } catch {}
        }
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

        // Skip if already searching nearby position
        if (
            this.currentBehavior === 'search' &&
            this.lastSearchPos &&
            mod.DistanceBetween(this.lastSearchPos, targetPos) <= BEHAVIOR_CONFIG.POS_EPSILON
        ) {
            return;
        }

        // Move to search position
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

        // If we have a visible enemy nearby, engage them IMMEDIATELY
        const visibleEnemy = memory.get('visibleEnemy');
        if (visibleEnemy && mod.IsPlayerValid(visibleEnemy)) {
            try {
                const enemyPos = mod.GetSoldierState(visibleEnemy, mod.SoldierStateVector.GetPosition);
                const enemyDist = mod.DistanceBetween(botPos, enemyPos);

                // ALWAYS engage visible enemy
                mod.AISetTarget(player, visibleEnemy);

                // Switch to battlefield if enemy is close
                if (enemyDist < 15) {
                    mod.AIBattlefieldBehavior(player);
                    this.currentBehavior = 'battlefield';
                    return;
                }
            } catch {}
        }

        // Skip if already pushing to same flag position
        if (
            this.currentBehavior === 'flagpush' &&
            this.lastFlagPos &&
            mod.DistanceBetween(this.lastFlagPos, flagPos) <= BEHAVIOR_CONFIG.POS_EPSILON
        ) {
            return;
        }

        if (distToFlag > SENSOR_CONFIG.FLAG_CAPTURE_RADIUS) {
            // Move toward flag with combat readiness
            // DefendPosition allows engaging enemies while moving
            mod.AIDefendPositionBehavior(player, flagPos, 2.0, 12.0);
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
