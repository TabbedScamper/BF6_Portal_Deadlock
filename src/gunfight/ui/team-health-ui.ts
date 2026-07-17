import { Timers } from 'bf6-portal-utils/timers/index.ts';
import { UIContainer } from 'bf6-portal-utils/ui/components/container/index.ts';
import { UIText } from 'bf6-portal-utils/ui/components/text/index.ts';
import { getPlayersOnTeam, rejectedPlayerIds } from '../../helpers/index.ts';
import { playVO } from '../../index.ts';
import { PLAYERS_PER_TEAM } from '../../config.ts';
import { getScores } from './round-result-ui.ts';

// ========== DEBUG LOGGING ==========
const DEBUG_TEAM_HEALTH = false;
let _healthUpdateTicks = 0;
let _countdownTicks = 0;
let _playerHealthChecks = 0;
let _uiPropertyUpdates = 0;
let _lastHealthLogTime = 0;

function logHealth(msg: string, ...args: any[]): void {
    if (DEBUG_TEAM_HEALTH) console.log(`[TeamHealthUI] ${msg}`, ...args);
}
// ===================================

// Countdown tick sounds (for 3, 2, 1 in overtime)
const OVERTIME_TICK_SOUND = mod.RuntimeSpawn_Common.SFX_UI_Shared_Countdown_Tick_OneShot2D;
const OVERTIME_FINAL_SOUND = mod.RuntimeSpawn_Common.SFX_UI_Shared_Countdown_Tick_Final_OneShot2D;

// Colors
const TEAM_HEALTH_COLORS = {
    BLUE: mod.CreateVector(0.2, 0.8, 1),
    RED: mod.CreateVector(1, 0.3, 0.3),
    WHITE: mod.CreateVector(1, 1, 1),
    DARK_BG: mod.CreateVector(0.15, 0.15, 0.15),
    BLACK: mod.CreateVector(0.1, 0.1, 0.1),
};

// Score tick marks
const SCORE_TICK_COUNT = 6; // Wins needed to win match
const SCORE_TICK_WIDTH = 20;
const SCORE_TICK_HEIGHT = 4;
const SCORE_TICK_GAP = 4;
const SCORE_TICK_Y = 22; // Below health bars

// UI sizing
const TEAM_BAR_WIDTH = 180;
const TEAM_BAR_HEIGHT = 8;
const TEAM_UI_Y = 70;
const TEAM_UI_GAP = 80; // Gap between bars for status text

// Health per player
const HEALTH_PER_PLAYER = 100;

export class TeamHealthUI {
    private _container: UIContainer;
    private _isVisible = false;
    private _updateInterval: number | null = null;

    // Left team (blue - player's team)
    private _leftBarBg: UIContainer;
    private _leftBarFill: UIContainer;
    private _leftHealthTexts: UIText[] = []; // 3 digits
    private _leftIcons: UIText;

    // Right team (red - enemy team)
    private _rightBarBg: UIContainer;
    private _rightBarFill: UIContainer;
    private _rightHealthTexts: UIText[] = []; // 3 digits
    private _rightIcons: UIText;

    // Center status
    private _statusText: UIText;
    private _countdownTexts: UIText[] = []; // 5 elements: S S : m m
    private _countdownInterval: number | null = null;
    private _countdownMs = 0; // Total milliseconds remaining
    private _onCountdownEnd: (() => void) | null = null;
    private _onOvertimeStart: (() => void) | null = null;
    private _isOvertime = false; // True when in 10-second overtime (red timer)
    private _isPaused = false; // True when countdown is paused (flag capture)
    private _lastBeepSecond = -1; // Track last second we played a beep for

    // Score tick marks
    private _leftTicks: UIContainer[] = [];
    private _rightTicks: UIContainer[] = [];

    // Team tracking
    private _maxHealthPerTeam = 200;
    private _localPlayerTeam: number = 1; // 1 or 2, determines color assignment
    private _receiver?: mod.Player; // The player this UI is for (determines team perspective)

