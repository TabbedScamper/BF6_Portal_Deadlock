/**
 * Roster module — custom scoreboard (per-player stats/columns) + persistent bot identity system
 * (name pool, per-identity stats that survive bot respawns, spawn-offset helper).
 * Extracted from index.ts (2026-07-17). The two are one module because they are mutually
 * referential: updateScoreboard reads bot identities; identity round-reset pushes scoreboard updates.
 */

// Bot ids known to the roster (used by index for sound filtering). Never reassigned; add/clear only.
export const knownBotIds: Set<number> = new Set();

// Debug logging is injected by index.ts (the DebugTool instance lives there).
let rosterLog: (msg: string) => void = () => {};
export function setRosterLogger(fn: (msg: string) => void): void {
    rosterLog = fn;
}

// ============================================================================
// CUSTOM SCOREBOARD SYSTEM
// ============================================================================
// Tracks: Damage, Kills, Deaths, Assists, Captures
// ============================================================================

export interface PlayerStats {
    damage: number;
    kills: number;
    deaths: number;
    assists: number;
    captures: number;
}

// Player stats tracking (by player ID)
export const playerStats: Map<number, PlayerStats> = new Map();

// Initialize scoreboard column names and settings
export function initScoreboard(): void {
    mod.SetScoreboardColumnNames(
        mod.Message(mod.stringkeys.gunfight.scoreboard.damage),
        mod.Message(mod.stringkeys.gunfight.scoreboard.kills),
        mod.Message(mod.stringkeys.gunfight.scoreboard.deaths),
        mod.Message(mod.stringkeys.gunfight.scoreboard.assists),
        mod.Message(mod.stringkeys.gunfight.scoreboard.captures)
    );
    mod.SetScoreboardColumnWidths(1, 1, 1, 1, 1);
    mod.SetScoreboardSorting(1, false); // Sort by kills (column 1), descending
}

// Get or create player stats
export function getPlayerStats(player: mod.Player): PlayerStats {
    const playerId = mod.GetObjId(player);
    let stats = playerStats.get(playerId);
    if (!stats) {
        stats = { damage: 0, kills: 0, deaths: 0, assists: 0, captures: 0 };
        playerStats.set(playerId, stats);
    }
    return stats;
}

// Update scoreboard for a player
export function updateScoreboard(player: mod.Player): void {
    // Check if this is a bot with persistent identity
    const botIdentity = getBotIdentityByPlayerId(mod.GetObjId(player));
    if (botIdentity) {
        // Use persistent bot stats
        try {
            mod.SetScoreboardPlayerValues(
                player,
                botIdentity.stats.damage,
                botIdentity.stats.kills,
                botIdentity.stats.deaths,
                botIdentity.stats.assists,
                botIdentity.stats.captures
            );
        } catch {}
        return;
    }

    // Regular player stats
    const stats = getPlayerStats(player);
    try {
        mod.SetScoreboardPlayerValues(player, stats.damage, stats.kills, stats.deaths, stats.assists, stats.captures);
    } catch {}
}

// ============================================================================
// PERSISTENT BOT IDENTITY SYSTEM
// ============================================================================
// Bots are deleted/respawned each round but we want to preserve their stats
// and keep them on the same team. Each bot has a unique identity.
// ============================================================================

export interface BotIdentity {
    id: number; // Unique persistent ID (1-8)
    name: string; // Bot display name (randomized at match start)
    teamId: 1 | 2; // Assigned team (never changes)
    stats: PlayerStats; // Persistent stats
    currentPlayerId: number | null; // Current player object ID (changes on respawn)
    isActive: boolean; // Whether this bot is currently deployed
}

// Pool of all available bot names (randomly assigned at match start)
export const BOT_NAME_POOL: string[] = [
    // Kept from the original pool (per request)
    'Hope',
    'DaPa',
    'dfanz0r',
    'BMO',
    'Andy6170',
    'Boxshards',
    // Top-active Portal Hub Discord members (by message count in our export)
    'Ariistuujj',
    'Lemon64k',
    'Phiality',
    'mikedeluca_',
    'gala_vs',
    'nightfyre',
    'Guzma',
    'muj',
    'TonisGaming',
    'joslick76',
    'ty_ger07',
    'Cyphr',
    'Renette',
    'Markebarca',
    'Bennen',
    'TabbedScamper',
    'F4rus',
    'defined_edits',
];

