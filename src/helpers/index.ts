import { Timers } from 'bf6-portal-utils/timers/index.ts';
import { UI } from 'bf6-portal-utils/ui/index.ts';
import { UIText } from 'bf6-portal-utils/ui/components/text/index.ts';
import { Vectors } from 'bf6-portal-utils/vectors/index.ts';

// ========== DEBUG LOGGING ==========
const DEBUG_HELPERS = false;
let _getAllPlayersCalls = 0;
let _getPlayersOnTeamCalls = 0;
let _getAlivePlayersOnTeamCalls = 0;
let _lastHelperLogTime = Date.now();

function logHelper(msg: string, ...args: any[]): void {
    if (DEBUG_HELPERS) console.log(`[Helpers] ${msg}`, ...args);
}

// Log helper stats periodically
export function logHelperStats(): void {
    const elapsed = (Date.now() - _lastHelperLogTime) / 1000;
    logHelper(`HELPER STATS (${elapsed.toFixed(1)}s):`, {
        getAllPlayersCalls: _getAllPlayersCalls,
        getPlayersOnTeamCalls: _getPlayersOnTeamCalls,
        getAlivePlayersOnTeamCalls: _getAlivePlayersOnTeamCalls,
    });
    // Reset counters
    _getAllPlayersCalls = 0;
    _getPlayersOnTeamCalls = 0;
    _getAlivePlayersOnTeamCalls = 0;
    _lastHelperLogTime = Date.now();
}
// ===================================

// Track players who were rejected (undeployed mid-round) to exclude from health calculations
export const rejectedPlayerIds: Set<number> = new Set();

export function rejectPlayer(playerId: number): void {
    rejectedPlayerIds.add(playerId);
}

export function clearRejectedPlayers(): void {
    rejectedPlayerIds.clear();
}

export function isPlayerRejected(playerId: number): boolean {
    return rejectedPlayerIds.has(playerId);
}

export function getPlayerStateVectorString(player: mod.Player, type: mod.SoldierStateVector): string {
    return Vectors.getVectorString(mod.GetSoldierState(player, type));
}

export function convertArray<T>(array: mod.Array): T[] {
    const v: T[] = [];
    const n = mod.CountOf(array);

    for (let i = 0; i < n; ++i) {
        v.push(mod.ValueInArray(array, i) as T);
    }

    return v;
}

export function getAllPlayers(): mod.Player[] {
    _getAllPlayersCalls++;
    return convertArray<mod.Player>(mod.AllPlayers());
}

export function getPlayersOnTeam(teamId: number): mod.Player[] {
    _getPlayersOnTeamCalls++;
    const allPlayers = getAllPlayers();
    const teamPlayers: mod.Player[] = [];
    const team = mod.GetTeam(teamId);

    for (const player of allPlayers) {
        try {
            const playerTeam = mod.GetTeam(player);
            if (mod.GetObjId(playerTeam) === mod.GetObjId(team)) {
                teamPlayers.push(player);
            }
        } catch {
            // Player might be invalid
        }
    }

    return teamPlayers;
}

export function getAlivePlayersOnTeam(teamId: number): mod.Player[] {
    _getAlivePlayersOnTeamCalls++;
    return getPlayersOnTeam(teamId).filter((player) => {
        try {
            const playerId = mod.GetObjId(player);
            // Exclude rejected players (mid-round spawn attempts)
            if (rejectedPlayerIds.has(playerId)) {
                return false;
            }
            return mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive);
        } catch {
            return false;
        }
    });
}

export function equals(a: unknown, b: unknown): boolean {
    if (a === b || mod.Equals(a, b)) return true;

    return mod.IsType(a, mod.Types.Object) && mod.IsType(b, mod.Types.Object)
        ? mod.GetObjId(a as mod.Object) == mod.GetObjId(b as mod.Object)
        : false;
}

/**
 * Safely remove equipment from a player slot (ignores errors if slot is empty)
 */
export function safeRemoveEquipment(player: mod.Player, slot: mod.InventorySlots): void {
    try {
        mod.RemoveEquipment(player, slot);
    } catch {
        // Slot was empty - ignore
    }
}

/**
 * Remove all gadgets/equipment from a player (safe, ignores empty slots)
 */
export function removeAllEquipment(player: mod.Player): void {
    safeRemoveEquipment(player, mod.InventorySlots.MiscGadget);
    safeRemoveEquipment(player, mod.InventorySlots.Throwable);
    safeRemoveEquipment(player, mod.InventorySlots.ClassGadget);
    safeRemoveEquipment(player, mod.InventorySlots.GadgetOne);
    safeRemoveEquipment(player, mod.InventorySlots.GadgetTwo);
    safeRemoveEquipment(player, mod.InventorySlots.MeleeWeapon);
    safeRemoveEquipment(player, mod.InventorySlots.Callins);
}

export function showEventGameModeMessage(event: mod.Message, target?: mod.Player | mod.Team) {
    const text = new UIText({
        position: { x: 0, y: 0 },
        size: { width: 2500, height: 80 },
        anchor: mod.UIAnchor.TopCenter,
        parent: UI.ROOT_NODE,
        visible: true,
        padding: 8,
        bgColor: UI.COLORS.BLACK,
        bgAlpha: 0.7,
        bgFill: mod.UIBgFill.Blur,
        message: event,
        textSize: 30,
        textColor: UI.COLORS.WHITE,
        textAlpha: 1,
        textAnchor: mod.UIAnchor.Center,
        receiver: target,
    });

    Timers.setTimeout(() => text.delete(), 6_000);
}
