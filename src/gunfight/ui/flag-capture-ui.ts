import { Timers } from 'bf6-portal-utils/timers/index.ts';
import { getAlivePlayersOnTeam } from '../../helpers/index.ts';

// ========== DEBUG LOGGING ==========
const DEBUG_FLAG_CAPTURE = false;
let _flagUpdateTicks = 0;
let _distanceChecks = 0;
let _uiCreations = 0;
let _uiCleanups = 0;
let _stateChanges = 0;
let _lastFlagLogTime = 0;

function logFlag(msg: string, ...args: any[]): void {
    if (DEBUG_FLAG_CAPTURE) console.log(`[FlagCaptureUI] ${msg}`, ...args);
}
// ===================================

// Flag spatial object ID
const FLAG_OBJECT_ID = 5;
const FLAG_OFFSET_Y = 50; // 50 meters up/down
const FLAG_CAPTURE_RADIUS = 3; // meters

// Capture timing
const CAPTURE_TIME_MS = 3000; // 3 seconds to capture
const UPDATE_TICK_MS = 50; // Update every 50ms

// UI Colors
const FLAG_COLORS = {
    BLUE: mod.CreateVector(0.2, 0.8, 1),
    RED: mod.CreateVector(1, 0.3, 0.3),
    GRAY: mod.CreateVector(0.5, 0.5, 0.5),
    WHITE: mod.CreateVector(1, 1, 1),
    DARK_BG: mod.CreateVector(0.15, 0.15, 0.15),
};

// UI sizing
const CAPTURE_BAR_WIDTH = 200;
const CAPTURE_BAR_HEIGHT = 12;
const CAPTURE_UI_Y = 150; // Below center

// Capture state
type CaptureState = 'none' | 'capturing' | 'contested';

// Per-player UI data
interface PlayerCaptureUI {
    container: mod.UIWidget;
    barBg: mod.UIWidget;
    barFill: mod.UIWidget;
    captureText: mod.UIWidget;
}

let uiCounter = 0;

export class FlagCaptureUI {
    private _flagObject: mod.SpatialObject | null = null;
    private _flagBasePosition: mod.Vector | null = null;
    private _isActive = false;
    private _isFlagHidden = false;

    // Beacon FX
    private _beaconFx: mod.SpatialObject | null = null;
    private _beaconSpawned = false;

    // World icon
    private _worldIcon: mod.WorldIcon | null = null;

    // Capture state
    private _captureProgress = 0; // 0 to CAPTURE_TIME_MS
    private _capturingTeam: 1 | 2 | null = null;
    private _lastCapturingTeam: 1 | 2 | null = null; // Track who was capturing before contested
    private _updateTimer: number | null = null;
    private _wasCapturing = false; // Track if we were capturing to detect state changes

    // Per-player UI tracking
    private _playerUIs: Map<number, PlayerCaptureUI> = new Map();
    private _playersOnFlag: Set<number> = new Set();

    // Callbacks
    private _onTeamCapture: ((teamId: number) => void) | null = null;
    private _onPauseCountdown: (() => void) | null = null;
    private _onResumeCountdown: (() => void) | null = null;
    private _onPlayCaptureVO: ((capturingTeamId: number) => void) | null = null;
    private _onPlayContestedVO: (() => void) | null = null;

    // State tracking
    private _wasContested = false;

    public constructor() {
        // No global UI - we create per-player UI as needed
    }

    /**
     * Initialize the flag system - call once at game start
     */
    public init(): void {
        try {
            this._flagObject = mod.GetSpatialObject(FLAG_OBJECT_ID);
            if (!this._flagObject) {
                return;
            }
            this._flagBasePosition = mod.GetObjectPosition(this._flagObject);
            // Hide flag underground at start
            this._hideFlag();
        } catch {
            // Failed to init flag
        }
    }

    /**
     * Reset flag for round start - hide it underground
     */
    public resetForRound(): void {
        this._captureProgress = 0;
        this._capturingTeam = null;
        this._lastCapturingTeam = null;
        this._wasCapturing = false;
        this._wasContested = false;
        this._isActive = false;
        this._stopUpdate();
        this._cleanupAllPlayerUIs();
        this._despawnBeacon();
        this._hideFlag();
    }

