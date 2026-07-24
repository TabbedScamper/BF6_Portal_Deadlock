// ============================================================================
// GAME MODE CONFIGURATION
// ============================================================================
// Change PLAYERS_PER_TEAM to configure the game mode:
// 1 = 1v1, 2 = 2v2, 3 = 3v3, 4 = 4v4
// UI and bot backfill will adjust automatically.
// ============================================================================

export const PLAYERS_PER_TEAM = 4;

// ============================================================================
// MINIMUM TEAM SIZE
// ============================================================================
// Bots fill each team to at least this many members. 1 = true 1v1s are allowed:
// a solo joiner plays 1 human vs 1 enemy bot, and 2 humans split into a pure
// human 1v1 with no bots. Spectate safety in a 1v1: your death wipes your team,
// which ends the round by elimination IMMEDIATELY — the round transition widens
// the spectate pool to everyone before the engine needs a target, so the
// "waiting for soldier deployment" wedge can't arise from having no teammate.
// Raise to 2..PLAYERS_PER_TEAM only if you want guaranteed bot teammates.
// ============================================================================
export const MIN_TEAM_SIZE = 1;

// ============================================================================
// LIVE-ROUND SPECTATE (dead players watch teammates)
// ============================================================================
// true = live rounds run in SpawnModes.Spectating (required for this mode).
// BUILD F choreography (see SPECTATE-FLOW.md) guards against the engine's sticky
// spectator-session bug: the moment a round is decided, ALL dead players are
// force-deployed WHILE the mode is still Spectating (closing every spectator
// session through the engine's own deploy path), the mode is then held at
// SpawnModes.Deploy through the result screen + countdown (no undeploys allowed
// in that window), and only flips back to Spectating at round start.
// false = live rounds run in SpawnModes.Deploy (dead players wait on the deploy
// screen, no spectate) — the structural fallback if the bug returns.
// ============================================================================
export const LIVE_SPECTATE = true;

// ============================================================================
// DEBUG MODE  --  set to FALSE for the final release build.
// ============================================================================
// When true:
//   - all [EVT]/[TLM] telemetry is written to PortalLog (for diagnosis).
//   - a FULL bot lobby is forced so solo play is a real match ("spawn me friends"),
//     instead of scaling down to 1v1 when only one human is present.
// When false (release): NO logging (nothing written to PortalLog -> no storage growth)
// and team size scales to the real human count as normal.
// ============================================================================
export const DEBUG_MODE = false;

// In debug mode, force this many seats per team (fills with bots) so there's a
// full match to test against solo. Ignored when DEBUG_MODE is false.
export const DEBUG_TEAM_SIZE = PLAYERS_PER_TEAM;

// ============================================================================
// AUDIO — MASTER SFX VOLUME
// ============================================================================
// ONE knob for every sound effect in the mode: all PlaySound call sites route
// their per-sound BASE volume through sfxVol(base) = base * SFX_MASTER_VOLUME.
// NOTE: the SDK's PlayVO has NO volume parameter — announcer/VO loudness is
// engine-fixed. Lowering this master is what makes the VO lines stand out.
// ============================================================================
export const SFX_MASTER_VOLUME = 0.6;

export function sfxVol(base: number = 1.0): number {
    return base * SFX_MASTER_VOLUME;
}
