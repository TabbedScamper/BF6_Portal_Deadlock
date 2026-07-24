/**
 * Bot Line-of-Sight (LOS) manager — stops bots seeing through walls.
 *
 * RayCast is heavily constrained (from the Portal community corpus):
 *   - ~1 raycast resolves per tick; a second before the first resolves OVERWRITES it.
 *   - each cast leaks a little memory (~9000-cast crash ceiling per VM lifetime).
 *   - results are async on Events.OnRayCastHit(bot, point, normal) / OnRayCastMissed(bot),
 *     keyed by the `bot` passed to mod.RayCast(bot, start, stop).
 *   - the ray HITS the caster (start it offset in front) and IGNORES terrain (buildings only).
 *
 * So we ROUND-ROBIN: exactly one cast per updateLos() call, for the next alive bot that
 * has an enemy within sight. Each bot's LOS refreshes every ~(bots/rate) seconds — ~human
 * reaction latency. senseEnemy() gates targeting on canSeeEnemy(), so a bot can only lock
 * onto an enemy it actually has a clear line to.
 */

import { getAlivePlayersOnTeam } from '../helpers/index.ts';
import { Tlm } from '../telemetry/index.ts';

interface LosEntry {
    enemyId: number;
    clear: boolean;
    ts: number;
}
interface Pending {
    enemyId: number;
    eye: mod.Vector;
    targetDist: number;
}

const losByBot = new Map<number, LosEntry>(); // botId -> LOS to its closest enemy
const pending = new Map<number, Pending>(); // botId -> in-flight ray

// Trust a LOS reading for 2s. This MUST comfortably exceed the round-robin refresh
// interval (bots * loopMs, e.g. 8 * 100ms = 800ms) or a bot's sight goes stale between
// casts and it "forgets" a target it can still see. 2s also reads as human: a bot that
// just saw you keeps pressuring your last position for a moment after you break cover.
const LOS_TTL_MS = 2000;
const HEAD_HEIGHT = 1.5; // eyes/chest height above the root position
// Push the ray START forward so it clears the caster's OWN ~0.3-0.4m capsule (a ray from
// dead-center would hit the bot itself and read every target as "blocked"). But NO further:
// at 0.9m a wall-hugging bot's ray began on the FAR side of a hugged wall -> false "clear"
// -> it shot enemies through solid geometry. 0.5m just clears the capsule. Tune 0.4-0.6.
// (Ported from FFA-Gunmaster — the "bots shoot through walls at close range" fix.)
const EYE_FORWARD = 0.5;
const CHEST_HEIGHT = 1.0; // aim at the enemy's chest, not their feet
const NEAR_FRAC = 0.85; // a hit past 85% of the way to the target = reached target = clear LOS

let castCount = 0;
export function getLosCastCount(): number {
    return castCount;
}

function scale(v: mod.Vector, s: number): mod.Vector {
    return mod.CreateVector(mod.XComponentOf(v) * s, mod.YComponentOf(v) * s, mod.ZComponentOf(v) * s);
}
function raise(v: mod.Vector, dy: number): mod.Vector {
    return mod.CreateVector(mod.XComponentOf(v), mod.YComponentOf(v) + dy, mod.ZComponentOf(v));
}

/** Does this bot have a fresh, clear line of sight to this specific enemy? */
export function canSeeEnemy(botId: number, enemyId: number): boolean {
    const e = losByBot.get(botId);
    if (!e || e.enemyId !== enemyId) return false;
    if (Date.now() - e.ts > LOS_TTL_MS) return false;
    return e.clear;
}

// Store LOS + emit a telemetry event ONLY on a clear<->blocked transition (naturally
// throttled) so we can SEE the wallhack fix working in PortalLog (debug mode only).
function setLos(botId: number, enemyId: number, clear: boolean): void {
    const prev = losByBot.get(botId);
    const changed = !prev || prev.enemyId !== enemyId || prev.clear !== clear;
    losByBot.set(botId, { enemyId, clear, ts: Date.now() });
    if (changed) Tlm.event('los.change', { bot: botId, enemy: enemyId, clear });
}

let rot = 0;
/**
 * Cast ONE LOS ray this call, for the next alive bot with an enemy within sightRange.
 * Call this on a fast interval (~10 Hz); it self-limits to a single cast to respect the
 * one-ray-per-tick + leak constraints.
 */
export function updateLos(bots: mod.Player[], sightRange: number): void {
    const n = bots.length;
    for (let i = 0; i < n; i++) {
        rot = (rot + 1) % n;
        const bot = bots[rot];
        try {
            if (!mod.IsPlayerValid(bot)) continue;
            if (!mod.GetSoldierState(bot, mod.SoldierStateBool.IsAlive)) continue;
            if (!mod.GetSoldierState(bot, mod.SoldierStateBool.IsAISoldier)) continue;

            const botId = mod.GetObjId(bot);
            const botTeam = mod.GetObjId(mod.GetTeam(bot));
            const team1 = mod.GetObjId(mod.GetTeam(1));
            const enemies = getAlivePlayersOnTeam(botTeam === team1 ? 2 : 1);

            const eye = raise(mod.GetSoldierState(bot, mod.SoldierStateVector.GetPosition), HEAD_HEIGHT);
            let target: mod.Player | null = null;
            let best = Infinity;
            for (const en of enemies) {
                try {
                    const d = mod.DistanceBetween(
                        eye,
                        mod.GetSoldierState(en, mod.SoldierStateVector.GetPosition)
                    );
                    if (d < best) {
                        best = d;
                        target = en;
                    }
                } catch {}
            }
            if (!target || best > sightRange) continue; // skip bots with no nearby enemy

            const enemyChest = raise(mod.GetSoldierState(target, mod.SoldierStateVector.GetPosition), CHEST_HEIGHT);
            const dir = mod.DirectionTowards(eye, enemyChest);
            const start = mod.Add(eye, scale(dir, EYE_FORWARD));

            pending.set(botId, {
                enemyId: mod.GetObjId(target),
                eye: start,
                targetDist: mod.DistanceBetween(start, enemyChest),
            });
            mod.RayCast(bot, start, enemyChest); // result -> onRayHit/onRayMiss(bot)
            castCount++;
            return; // exactly one cast per call
        } catch {}
    }
}

/** Events.OnRayCastHit handler: geometry was hit at `point`. */
export function onRayHit(bot: mod.Player, point: mod.Vector): void {
    try {
        const botId = mod.GetObjId(bot);
        const p = pending.get(botId);
        if (!p) return;
        const hitDist = mod.DistanceBetween(p.eye, point);
        // A hit at/near the target = we reached them (clear). A hit well short = a wall between.
        const clear = hitDist >= p.targetDist * NEAR_FRAC;
        setLos(botId, p.enemyId, clear);
        pending.delete(botId);
    } catch {}
}

/** Events.OnRayCastMissed handler: nothing in the way -> clear LOS. */
export function onRayMiss(bot: mod.Player): void {
    try {
        const botId = mod.GetObjId(bot);
        const p = pending.get(botId);
        if (!p) return;
        setLos(botId, p.enemyId, true); // nothing in the way = clear
        pending.delete(botId);
    } catch {}
}

export function clearLos(): void {
    losByBot.clear();
    pending.clear();
}