    /**
     * Activate the flag for overtime - raise it and start detecting captures
     */
    public raiseFlag(): void {
        if (this._isActive) {
            logFlag('raiseFlag called but already active - SKIPPING');
            return;
        }

        if (!this._flagObject || !this._flagBasePosition) {
            logFlag('raiseFlag called but no flag object - SKIPPING');
            return;
        }

        // Reset debug counters
        _flagUpdateTicks = 0;
        _distanceChecks = 0;
        _uiCreations = 0;
        _uiCleanups = 0;
        _stateChanges = 0;
        _lastFlagLogTime = Date.now();

        logFlag('RAISING FLAG - starting capture detection (50ms interval)');

        // Raise the flag to its original position
        this._showFlag();

        // Spawn beacon at flag
        this._spawnBeacon();

        // Reset capture state
        this._captureProgress = 0;
        this._capturingTeam = null;
        this._lastCapturingTeam = null;
        this._wasCapturing = false;
        this._isActive = true;

        // Start checking for captures
        this._startUpdate();
    }

    private _hideFlag(): void {
        this._despawnBeacon();
        this._removeIcon();

        if (!this._flagObject || !this._flagBasePosition || this._isFlagHidden) return;

        try {
            const hiddenPos = mod.CreateVector(
                mod.XComponentOf(this._flagBasePosition),
                mod.YComponentOf(this._flagBasePosition) - FLAG_OFFSET_Y,
                mod.ZComponentOf(this._flagBasePosition)
            );
            mod.MoveObject(this._flagObject, hiddenPos);
            this._isFlagHidden = true;
        } catch {
            // Failed to move object
        }
    }

    private _showFlag(): void {
        if (!this._flagObject || !this._flagBasePosition || !this._isFlagHidden) return;

        try {
            mod.MoveObject(this._flagObject, this._flagBasePosition);
            this._isFlagHidden = false;

            // Spawn blue flag world icon 2.5 meters above flag
            this._spawnIcon();
        } catch {
            // Failed to move object
        }
    }

    private _spawnIcon(): void {
        if (this._worldIcon || !this._flagBasePosition) return;

        try {
            // Spawn world icon
            this._worldIcon = mod.SpawnObject(
                mod.RuntimeSpawn_Common.WorldIcon,
                mod.CreateVector(0, 0, 0),
                mod.CreateVector(0, 0, 0)
            ) as unknown as mod.WorldIcon;

            // Configure icon
            const blueColor = mod.CreateVector(0.2, 0.5, 1);
            mod.SetWorldIconImage(this._worldIcon, mod.WorldIconImages.Flag);
            mod.SetWorldIconColor(this._worldIcon, blueColor);
            mod.EnableWorldIconImage(this._worldIcon, true);
            mod.EnableWorldIconText(this._worldIcon, false);

            // Position 2.5 meters above flag
            const iconPos = mod.CreateVector(
                mod.XComponentOf(this._flagBasePosition),
                mod.YComponentOf(this._flagBasePosition) + 2.5,
                mod.ZComponentOf(this._flagBasePosition)
            );
            mod.SetWorldIconPosition(this._worldIcon, iconPos);
        } catch {
            // Failed to spawn icon
        }
    }

    private _spawnBeacon(): void {
        if (!this._flagBasePosition || this._beaconSpawned) return;

        try {
            // Offset beacon 15 meters down
            const beaconPos = mod.CreateVector(
                mod.XComponentOf(this._flagBasePosition),
                mod.YComponentOf(this._flagBasePosition) - 15,
                mod.ZComponentOf(this._flagBasePosition)
            );
            this._beaconFx = mod.SpawnObject(
                mod.RuntimeSpawn_Common.FX_Gadget_DeployableMortar_Target_Area,
                beaconPos,
                mod.CreateVector(0, 0, 0)
            );
            mod.EnableVFX(this._beaconFx as unknown as mod.VFX, true);
            this._beaconSpawned = true;
        } catch {
            // Failed to spawn beacon
        }
    }

    private _despawnBeacon(): void {
        if (this._beaconFx) {
            try {
                mod.UnspawnObject(this._beaconFx);
            } catch {
                // Failed to unspawn
            }
            this._beaconFx = null;
        }
        this._beaconSpawned = false;
    }

