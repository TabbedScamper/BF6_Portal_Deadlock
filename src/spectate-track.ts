// ============================================================================
// DEADLOCK — SPECTATE-BUG DIAGNOSTIC TRACKER (online-hosted friendly)
// ============================================================================
// Massive-but-compact trace of the death/deploy/spectate state machine, written
// as one-line [SPEC t=..] console.log entries (-> PortalLog) and periodically
// SHIPPED TO THE ADMIN CLIENT via mod.SendPortalLogToAdmin() — the only way to
// read logs on a hosted (non-local) server. Sends are QUOTA-LIMITED per session,
// so we flush on a 20s cadence + once per round transition, never per-event.
//
// What it captures:
//   DEATH        id, source (died/mandown), per-team alive counts, round flags
//   DEPLOY       id, team, latency since that player's death (ms)
//   DEPLOY-BLOCK the mid-round spawn blocker rejecting a deploy
//   UNDEPLOY     teardown/blocker undeploys with a reason
//   FILTERS      every spectate-pool change (Team / All)
//   MODE         every SetSpawnMode transition (AutoSpawn / Spectating) w/ reason
//   ROUND        countdown start/end, round start, transition (+ which ender)
//   STATE        5s roster snapshot: every player as <id><h|b>:<A|D> per team
//
// SPEC_TRACK=false silences everything (release). Diagnostic builds: true.
// ============================================================================

import { Timers } from 'bf6-portal-utils/timers/index.ts';

export const SPEC_TRACK = false; // RELEASE: no PortalLog writes, no admin-log sends

let t0 = 0;
let flushTimer: number | null = null;
let snapTimer: number | null = null;
let sends = 0;
const deathAt: Map<number, number> = new Map();

function ts(): string {
    return ((Date.now() - t0) / 1000).toFixed(2);
}

/** One compact trace line into PortalLog. */
export function spec(tag: string, detail: string = ''): void {
    if (!SPEC_TRACK) return;
    console.log(`[SPEC ${ts()}] ${tag}${detail ? ' ' + detail : ''}`);
}

function teamCounts(): string {
    let t1a = 0, t1d = 0, t2a = 0, t2d = 0, other = 0;
    try {
        const arr = mod.AllPlayers();
        const n = mod.CountOf(arr);
        for (let i = 0; i < n; i++) {
            const p = mod.ValueInArray(arr, i) as mod.Player;
            try {
                if (!mod.IsPlayerValid(p)) continue;
                const team = mod.GetObjId(mod.GetTeam(p));
                const alive = mod.GetSoldierState(p, mod.SoldierStateBool.IsAlive);
                if (team === 1) alive ? t1a++ : t1d++;
                else if (team === 2) alive ? t2a++ : t2d++;
                else other++;
            } catch {}
        }
    } catch {}
    return `t1=${t1a}A/${t1d}D t2=${t2a}A/${t2d}D${other ? ` other=${other}` : ''}`;
}

/** Full roster snapshot — every player as <id><h|b>:<A|D>, grouped by team. */
export function specState(label: string): void {
    if (!SPEC_TRACK) return;
    try {
        const teams: { [t: number]: string[] } = {};
        const arr = mod.AllPlayers();
        const n = mod.CountOf(arr);
        for (let i = 0; i < n; i++) {
            const p = mod.ValueInArray(arr, i) as mod.Player;
            try {
                if (!mod.IsPlayerValid(p)) continue;
                const id = mod.GetObjId(p);
                const team = mod.GetObjId(mod.GetTeam(p));
                const bot = mod.GetSoldierState(p, mod.SoldierStateBool.IsAISoldier) ? 'b' : 'h';
                const alive = mod.GetSoldierState(p, mod.SoldierStateBool.IsAlive) ? 'A' : 'D';
                (teams[team] = teams[team] ?? []).push(`${id}${bot}:${alive}`);
            } catch {}
        }
        const body = Object.keys(teams).map((t) => `T${t}[${teams[Number(t)].join(' ')}]`).join(' ');
        spec('STATE', `${label} ${body}`);
    } catch {}
}

export function specDeath(player: mod.Player, source: 'died' | 'mandown'): void {
    if (!SPEC_TRACK) return;
    try {
        const id = mod.GetObjId(player);
        if (source === 'died') deathAt.set(id, Date.now());
        spec('DEATH', `id=${id} src=${source} ${teamCounts()}`);
    } catch {}
}

export function specDeploy(player: mod.Player): void {
    if (!SPEC_TRACK) return;
    try {
        const id = mod.GetObjId(player);
        const d = deathAt.get(id);
        deathAt.delete(id);
        spec('DEPLOY', `id=${id} team=${mod.GetObjId(mod.GetTeam(player))}${d !== undefined ? ` sinceDeath=${Date.now() - d}ms` : ' (first/redeploy)'}`);
    } catch {}
}

export function specUndeploy(playerId: number, why: string): void {
    spec('UNDEPLOY', `id=${playerId} why=${why}`);
}

/** Force a log ship to the admin client NOW (round transitions). */
export function specFlush(reason: string): void {
    if (!SPEC_TRACK) return;
    try {
        sends++;
        spec('FLUSH', `#${sends} (${reason})`);
        mod.SendPortalLogToAdmin();
    } catch {}
}

/** Call once in OnGameModeStarted: zero the clock, start snapshot + flush timers. */
export function specInit(): void {
    if (!SPEC_TRACK) return;
    t0 = Date.now();
    spec('INIT', 'spectate tracker online');
    if (snapTimer === null) snapTimer = Timers.setInterval(() => specState('tick'), 5000);
    if (flushTimer === null) flushTimer = Timers.setInterval(() => specFlush('periodic'), 20000);
}

export function specStop(): void {
    if (snapTimer !== null) { try { Timers.clearInterval(snapTimer); } catch {} snapTimer = null; }
    if (flushTimer !== null) { try { Timers.clearInterval(flushTimer); } catch {} flushTimer = null; }
    specFlush('final');
}
