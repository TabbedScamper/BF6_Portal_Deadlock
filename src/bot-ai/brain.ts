/**
 * Bot Brain - Coordinates memory, sensors, and behaviors
 * Based on bf6-portal-bots-brain Brain pattern
 */

import { BotMemory } from './memory.ts';
import { BotBehaviorSelector, DEFAULT_WEIGHTS } from './behaviors.ts';
import type { BehaviorKind } from './behaviors.ts';
import {
    SENSOR_CONFIG,
    senseEnemy,
    senseRoamPosition,
    senseArrival,
    onBotDamaged,
    onBotFiring,
    senseFlagSituation,
} from './sensors.ts';

// ========== DEBUG LOGGING ==========
const DEBUG_BRAIN = false;
let _brainTickCount = 0;
let _enemySenseAttempts = 0;
let _enemySenseHits = 0;
let _roamSenseAttempts = 0;
let _roamSenseHits = 0;
let _lastBrainLogTime = Date.now();

function logBrain(msg: string, ...args: any[]): void {
    if (DEBUG_BRAIN) console.log(`[BotBrain] ${msg}`, ...args);
}

export function logBrainStats(): void {
    const elapsed = (Date.now() - _lastBrainLogTime) / 1000;
    logBrain(`BRAIN STATS (${elapsed.toFixed(1)}s):`, {
        ticks: _brainTickCount,
        enemySense: `${_enemySenseHits}/${_enemySenseAttempts}`,
        roamSense: `${_roamSenseHits}/${_roamSenseAttempts}`,
    });
    // Reset counters
    _brainTickCount = 0;
    _enemySenseAttempts = 0;
    _enemySenseHits = 0;
    _roamSenseAttempts = 0;
    _roamSenseHits = 0;
    _lastBrainLogTime = Date.now();
}
// ===================================

/**
 * BotBrain
 *
 * Pure AI logic unit that coordinates:
 * - Memory (TTL-based forgetting)
 * - Sensors (enemy detection, roaming, arrival)
 * - Behavior selection (weight-based priority)
 *
 * Does NOT handle player lifecycle - that's done externally.
 */
export class BotBrain {
    public player: mod.Player;
    public memory: BotMemory;
    private behaviorSelector: BotBehaviorSelector;

    // Sensor timing
    private lastEnemySenseTime: number = 0;
    private lastRoamSenseTime: number = 0;
    private lastFlagSenseTime: number = 0;
    private nextMoveFlavor: number = 0;

    // External references
    private flagPosGetter: (() => mod.Vector | null) | null = null;
    private flagUrgencyGetter: (() => number) | null = null;
    private spawnPositionsGetter: (() => mod.Vector[]) | null = null;

    // Flag state
    private flagActive: boolean = false;

    constructor(player: mod.Player) {
        this.player = player;
        this.memory = new BotMemory();
        this.behaviorSelector = new BotBehaviorSelector(DEFAULT_WEIGHTS);
    }

    /**
     * Set function to get current flag position (null when no flag)
     */
    setFlagPosGetter(getter: () => mod.Vector | null): void {
        this.flagPosGetter = getter;
    }

    /**
     * Set function to get flag urgency (0-1, how urgent is capture)
     */
    setFlagUrgencyGetter(getter: () => number): void {
        this.flagUrgencyGetter = getter;
    }

    /**
     * Set function to get spawn positions (for roaming waypoints)
     */
    setSpawnPositionsGetter(getter: () => mod.Vector[]): void {
        this.spawnPositionsGetter = getter;
    }

    /**
     * Notify brain that flag has spawned (overtime started)
     */
    notifyFlagSpawned(): void {
        this.flagActive = true;
        logBrain(`Bot ${mod.GetObjId(this.player)} notified of flag spawn`);
    }

    /**
     * Notify brain that flag is gone (round ended or captured)
     */
    notifyFlagGone(): void {
        this.flagActive = false;
        this.memory.clear('flagPos');
        this.memory.clear('shouldPushFlag');
        this.memory.clear('enemyOnFlag');
        this.memory.clear('flagUrgency');
    }

    /**
     * Set push target for initial forward movement
     * Called at round start to make bots push toward enemies
     */
    setPushTarget(target: mod.Vector): void {
        // Push target lasts 8 seconds - enough time to reach mid-map
        this.memory.set('pushTarget', target, 8000);
        this.memory.set('shouldSprint', true, 8000);
        logBrain(`Bot ${mod.GetObjId(this.player)} set push target`);
    }

    /**
     * Clear push target (called when transitioning to normal behavior)
     */
    clearPushTarget(): void {
        this.memory.clear('pushTarget');
        this.memory.clear('shouldSprint');
    }