// Define bot identities (up to 4 per team for 4v4 support)
// Names are randomized at match start via randomizeBotNames()
export const BOT_IDENTITIES: BotIdentity[] = [
    // Team 1 bots
    {
        id: 1,
        name: BOT_NAME_POOL[0],
        teamId: 1,
        stats: { damage: 0, kills: 0, deaths: 0, assists: 0, captures: 0 },
        currentPlayerId: null,
        isActive: false,
    },
    {
        id: 2,
        name: BOT_NAME_POOL[1],
        teamId: 1,
        stats: { damage: 0, kills: 0, deaths: 0, assists: 0, captures: 0 },
        currentPlayerId: null,
        isActive: false,
    },
    {
        id: 3,
        name: BOT_NAME_POOL[2],
        teamId: 1,
        stats: { damage: 0, kills: 0, deaths: 0, assists: 0, captures: 0 },
        currentPlayerId: null,
        isActive: false,
    },
    {
        id: 4,
        name: BOT_NAME_POOL[3],
        teamId: 1,
        stats: { damage: 0, kills: 0, deaths: 0, assists: 0, captures: 0 },
        currentPlayerId: null,
        isActive: false,
    },
    // Team 2 bots
    {
        id: 5,
        name: BOT_NAME_POOL[4],
        teamId: 2,
        stats: { damage: 0, kills: 0, deaths: 0, assists: 0, captures: 0 },
        currentPlayerId: null,
        isActive: false,
    },
    {
        id: 6,
        name: BOT_NAME_POOL[5],
        teamId: 2,
        stats: { damage: 0, kills: 0, deaths: 0, assists: 0, captures: 0 },
        currentPlayerId: null,
        isActive: false,
    },
    {
        id: 7,
        name: BOT_NAME_POOL[6],
        teamId: 2,
        stats: { damage: 0, kills: 0, deaths: 0, assists: 0, captures: 0 },
        currentPlayerId: null,
        isActive: false,
    },
    {
        id: 8,
        name: BOT_NAME_POOL[7],
        teamId: 2,
        stats: { damage: 0, kills: 0, deaths: 0, assists: 0, captures: 0 },
        currentPlayerId: null,
        isActive: false,
    },
];

// Randomize bot names at match start (call once per match)
export function randomizeBotNames(): void {
    // Shuffle the name pool
    const shuffled = [...BOT_NAME_POOL];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    // Assign first 8 names to bot identities
    for (let i = 0; i < BOT_IDENTITIES.length; i++) {
        BOT_IDENTITIES[i].name = shuffled[i % shuffled.length];
    }
    rosterLog('Randomized bot names for new match');
}

// Get an available bot identity for a team and mark it as active immediately
// (returns null if none available)
/** Is this player id still a valid, ALIVE bot on the field? (Used to refuse handing out a
 *  name that is visibly in use — belt-and-braces against a stale isActive flag.) */
function isPlayerIdLiveBot(playerId: number): boolean {
    try {
        const all = mod.AllPlayers();
        const count = mod.CountOf(all);
        for (let i = 0; i < count; i++) {
            const p = mod.ValueInArray(all, i) as mod.Player;
            try {
                if (mod.GetObjId(p) !== playerId) continue;
                return (
                    mod.IsPlayerValid(p) && mod.GetSoldierState(p, mod.SoldierStateBool.IsAlive)
                );
            } catch {}
        }
    } catch {}
    return false;
}

