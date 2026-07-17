import { Timers } from 'bf6-portal-utils/timers/index.ts';
import { UIContainer } from 'bf6-portal-utils/ui/components/container/index.ts';
import { UIText } from 'bf6-portal-utils/ui/components/text/index.ts';
import { LoadoutUI, type Loadout } from './loadout-ui.ts';
import { TeamHealthUI } from './team-health-ui.ts';
import { playVO, getCurrentRoundNumber } from '../../index.ts';

// ========== DEBUG LOGGING ==========
const DEBUG_COUNTDOWN = false;
let _posEnforcementTicks = 0;
let _inputRestrictionCalls = 0;
let _botRelocationChecks = 0;
let _teleportCalls = 0;
let _lastLogTime = 0;

function logCountdown(msg: string, ...args: any[]): void {
    if (DEBUG_COUNTDOWN) console.log(`[CountdownUI] ${msg}`, ...args);
}
// ===================================

// Outline offsets for creating text stroke effect
const OUTLINE_OFFSETS = [
    { x: -2, y: -2 },
    { x: 2, y: -2 },
    { x: -2, y: 2 },
    { x: 2, y: 2 },
    { x: 0, y: -2 },
    { x: 0, y: 2 },
    { x: -2, y: 0 },
    { x: 2, y: 0 },
];

// Colors
const COLORS = {
    WHITE: mod.CreateVector(1, 1, 1),
    BLACK: mod.CreateVector(0, 0, 0),
    DARK_BG: mod.CreateVector(0.2, 0.2, 0.2),
    GRAY_OUTLINE: mod.CreateVector(0.75, 0.75, 0.75),
};

// Animation timing (milliseconds)
// Total per number should be ~1000ms
const BOX_GROW_DURATION = 200; // 200ms
const NUMBER_FADE_IN_DURATION = 150; // 150ms
const DASH_INTERVAL = 80; // 80ms × 3 = 240ms
const BG_FADE_DURATION = 300; // 300ms
// Total: ~890ms + small delays = ~1000ms
const ANIMATION_TICK = 33; // ~30fps - smoother for game UI

// UI sizing
const NUMBER_SIZE = 90;
const BOX_MIN_SIZE = 20;
const BOX_MAX_SIZE = 130;
const DASH_GAP = 8; // Gap between box and dashes

// Position (negative Y = up from center)
const POSITION_Y = -180;

// Round start sound
const ROUND_START_SOUND = mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_Vendetta_NewHVT_OneShot2D;

// Countdown tick sounds (for 3, 2, 1)
const COUNTDOWN_TICK_SOUND = mod.RuntimeSpawn_Common.SFX_UI_Shared_Countdown_Tick_OneShot2D;
const COUNTDOWN_FINAL_SOUND = mod.RuntimeSpawn_Common.SFX_UI_Shared_Countdown_Tick_Final_OneShot2D;

// Inputs to BLOCK during countdown (allow crouch, prone, zoom for stance/aiming)
const BLOCKED_INPUTS = [
    mod.RestrictedInputs.CycleFire,
    mod.RestrictedInputs.FireWeapon,
    mod.RestrictedInputs.Interact,
    mod.RestrictedInputs.Jump,
    mod.RestrictedInputs.MoveForwardBack,
    mod.RestrictedInputs.MoveLeftRight,
    mod.RestrictedInputs.Reload,
    mod.RestrictedInputs.SelectCharacterGadget,
    mod.RestrictedInputs.SelectMelee,
    mod.RestrictedInputs.SelectOpenGadget,
    mod.RestrictedInputs.SelectThrowable,
    mod.RestrictedInputs.Sprint,
];

export class CountdownUI {
    private _receiver?: mod.Player | mod.Team;
    private _container: UIContainer;

    // Box elements
    private _boxBg: UIContainer;
    private _boxOutline: UIContainer;

    // Number elements
    private _outlineTexts: UIText[] = [];
    private _mainText: UIText;

    // Dash elements (3 on each side)
    private _leftDashes: UIText[] = [];
    private _rightDashes: UIText[] = [];

    // State
    private _animationTimer: number | null = null;
    private _isRunning = false;
    private _frozenPlayers: mod.Player[] = [];
    private _startingPositions: Map<number, mod.Vector> = new Map();
    private _positionEnforcementTimer: number | null = null;
    private _currentLoadout: Loadout | null = null;
    private _team1Positions: mod.Vector[] = [];
    private _team2Positions: mod.Vector[] = [];

    // Track recently relocated bots to prevent rapid re-teleporting
    private _recentlyRelocated: Map<number, number> = new Map(); // botId -> timestamp
    private static readonly RELOCATION_COOLDOWN_MS = 500; // Don't relocate same bot within 500ms

    // Loadout UI
    private _loadoutUI: LoadoutUI;

    // Team Health UIs (one per human player for correct perspective)
    private _teamHealthUIs: Map<number, TeamHealthUI> = new Map();

    // Flag position for player facing direction
    private _flagPosition: mod.Vector | null = null;