    public constructor(receiver?: mod.Player) {
        this._receiver = receiver;
        // Main container at top center
        this._container = new UIContainer({
            anchor: mod.UIAnchor.TopCenter,
            y: TEAM_UI_Y,
            width: 600,
            height: 50,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.None,
            visible: false,
            depth: mod.UIDepth.AboveGameUI,
            receiver: this._receiver, // Show only to this player if specified
        });

        // === LEFT SIDE (Blue team) ===
        // Player icons (dots) - inner side, above bar
        this._leftIcons = new UIText({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            x: -(TEAM_UI_GAP / 2 + 25),
            y: -8,
            width: 80, // Wide enough for 4 dots
            height: 25,
            message: mod.Message(this._getIconsStringKey(PLAYERS_PER_TEAM, PLAYERS_PER_TEAM)),
            textSize: 16,
            textColor: TEAM_HEALTH_COLORS.BLUE,
            textAlpha: 1,
            textAnchor: mod.UIAnchor.CenterRight,
            visible: true,
        });

        // Health bar background
        this._leftBarBg = new UIContainer({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            x: -(TEAM_BAR_WIDTH / 2 + TEAM_UI_GAP / 2),
            y: 8,
            width: TEAM_BAR_WIDTH,
            height: TEAM_BAR_HEIGHT,
            bgColor: TEAM_HEALTH_COLORS.DARK_BG,
            bgAlpha: 0.8,
            bgFill: mod.UIBgFill.Solid,
            visible: true,
        });

        // Health bar fill (position adjusted in _updateHealth to shrink toward center)
        this._leftBarFill = new UIContainer({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            x: -(TEAM_BAR_WIDTH / 2 + TEAM_UI_GAP / 2),
            y: 8,
            width: TEAM_BAR_WIDTH,
            height: TEAM_BAR_HEIGHT,
            bgColor: TEAM_HEALTH_COLORS.BLUE,
            bgAlpha: 1,
            bgFill: mod.UIBgFill.Solid,
            visible: true,
        });

        // Health number (3 digit texts) - above the outer end of bar
        // Mirror the right side positioning: start at outer edge + 8px offset
        for (let i = 0; i < 3; i++) {
            const digitText = new UIText({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: -(TEAM_BAR_WIDTH + TEAM_UI_GAP / 2) + 8 + i * 18,
                y: -10,
                width: 24,
                height: 30,
                message: mod.Message(mod.stringkeys.logger.chars['0']),
                textSize: 26,
                textColor: TEAM_HEALTH_COLORS.WHITE,
                textAlpha: 1,
                textAnchor: mod.UIAnchor.Center,
                visible: true,
            });
            this._leftHealthTexts.push(digitText);
        }

        // === CENTER STATUS ===
        this._statusText = new UIText({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            x: 0,
            y: -8,
            width: TEAM_UI_GAP,
            height: 25,
            message: mod.Message(mod.stringkeys.gunfight.health.tied),
            textSize: 14,
            textColor: TEAM_HEALTH_COLORS.WHITE,
            textAlpha: 1,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Countdown timer below status (5 characters: SS:mm)
        const countdownY = 18;
        const digitWidth = 10;
        const colonWidth = 6;
        const totalWidth = digitWidth * 4 + colonWidth;
        const startX = -totalWidth / 2;

        // Seconds digit 1
        this._countdownTexts.push(
            new UIText({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: startX + digitWidth * 0.5,
                y: countdownY,
                width: digitWidth,
                height: 25,
                message: mod.Message(mod.stringkeys.logger.chars['0']),
                textSize: 16,
                textColor: TEAM_HEALTH_COLORS.WHITE,
                textAlpha: 0.8,
                textAnchor: mod.UIAnchor.Center,
                visible: true,
            })
        );

        // Seconds digit 2
        this._countdownTexts.push(
            new UIText({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: startX + digitWidth * 1.5,
                y: countdownY,
                width: digitWidth,
                height: 25,
                message: mod.Message(mod.stringkeys.logger.chars['0']),
                textSize: 16,
                textColor: TEAM_HEALTH_COLORS.WHITE,
                textAlpha: 0.8,
                textAnchor: mod.UIAnchor.Center,
                visible: true,
            })
        );

        // Colon
        this._countdownTexts.push(
            new UIText({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: startX + digitWidth * 2 + colonWidth * 0.5,
                y: countdownY,
                width: colonWidth,
                height: 25,
                message: mod.Message(mod.stringkeys.gunfight.countdown.colon),
                textSize: 16,
                textColor: TEAM_HEALTH_COLORS.WHITE,
                textAlpha: 0.8,
                textAnchor: mod.UIAnchor.Center,
                visible: true,
            })
        );

        // Centiseconds digit 1
        this._countdownTexts.push(
            new UIText({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: startX + digitWidth * 2 + colonWidth + digitWidth * 0.5,
                y: countdownY,
                width: digitWidth,
                height: 25,
                message: mod.Message(mod.stringkeys.logger.chars['0']),
                textSize: 16,
                textColor: TEAM_HEALTH_COLORS.WHITE,
                textAlpha: 0.8,
                textAnchor: mod.UIAnchor.Center,
                visible: true,
            })
        );

        // Centiseconds digit 2
        this._countdownTexts.push(
            new UIText({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: startX + digitWidth * 2 + colonWidth + digitWidth * 1.5,
                y: countdownY,
                width: digitWidth,
                height: 25,
                message: mod.Message(mod.stringkeys.logger.chars['0']),
                textSize: 16,
                textColor: TEAM_HEALTH_COLORS.WHITE,
                textAlpha: 0.8,
                textAnchor: mod.UIAnchor.Center,
                visible: true,
            })
        );

        // === RIGHT SIDE (Red team) ===
        // Player icons (dots) - inner side, above bar
        this._rightIcons = new UIText({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            x: TEAM_UI_GAP / 2 + 25,
            y: -8,
            width: 80, // Wide enough for 4 dots
            height: 25,
            message: mod.Message(this._getIconsStringKey(PLAYERS_PER_TEAM, PLAYERS_PER_TEAM)),
            textSize: 16,
            textColor: TEAM_HEALTH_COLORS.RED,
            textAlpha: 1,
            textAnchor: mod.UIAnchor.CenterLeft,
            visible: true,
        });

        // Health bar background
        this._rightBarBg = new UIContainer({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            x: TEAM_BAR_WIDTH / 2 + TEAM_UI_GAP / 2,
            y: 8,
            width: TEAM_BAR_WIDTH,
            height: TEAM_BAR_HEIGHT,
            bgColor: TEAM_HEALTH_COLORS.DARK_BG,
            bgAlpha: 0.8,
            bgFill: mod.UIBgFill.Solid,
            visible: true,
        });

        // Health bar fill (position adjusted in _updateHealth to shrink toward center)
        this._rightBarFill = new UIContainer({
            parent: this._container,
            anchor: mod.UIAnchor.Center,
            x: TEAM_BAR_WIDTH / 2 + TEAM_UI_GAP / 2,
            y: 8,
            width: TEAM_BAR_WIDTH,
            height: TEAM_BAR_HEIGHT,
            bgColor: TEAM_HEALTH_COLORS.RED,
            bgAlpha: 1,
            bgFill: mod.UIBgFill.Solid,
            visible: true,
        });

        // Health number (3 digit texts) - above the outer end of bar
        for (let i = 0; i < 3; i++) {
            const digitText = new UIText({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: TEAM_BAR_WIDTH + TEAM_UI_GAP / 2 - 44 + i * 18,
                y: -10,
                width: 24,
                height: 30,
                message: mod.Message(mod.stringkeys.logger.chars['0']),
                textSize: 26,
                textColor: TEAM_HEALTH_COLORS.WHITE,
                textAlpha: 1,
                textAnchor: mod.UIAnchor.Center,
                visible: true,
            });
            this._rightHealthTexts.push(digitText);
        }

        // === SCORE TICK MARKS ===
        // Calculate total ticks width
        const totalTicksWidth = SCORE_TICK_COUNT * SCORE_TICK_WIDTH + (SCORE_TICK_COUNT - 1) * SCORE_TICK_GAP;

        // Left ticks (blue team) - grow from outer edge (left) toward center
        // Start at outer edge of health bar, tick 0 at far left, tick 5 closest to center
        const leftOuterEdge = -(TEAM_UI_GAP / 2 + TEAM_BAR_WIDTH);
        for (let i = 0; i < SCORE_TICK_COUNT; i++) {
            const tick = new UIContainer({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: leftOuterEdge + (SCORE_TICK_WIDTH + SCORE_TICK_GAP) * i + SCORE_TICK_WIDTH / 2,
                y: SCORE_TICK_Y,
                width: SCORE_TICK_WIDTH,
                height: SCORE_TICK_HEIGHT,
                bgColor: TEAM_HEALTH_COLORS.BLACK,
                bgAlpha: 0.8,
                bgFill: mod.UIBgFill.Solid,
                visible: true,
            });
            this._leftTicks.push(tick);
        }

        // Right ticks (red team) - grow from outer edge (right) toward center
        // Start at outer edge of health bar, tick 0 at far right, tick 5 closest to center
        const rightOuterEdge = TEAM_UI_GAP / 2 + TEAM_BAR_WIDTH;
        for (let i = 0; i < SCORE_TICK_COUNT; i++) {
            const tick = new UIContainer({
                parent: this._container,
                anchor: mod.UIAnchor.Center,
                x: rightOuterEdge - (SCORE_TICK_WIDTH + SCORE_TICK_GAP) * i - SCORE_TICK_WIDTH / 2,
                y: SCORE_TICK_Y,
                width: SCORE_TICK_WIDTH,
                height: SCORE_TICK_HEIGHT,
                bgColor: TEAM_HEALTH_COLORS.BLACK,
                bgAlpha: 0.8,
                bgFill: mod.UIBgFill.Solid,
                visible: true,
            });
            this._rightTicks.push(tick);
        }
    }

    public setTeams(_team1: mod.Player[], _team2: mod.Player[]): void {
        // Teams are now fetched dynamically in _updateHealth()
        // Detect local player's team for color assignment
        this._detectLocalPlayerTeam();
    }

    private _detectLocalPlayerTeam(): void {
        // If we have a specific receiver, use their team directly
        if (this._receiver) {
            try {
                const playerTeam = mod.GetTeam(this._receiver);
                const team1 = mod.GetTeam(1);
                const isTeam1 = mod.GetObjId(playerTeam) === mod.GetObjId(team1);
                this._localPlayerTeam = isTeam1 ? 1 : 2;
                return;
            } catch {}
        }

        // Fallback: Find first human player and use their team for data swapping
        // Colors stay fixed (blue on left, red on right) - only team data swaps
        const team1Players = getPlayersOnTeam(1);
        const team2Players = getPlayersOnTeam(2);

        // Check team 1 for human player
        for (const player of team1Players) {
            try {
                if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                    this._localPlayerTeam = 1;
                    return;
                }
            } catch {}
        }

        // Check team 2 for human player
        for (const player of team2Players) {
            try {
                if (!mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) {
                    this._localPlayerTeam = 2;
                    return;
                }
            } catch {}
        }
    }

    public show(): void {
        if (this._isVisible) return;
        this._isVisible = true;
        this._container.visible = true;

        // Reset debug counters
        _healthUpdateTicks = 0;
        _playerHealthChecks = 0;
        _uiPropertyUpdates = 0;
        _lastHealthLogTime = Date.now();

        logHealth('SHOW - starting health update loop (100ms interval)');

        // Start updating health
        this._startHealthUpdate();
    }

    public hide(): void {
        if (!this._isVisible) return;
        this._isVisible = false;
        this._container.visible = false;
        this._stopHealthUpdate();
    }

    private _startHealthUpdate(): void {
        // Update health and scores every 100ms
        this._updateInterval = Timers.setInterval(() => {
            this._updateHealth();
            this.updateScores();
        }, 100);
    }

    private _stopHealthUpdate(): void {
        if (this._updateInterval !== null) {
            Timers.clearInterval(this._updateInterval);
            this._updateInterval = null;
        }
    }

    private _updateHealth(): void {
        _healthUpdateTicks++;

        // Get current players on each team (dynamically fetch to include bots)
        const team1Players = getPlayersOnTeam(1);
        const team2Players = getPlayersOnTeam(2);

        // Calculate team health totals and alive counts
        let team1Health = 0;
        let team1Alive = 0;
        let team2Health = 0;
        let team2Alive = 0;

        for (const player of team1Players) {
            try {
                _playerHealthChecks++;
                const playerId = mod.GetObjId(player);
                // Skip rejected players (mid-round spawn attempts)
                if (rejectedPlayerIds.has(playerId)) continue;

                const isAlive = mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive);
                if (isAlive) {
                    team1Alive++;
                    team1Health +=
                        mod.GetSoldierState(player, mod.SoldierStateNumber.NormalizedHealth) * HEALTH_PER_PLAYER;
                }
            } catch (e) {
                // Player might be invalid
            }
        }

        for (const player of team2Players) {
            try {
                _playerHealthChecks++;
                const playerId = mod.GetObjId(player);
                // Skip rejected players (mid-round spawn attempts)
                if (rejectedPlayerIds.has(playerId)) continue;

                const isAlive = mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive);
                if (isAlive) {
                    team2Alive++;
                    team2Health +=
                        mod.GetSoldierState(player, mod.SoldierStateNumber.NormalizedHealth) * HEALTH_PER_PLAYER;
                }
            } catch (e) {
                // Player might be invalid
            }
        }