    /**
     * Reset brain state (call on death/respawn)
     */
    reset(): void {
        this.memory.clearAll();
        this.behaviorSelector.reset();
        this.lastEnemySenseTime = 0;
        this.lastRoamSenseTime = 0;
        this.lastFlagSenseTime = 0;
        // Note: don't reset flagActive - flag persists across respawns

        // Clear target
        if (mod.IsPlayerValid(this.player)) {
            try {
                mod.AISetTarget(this.player);
            } catch {}
        }
    }

    /**
     * Handle damage event - triggers battle state
     */
    onDamaged(attacker: mod.Player, attackerPos?: mod.Vector): void {
        onBotDamaged(this.memory, attackerPos);
        // Trigger-happy: remember WHO shot us and lock onto them for a few seconds so the normal
        // "closest visible" sensor can't pull us off the guy actually shooting.
        this.memory.set('retaliate', attacker, 3000);
    }

    /**
     * Handle firing event - triggers battle state
     */
    onFiring(): void {
        onBotFiring(this.memory);
    }

    /**
     * Main tick - sense, think, act
     */
    tick(): void {
        _brainTickCount++;

        if (!mod.IsPlayerValid(this.player)) return;
        if (!mod.GetSoldierState(this.player, mod.SoldierStateBool.IsAlive)) return;

        // Prune expired memory entries
        this.memory.prune();

        const now = Date.now();

        // Run sensors at their configured rates
        // Flag sensor runs first and fast (highest priority in overtime)
        if (this.flagActive) {
            this.runFlagSensor(now);
        }

        this.runEnemySensor(now);
        this.runRoamSensor(now);
        this.runArrivalSensor();

        // Select and execute behavior
        this.behaviorSelector.update(this.player, this.memory);

        // Human-feel movement variety on top of the behavior.
        this.humanize(now);
    }

    // Random sprint / strafe / (rare) crouch / (very rare) prone so bots move like players.
    // Sprint is used only OUT of combat (sprinting AI are known to stop engaging).
    private humanize(now: number): void {
        if (now < this.nextMoveFlavor) return;
        this.nextMoveFlavor = now + 2200 + Math.random() * 2600; // re-roll every ~2.2-4.8s per bot
        const inCombat = this.memory.has('visibleEnemy') || this.memory.has('isInBattle');
        const r = Math.random();
        try {
            if (inCombat) {
                // In a fight: juke side-to-side; occasionally crouch; very rarely go prone.
                if (r < 0.62) mod.SetAiInput(this.player, mod.AiInput.Strafe, 0.4 + Math.random() * 0.5);
                else if (r < 0.72) mod.SetAiInput(this.player, mod.AiInput.Crouch, 0.8); // ~10% crouch
                else if (r < 0.74) mod.SetAiInput(this.player, mod.AiInput.Prone, 1.2); // ~2% prone
                // else: just keep fighting
            } else {
                // Repositioning: sprint bursts and the occasional slide (sprint -> crouch).
                if (r < 0.5) mod.SetAiInput(this.player, mod.AiInput.Sprint, 0.9 + Math.random());
                else if (r < 0.6) {
                    mod.SetAiInput(this.player, mod.AiInput.Sprint, 0.5);
                    mod.SetAiInput(this.player, mod.AiInput.Crouch, 0.5); // slide-ish transition
                } else if (r < 0.67) mod.SetAiInput(this.player, mod.AiInput.Crouch, 0.6); // ~7% crouch
            }
        } catch {}
    }

    /**
     * Enemy detection sensor - AGGRESSIVE: instant targeting and shooting
     */
    private runEnemySensor(now: number): void {
        if (now - this.lastEnemySenseTime < SENSOR_CONFIG.ENEMY_SENSOR_RATE) return;
        this.lastEnemySenseTime = now;

        // TRIGGER-HAPPY: if we were shot recently, stay locked on the shooter and keep firing,
        // even if a different enemy is technically closer. Overrides normal target selection.
        const retal = this.memory.get('retaliate');
        if (retal) {
            try {
                if (mod.IsPlayerValid(retal) && mod.GetSoldierState(retal, mod.SoldierStateBool.IsAlive)) {
                    mod.AISetTarget(this.player, retal);
                    mod.AIEnableShooting(this.player, true);
                    mod.AIEnableTargeting(this.player, true);
                    mod.AIForceFire(this.player, 0.6);
                    return;
                }
            } catch {}
            this.memory.clear('retaliate'); // dead / invalid -> stop chasing it
        }

        _enemySenseAttempts++;
        const enemy = senseEnemy(this.player, this.memory);
        if (enemy) {
            _enemySenseHits++;

            // Clear push target when enemy spotted - engage instead of pushing
            if (this.memory.has('pushTarget')) {
                this.memory.clear('pushTarget');
                this.memory.clear('shouldSprint');
            }

            // AGGRESSIVE: Immediately set target and ensure shooting is enabled
            try {
                mod.AISetTarget(this.player, enemy);
                mod.AIEnableShooting(this.player, true);
                mod.AIEnableTargeting(this.player, true);
                // Stop sprinting - use run speed for combat
                mod.AISetMoveSpeed(this.player, mod.MoveSpeed.Run);
                // Reliably fire at a visible target: snap-shoot on acquisition, and keep the
                // trigger warm (~every 0.9s) while it stays in engagement range, so a bot never
                // just stands there staring at someone right in front of it.
                const eid = mod.GetObjId(enemy);
                const newTarget = this.memory.get('curTargetId') !== eid;
                let dist = 0;
                try {
                    dist = mod.DistanceBetween(
                        mod.GetSoldierState(this.player, mod.SoldierStateVector.GetPosition),
                        mod.GetSoldierState(enemy, mod.SoldierStateVector.GetPosition)
                    );
                } catch {}
                const lastFF = this.memory.get('lastForceFire') ?? 0;
                if (dist < 30 && (newTarget || now - lastFF > 900)) {
                    mod.AIForceFire(this.player, 0.7);
                    this.memory.set('lastForceFire', now, 5000);
                }
                if (newTarget) this.memory.set('curTargetId', eid, 4000);
            } catch {}
        }
    }

