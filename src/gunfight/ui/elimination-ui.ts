import { Timers } from 'bf6-portal-utils/timers/index.ts';
import { UIContainer } from 'bf6-portal-utils/ui/components/container/index.ts';
import { UIText } from 'bf6-portal-utils/ui/components/text/index.ts';
import { getAlivePlayersOnTeam } from '../../helpers/index.ts';
import { PLAYERS_PER_TEAM } from '../../config.ts';

// ========== DEBUG LOGGING ==========
const DEBUG_ELIMINATION = false;
let _eliminationShows = 0;
let _uisCreated = 0;
let _uisDestroyed = 0;
let _animationTimers = 0;

function logElim(msg: string, ...args: any[]): void {
    if (DEBUG_ELIMINATION) console.log(`[EliminationUI] ${msg}`, ...args);
}
// ===================================

// Colors
const ELIM_COLORS = {
    CYAN: mod.CreateVector(0.2, 0.85, 0.95),
    RED: mod.CreateVector(1, 0.3, 0.3),
    WHITE: mod.CreateVector(1, 1, 1),
};

// Animation timing
const ELIM_SHRINK_DURATION = 200; // Time to shrink from big to normal
const ELIM_TRANSITION_DELAY = 300; // Delay before number changes
const ELIM_HOLD_DURATION = 3000; // Stay on screen for 3 seconds
const ELIM_FADE_OUT_DURATION = 300;
const ELIM_ANIMATION_TICK = 33;
const ELIM_FINAL_HOLD_DURATION = 800; // Brief hold when showing final elimination (0vX)

// UI sizing - start big and shrink to these sizes
const ELIM_NUMBER_SIZE_START = 120; // Starting size (big)
const ELIM_NUMBER_SIZE_END = 50; // Final size (normal)
const ELIM_VS_SIZE_START = 50;
const ELIM_VS_SIZE_END = 22;

// Position (closer to health bars at top)
const ELIM_POSITION_Y = -200;

// Track active elimination UIs (one per player) and previous counts
const activeUIs: Map<number, EliminationUI> = new Map();
let prevTeam1Alive = PLAYERS_PER_TEAM;
let prevTeam2Alive = PLAYERS_PER_TEAM;

class EliminationUI {
    private _container: UIContainer;
    private _leftNumber: UIText;
    private _vsText: UIText;
    private _rightNumber: UIText;
    private _timer: number | null = null;
    private _newLeftCount: number;
    private _newRightCount: number;
    private _isFinalElimination: boolean;