    public constructor(receiver?: mod.Player | mod.Team) {
        this._receiver = receiver;

        // Main container
        this._container = new UIContainer({
            anchor: mod.UIAnchor.Center,
            y: POSITION_Y,
            width: 400,
            height: 200,
            visible: false,
            receiver: this._receiver,
            depth: mod.UIDepth.AboveGameUI,
        });

        // Box background (gray, semi-transparent)
        this._boxBg = new UIContainer({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            width: BOX_MIN_SIZE,
            height: BOX_MIN_SIZE,
            bgColor: COLORS.DARK_BG,
            bgAlpha: 0.1,
            bgFill: mod.UIBgFill.Solid,
            visible: false,
        });

        // Box outline (white border)
        this._boxOutline = new UIContainer({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            width: BOX_MIN_SIZE,
            height: BOX_MIN_SIZE,
            bgColor: COLORS.GRAY_OUTLINE,
            bgAlpha: 1,
            bgFill: mod.UIBgFill.OutlineThin,
            visible: false,
        });

        // Number outline texts (black stroke)
        for (const offset of OUTLINE_OFFSETS) {
            const text = new UIText({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: offset.x,
                y: offset.y,
                width: BOX_MAX_SIZE,
                height: BOX_MAX_SIZE,
                message: mod.Message(mod.stringkeys.countdown.n4),
                textSize: NUMBER_SIZE,
                textColor: COLORS.BLACK,
                textAlpha: 0,
                textAnchor: mod.UIAnchor.Center,
                visible: true,
            });
            this._outlineTexts.push(text);
        }

        // Main number text (white)
        this._mainText = new UIText({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            width: BOX_MAX_SIZE,
            height: BOX_MAX_SIZE,
            message: mod.Message(mod.stringkeys.countdown.n4),
            textSize: NUMBER_SIZE,
            textColor: COLORS.WHITE,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Create 3 dashes on each side
        for (let i = 0; i < 3; i++) {
            const xOffset = BOX_MAX_SIZE / 2 + DASH_GAP + i * 12 + 6;

            // Left dash
            const leftDash = new UIText({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: -xOffset,
                y: 0,
                width: 20,
                height: 30,
                message: mod.Message(mod.stringkeys.countdown.dash),
                textSize: 24,
                textColor: COLORS.WHITE,
                textAlpha: 0,
                textAnchor: mod.UIAnchor.Center,
                visible: true,
            });
            this._leftDashes.push(leftDash);

            // Right dash
            const rightDash = new UIText({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: xOffset,
                y: 0,
                width: 20,
                height: 30,
                message: mod.Message(mod.stringkeys.countdown.dash),
                textSize: 24,
                textColor: COLORS.WHITE,
                textAlpha: 0,
                textAnchor: mod.UIAnchor.Center,
                visible: true,
            });
            this._rightDashes.push(rightDash);
        }

        // Create loadout UI
        this._loadoutUI = new LoadoutUI(this._receiver);

        // Team health UIs are created per-player in start()
    }

    public async start(
        startFrom: number = 5,
        team1?: mod.Player[],
        team2?: mod.Player[],
        loadout?: Loadout,
        spawnPositions?: { team1: mod.Vector[]; team2: mod.Vector[] },
        onRoundTimeEnd?: () => void,
        onOvertimeStart?: () => void,
        onCountdownEnd?: () => void
    ): Promise<void> {
        if (this._isRunning) return;

        // Reset debug counters
        _posEnforcementTicks = 0;
        _inputRestrictionCalls = 0;
        _botRelocationChecks = 0;
        _teleportCalls = 0;
        _lastLogTime = Date.now();

        logCountdown('START called', {
            startFrom,
            team1Count: team1?.length ?? 0,
            team2Count: team2?.length ?? 0,
            hasLoadout: !!loadout,
            hasSpawnPositions: !!spawnPositions,
        });

        this._isRunning = true;
        this._container.visible = true;

        // Set spawn mode to auto spawn during countdown
        mod.SetSpawnMode(mod.SpawnModes.AutoSpawn);

        // Combine teams for freezing
        const allPlayers = [...(team1 ?? []), ...(team2 ?? [])];
        this._frozenPlayers =
            allPlayers.length > 0
                ? allPlayers
                : this._receiver && !('GetPlayers' in this._receiver)
                  ? [this._receiver as mod.Player]
                  : [];

        // Create per-player TeamHealthUI instances for correct team perspective
        // Destroy any existing instances first
        for (const ui of this._teamHealthUIs.values()) {
            ui.destroy();
        }
        this._teamHealthUIs.clear();

        // Create TeamHealthUI for each human player
        const playersForUI = [...(team1 || []), ...(team2 || [])];
        for (const player of playersForUI) {
            try {
                if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                    const playerId = mod.GetObjId(player);
                    const ui = new TeamHealthUI(player);
                    ui.setTeams(team1 || [], team2 || []);
                    this._teamHealthUIs.set(playerId, ui);
                }
            } catch {}
        }

        // Store spawn positions for late players
        if (spawnPositions) {
            this._team1Positions = spawnPositions.team1;
            this._team2Positions = spawnPositions.team2;
        }

        // Assign players to spawn positions (humans first, then bots)
        if (spawnPositions && team1 && team2) {
            this._assignPlayersToPositions(team1, spawnPositions.team1);
            this._assignPlayersToPositions(team2, spawnPositions.team2);
        } else {
            this._recordStartingPositions(this._frozenPlayers);
        }

        // Teleport all players to their assigned positions
        this._teleportAllToAssignedPositions();

        // Check if any bots are too close to human players and relocate them
        if (team1 && team2 && spawnPositions) {
            this._relocateBotsIfTooClose(team1, spawnPositions.team1);
            this._relocateBotsIfTooClose(team2, spawnPositions.team2);
        }

        // Restrict players and start position enforcement for bots
        // Apply restrictions immediately
        this._setPlayersRestricted(this._frozenPlayers, true);
        // Apply again after a brief delay to ensure they stick
        Timers.setTimeout(() => {
            this._setPlayersRestricted(this._frozenPlayers, true);
        }, 100);
        this._startPositionEnforcement();

        // Set and apply weapons only (gadgets/throwables given after freeze ends)
        if (loadout) {
            this._currentLoadout = loadout;
            this._loadoutUI.setLoadout(loadout);
            // Apply only weapons to players immediately (no gadgets during freeze)
            for (const player of this._frozenPlayers) {
                LoadoutUI.applyWeaponsToPlayer(player, loadout);
            }
        }

        // Count down from startFrom to 1
        for (let num = startFrom; num >= 1; num--) {
            if (!this._isRunning) break;

            // Show loadout UI at 5 seconds
            if (num === 5 && loadout) {
                this._loadoutUI.fadeIn();
            }

            // Hide loadout UI at 1 second
            if (num === 1 && loadout) {
                this._loadoutUI.fadeOut();
            }

            // Play countdown tick sound at 3, 2, 1
            if (num <= 3 && num >= 1) {
                this._playCountdownTick(num === 1);
            }

            await this._animateNumber(num);
        }

        // Ensure loadout is hidden
        this._loadoutUI.hide();

        // Show team health UI after countdown (all instances)
        for (const ui of this._teamHealthUIs.values()) {
            ui.show();
        }

        // Start 40-second round countdown with overtime callback
        // Only the first instance gets callbacks to avoid duplicate triggers
        let isFirst = true;
        for (const ui of this._teamHealthUIs.values()) {
            if (isFirst) {
                ui.startCountdown(40, onRoundTimeEnd, onOvertimeStart);
                isFirst = false;
            } else {
                ui.startCountdown(40); // No callbacks for other instances
            }
        }

        // Set spawn mode to spectating after countdown
        mod.SetSpawnMode(mod.SpawnModes.Spectating);

        // Stop position enforcement and unfreeze players after countdown
        this._stopPositionEnforcement();
        this._setPlayersRestricted(this._frozenPlayers, false);

        // Call countdown end callback
        onCountdownEnd?.();

        // Play round start sound for all players (SFX at 50% volume)
        for (const player of this._frozenPlayers) {
            try {
                if (mod.IsPlayerValid(player) && !mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                    const sfx = mod.SpawnObject(
                        ROUND_START_SOUND,
                        mod.CreateVector(0, 0, 0),
                        mod.CreateVector(0, 0, 0)
                    );
                    mod.PlaySound(sfx, 0.5, player);
                    Timers.setTimeout(() => {
                        try {
                            mod.StopSound(sfx);
                            mod.UnspawnObject(sfx);
                        } catch {}
                    }, 5000);
                }
            } catch {}
        }

        // Play RoundStartGeneric VO on round 1
        if (getCurrentRoundNumber() === 1) {
            playVO(mod.VoiceOverEvents2D.RoundStartGeneric);
        }

        // Store players and loadout for delayed gadget application
        const playersToGiveGadgets = [...this._frozenPlayers];
        const loadoutToApply = this._currentLoadout;

        this._frozenPlayers = [];
        this._currentLoadout = null;

        // Apply gadgets and throwables after 5 seconds
        if (loadoutToApply) {
            Timers.setTimeout(() => {
                for (const player of playersToGiveGadgets) {
                    try {
                        if (mod.IsPlayerValid(player)) {
                            LoadoutUI.applyGadgetsToPlayer(player, loadoutToApply);
                        }
                    } catch {
                        // Player might be invalid
                    }
                }
            }, 5000);
        }

        this._container.visible = false;
        this._isRunning = false;
    }

    public stop(): void {
        this._clearTimer();
        this._stopPositionEnforcement();
        this._isRunning = false;
        this._container.visible = false;
        this._loadoutUI.hide();

        // Stop countdown and hide all TeamHealthUI instances
        for (const ui of this._teamHealthUIs.values()) {
            ui.stopCountdown();
            ui.hide();
        }

        // Unfreeze any frozen players
        this._setPlayersRestricted(this._frozenPlayers, false);
        this._frozenPlayers = [];
    }

    public destroy(): void {
        this.stop();
        this._loadoutUI.destroy();

        // Destroy all TeamHealthUI instances
        for (const ui of this._teamHealthUIs.values()) {
            ui.destroy();
        }
        this._teamHealthUIs.clear();

        this._container.delete();
    }

    public get isRunning(): boolean {
        return this._isRunning;
    }

    public addLatePlayer(player: mod.Player, loadout: Loadout): void {
        if (!this._isRunning) return;

        // Add to frozen players list
        this._frozenPlayers.push(player);

        // Assign position based on team
        try {
            const playerTeam = mod.GetTeam(player);
            const team1 = mod.GetTeam(1);
            const isTeam1 = mod.GetObjId(playerTeam) === mod.GetObjId(team1);
            const positions = isTeam1 ? this._team1Positions : this._team2Positions;
            const playerId = mod.GetObjId(player);

            if (positions.length > 0) {
                // Find a position not already assigned to another player on this team
                const usedPositions = new Set<number>();
                for (const [, pos] of this._startingPositions) {
                    for (let i = 0; i < positions.length; i++) {
                        const p = positions[i];
                        if (
                            mod.XComponentOf(p) === mod.XComponentOf(pos) &&
                            mod.YComponentOf(p) === mod.YComponentOf(pos) &&
                            mod.ZComponentOf(p) === mod.ZComponentOf(pos)
                        ) {
                            usedPositions.add(i);
                        }
                    }
                }

                // Find unused position or cycle
                let posIndex = 0;
                for (let i = 0; i < positions.length; i++) {
                    if (!usedPositions.has(i)) {
                        posIndex = i;
                        break;
                    }
                }

                const pos = positions[posIndex];
                this._startingPositions.set(playerId, pos);
                const facingAngle = this._getFacingAngleToFlag(pos);
                mod.Teleport(player, pos, facingAngle);

                // Check if any teammates are too close and relocate them to the other position
                this._relocateTeammatesFromPosition(player, pos, positions);

                // Re-teleport after delay to ensure facing direction sticks
                Timers.setTimeout(() => {
                    try {
                        if (mod.IsPlayerValid(player)) {
                            mod.Teleport(player, pos, facingAngle);
                        }
                    } catch {}
                }, 100);
            }
        } catch {
            // Player might be invalid
        }

        // Apply restrictions
        this._setPlayersRestricted([player], true);

        // Apply weapons only (gadgets given when countdown ends)
        LoadoutUI.applyWeaponsToPlayer(player, loadout);

        // LATE-JOINER FIX: give them their own TeamHealthUI (previously missing — a
        // countdown joiner played the whole round with no health bars/round timer).
        // Rosters are fetched dynamically by the UI, and the show()/startCountdown(40)
        // loops at countdown end iterate the map, so this instance is fully wired in.
        try {
            const lateId = mod.GetObjId(player);
            if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier) && !this._teamHealthUIs.has(lateId)) {
                const ui = new TeamHealthUI(player);
                ui.setTeams([], []); // args unused (dynamic rosters); triggers local-team color detect
                this._teamHealthUIs.set(lateId, ui);
            }
        } catch {}
    }

    public freezeAllPlayers(players: mod.Player[]): void {
        this._setPlayersRestricted(players, true);
    }

    public unfreezeAllPlayers(players: mod.Player[]): void {
        this._setPlayersRestricted(players, false);
    }

    private async _animateNumber(num: number): Promise<void> {
        if (!this._isRunning) return;

        // Set number text
        const stringKey = this._getNumberStringKey(num);
        this._mainText.message = mod.Message(stringKey);
        this._outlineTexts.forEach((t) => (t.message = mod.Message(stringKey)));

        // Reset state
        this._resetForNumber();

        // Phase 1: Box grows from small to full size
        await this._growBox();
        if (!this._isRunning) return;

        // Phase 2: Number fades in
        await this._fadeInNumber();
        if (!this._isRunning) return;

        // Phase 3: Dashes appear one by one
        await this._showDashes();
        if (!this._isRunning) return;

        // Phase 4: Box background fades out (while number and dashes stay visible)
        await this._fadeBgOnly();
        if (!this._isRunning) return;

        // Phase 5: Instantly hide everything (no fade)
        this._hideAll();
    }

    private _resetForNumber(): void {
        // Reset box to small size
        this._boxBg.width = BOX_MIN_SIZE;
        this._boxBg.height = BOX_MIN_SIZE;
        this._boxOutline.width = BOX_MIN_SIZE;
        this._boxOutline.height = BOX_MIN_SIZE;
        this._boxBg.bgAlpha = 0.1;
        this._boxOutline.bgAlpha = 1;
        this._boxBg.visible = true;
        this._boxOutline.visible = true;

        // Hide number
        this._setTextAlpha(0);

        // Hide dashes
        this._leftDashes.forEach((d) => (d.textAlpha = 0));
        this._rightDashes.forEach((d) => (d.textAlpha = 0));
    }

    private async _growBox(): Promise<void> {
        return new Promise<void>((resolve) => {
            let elapsed = 0;

            this._animationTimer = Timers.setInterval(() => {
                if (!this._isRunning) {
                    this._clearTimer();
                    resolve();
                    return;
                }

                elapsed += ANIMATION_TICK;
                const progress = Math.min(elapsed / BOX_GROW_DURATION, 1);

                // Ease out cubic for snappy grow
                const eased = 1 - Math.pow(1 - progress, 3);
                const size = BOX_MIN_SIZE + (BOX_MAX_SIZE - BOX_MIN_SIZE) * eased;

                this._boxBg.width = size;
                this._boxBg.height = size;
                this._boxOutline.width = size;
                this._boxOutline.height = size;

                if (progress >= 1) {
                    this._clearTimer();
                    resolve();
                }
            }, ANIMATION_TICK);
        });
    }

    private async _fadeInNumber(): Promise<void> {
        return new Promise<void>((resolve) => {
            let elapsed = 0;

            this._animationTimer = Timers.setInterval(() => {
                if (!this._isRunning) {
                    this._clearTimer();
                    resolve();
                    return;
                }

                elapsed += ANIMATION_TICK;
                const progress = Math.min(elapsed / NUMBER_FADE_IN_DURATION, 1);

                this._setTextAlpha(progress);

                if (progress >= 1) {
                    this._clearTimer();
                    resolve();
                }
            }, ANIMATION_TICK);
        });
    }

    private async _showDashes(): Promise<void> {
        // Show dashes one by one
        for (let i = 0; i < 3; i++) {
            if (!this._isRunning) return;

            // Show this dash (from inside out, so index 0 is closest to number)
            this._leftDashes[i].textAlpha = 1;
            this._rightDashes[i].textAlpha = 1;

            await this._wait(DASH_INTERVAL);
        }
    }

    private async _fadeBgOnly(): Promise<void> {
        return new Promise<void>((resolve) => {
            let elapsed = 0;

            this._animationTimer = Timers.setInterval(() => {
                if (!this._isRunning) {
                    this._clearTimer();
                    resolve();
                    return;
                }

                elapsed += ANIMATION_TICK;
                const progress = Math.min(elapsed / BG_FADE_DURATION, 1);

                // Fade background and outline
                this._boxBg.bgAlpha = 0.1 * (1 - progress);
                this._boxOutline.bgAlpha = 1 - progress;

                if (progress >= 1) {
                    this._boxBg.visible = false;
                    this._boxOutline.visible = false;
                    this._clearTimer();
                    resolve();
                }
            }, ANIMATION_TICK);
        });
    }

    private _hideAll(): void {
        // Instantly hide number
        this._setTextAlpha(0);

        // Instantly hide dashes
        this._leftDashes.forEach((d) => (d.textAlpha = 0));
        this._rightDashes.forEach((d) => (d.textAlpha = 0));
    }

    private _setTextAlpha(alpha: number): void {
        this._mainText.textAlpha = alpha;
        this._outlineTexts.forEach((t) => (t.textAlpha = alpha));
    }

    private _playCountdownTick(isFinal: boolean): void {
        const sound = isFinal ? COUNTDOWN_FINAL_SOUND : COUNTDOWN_TICK_SOUND;
        for (const player of this._frozenPlayers) {
            try {
                if (mod.IsPlayerValid(player) && !mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                    const sfx = mod.SpawnObject(sound, mod.CreateVector(0, 0, 0), mod.CreateVector(0, 0, 0));
                    mod.PlaySound(sfx, 0.7, player);
                    Timers.setTimeout(() => {
                        try {
                            mod.StopSound(sfx);
                            mod.UnspawnObject(sfx);
                        } catch {}
                    }, 1000);
                }
            } catch {}
        }
    }

    private _clearTimer(): void {
        if (this._animationTimer !== null) {
            Timers.clearInterval(this._animationTimer);
            this._animationTimer = null;
        }
    }

    private async _wait(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            Timers.setTimeout(() => resolve(), ms);
        });
    }

    private _getNumberStringKey(num: number): mod.Any {
        switch (num) {
            case 15:
                return mod.stringkeys.countdown.n15;
            case 14:
                return mod.stringkeys.countdown.n14;
            case 13:
                return mod.stringkeys.countdown.n13;
            case 12:
                return mod.stringkeys.countdown.n12;
            case 11:
                return mod.stringkeys.countdown.n11;
            case 10:
                return mod.stringkeys.countdown.n10;
            case 9:
                return mod.stringkeys.countdown.n9;
            case 8:
                return mod.stringkeys.countdown.n8;
            case 7:
                return mod.stringkeys.countdown.n7;
            case 6:
                return mod.stringkeys.countdown.n6;
            case 5:
                return mod.stringkeys.countdown.n5;
            case 4:
                return mod.stringkeys.countdown.n4;
            case 3:
                return mod.stringkeys.countdown.n3;
            case 2:
                return mod.stringkeys.countdown.n2;
            case 1:
                return mod.stringkeys.countdown.n1;
            default:
                return mod.stringkeys.countdown.n1;
        }
    }

    private _setPlayersRestricted(players: mod.Player[], restrict: boolean): void {
        logCountdown(`setPlayersRestricted called`, { playerCount: players.length, restrict });
        for (const player of players) {
            try {
                const isAI = mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier);

                if (isAI) {
                    // For AI players: control their behavior
                    if (restrict) {
                        // Set stance to stand before freezing
                        mod.AISetStance(player, mod.Stance.Stand);
                        // Make AI idle (stop moving)
                        mod.AIIdleBehavior(player);
                        // Disable shooting and targeting
                        mod.AIEnableShooting(player, false);
                        mod.AIEnableTargeting(player, false);
                    } else {
                        // Restore normal AI behavior
                        mod.AIBattlefieldBehavior(player);
                        mod.AIEnableShooting(player, true);
                        mod.AIEnableTargeting(player, true);
                    }
                } else {
                    // For human players: explicitly set each blocked input
                    // This is more reliable than EnableAllInputRestrictions
                    for (const input of BLOCKED_INPUTS) {
                        mod.EnableInputRestriction(player, input, restrict);
                    }
                }
            } catch (e) {
                // Player might be invalid
            }
        }
    }

    private _recordStartingPositions(players: mod.Player[]): void {
        this._startingPositions.clear();
        for (const player of players) {
            try {
                const pos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
                this._startingPositions.set(mod.GetObjId(player), pos);
            } catch {
                // Player might be invalid
            }
        }
    }

    private _assignPlayersToPositions(players: mod.Player[], positions: mod.Vector[]): void {
        if (positions.length === 0 || players.length === 0) return;

        // Track used position indices and assigned positions for distance checks
        const usedPositionIndices = new Set<number>();
        const assignedPositions: mod.Vector[] = [];

        // Separate humans and bots - humans get priority
        const humans: mod.Player[] = [];
        const bots: mod.Player[] = [];

        for (const player of players) {
            try {
                if (mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                    bots.push(player);
                } else {
                    humans.push(player);
                }
            } catch {}
        }

        // Assign all players (humans first, then bots)
        const orderedPlayers = [...humans, ...bots];

        for (const player of orderedPlayers) {
            let bestPosIndex = -1;
            let bestMinDistance = -1;

            // Find position with maximum minimum distance from all already assigned positions
            for (let i = 0; i < positions.length; i++) {
                if (usedPositionIndices.has(i)) continue;

                const pos = positions[i];
                let minDistToOthers = Infinity;

                // Check distance to all already assigned positions
                for (const assignedPos of assignedPositions) {
                    const dist = mod.DistanceBetween(pos, assignedPos);
                    if (dist < minDistToOthers) {
                        minDistToOthers = dist;
                    }
                }

                // First player or position furthest from others
                if (assignedPositions.length === 0 || minDistToOthers > bestMinDistance) {
                    bestMinDistance = minDistToOthers;
                    bestPosIndex = i;
                }
            }

            // If all positions used, find position furthest from assigned ones
            if (bestPosIndex === -1) {
                bestMinDistance = -1;
                for (let i = 0; i < positions.length; i++) {
                    const pos = positions[i];
                    let minDistToOthers = Infinity;

                    for (const assignedPos of assignedPositions) {
                        const dist = mod.DistanceBetween(pos, assignedPos);
                        if (dist < minDistToOthers) {
                            minDistToOthers = dist;
                        }
                    }

                    if (minDistToOthers > bestMinDistance) {
                        bestMinDistance = minDistToOthers;
                        bestPosIndex = i;
                    }
                }
            }

            if (bestPosIndex !== -1) {
                usedPositionIndices.add(bestPosIndex);
                const pos = positions[bestPosIndex];
                this._startingPositions.set(mod.GetObjId(player), pos);
                assignedPositions.push(pos);
            }
        }
    }

    private _teleportAllToAssignedPositions(): void {
        logCountdown('teleportAllToAssignedPositions', { playerCount: this._frozenPlayers.length });
        for (const player of this._frozenPlayers) {
            _teleportCalls++;
            try {
                // Check if player is deployed before teleporting
                const isDeployed =
                    mod.GetSoldierState(player, mod.SoldierStateBool.IsManDown) !== undefined ||
                    mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive);
                if (!isDeployed) continue;

                const playerId = mod.GetObjId(player);
                const pos = this._startingPositions.get(playerId);
                if (pos) {
                    const facingAngle = this._getFacingAngleToFlag(pos);
                    mod.Teleport(player, pos, facingAngle);
                    // Re-teleport after delay to ensure facing direction sticks
                    Timers.setTimeout(() => {
                        try {
                            if (mod.IsPlayerValid(player)) {
                                mod.Teleport(player, pos, facingAngle);
                            }
                        } catch {}
                    }, 100);
                }
            } catch {
                // Player might be invalid or not deployed
            }
        }
    }

    /**
     * Relocate any teammates that are too close to a given position
     * Used when a player deploys on a spawn point to move existing teammates away
     */
    private _relocateTeammatesFromPosition(
        deployedPlayer: mod.Player,
        deployedPosition: mod.Vector,
        teamPositions: mod.Vector[]
    ): void {
        const MIN_DISTANCE = 0.5; // 1 meter
        const deployedPlayerId = mod.GetObjId(deployedPlayer);

        // Find all teammates
        for (const frozenPlayer of this._frozenPlayers) {
            try {
                const frozenPlayerId = mod.GetObjId(frozenPlayer);
                if (frozenPlayerId === deployedPlayerId) continue; // Skip self

                // Check if same team
                const deployedTeam = mod.GetTeam(deployedPlayer);
                const frozenTeam = mod.GetTeam(frozenPlayer);
                if (mod.GetObjId(deployedTeam) !== mod.GetObjId(frozenTeam)) continue; // Different team

                // Check distance to deployed position
                const frozenPos = mod.GetSoldierState(frozenPlayer, mod.SoldierStateVector.GetPosition);
                const distance = mod.DistanceBetween(frozenPos, deployedPosition);

                if (distance < MIN_DISTANCE) {
                    // Find an alternate position that's not the deployed position
                    for (const altPos of teamPositions) {
                        const distToDeployed = mod.DistanceBetween(altPos, deployedPosition);
                        if (distToDeployed >= MIN_DISTANCE) {
                            // Teleport teammate to alternate position
                            const facingAngle = this._getFacingAngleToFlag(altPos);
                            mod.Teleport(frozenPlayer, altPos, facingAngle);
                            this._startingPositions.set(frozenPlayerId, altPos);

                            // Re-teleport after delay
                            Timers.setTimeout(() => {
                                try {
                                    if (mod.IsPlayerValid(frozenPlayer)) {
                                        mod.Teleport(frozenPlayer, altPos, facingAngle);
                                    }
                                } catch {}
                            }, 100);
                            break;
                        }
                    }
                }
            } catch {}
        }
    }

    /**
     * Check if any bots on a team are within 1 meter of another player and relocate them
     */
    private _relocateBotsIfTooClose(teamPlayers: mod.Player[], teamPositions: mod.Vector[]): void {
        const MIN_DISTANCE = 0.5; // 1 meter

        // Separate humans and bots on this team
        const bots: mod.Player[] = [];
        const allPlayerPositions: { pos: mod.Vector; playerId: number }[] = [];

        for (const player of teamPlayers) {
            try {
                const pos = mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
                const playerId = mod.GetObjId(player);
                allPlayerPositions.push({ pos, playerId });

                if (mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                    bots.push(player);
                }
            } catch {}
        }

        // No bots = nothing to relocate
        if (bots.length === 0) return;

        // Check each bot
        for (const bot of bots) {
            try {
                const botId = mod.GetObjId(bot);
                const botPos = mod.GetSoldierState(bot, mod.SoldierStateVector.GetPosition);

                // Check distance to all other players
                let tooClose = false;
                for (const { pos: otherPos, playerId } of allPlayerPositions) {
                    if (playerId === botId) continue; // Skip self
                    const distance = mod.DistanceBetween(botPos, otherPos);
                    if (distance < MIN_DISTANCE) {
                        tooClose = true;
                        break;
                    }
                }

                if (tooClose) {
                    // Find an alternate spawn position that's not too close to any player
                    for (const altPos of teamPositions) {
                        let positionIsSafe = true;
                        for (const { pos: otherPos, playerId } of allPlayerPositions) {
                            if (playerId === botId) continue; // Skip self
                            if (mod.DistanceBetween(altPos, otherPos) < MIN_DISTANCE) {
                                positionIsSafe = false;
                                break;
                            }
                        }

                        // Also check it's different from current bot position
                        if (positionIsSafe && mod.DistanceBetween(altPos, botPos) > MIN_DISTANCE) {
                            // Teleport bot to this alternate position
                            const facingAngle = this._getFacingAngleToFlag(altPos);
                            mod.Teleport(bot, altPos, facingAngle);
                            // Update stored position
                            this._startingPositions.set(botId, altPos);
                            // Mark as recently relocated to prevent rapid re-teleporting
                            this._recentlyRelocated.set(botId, Date.now());
                            break;
                        }
                    }
                }
            } catch {}
        }
    }

    private _startPositionEnforcement(): void {
        logCountdown('Starting position enforcement loop (50ms interval)');
        // Continuously enforce restrictions every tick
        this._positionEnforcementTimer = Timers.setInterval(() => {
            _posEnforcementTicks++;

            // Separate humans and bots
            const humans: mod.Player[] = [];
            const bots: mod.Player[] = [];

            for (const player of this._frozenPlayers) {
                try {
                    const isAI = mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier);

                    if (isAI) {
                        bots.push(player);
                        // For bots: enforce idle behavior
                        mod.AIIdleBehavior(player);
                        mod.AIEnableShooting(player, false);
                        mod.AIEnableTargeting(player, false);
                    } else {
                        humans.push(player);
                        // For humans: continuously re-apply input restrictions
                        for (const input of BLOCKED_INPUTS) {
                            mod.EnableInputRestriction(player, input, true);
                            _inputRestrictionCalls++;
                        }
                    }
                } catch {
                    // Player might be invalid
                }
            }

            // Log every 1 second (20 ticks at 50ms)
            if (_posEnforcementTicks % 20 === 0) {
                const elapsed = (Date.now() - _lastLogTime) / 1000;
                logCountdown(`POS ENFORCEMENT STATS (${elapsed.toFixed(1)}s):`, {
                    ticks: _posEnforcementTicks,
                    inputRestrictionCalls: _inputRestrictionCalls,
                    botRelocationChecks: _botRelocationChecks,
                    teleportCalls: _teleportCalls,
                    frozenPlayers: this._frozenPlayers.length,
                    humans: humans.length,
                    bots: bots.length,
                });
            }

            // Check if any players are too close and relocate bots
            this._checkAndRelocatePlayers(humans, bots);
        }, 50);
    }

    /**
     * Check if any bots are within 1 meter of other players and relocate them
     */
    private _checkAndRelocatePlayers(humans: mod.Player[], bots: mod.Player[]): void {
        const MIN_DISTANCE = 0.5;
        _botRelocationChecks++;

        if (bots.length === 0) return;

        // Get all player positions (humans and bots)
        const allPlayerPositions: { pos: mod.Vector; teamId: number; playerId: number }[] = [];

        for (const human of humans) {
            try {
                const pos = mod.GetSoldierState(human, mod.SoldierStateVector.GetPosition);
                const playerTeam = mod.GetTeam(human);
                const team1 = mod.GetTeam(1);
                const teamId = mod.GetObjId(playerTeam) === mod.GetObjId(team1) ? 1 : 2;
                allPlayerPositions.push({ pos, teamId, playerId: mod.GetObjId(human) });
            } catch {}
        }

        for (const bot of bots) {
            try {
                const pos = mod.GetSoldierState(bot, mod.SoldierStateVector.GetPosition);
                const playerTeam = mod.GetTeam(bot);
                const team1 = mod.GetTeam(1);
                const teamId = mod.GetObjId(playerTeam) === mod.GetObjId(team1) ? 1 : 2;
                allPlayerPositions.push({ pos, teamId, playerId: mod.GetObjId(bot) });
            } catch {}
        }

        // Check each bot against all other players
        const now = Date.now();
        for (const bot of bots) {
            try {
                const botId = mod.GetObjId(bot);

                // Skip if this bot was recently relocated (prevents rapid back-and-forth)
                const lastRelocation = this._recentlyRelocated.get(botId);
                if (lastRelocation && now - lastRelocation < CountdownUI.RELOCATION_COOLDOWN_MS) {
                    continue;
                }

                const botPos = mod.GetSoldierState(bot, mod.SoldierStateVector.GetPosition);
                const botTeam = mod.GetTeam(bot);
                const team1 = mod.GetTeam(1);
                const botTeamId = mod.GetObjId(botTeam) === mod.GetObjId(team1) ? 1 : 2;

                // Check distance to all other players on same team
                let tooClose = false;
                for (const { pos: otherPos, teamId, playerId } of allPlayerPositions) {
                    if (playerId === botId) continue; // Skip self
                    if (teamId === botTeamId) {
                        const distance = mod.DistanceBetween(botPos, otherPos);
                        if (distance < MIN_DISTANCE) {
                            tooClose = true;
                            break;
                        }
                    }
                }

                if (tooClose) {
                    // Get team positions
                    const teamPositions = botTeamId === 1 ? this._team1Positions : this._team2Positions;

                    // Find an alternate spawn position
                    for (const altPos of teamPositions) {
                        let positionIsSafe = true;

                        // Check distance from all players on same team
                        for (const { pos: otherPos, teamId, playerId } of allPlayerPositions) {
                            if (playerId === botId) continue; // Skip self
                            if (teamId === botTeamId && mod.DistanceBetween(altPos, otherPos) < MIN_DISTANCE) {
                                positionIsSafe = false;
                                break;
                            }
                        }

                        // Also check it's different from current bot position
                        if (positionIsSafe && mod.DistanceBetween(altPos, botPos) > MIN_DISTANCE) {
                            const facingAngle = this._getFacingAngleToFlag(altPos);
                            mod.Teleport(bot, altPos, facingAngle);
                            this._startingPositions.set(botId, altPos);
                            // Mark as recently relocated
                            this._recentlyRelocated.set(botId, now);
                            break;
                        }
                    }
                }
            } catch {}
        }
    }

    private _stopPositionEnforcement(): void {
        if (this._positionEnforcementTimer !== null) {
            logCountdown('STOPPING position enforcement', {
                totalTicks: _posEnforcementTicks,
                totalInputRestrictionCalls: _inputRestrictionCalls,
                totalBotRelocationChecks: _botRelocationChecks,
                totalTeleportCalls: _teleportCalls,
                durationMs: Date.now() - _lastLogTime,
            });
            Timers.clearInterval(this._positionEnforcementTimer);
            this._positionEnforcementTimer = null;
        }
        // Clear relocation tracking
        this._recentlyRelocated.clear();
    }

    public getStartingPositions(): Map<number, mod.Vector> {
        return this._startingPositions;
    }

    public teleportAllToStart(): void {
        for (const [playerId, pos] of this._startingPositions) {
            try {
                // Find player by ID and teleport
                const allPlayers = mod.AllPlayers();
                const count = mod.CountOf(allPlayers);
                for (let i = 0; i < count; i++) {
                    const player = mod.ValueInArray(allPlayers, i) as mod.Player;
                    if (mod.GetObjId(player) === playerId) {
                        const facingAngle = this._getFacingAngleToFlag(pos);
                        mod.Teleport(player, pos, facingAngle);
                        // Re-teleport after delay to ensure facing direction sticks
                        Timers.setTimeout(() => {
                            try {
                                if (mod.IsPlayerValid(player)) {
                                    mod.Teleport(player, pos, facingAngle);
                                }
                            } catch {}
                        }, 100);
                        break;
                    }
                }
            } catch {
                // Player might be invalid
            }
        }
    }

    public getTeamHealthUI(): TeamHealthUI | undefined {
        // Return the first instance for backward compatibility
        // Used for pause/resume - these methods should be called via pauseAllCountdowns/resumeAllCountdowns
        for (const ui of this._teamHealthUIs.values()) {
            return ui;
        }
        return undefined;
    }

    public pauseAllCountdowns(): void {
        for (const ui of this._teamHealthUIs.values()) {
            ui.pauseCountdown();
        }
    }

    public resumeAllCountdowns(): void {
        for (const ui of this._teamHealthUIs.values()) {
            ui.resumeCountdown();
        }
    }

    /**
     * Set the flag position for player facing direction
     */
    public setFlagPosition(position: mod.Vector | null): void {
        this._flagPosition = position;
    }

    /**
     * Calculate the angle (in radians) to face from one position toward another
     * Based on lookAtYaw from AcePursuit mod
     */
    private _calculateFacingAngle(fromPos: mod.Vector, toPos: mod.Vector): number {
        const dx = mod.XComponentOf(toPos) - mod.XComponentOf(fromPos);
        const dz = mod.ZComponentOf(toPos) - mod.ZComponentOf(fromPos);
        return Math.atan2(dx, dz); // radians
    }

    /**
     * Get the facing angle toward the flag from a given position
     * Returns 0 if no flag position is set
     */
    private _getFacingAngleToFlag(fromPos: mod.Vector): number {
        if (!this._flagPosition) return 0;
        return this._calculateFacingAngle(fromPos, this._flagPosition);
    }
}