    /**
     * Roam point sensor (direction-driven patrol)
     */
    private runRoamSensor(now: number): void {
        // Don't roam if in battle
        if (this.memory.has('isInBattle')) return;
        if (this.memory.has('lastKnownEnemyPos')) return;

        if (now - this.lastRoamSenseTime < SENSOR_CONFIG.ROAM_SENSOR_RATE) return;
        this.lastRoamSenseTime = now;

        _roamSenseAttempts++;

        const flagPos = this.flagPosGetter?.() ?? null;
        const spawnPositions = this.spawnPositionsGetter?.() ?? [];

        const roamPos = senseRoamPosition(this.player, this.memory, flagPos, spawnPositions);
        if (roamPos) {
            _roamSenseHits++;
        }
    }

    /**
     * Arrival detection sensor
     */
    private runArrivalSensor(): void {
        senseArrival(this.player, this.memory);
    }

    /**
     * Flag situation sensor - evaluates flag priority and updates memory
     */
    private runFlagSensor(now: number): void {
        if (now - this.lastFlagSenseTime < SENSOR_CONFIG.FLAG_SENSOR_RATE) return;
        this.lastFlagSenseTime = now;

        const flagPos = this.flagPosGetter?.() ?? null;
        const urgency = this.flagUrgencyGetter?.() ?? SENSOR_CONFIG.FLAG_URGENCY_BASE;

        // Update flag situation in memory
        senseFlagSituation(this.player, this.memory, flagPos, urgency);
    }

    /**
     * Get current behavior for debugging
     */
    getCurrentBehavior(): BehaviorKind | null {
        return this.behaviorSelector.getCurrent();
    }

    /**
     * Check if bot is in battle state
     */
    isInBattle(): boolean {
        return this.memory.has('isInBattle');
    }

    /**
     * Check if bot has visible enemy
     */
    hasVisibleEnemy(): boolean {
        return this.memory.has('visibleEnemy');
    }

    /**
     * Get last known enemy position
     */
    getLastKnownEnemyPos(): mod.Vector | null {
        return this.memory.get('lastKnownEnemyPos');
    }
}

// ========== BOT BRAIN MANAGER ==========

/**
 * Global registry of bot brains by player ID
 */
const botBrains: Map<number, BotBrain> = new Map();

/**
 * Get or create a brain for a bot player
 */
export function getBotBrain(player: mod.Player): BotBrain {
    const playerId = mod.GetObjId(player);
    let brain = botBrains.get(playerId);

    if (!brain) {
        brain = new BotBrain(player);
        botBrains.set(playerId, brain);
        logBrain(`Created brain for bot ${playerId}`);
    }

    return brain;
}

/**
 * Remove brain for a player (call on bot removal)
 */
export function removeBotBrain(player: mod.Player): void {
    const playerId = mod.GetObjId(player);
    if (botBrains.delete(playerId)) {
        logBrain(`Removed brain for bot ${playerId}`);
    }
}

/**
 * Reset brain for a player (call on respawn)
 */
export function resetBotBrain(player: mod.Player): void {
    const brain = botBrains.get(mod.GetObjId(player));
    if (brain) {
        brain.reset();
        logBrain(`Reset brain for bot ${mod.GetObjId(player)}`);
    }
}

/**
 * Clear all bot brains
 */
export function clearAllBotBrains(): void {
    botBrains.clear();
    logBrain('Cleared all bot brains');
}

/**
 * Get count of active bot brains
 */
export function getBotBrainCount(): number {
    return botBrains.size;
}

/**
 * Tick all bot brains (call from main loop)
 */
export function tickAllBotBrains(): void {
    for (const brain of botBrains.values()) {
        try {
            brain.tick();
        } catch {}
    }
}
