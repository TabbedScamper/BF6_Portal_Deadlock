/**
 * Bot Memory System - TTL-based memory for realistic "forgetting"
 * Based on bf6-portal-bots-brain MemoryManager pattern
 */

export interface BotMemoryFields {
    // Last known enemy position (not the player, the POSITION where we saw them)
    lastKnownEnemyPos: mod.Vector | null;
    // The actual enemy player (for targeting when visible)
    visibleEnemy: mod.Player | null;
    // Current patrol/roam destination
    roamPos: mod.Vector | null;
    // Are we currently in combat (recently saw/shot at enemy)
    isInBattle: boolean;
    // Position we're searching around
    searchPos: mod.Vector | null;
    // Have we arrived at our destination
    arrivedAtDest: boolean;

    // The player who most recently shot us — lock on and return fire (trigger-happy).
    retaliate: mod.Player | null;
    // ObjId of our current AI target — used to snap-fire only when the target CHANGES.
    curTargetId: number | null;
    // Timestamp of our last forced burst — throttles keeping the trigger warm on a held target.
    lastForceFire: number | null;

    // ===== PUSH FORWARD FIELDS =====
    // Initial push target (toward enemy side at round start)
    pushTarget: mod.Vector | null;
    // Should bot sprint (when moving but not in combat)
    shouldSprint: boolean;

    // ===== FLAG/OVERTIME FIELDS =====
    // Current flag position (when overtime is active)
    flagPos: mod.Vector | null;
    // Should this bot push the flag (dynamic decision)
    shouldPushFlag: boolean;
    // Enemy is on or very close to flag (urgent!)
    enemyOnFlag: boolean;
    // Flag urgency level (0-1, increases as time runs out)
    flagUrgency: number;
}

interface MemoryEntry<T> {
    value: T;
    expiresAt: number;
}

export class BotMemory {
    private _entries: Map<keyof BotMemoryFields, MemoryEntry<any>> = new Map();

    /**
     * Set a memory field with TTL (time-to-live in milliseconds)
     */
    public set<K extends keyof BotMemoryFields>(key: K, value: BotMemoryFields[K], ttlMs: number): void {
        this._entries.set(key, {
            value,
            expiresAt: Date.now() + ttlMs,
        });
    }

    /**
     * Get a memory field (returns null if expired or not set)
     */
    public get<K extends keyof BotMemoryFields>(key: K): BotMemoryFields[K] | null {
        const entry = this._entries.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this._entries.delete(key);
            return null;
        }
        return entry.value;
    }

    /**
     * Check if a memory field is set and not expired
     */
    public has(key: keyof BotMemoryFields): boolean {
        return this.get(key) !== null;
    }

    /**
     * Get time remaining until expiration (0 if expired/not set)
     */
    public getTimeRemaining(key: keyof BotMemoryFields): number {
        const entry = this._entries.get(key);
        if (!entry) return 0;
        const remaining = entry.expiresAt - Date.now();
        return remaining > 0 ? remaining : 0;
    }

    /**
     * Clear a specific memory field
     */
    public clear(key: keyof BotMemoryFields): void {
        this._entries.delete(key);
    }

    /**
     * Clear all memory
     */
    public clearAll(): void {
        this._entries.clear();
    }

    /**
     * Prune expired entries (call periodically)
     */
    public prune(): void {
        const now = Date.now();
        for (const [key, entry] of this._entries) {
            if (now > entry.expiresAt) {
                this._entries.delete(key);
            }
        }
    }
}