    private _removeIcon(): void {
        if (this._worldIcon) {
            try {
                mod.UnspawnObject(this._worldIcon as unknown as mod.Object);
            } catch {
                // Failed to remove icon
            }
            this._worldIcon = null;
        }
    }

    private _tryPlayCaptureVO(capturingTeamId: number): void {
        this._onPlayCaptureVO?.(capturingTeamId);
    }

    private _tryPlayContestedVO(): void {
        this._onPlayContestedVO?.();
    }

    public setCallbacks(
        onTeamCapture: (teamId: number) => void,
        onPauseCountdown: () => void,
        onResumeCountdown: () => void,
        onPlayCaptureVO?: (capturingTeamId: number) => void,
        onPlayContestedVO?: () => void
    ): void {
        this._onTeamCapture = onTeamCapture;
        this._onPauseCountdown = onPauseCountdown;
        this._onResumeCountdown = onResumeCountdown;
        this._onPlayCaptureVO = onPlayCaptureVO || null;
        this._onPlayContestedVO = onPlayContestedVO || null;
    }

    public destroy(): void {
        this._stopUpdate();
        this._despawnBeacon();
        this._removeIcon();
        this._cleanupAllPlayerUIs();
    }

    private _startUpdate(): void {
        if (this._updateTimer !== null) return;

        this._updateTimer = Timers.setInterval(() => {
            this._updateCapture();
        }, UPDATE_TICK_MS);
    }

    private _stopUpdate(): void {
        if (this._updateTimer !== null) {
            Timers.clearInterval(this._updateTimer);
            this._updateTimer = null;
        }
    }

    private _updateCapture(): void {
        if (!this._flagBasePosition || !this._isActive) return;

        _flagUpdateTicks++;
        const flagPos = this._flagBasePosition;
        const team1Players = getAlivePlayersOnTeam(1);
        const team2Players = getAlivePlayersOnTeam(2);

        // Log every 1 second (20 ticks at 50ms)
        if (_flagUpdateTicks % 20 === 0) {
            const elapsed = (Date.now() - _lastFlagLogTime) / 1000;
            logFlag(`FLAG UPDATE STATS (${elapsed.toFixed(1)}s):`, {
                ticks: _flagUpdateTicks,
                distanceChecks: _distanceChecks,
                uiCreations: _uiCreations,
                uiCleanups: _uiCleanups,
                stateChanges: _stateChanges,
                captureProgress: this._captureProgress,
                capturingTeam: this._capturingTeam,
                playersOnFlag: this._playersOnFlag.size,
                playerUIs: this._playerUIs.size,
                team1Alive: team1Players.length,
                team2Alive: team2Players.length,
            });
        }

        // Track players near flag
        const team1Near: mod.Player[] = [];
        const team2Near: mod.Player[] = [];
        const currentPlayersOnFlag = new Set<number>();

        // Check team 1 players (including bots)
        for (const player of team1Players) {
            try {
                _distanceChecks++;
                const playerPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
                const distance = mod.DistanceBetween(playerPos, flagPos);
                if (distance <= FLAG_CAPTURE_RADIUS) {
                    team1Near.push(player);
                    // Only track humans for UI purposes
                    if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                        currentPlayersOnFlag.add(mod.GetObjId(player));
                    }
                }
            } catch {
                // Player invalid
            }
        }

