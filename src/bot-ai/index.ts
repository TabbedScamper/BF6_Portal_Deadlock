/**
 * Bot AI System
 *
 * Realistic bot behavior without omniscient awareness.
 * Bots must "see" enemies probabilistically and "forget" over time.
 *
 * Architecture:
 * - Memory: TTL-based storage for realistic forgetting
 * - Sensors: Probabilistic enemy detection, direction-driven patrol
 * - Behaviors: Weight-based priority selection (engage > search > patrol)
 * - Brain: Coordinates all systems in a sense-think-act loop
 */

// Memory system
export { BotMemory } from './memory.ts';
export type { BotMemoryFields } from './memory.ts';

// Sensor system
export {
    SENSOR_CONFIG,
    canDetectEnemy,
    senseEnemy,
    senseRoamPosition,
    senseArrival,
    onBotDamaged,
    onBotFiring,
    // Flag sensors
    senseFlagContext,
    senseFlagSituation,
    shouldBotPushFlag,
    hasEnemyBlockingFlag,
} from './sensors.ts';
export type { FlagContext } from './sensors.ts';

// Behavior system
export { BEHAVIOR_CONFIG, DEFAULT_WEIGHTS, BotBehaviorSelector } from './behaviors.ts';
export type { BehaviorKind } from './behaviors.ts';

// Brain system
export {
    BotBrain,
    getBotBrain,
    removeBotBrain,
    resetBotBrain,
    clearAllBotBrains,
    getBotBrainCount,
    tickAllBotBrains,
    logBrainStats,
} from './brain.ts';
