// ============================================================================
// GAME MODE CONFIGURATION
// ============================================================================
// Change PLAYERS_PER_TEAM to configure the game mode:
// 1 = 1v1, 2 = 2v2, 3 = 3v3, 4 = 4v4
// UI and bot backfill will adjust automatically.
// ============================================================================

export const PLAYERS_PER_TEAM = 4;

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