        // Check team 2 players (including bots)
        for (const player of team2Players) {
            try {
                _distanceChecks++;
                const playerPos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
                const distance = mod.DistanceBetween(playerPos, flagPos);
                if (distance <= FLAG_CAPTURE_RADIUS) {
                    team2Near.push(player);
                    // Only track humans for UI purposes
                    if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                        currentPlayersOnFlag.add(mod.GetObjId(player));
                    }
                }
            } catch {
                // Player invalid
            }
        }

        // Handle players leaving the flag - remove their UI
        for (const playerId of this._playersOnFlag) {
            if (!currentPlayersOnFlag.has(playerId)) {
                this._cleanupPlayerUI(playerId);
            }
        }
        this._playersOnFlag = currentPlayersOnFlag;

        // Determine capture state
        const isContested = team1Near.length > 0 && team2Near.length > 0;
        const team1Capturing = team1Near.length > 0 && team2Near.length === 0;
        const team2Capturing = team2Near.length > 0 && team1Near.length === 0;
        const anyoneOnFlag = team1Near.length > 0 || team2Near.length > 0;

        // Handle capture logic
        if (!anyoneOnFlag) {
            // No one on flag
            if (this._wasCapturing) {
                _stateChanges++;
                logFlag('STATE CHANGE: capturing -> idle (no one on flag)');
                this._onResumeCountdown?.();
                this._wasCapturing = false;
            }
            this._capturingTeam = null;
            this._wasContested = false;

            // Decay capture progress
            if (this._captureProgress > 0) {
                this._captureProgress = Math.max(0, this._captureProgress - UPDATE_TICK_MS * 2);
            }
        } else if (isContested) {
            // Contested - both teams on flag
            if (this._wasCapturing) {
                this._onResumeCountdown?.();
                this._wasCapturing = false;
            }

            // Save who was capturing before contested state
            if (this._capturingTeam !== null) {
                this._lastCapturingTeam = this._capturingTeam;
            }
            this._capturingTeam = null;

            // Play contested VO when flag becomes contested
            if (!this._wasContested) {
                _stateChanges++;
                logFlag('STATE CHANGE: -> contested (both teams on flag)');
                this._wasContested = true;
                this._tryPlayContestedVO();
            }

            // Update UI for human players on flag - show CONTESTED
            for (const player of [...team1Near, ...team2Near]) {
                if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                    this._updatePlayerUI(player, 'contested');
                }
            }
        } else {
            // One team capturing
            const teamId = team1Capturing ? 1 : 2;
            const capturingPlayers = team1Capturing ? team1Near : team2Near;

            // Check if a different team is now capturing (either from direct switch or after contested)
            const previousTeam = this._capturingTeam ?? this._lastCapturingTeam;
            const isTeamSwitch = previousTeam !== null && previousTeam !== teamId;

            // Reset contested state
            this._wasContested = false;

            // If switching teams, reset progress
            if (isTeamSwitch) {
                this._captureProgress = 0;
                this._tryPlayCaptureVO(teamId);
            }

            // Start capturing
            if (!this._wasCapturing) {
                this._onPauseCountdown?.();
                this._wasCapturing = true;
                // Only play VO if not a team switch (team switch already plays VO above)
                if (!isTeamSwitch) {
                    this._tryPlayCaptureVO(teamId);
                }
            }

            this._capturingTeam = teamId;
            this._lastCapturingTeam = teamId;
            this._captureProgress += UPDATE_TICK_MS;

            // Check for capture complete
            if (this._captureProgress >= CAPTURE_TIME_MS) {
                this._captureProgress = CAPTURE_TIME_MS;
                this._stopUpdate();
                this._isActive = false;
                this._cleanupAllPlayerUIs();
                this._onTeamCapture?.(teamId);
                return;
            }

            // Update UI for human capturing players - show CAPTURING
            for (const player of capturingPlayers) {
                if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                    this._updatePlayerUI(player, 'capturing');
                }
            }
        }
    }

    private _createPlayerUI(player: mod.Player): PlayerCaptureUI {
        _uiCreations++;
        const playerId = mod.GetObjId(player);
        const uid = uiCounter++;
        logFlag('Creating player UI', { playerId, uiCounter: uid });

        // Create container
        const containerName = `flag_ui_${playerId}_${uid}`;
        mod.AddUIContainer(
            containerName,
            mod.CreateVector(0, CAPTURE_UI_Y, 0),
            mod.CreateVector(CAPTURE_BAR_WIDTH + 40, 60, 0),
            mod.UIAnchor.Center,
            mod.GetUIRoot(),
            true,
            0,
            mod.CreateVector(0, 0, 0),
            0,
            mod.UIBgFill.None,
            mod.UIDepth.AboveGameUI,
            player
        );
        const container = mod.FindUIWidgetWithName(containerName);

        // Create bar background
        const barBgName = `flag_barbg_${playerId}_${uid}`;
        mod.AddUIContainer(
            barBgName,
            mod.CreateVector(0, 0, 0),
            mod.CreateVector(CAPTURE_BAR_WIDTH, CAPTURE_BAR_HEIGHT, 0),
            mod.UIAnchor.Center,
            container,
            true,
            0,
            FLAG_COLORS.DARK_BG,
            0.8,
            mod.UIBgFill.Solid,
            mod.UIDepth.AboveGameUI,
            player
        );
        const barBg = mod.FindUIWidgetWithName(barBgName);

        // Create bar fill
        const barFillName = `flag_barfill_${playerId}_${uid}`;
        mod.AddUIContainer(
            barFillName,
            mod.CreateVector(-CAPTURE_BAR_WIDTH / 2, 0, 0),
            mod.CreateVector(0, CAPTURE_BAR_HEIGHT, 0),
            mod.UIAnchor.Center,
            container,
            true,
            0,
            FLAG_COLORS.WHITE,
            1,
            mod.UIBgFill.Solid,
            mod.UIDepth.AboveGameUI,
            player
        );
        const barFill = mod.FindUIWidgetWithName(barFillName);

        // Create capture text
        const textName = `flag_text_${playerId}_${uid}`;
        mod.AddUIText(
            textName,
            mod.CreateVector(0, -20, 0),
            mod.CreateVector(CAPTURE_BAR_WIDTH, 30, 0),
            mod.UIAnchor.Center,
            container,
            true,
            0,
            mod.CreateVector(0, 0, 0),
            0,
            mod.UIBgFill.None,
            mod.Message(mod.stringkeys.gunfight.flag.capturing),
            14,
            FLAG_COLORS.WHITE,
            1,
            mod.UIAnchor.Center,
            mod.UIDepth.AboveGameUI,
            player
        );
        const captureText = mod.FindUIWidgetWithName(textName);

        return { container, barBg, barFill, captureText };
    }

    private _updatePlayerUI(player: mod.Player, state: CaptureState): void {
        const playerId = mod.GetObjId(player);
        let ui = this._playerUIs.get(playerId);

        if (!ui) {
            ui = this._createPlayerUI(player);
            this._playerUIs.set(playerId, ui);
        }

        // Update bar fill
        const fillPercent = this._captureProgress / CAPTURE_TIME_MS;
        const fillWidth = CAPTURE_BAR_WIDTH * fillPercent;

        try {
            mod.SetUIWidgetSize(ui.barFill, mod.CreateVector(fillWidth, CAPTURE_BAR_HEIGHT, 0));
            mod.SetUIWidgetPosition(ui.barFill, mod.CreateVector(-CAPTURE_BAR_WIDTH / 2 + fillWidth / 2, 0, 0));

            // Update text and colors based on state
            if (state === 'capturing') {
                mod.SetUITextLabel(ui.captureText, mod.Message(mod.stringkeys.gunfight.flag.capturing));
                mod.SetUITextColor(ui.captureText, FLAG_COLORS.WHITE);
                mod.SetUIWidgetBgColor(ui.barFill, FLAG_COLORS.WHITE);
            } else if (state === 'contested') {
                mod.SetUITextLabel(ui.captureText, mod.Message(mod.stringkeys.gunfight.flag.contested));
                mod.SetUITextColor(ui.captureText, FLAG_COLORS.GRAY);
                mod.SetUIWidgetBgColor(ui.barFill, FLAG_COLORS.GRAY);
            }
        } catch {
            // UI update failed
        }
    }

    private _cleanupPlayerUI(playerId: number): void {
        const ui = this._playerUIs.get(playerId);
        if (ui) {
            _uiCleanups++;
            logFlag('Cleaning up player UI', { playerId });
            try {
                mod.DeleteUIWidget(ui.container);
            } catch {
                // Widget already deleted
            }
            this._playerUIs.delete(playerId);
        }
    }

    private _cleanupAllPlayerUIs(): void {
        for (const [playerId] of this._playerUIs) {
            this._cleanupPlayerUI(playerId);
        }
        this._playerUIs.clear();
        this._playersOnFlag.clear();
    }

    public hide(): void {
        this._stopUpdate();
        this._despawnBeacon();
        this._removeIcon();
        this._cleanupAllPlayerUIs();
    }

    /**
     * Get the flag's base position (for bot targeting)
     */
    public getFlagPosition(): mod.Vector | null {
        return this._flagBasePosition;
    }

    /**
     * Check if the flag is currently active (raised)
     */
    public isActive(): boolean {
        return this._isActive;
    }
}