    constructor(
        oldLeftCount: number,
        oldRightCount: number,
        newLeftCount: number,
        newRightCount: number,
        isFinalElimination: boolean,
        receiver?: mod.Player
    ) {
        this._newLeftCount = newLeftCount;
        this._newRightCount = newRightCount;
        this._isFinalElimination = isFinalElimination;
        // Main container
        this._container = new UIContainer({
            anchor: mod.UIAnchor.Center,
            y: ELIM_POSITION_Y,
            width: 300,
            height: 100,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.None,
            visible: true,
            receiver: receiver,
            depth: mod.UIDepth.AboveGameUI,
        });

        // Left number (friendly team - cyan)
        this._leftNumber = new UIText({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            x: -30,
            y: 0,
            width: 80,
            height: 80,
            message: mod.Message(mod.stringkeys.logger.chars[String(oldLeftCount)]),
            textSize: ELIM_NUMBER_SIZE_START,
            textColor: ELIM_COLORS.CYAN,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // "v" text
        this._vsText = new UIText({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            x: 0,
            y: 0,
            width: 40,
            height: 50,
            message: mod.Message(mod.stringkeys.gunfight.elimination.vs),
            textSize: ELIM_VS_SIZE_START,
            textColor: ELIM_COLORS.WHITE,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Right number (enemy team - red)
        this._rightNumber = new UIText({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            x: 30,
            y: 0,
            width: 80,
            height: 80,
            message: mod.Message(mod.stringkeys.logger.chars[String(oldRightCount)]),
            textSize: ELIM_NUMBER_SIZE_START,
            textColor: ELIM_COLORS.RED,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });
    }

    public async animate(): Promise<void> {
        // Pop in with shrink effect (showing old numbers)
        await this._animateShrinkIn();

        // Brief pause before transition
        await this._wait(ELIM_TRANSITION_DELAY);

        // Update to new numbers
        this._leftNumber.message = mod.Message(mod.stringkeys.logger.chars[String(this._newLeftCount)]);
        this._rightNumber.message = mod.Message(mod.stringkeys.logger.chars[String(this._newRightCount)]);

        // Hold - shorter for final elimination
        const holdDuration = this._isFinalElimination ? ELIM_FINAL_HOLD_DURATION : ELIM_HOLD_DURATION;
        await this._wait(holdDuration);

        // Fade out
        await this._animateFadeOut();

        // Clean up
        this.destroy();
    }

    private _animateShrinkIn(): Promise<void> {
        return new Promise((resolve) => {
            let elapsed = 0;

            this._timer = Timers.setInterval(() => {
                elapsed += ELIM_ANIMATION_TICK;
                const progress = Math.min(elapsed / ELIM_SHRINK_DURATION, 1);

                // Ease out cubic for smooth deceleration
                const eased = 1 - Math.pow(1 - progress, 3);

                // Alpha: 0 to 1
                const alpha = eased;

                // Size: START to END (shrinking)
                const numberSize = ELIM_NUMBER_SIZE_START + (ELIM_NUMBER_SIZE_END - ELIM_NUMBER_SIZE_START) * eased;
                const vsSize = ELIM_VS_SIZE_START + (ELIM_VS_SIZE_END - ELIM_VS_SIZE_START) * eased;

                this._leftNumber.textAlpha = alpha;
                this._leftNumber.textSize = numberSize;
                this._vsText.textAlpha = alpha * 0.9;
                this._vsText.textSize = vsSize;
                this._rightNumber.textAlpha = alpha;
                this._rightNumber.textSize = numberSize;

                if (progress >= 1) {
                    this._clearTimer();
                    resolve();
                }
            }, ELIM_ANIMATION_TICK);
        });
    }

    private _animateFadeOut(): Promise<void> {
        return new Promise((resolve) => {
            let elapsed = 0;

            this._timer = Timers.setInterval(() => {
                elapsed += ELIM_ANIMATION_TICK;
                const progress = Math.min(elapsed / ELIM_FADE_OUT_DURATION, 1);

                const alpha = 1 - progress;

                this._leftNumber.textAlpha = alpha;
                this._vsText.textAlpha = alpha * 0.9;
                this._rightNumber.textAlpha = alpha;

                if (progress >= 1) {
                    this._clearTimer();
                    resolve();
                }
            }, ELIM_ANIMATION_TICK);
        });
    }

    private _wait(duration: number): Promise<void> {
        return new Promise((resolve) => {
            Timers.setTimeout(() => resolve(), duration);
        });
    }

    private _clearTimer(): void {
        if (this._timer !== null) {
            Timers.clearInterval(this._timer);
            this._timer = null;
        }
    }

    private _playerId: number = 0;

    public setPlayerId(playerId: number): void {
        this._playerId = playerId;
    }

    public destroy(): void {
        this._clearTimer();
        this._container.delete();
        if (this._playerId && activeUIs.get(this._playerId) === this) {
            activeUIs.delete(this._playerId);
        }
    }
}

/**
 * Show elimination effect to all players
 * Displays "X v Y" showing transition from old to new alive counts
 * @returns true if this is a final elimination (one team at 0)
 */
export function showEliminationEffect(): boolean {
    _eliminationShows++;
    logElim('showEliminationEffect called', {
        callNumber: _eliminationShows,
        activeUIsBeforeCleanup: activeUIs.size,
        prevTeam1Alive,
        prevTeam2Alive,
    });

    // Clean up ALL existing UIs to prevent stacking
    for (const [_playerId, ui] of activeUIs) {
        _uisDestroyed++;
        ui.destroy();
    }
    activeUIs.clear();

    // Get current alive counts
    const team1Alive = getAlivePlayersOnTeam(1).length;
    const team2Alive = getAlivePlayersOnTeam(2).length;
    logElim('Alive counts', { team1Alive, team2Alive });

    // Check if this is a final elimination (one team wiped out)
    const isFinalElimination = team1Alive === 0 || team2Alive === 0;

    // Show to all human players
    const allPlayers = mod.AllPlayers();
    const count = mod.CountOf(allPlayers);

    for (let i = 0; i < count; i++) {
        try {
            const player = mod.ValueInArray(allPlayers, i) as mod.Player;

            // Skip invalid players (including the player who just died)
            if (!mod.IsPlayerValid(player)) continue;

            const playerId = mod.GetObjId(player);

            // Skip AI players
            if (mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) continue;

            // Determine team perspective (swap numbers based on player's team)
            const playerTeam = mod.GetTeam(player);
            const playerTeamId = mod.GetObjId(playerTeam);
            const team1Id = mod.GetObjId(mod.GetTeam(1));

            // Calculate old and new counts from player's perspective
            const oldLeftCount = playerTeamId === team1Id ? prevTeam1Alive : prevTeam2Alive;
            const oldRightCount = playerTeamId === team1Id ? prevTeam2Alive : prevTeam1Alive;
            const newLeftCount = playerTeamId === team1Id ? team1Alive : team2Alive;
            const newRightCount = playerTeamId === team1Id ? team2Alive : team1Alive;

            _uisCreated++;
            logElim('Creating UI for player', { playerId, oldLeftCount, oldRightCount, newLeftCount, newRightCount });
            const ui = new EliminationUI(
                oldLeftCount,
                oldRightCount,
                newLeftCount,
                newRightCount,
                isFinalElimination,
                player
            );
            ui.setPlayerId(playerId);
            activeUIs.set(playerId, ui);
            ui.animate();
        } catch {
            // Player might be invalid
        }
    }

    // Update previous counts for next elimination
    prevTeam1Alive = team1Alive;
    prevTeam2Alive = team2Alive;

    return isFinalElimination;
}

/**
 * Reset elimination tracking (call at round start)
 */
export function resetEliminationTracking(): void {
    prevTeam1Alive = PLAYERS_PER_TEAM;
    prevTeam2Alive = PLAYERS_PER_TEAM;
}

/**
 * Clean up all active elimination UIs
 */
export function hideEliminationEffect(): void {
    for (const [_playerId, ui] of activeUIs) {
        ui.destroy();
    }
    activeUIs.clear();
}