        // Log every 1 second (10 ticks at 100ms)
        if (_healthUpdateTicks % 10 === 0) {
            const elapsed = (Date.now() - _lastHealthLogTime) / 1000;
            logHealth(`HEALTH UPDATE STATS (${elapsed.toFixed(1)}s):`, {
                ticks: _healthUpdateTicks,
                playerHealthChecks: _playerHealthChecks,
                uiPropertyUpdates: _uiPropertyUpdates,
                team1Players: team1Players.length,
                team2Players: team2Players.length,
                team1Health: Math.round(team1Health),
                team2Health: Math.round(team2Health),
                team1Alive,
                team2Alive,
            });
        }

        // Update max health based on current player counts
        this._maxHealthPerTeam = Math.max(team1Players.length, team2Players.length) * HEALTH_PER_PLAYER;

        // Round to whole numbers
        team1Health = Math.round(team1Health);
        team2Health = Math.round(team2Health);

        // Determine which team's data goes on which side
        // Left side = local player's team (blue), Right side = enemy team (red)
        const leftHealth = this._localPlayerTeam === 1 ? team1Health : team2Health;
        const rightHealth = this._localPlayerTeam === 1 ? team2Health : team1Health;
        const leftAlive = this._localPlayerTeam === 1 ? team1Alive : team2Alive;
        const rightAlive = this._localPlayerTeam === 1 ? team2Alive : team1Alive;
        const leftTotal = this._localPlayerTeam === 1 ? team1Players.length : team2Players.length;
        const rightTotal = this._localPlayerTeam === 1 ? team2Players.length : team1Players.length;