export function getAvailableBotIdentity(teamId: number): BotIdentity | null {
    for (const identity of BOT_IDENTITIES) {
        if (identity.teamId !== teamId || identity.isActive) continue;
        // NEVER reuse a name whose bot is still alive on the field. A free identity has
        // currentPlayerId === null, so this scan only runs for suspicious leftovers.
        if (identity.currentPlayerId !== null && isPlayerIdLiveBot(identity.currentPlayerId)) {
            identity.isActive = true; // re-reserve it for the bot that still owns it
            rosterLog(`Identity ${identity.id} (${identity.name}) still live — not reused`);
            continue;
        }
        // Mark as active immediately to prevent duplicate assignment
        identity.isActive = true;
        identity.currentPlayerId = null;
        return identity;
    }
    return null;
}

// Get bot identity by current player ID
export function getBotIdentityByPlayerId(playerId: number): BotIdentity | null {
    for (const identity of BOT_IDENTITIES) {
        if (identity.currentPlayerId === playerId) {
            return identity;
        }
    }
    return null;
}

// Associate a newly spawned bot with its identity
export function associateBotWithIdentity(bot: mod.Player, identity: BotIdentity): void {
    const playerId = mod.GetObjId(bot);
    identity.currentPlayerId = playerId;
    // isActive is already set by getAvailableBotIdentity when reserved
    knownBotIds.add(playerId); // Track for sound filtering

    // Update scoreboard with persistent stats
    updateScoreboard(bot);

    rosterLog(`Bot ${playerId} associated with identity ${identity.id}`);
}

// Mark a bot identity as inactive (when undeployed/killed)
export function deactivateBotIdentity(playerId: number): void {
    const identity = getBotIdentityByPlayerId(playerId);
    if (identity) {
        identity.isActive = false;
        identity.currentPlayerId = null;
        rosterLog(`Bot identity ${identity.id} deactivated`);
    }
}

// Reset bot identity active states at round start (they'll be re-associated when spawned)
/**
 * Per-round identity reconcile. MUST NOT blindly clear every identity: a bot that SURVIVES
 * a round keeps playing into the next one, and releasing its identity put its name back in
 * the free pool — the next backfill then spawned a SECOND bot with that same name onto the
 * same team (the "multiple muj bots" bug), and the survivor's scoreboard stats went
 * untracked because stats are looked up by identity.
 *
 * So: an identity stays reserved only while its bot is still a valid, ALIVE player.
 * Dead bots (their bodies unspawn ~BOT_UNSPAWN_DELAY after death) and identities that were
 * reserved but never bound to a deployed bot are released for reuse.
 *
 * Call this ONLY between rounds (resetRound), never mid-spawn-batch: identities reserved by
 * spawnCustomBot have currentPlayerId === null until their bot deploys, and pruning during
 * a batch would hand those same identities out twice.
 */
export function resetBotIdentitiesForRound(): void {
    const liveBotIds: Set<number> = new Set<number>();
    try {
        const all = mod.AllPlayers();
        const count = mod.CountOf(all);
        for (let i = 0; i < count; i++) {
            const p = mod.ValueInArray(all, i) as mod.Player;
            try {
                if (!mod.IsPlayerValid(p)) continue;
                if (!mod.GetSoldierState(p, mod.SoldierStateBool.IsAISoldier)) continue;
                if (!mod.GetSoldierState(p, mod.SoldierStateBool.IsAlive)) continue;
                liveBotIds.add(mod.GetObjId(p));
            } catch {}
        }
    } catch {}

    let kept = 0;
    for (const identity of BOT_IDENTITIES) {
        if (identity.currentPlayerId !== null && liveBotIds.has(identity.currentPlayerId)) {
            identity.isActive = true; // survivor keeps its name AND its stats
            kept++;
            continue;
        }
        identity.isActive = false;
        identity.currentPlayerId = null;
    }
    rosterLog(`Bot identities reconciled: ${kept} survivor(s) kept, ${BOT_IDENTITIES.length - kept} released`);
}

// Get bot stats by player (uses persistent identity stats for bots)
export function getBotStats(player: mod.Player): PlayerStats | null {
    const identity = getBotIdentityByPlayerId(mod.GetObjId(player));
    return identity ? identity.stats : null;
}
