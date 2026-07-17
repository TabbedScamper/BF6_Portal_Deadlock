import { Timers } from 'bf6-portal-utils/timers/index.ts';

// ============================================================================
// TELEMETRY — the "MCP-like" live view into a running match.
// ============================================================================
// Emits structured, machine-parseable lines to console.log -> PortalLog.txt
// (written when hosting "Host Locally"; on a dedicated server use
// mod.SendPortalLogToAdmin() to flush to the admin client's PortalLog.txt).
// A tailer parses:
//     [EVT] <name> {json}     discrete events (round start, deploy, kill, ...)
//     [TLM] <name> {json}     periodic samples (perf frame time, roster counts)
// Every payload is JSON.stringify'd, which fixes the old
// console.log('...STATS', obj) pattern that logged "[object Object]" and lost
// every stat value (875x in the captured session log).
// Telemetry follows DEBUG_MODE: ON for testing, fully OFF for the release build
// (so nothing is written to PortalLog and it never grows on disk).
// ============================================================================

import { DEBUG_MODE } from '../config.ts';

export const TELEMETRY_ENABLED = DEBUG_MODE;

// Serialize a payload to a compact, ASCII-safe string. Never throws.
function ser(data: unknown): string {
    if (data === undefined) return '';
    try {
        return ' ' + JSON.stringify(data);
    } catch {
        return ' ' + String(data);
    }
}

export const Tlm = {
    // Discrete event.  Tlm.event('round.start', { round: 3, ... })
    event(name: string, data?: Record<string, unknown>): void {
        if (!TELEMETRY_ENABLED) return;
        console.log('[EVT] ' + name + ser(data));
    },

    // Periodic sample.  Tlm.sample('roster', { t1: 2, t2: 2, bots: 1 })
    sample(name: string, data: Record<string, unknown>): void {
        if (!TELEMETRY_ENABLED) return;
        console.log('[TLM] ' + name + ser(data));
    },
};

// ---- perf heartbeat: native 1.3.3.0 server/Portal frame-time telemetry -------
// The averages update infrequently (per EA's PortalPerformanceExample), so a
// low sample rate is plenty. serverMs = whole server tick; portalMs = OUR
// script's contribution — watch portalMs to catch our own regressions.
let _perfTimer: ReturnType<typeof Timers.setInterval> | undefined;

export function startPerfHeartbeat(intervalSec: number = 2): void {
    if (!TELEMETRY_ENABLED || _perfTimer !== undefined) return;
    _perfTimer = Timers.setInterval(() => {
        try {
            Tlm.sample('perf', {
                serverMs: +mod.GetServerAverageFrameTime().toFixed(2),
                portalMs: +mod.GetPortalAverageFrameTime().toFixed(2),
            });
        } catch {}
    }, intervalSec * 1000);
}

export function stopPerfHeartbeat(): void {
    if (_perfTimer !== undefined) {
        Timers.clearInterval(_perfTimer);
        _perfTimer = undefined;
    }
}