        // Update health number displays
        this._setHealthNumber(this._leftHealthTexts, leftHealth);
        this._setHealthNumber(this._rightHealthTexts, rightHealth);

        // Update alive icons
        this._leftIcons.message = mod.Message(this._getIconsStringKey(leftAlive, leftTotal));
        this._rightIcons.message = mod.Message(this._getIconsStringKey(rightAlive, rightTotal));

        // Update bar widths and positions (bars shrink toward center)
        const leftPercent = this._maxHealthPerTeam > 0 ? leftHealth / this._maxHealthPerTeam : 0;
        const rightPercent = this._maxHealthPerTeam > 0 ? rightHealth / this._maxHealthPerTeam : 0;

        const leftBarWidth = TEAM_BAR_WIDTH * leftPercent;
        const rightBarWidth = TEAM_BAR_WIDTH * rightPercent;

        // Left bar: shrinks from left toward center (shift x right as width decreases)
        this._leftBarFill.width = leftBarWidth;
        this._leftBarFill.x = -(TEAM_UI_GAP / 2) - leftBarWidth / 2;

        // Right bar: shrinks from right toward center (shift x left as width decreases)
        this._rightBarFill.width = rightBarWidth;
        this._rightBarFill.x = TEAM_UI_GAP / 2 + rightBarWidth / 2;

        // Update status text (relative to local player's team)
        if (leftHealth === rightHealth) {
            this._statusText.message = mod.Message(mod.stringkeys.gunfight.health.tied);
        } else {
            this._statusText.message = mod.Message(
                leftHealth > rightHealth
                    ? mod.stringkeys.gunfight.health.winning
                    : mod.stringkeys.gunfight.health.losing
            );
        }
    }

    private _setHealthNumber(texts: UIText[], value: number): void {
        // Pad to 3 digits and display each digit
        const str = String(Math.min(999, Math.max(0, value))).padStart(3, ' ');
        for (let i = 0; i < 3; i++) {
            const char = str[i];
            if (char === ' ') {
                texts[i].textAlpha = 0; // Hide leading spaces
            } else {
                texts[i].textAlpha = 1;
                texts[i].message = mod.Message(mod.stringkeys.logger.chars[char]);
            }
        }
    }

    private _getIconsStringKey(alive: number, _total: number): mod.Any {
        // Dynamic icons based on alive count (supports 1v1 to 4v4)
        if (alive >= 4) return mod.stringkeys.gunfight.health.icons4;
        if (alive === 3) return mod.stringkeys.gunfight.health.icons3;
        if (alive === 2) return mod.stringkeys.gunfight.health.icons2;
        if (alive === 1) return mod.stringkeys.gunfight.health.icons1;
        return mod.stringkeys.gunfight.health.icons0;
    }

    /**
     * Update score tick marks based on current round scores
     */
    public updateScores(): void {
        const scores = getScores();

        // Determine which team's score goes on which side
        // Left side = local player's team (blue), Right side = enemy team (red)
        const leftScore = this._localPlayerTeam === 1 ? scores.team1 : scores.team2;
        const rightScore = this._localPlayerTeam === 1 ? scores.team2 : scores.team1;

        // Update left ticks (blue team) - fill from outer edge toward center
        for (let i = 0; i < SCORE_TICK_COUNT; i++) {
            // Ticks are ordered from outer (0) to inner (5), so tick i is filled if score > i
            const isFilled = i < leftScore;
            this._leftTicks[i].bgColor = isFilled ? TEAM_HEALTH_COLORS.BLUE : TEAM_HEALTH_COLORS.BLACK;
        }

        // Update right ticks (red team) - fill from outer edge toward center
        for (let i = 0; i < SCORE_TICK_COUNT; i++) {
            const isFilled = i < rightScore;
            this._rightTicks[i].bgColor = isFilled ? TEAM_HEALTH_COLORS.RED : TEAM_HEALTH_COLORS.BLACK;
        }
    }

    public destroy(): void {
        this._stopHealthUpdate();
        this.stopCountdown();
        this._container.delete();
    }

    public get isVisible(): boolean {
        return this._isVisible;
    }

    public startCountdown(seconds: number, onEnd?: () => void, onOvertimeStart?: () => void): void {
        logHealth('START COUNTDOWN', { seconds, hasOnEnd: !!onEnd, hasOnOvertimeStart: !!onOvertimeStart });
        _countdownTicks = 0;

        this.stopCountdown();
        this._countdownMs = seconds * 1000;
        this._onCountdownEnd = onEnd || null;
        this._onOvertimeStart = onOvertimeStart || null;
        this._isOvertime = false;
        this._isPaused = false;
        this._lastBeepSecond = -1;
        this._setCountdownColor(TEAM_HEALTH_COLORS.WHITE);
        this._updateCountdownDisplay();

        // Update every 100ms for smooth display
        this._countdownInterval = Timers.setInterval(() => {
            // Skip countdown tick if paused
            if (!this._isPaused) {
                this._countdownMs -= 100;
            }
            this._updateCountdownDisplay();

            // Play beep at 10, 9, 8... down to 1 seconds during overtime
            if (this._isOvertime) {
                const currentSecond = Math.ceil(this._countdownMs / 1000);
                if (currentSecond <= 10 && currentSecond >= 1 && currentSecond !== this._lastBeepSecond) {
                    this._lastBeepSecond = currentSecond;
                    this._playCountdownTick(currentSecond === 1);
                }
            }

            if (this._countdownMs <= 0) {
                if (!this._isOvertime) {
                    // First time hitting 0 - enter overtime
                    this._isOvertime = true;
                    this._countdownMs = 10 * 1000; // Add 10 seconds
                    this._lastBeepSecond = -1; // Reset beep tracking for overtime
                    this._setCountdownColor(TEAM_HEALTH_COLORS.RED);
                    playVO(mod.VoiceOverEvents2D.TimeLow);
                    // Notify that overtime has started
                    if (this._onOvertimeStart) {
                        this._onOvertimeStart();
                    }
                } else {
                    // Overtime expired - end the round
                    this.stopCountdown();
                    if (this._onCountdownEnd) {
                        this._onCountdownEnd();
                    }
                }
            }
        }, 100);
    }

    public pauseCountdown(): void {
        this._isPaused = true;
    }

    public resumeCountdown(): void {
        this._isPaused = false;
    }

    private _playCountdownTick(isFinal: boolean): void {
        const sound = isFinal ? OVERTIME_FINAL_SOUND : OVERTIME_TICK_SOUND;
        const allPlayers = [...getPlayersOnTeam(1), ...getPlayersOnTeam(2)];
        for (const player of allPlayers) {
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

    public get isOvertime(): boolean {
        return this._isOvertime;
    }

    public get isPaused(): boolean {
        return this._isPaused;
    }

    private _setCountdownColor(color: mod.Vector): void {
        for (const text of this._countdownTexts) {
            text.textColor = color;
        }
    }

    public stopCountdown(): void {
        if (this._countdownInterval !== null) {
            Timers.clearInterval(this._countdownInterval);
            this._countdownInterval = null;
        }
        this._isOvertime = false;
        this._isPaused = false;
        // Reset to white and show dashes when stopped
        this._setCountdownColor(TEAM_HEALTH_COLORS.WHITE);
        if (this._countdownTexts.length >= 5) {
            this._countdownTexts[0].message = mod.Message(mod.stringkeys.countdown.dash);
            this._countdownTexts[1].message = mod.Message(mod.stringkeys.countdown.dash);
            this._countdownTexts[3].message = mod.Message(mod.stringkeys.countdown.dash);
            this._countdownTexts[4].message = mod.Message(mod.stringkeys.countdown.dash);
        }
    }

    private _updateCountdownDisplay(): void {
        if (this._countdownTexts.length < 5) return;

        // Calculate seconds and centiseconds (hundredths)
        const totalCentiseconds = Math.max(0, Math.floor(this._countdownMs / 10));
        const seconds = Math.floor(totalCentiseconds / 100);
        const centiseconds = totalCentiseconds % 100;

        // Format as SS:mm
        const secStr = String(seconds).padStart(2, '0');
        const csStr = String(centiseconds).padStart(2, '0');

        // Update each digit
        this._countdownTexts[0].message = mod.Message(mod.stringkeys.logger.chars[secStr[0]]);
        this._countdownTexts[1].message = mod.Message(mod.stringkeys.logger.chars[secStr[1]]);
        // Index 2 is the colon, leave it
        this._countdownTexts[3].message = mod.Message(mod.stringkeys.logger.chars[csStr[0]]);
        this._countdownTexts[4].message = mod.Message(mod.stringkeys.logger.chars[csStr[1]]);
    }
}
