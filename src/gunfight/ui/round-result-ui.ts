import { Timers } from 'bf6-portal-utils/timers/index.ts';
import { UIContainer } from 'bf6-portal-utils/ui/components/container/index.ts';
import { UIText } from 'bf6-portal-utils/ui/components/text/index.ts';
import { getAllPlayers } from '../../helpers/index.ts';

// ========== DEBUG LOGGING ==========
const DEBUG_ROUND_RESULT = false;
let _showRoundResultCalls = 0;
let _animationTimersCreated = 0;
let _uiElementsCreated = 0;

function logResult(msg: string, ...args: any[]): void {
    if (DEBUG_ROUND_RESULT) console.log(`[RoundResultUI] ${msg}`, ...args);
}
// ===================================

// Colors (MW2 Gunfight style)
const RESULT_COLORS = {
    WHITE: mod.CreateVector(1, 1, 1),
    CYAN: mod.CreateVector(0.2, 0.85, 0.95),
    RED: mod.CreateVector(1, 0.3, 0.3),
    DARK_BG: mod.CreateVector(0, 0, 0),
    GRAY: mod.CreateVector(0.6, 0.6, 0.6),
    DRAW_GRAY: mod.CreateVector(0.5, 0.5, 0.5),
};

// Animation timing
const POP_DURATION = 500; // Color pop fades out in 500ms
const CONTENT_FADE_DURATION = 400; // Content fades in over 400ms
const CONTENT_DELAY = 200; // Content starts fading in after 200ms
const DARK_BG_FADE_DURATION = 150; // Dark backgrounds fade in quickly (150ms)
const DARK_BG_ALPHA = 0.92; // Slight transparency (almost solid black)
const RESULT_ANIMATION_TICK = 33;

// Result duration
const RESULT_DISPLAY_DURATION = 5000;

// Sound effects for round results
const ROUND_WIN_SOUND = mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_EOM_Qualified_OneShot2D;
const ROUND_LOSS_SOUND = mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_Rodeo_TankAcquired_OneShot2D;

// Score ticks constants
const SCORE_TICKS_COUNT = 6;
const TICK_WIDTH = 10;
const TICK_HEIGHT = 4;
const TICK_GAP = 4;

// Track active result UIs per player
interface ResultUI {
    container: UIContainer;
    crownImageName: string;
    colorPopOverlay: UIContainer;
    darkBaseOverlay: UIContainer;
    darkGradientOverlay: UIContainer;
    elements: {
        title: UIText;
        subtitle: UIText;
        leftScore: UIText;
        rightScore: UIText;
        leftName: UIText;
        rightName: UIText;
        leftBar: UIContainer;
        rightBar: UIContainer;
        chevronLeft: UIText;
        chevronRight: UIText;
        leftTicks: UIContainer[];
        rightTicks: UIContainer[];
    };
}

const activeResultUIs: Map<number, ResultUI> = new Map();

// Track team scores
let team1Score = 0;
let team2Score = 0;
let imageCounter = 0;

/**
 * Update team scores
 */
export function updateScores(t1Score: number, t2Score: number): void {
    team1Score = t1Score;
    team2Score = t2Score;
}

/**
 * Show round result to a specific player with MW2-style animation
 * @param isFlagCapture - If true, shows "OBJECTIVE CAPTURED/LOST" instead of "ENEMY/TEAM ELIMINATED"
 * @param isHealthWin - If true, shows "ENEMY WAS DEFEATED/SUCCESSFUL" (timer ran out, health-based win)
 */
function showRoundResult(
    player: mod.Player,
    isWin: boolean,
    winningTeamId: number,
    isFlagCapture: boolean = false,
    isHealthWin: boolean = false
): void {
    try {
        const playerId = mod.GetObjId(player);

        // Clean up any existing result UI for this player
        const existing = activeResultUIs.get(playerId);
        if (existing) {
            try {
                // Delete crown image
                const crownWidget = mod.FindUIWidgetWithName(existing.crownImageName);
                if (crownWidget) {
                    mod.DeleteUIWidget(crownWidget);
                }
                existing.container.delete();
            } catch {
                // Already deleted
            }
            activeResultUIs.delete(playerId);
        }

        // Determine if we need to swap sides based on player's team
        // Player's team should always be on the left (cyan)
        const playerTeam = mod.GetTeam(player);
        const team1 = mod.GetTeam(1);
        const isPlayerTeam1 = mod.GetObjId(playerTeam) === mod.GetObjId(team1);

        // Left side = player's team (cyan), Right side = enemy (red)
        const leftScore = isPlayerTeam1 ? team1Score : team2Score;
        const rightScoreValue = isPlayerTeam1 ? team2Score : team1Score;
        const leftTeamName = isPlayerTeam1 ? mod.stringkeys.gunfight.round.nato : mod.stringkeys.gunfight.round.pax;
        const rightTeamName = isPlayerTeam1 ? mod.stringkeys.gunfight.round.pax : mod.stringkeys.gunfight.round.nato;

        const accentColor = isWin ? RESULT_COLORS.CYAN : RESULT_COLORS.RED;
        imageCounter++;
        const crownImageName = `round_result_crown_${playerId}_${imageCounter}`;

        // Play win or loss sound (SFX at 50% volume)
        try {
            const sound = isWin ? ROUND_WIN_SOUND : ROUND_LOSS_SOUND;
            const sfx = mod.SpawnObject(sound, mod.CreateVector(0, 0, 0), mod.CreateVector(0, 0, 0));
            mod.PlaySound(sfx, 0.5, player);
            Timers.setTimeout(() => {
                try {
                    mod.StopSound(sfx);
                    mod.UnspawnObject(sfx);
                } catch {}
            }, 5000);
        } catch {}

        // Main container (no background)
        const container = new UIContainer({
            anchor: mod.UIAnchor.Center,
            width: 10000,
            height: 10000,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.None,
            visible: true,
            receiver: player,
            depth: mod.UIDepth.AboveGameUI,
        });

        // COLOR POP overlay - bright flash that fades out quickly (gradient bottom to top)
        const colorPopOverlay = new UIContainer({
            parent: container,
            anchor: mod.UIAnchor.Center,
            width: 10000,
            height: 10000,
            bgColor: accentColor,
            bgAlpha: 0.85, // Start bright
            bgFill: mod.UIBgFill.GradientBottom,
            visible: true,
        });

        // Bottom half - solid black (no transparency)
        const darkBaseOverlay = new UIContainer({
            parent: container,
            anchor: mod.UIAnchor.BottomCenter,
            width: 10000,
            height: 5000, // Bottom half of screen
            bgColor: RESULT_COLORS.DARK_BG,
            bgAlpha: 0, // Starts invisible, fades in to 1.0
            bgFill: mod.UIBgFill.Solid,
            visible: true,
        });

        // Top half - gradient from solid black to fully transparent
        const darkGradientOverlay = new UIContainer({
            parent: container,
            anchor: mod.UIAnchor.TopCenter,
            width: 10000,
            height: 5000, // Top half of screen
            bgColor: RESULT_COLORS.DARK_BG,
            bgAlpha: 0, // Starts invisible, fades in to 0.9
            bgFill: mod.UIBgFill.GradientBottom,
            visible: true,
        });

        // Add symbol image in the center (AFTER overlays so it renders on top)
        // Crown for winners (1890x1890), SelfHeal icon for losers (945x945 - half size)
        const symbolType = isWin ? mod.UIImageType.CrownOutline : mod.UIImageType.SelfHeal;
        const symbolSize = isWin ? 1890 : 945;
        const containerWidget = container.uiWidget;
        mod.AddUIImage(
            crownImageName,
            mod.CreateVector(0, 0, 0), // position
            mod.CreateVector(symbolSize, symbolSize, 0), // size
            mod.UIAnchor.Center, // anchor
            containerWidget || mod.GetUIRoot(), // parent (container, so it's above overlays)
            true, // visible
            0, // padding
            mod.CreateVector(0, 0, 0), // bgColor (black)
            0, // bgAlpha (transparent - no background!)
            mod.UIBgFill.None, // bgFill (none)
            symbolType, // imageType
            RESULT_COLORS.WHITE, // imageColor
            0, // imageAlpha (start invisible)
            player // receiver
        );
        const crownWidget = mod.FindUIWidgetWithName(crownImageName);

        // "ROUND WIN" or "ROUND LOSS" - large white text
        const title = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            y: -100,
            width: 1000,
            height: 150,
            message: mod.Message(isWin ? mod.stringkeys.gunfight.round.win : mod.stringkeys.gunfight.round.loss),
            textSize: 72,
            textColor: RESULT_COLORS.WHITE,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Subtitle - depends on win condition (elimination, flag capture, or health-based)
        let subtitleKey: mod.Any;
        if (isFlagCapture) {
            subtitleKey = isWin
                ? mod.stringkeys.gunfight.round.objectiveCaptured
                : mod.stringkeys.gunfight.round.objectiveLost;
        } else if (isHealthWin) {
            subtitleKey = isWin
                ? mod.stringkeys.gunfight.round.enemyDefeated
                : mod.stringkeys.gunfight.round.enemySuccessful;
        } else {
            subtitleKey = isWin
                ? mod.stringkeys.gunfight.round.enemyEliminated
                : mod.stringkeys.gunfight.round.teamEliminated;
        }
        const subtitle = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            y: -40,
            width: 800,
            height: 50,
            message: mod.Message(subtitleKey),
            textSize: 18,
            textColor: RESULT_COLORS.GRAY,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Small decorative chevrons near title
        const chevronLeft = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: -280,
            y: -100,
            width: 60,
            height: 80,
            message: mod.Message(mod.stringkeys.gunfight.round.chevronLeft),
            textSize: 32,
            textColor: RESULT_COLORS.WHITE,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        const chevronRight = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: 280,
            y: -100,
            width: 60,
            height: 80,
            message: mod.Message(mod.stringkeys.gunfight.round.chevronRight),
            textSize: 32,
            textColor: RESULT_COLORS.WHITE,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Left score (Player's team - Cyan) - larger
        const leftScoreText = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: -220,
            y: 60,
            width: 150,
            height: 150,
            message: mod.Message(mod.stringkeys.logger.chars[String(leftScore)]),
            textSize: 110,
            textColor: RESULT_COLORS.CYAN,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Right score (Enemy team - Red) - larger
        const rightScoreText = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: 220,
            y: 60,
            width: 150,
            height: 150,
            message: mod.Message(mod.stringkeys.logger.chars[String(rightScoreValue)]),
            textSize: 110,
            textColor: RESULT_COLORS.RED,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Left score bar
        const leftBar = new UIContainer({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: -220,
            y: 140,
            width: 80,
            height: 4,
            bgColor: RESULT_COLORS.CYAN,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.Solid,
            visible: true,
        });

        // Left team name (Player's team)
        const leftName = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: -220,
            y: 165,
            width: 120,
            height: 35,
            message: mod.Message(leftTeamName),
            textSize: 16,
            textColor: RESULT_COLORS.CYAN,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Right score bar
        const rightBar = new UIContainer({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: 220,
            y: 140,
            width: 80,
            height: 4,
            bgColor: RESULT_COLORS.RED,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.Solid,
            visible: true,
        });

        // Right team name (Enemy team)
        const rightName = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: 220,
            y: 165,
            width: 120,
            height: 35,
            message: mod.Message(rightTeamName),
            textSize: 16,
            textColor: RESULT_COLORS.RED,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Score ticks - 6 ticks under each score (filled based on wins)
        const totalTicksWidth = SCORE_TICKS_COUNT * TICK_WIDTH + (SCORE_TICKS_COUNT - 1) * TICK_GAP;
        const leftTicksStartX = -220 - totalTicksWidth / 2 + TICK_WIDTH / 2;
        const rightTicksStartX = 220 - totalTicksWidth / 2 + TICK_WIDTH / 2;
        const ticksY = 125;

        // Left team ticks (player's team)
        const leftTicks: UIContainer[] = [];
        for (let i = 0; i < SCORE_TICKS_COUNT; i++) {
            const isFilled = i < leftScore;
            const tick = new UIContainer({
                parent: container,
                anchor: mod.UIAnchor.Center,
                x: leftTicksStartX + i * (TICK_WIDTH + TICK_GAP),
                y: ticksY,
                width: TICK_WIDTH,
                height: TICK_HEIGHT,
                bgColor: isFilled ? RESULT_COLORS.CYAN : RESULT_COLORS.DARK_BG,
                bgAlpha: 0,
                bgFill: mod.UIBgFill.Solid,
                visible: true,
            });
            leftTicks.push(tick);
        }

        // Right team ticks (enemy team)
        const rightTicks: UIContainer[] = [];
        for (let i = 0; i < SCORE_TICKS_COUNT; i++) {
            const isFilled = i < rightScoreValue;
            const tick = new UIContainer({
                parent: container,
                anchor: mod.UIAnchor.Center,
                x: rightTicksStartX + i * (TICK_WIDTH + TICK_GAP),
                y: ticksY,
                width: TICK_WIDTH,
                height: TICK_HEIGHT,
                bgColor: isFilled ? RESULT_COLORS.RED : RESULT_COLORS.DARK_BG,
                bgAlpha: 0,
                bgFill: mod.UIBgFill.Solid,
                visible: true,
            });
            rightTicks.push(tick);
        }

        const resultUI: ResultUI = {
            container,
            crownImageName,
            colorPopOverlay,
            darkBaseOverlay,
            darkGradientOverlay,
            elements: {
                title,
                subtitle,
                leftScore: leftScoreText,
                rightScore: rightScoreText,
                leftName,
                rightName,
                leftBar,
                rightBar,
                chevronLeft,
                chevronRight,
                leftTicks,
                rightTicks,
            },
        };

        activeResultUIs.set(playerId, resultUI);

        // Animate: color pop fades out, then content fades in
        animateColorPop(resultUI);
        animateContentFadeIn(resultUI);
    } catch {
        // Player might be invalid
    }
}

/**
 * Animate the color pop (bright flash that fades out quickly)
 */
function animateColorPop(ui: ResultUI): void {
    _animationTimersCreated++;
    logResult('Creating animateColorPop timer', { totalAnimationTimers: _animationTimersCreated });
    let elapsed = 0;

    const timer = Timers.setInterval(() => {
        elapsed += RESULT_ANIMATION_TICK;
        const progress = Math.min(elapsed / POP_DURATION, 1);

        // Ease out - starts bright, fades quickly
        const fadeOut = 1 - progress;
        const eased = fadeOut * fadeOut; // Quadratic ease out

        // Color pop fades from 0.85 to 0
        ui.colorPopOverlay.bgAlpha = eased * 0.85;

        if (progress >= 1) {
            Timers.clearInterval(timer);
            // Hide the pop overlay completely
            ui.colorPopOverlay.visible = false;
        }
    }, RESULT_ANIMATION_TICK);
}

/**
 * Animate content fading in (delayed start)
 */
// Quick fade-in for dark backgrounds (starts immediately)
function animateDarkBackgrounds(ui: ResultUI): void {
    let elapsed = 0;

    const timer = Timers.setInterval(() => {
        elapsed += RESULT_ANIMATION_TICK;
        const progress = Math.min(elapsed / DARK_BG_FADE_DURATION, 1);

        // Ease out cubic for smooth fade
        const eased = 1 - Math.pow(1 - progress, 3);

        // Dark overlays fade in to slightly transparent
        ui.darkBaseOverlay.bgAlpha = eased * DARK_BG_ALPHA;
        ui.darkGradientOverlay.bgAlpha = eased * DARK_BG_ALPHA;

        if (progress >= 1) {
            Timers.clearInterval(timer);
        }
    }, RESULT_ANIMATION_TICK);
}

function animateContentFadeIn(ui: ResultUI): void {
    // Start dark backgrounds fading in immediately
    animateDarkBackgrounds(ui);

    // Delay content fade-in
    Timers.setTimeout(() => {
        let elapsed = 0;

        const timer = Timers.setInterval(() => {
            elapsed += RESULT_ANIMATION_TICK;
            const progress = Math.min(elapsed / CONTENT_FADE_DURATION, 1);

            // Ease out cubic
            const eased = 1 - Math.pow(1 - progress, 3);

            // Crown/symbol fades in
            const crownWidget = mod.FindUIWidgetWithName(ui.crownImageName);
            if (crownWidget) {
                mod.SetUIImageAlpha(crownWidget, eased * 0.04); // Very subtle
            }

            // Main UI elements fade in
            ui.elements.title.textAlpha = eased;
            ui.elements.subtitle.textAlpha = eased * 0.8;
            ui.elements.leftScore.textAlpha = eased;
            ui.elements.rightScore.textAlpha = eased;
            ui.elements.leftName.textAlpha = eased * 0.9;
            ui.elements.rightName.textAlpha = eased * 0.9;
            ui.elements.leftBar.bgAlpha = eased;
            ui.elements.rightBar.bgAlpha = eased;
            ui.elements.chevronLeft.textAlpha = eased * 0.7;
            ui.elements.chevronRight.textAlpha = eased * 0.7;

            // Score ticks fade in
            for (const tick of ui.elements.leftTicks) {
                tick.bgAlpha = eased;
            }
            for (const tick of ui.elements.rightTicks) {
                tick.bgAlpha = eased;
            }

            if (progress >= 1) {
                Timers.clearInterval(timer);
            }
        }, RESULT_ANIMATION_TICK);
    }, CONTENT_DELAY);
}

/**
 * Show round results to all players based on winning team
 * @param winningTeamId - The team ID that won (1 or 2)
 * @param duration - How long to show the result in milliseconds (default 5000)
 * @param isFlagCapture - If true, shows "OBJECTIVE CAPTURED/LOST" instead of elimination text
 * @param isHealthWin - If true, shows "ENEMY WAS DEFEATED/SUCCESSFUL" (timer ran out, health-based win)
 */
export function showRoundResults(
    winningTeamId: number,
    duration: number = RESULT_DISPLAY_DURATION,
    isFlagCapture: boolean = false,
    isHealthWin: boolean = false
): void {
    _showRoundResultCalls++;
    logResult('showRoundResults called', {
        callNumber: _showRoundResultCalls,
        winningTeamId,
        duration,
        isFlagCapture,
        isHealthWin,
        team1ScoreBefore: team1Score,
        team2ScoreBefore: team2Score,
        activeResultUIsBefore: activeResultUIs.size,
    });

    // Update scores - winning team gets a point
    if (winningTeamId === 1) {
        team1Score++;
    } else {
        team2Score++;
    }

    const allPlayers = getAllPlayers();
    logResult('Creating result UIs for players', { playerCount: allPlayers.length });
    const winningTeam = mod.GetTeam(winningTeamId);

    for (const player of allPlayers) {
        try {
            // Skip AI players
            if (mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) continue;

            const playerTeam = mod.GetTeam(player);
            const isWinner = mod.GetObjId(playerTeam) === mod.GetObjId(winningTeam);

            showRoundResult(player, isWinner, winningTeamId, isFlagCapture, isHealthWin);
        } catch {
            // Player might be invalid
        }
    }

    // Auto-hide after duration
    Timers.setTimeout(() => {
        hideAllRoundResults();
    }, duration);
}

/**
 * Hide all round result UIs
 */
export function hideAllRoundResults(): void {
    for (const [_playerId, ui] of activeResultUIs) {
        try {
            // Delete crown image
            const crownWidget = mod.FindUIWidgetWithName(ui.crownImageName);
            if (crownWidget) {
                mod.DeleteUIWidget(crownWidget);
            }
            ui.container.delete();
        } catch {
            // Already deleted
        }
    }
    activeResultUIs.clear();
}

/**
 * Reset scores (call at game start)
 */
export function resetScores(): void {
    team1Score = 0;
    team2Score = 0;
}

export function getScores(): { team1: number; team2: number } {
    return { team1: team1Score, team2: team2Score };
}

/**
 * Show round draw to a specific player with grey flash
 */
function showRoundDrawResult(player: mod.Player): void {
    try {
        const playerId = mod.GetObjId(player);

        // Clean up any existing result UI for this player
        const existing = activeResultUIs.get(playerId);
        if (existing) {
            try {
                const crownWidget = mod.FindUIWidgetWithName(existing.crownImageName);
                if (crownWidget) {
                    mod.DeleteUIWidget(crownWidget);
                }
                existing.container.delete();
            } catch {
                // Already deleted
            }
            activeResultUIs.delete(playerId);
        }

        // Determine team perspective for scores
        const playerTeam = mod.GetTeam(player);
        const team1 = mod.GetTeam(1);
        const isPlayerTeam1 = mod.GetObjId(playerTeam) === mod.GetObjId(team1);

        const leftScore = isPlayerTeam1 ? team1Score : team2Score;
        const rightScoreValue = isPlayerTeam1 ? team2Score : team1Score;
        const leftTeamName = isPlayerTeam1 ? mod.stringkeys.gunfight.round.nato : mod.stringkeys.gunfight.round.pax;
        const rightTeamName = isPlayerTeam1 ? mod.stringkeys.gunfight.round.pax : mod.stringkeys.gunfight.round.nato;

        imageCounter++;
        const crownImageName = `round_result_crown_${playerId}_${imageCounter}`;

        // Play loss sound for draw (neutral outcome)
        try {
            const sfx = mod.SpawnObject(ROUND_LOSS_SOUND, mod.CreateVector(0, 0, 0), mod.CreateVector(0, 0, 0));
            mod.PlaySound(sfx, 0.5, player);
            Timers.setTimeout(() => {
                try {
                    mod.StopSound(sfx);
                    mod.UnspawnObject(sfx);
                } catch {}
            }, 5000);
        } catch {}

        // Main container (no background)
        const container = new UIContainer({
            anchor: mod.UIAnchor.Center,
            width: 10000,
            height: 10000,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.None,
            visible: true,
            receiver: player,
            depth: mod.UIDepth.AboveGameUI,
        });

        // COLOR POP overlay - grey flash that fades out quickly
        const colorPopOverlay = new UIContainer({
            parent: container,
            anchor: mod.UIAnchor.Center,
            width: 10000,
            height: 10000,
            bgColor: RESULT_COLORS.DRAW_GRAY,
            bgAlpha: 0.85,
            bgFill: mod.UIBgFill.GradientBottom,
            visible: true,
        });

        // Bottom half - solid black
        const darkBaseOverlay = new UIContainer({
            parent: container,
            anchor: mod.UIAnchor.BottomCenter,
            width: 10000,
            height: 5000,
            bgColor: RESULT_COLORS.DARK_BG,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.Solid,
            visible: true,
        });

        // Top half - gradient from solid black to fully transparent
        const darkGradientOverlay = new UIContainer({
            parent: container,
            anchor: mod.UIAnchor.TopCenter,
            width: 10000,
            height: 5000,
            bgColor: RESULT_COLORS.DARK_BG,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.GradientBottom,
            visible: true,
        });

        // Add symbol image (SelfHeal icon for draw - like a loss)
        const symbolType = mod.UIImageType.SelfHeal;
        const symbolSize = 945;
        const containerWidget = container.uiWidget;
        mod.AddUIImage(
            crownImageName,
            mod.CreateVector(0, 0, 0),
            mod.CreateVector(symbolSize, symbolSize, 0),
            mod.UIAnchor.Center,
            containerWidget || mod.GetUIRoot(),
            true,
            0,
            mod.CreateVector(0, 0, 0),
            0,
            mod.UIBgFill.None,
            symbolType,
            RESULT_COLORS.WHITE,
            0,
            player
        );

        // "ROUND DRAW" - large white text
        const title = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            y: -70,
            width: 1000,
            height: 150,
            message: mod.Message(mod.stringkeys.gunfight.round.draw),
            textSize: 72,
            textColor: RESULT_COLORS.WHITE,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // No subtitle for draw - just placeholder for ResultUI interface
        const subtitleText = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            y: -40,
            width: 800,
            height: 50,
            message: mod.Message(mod.stringkeys.gunfight.round.draw),
            textSize: 18,
            textColor: RESULT_COLORS.GRAY,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: false, // Hidden - no subtitle for draw
        });

        // Small decorative chevrons near title
        const chevronLeft = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: -280,
            y: -100,
            width: 60,
            height: 80,
            message: mod.Message(mod.stringkeys.gunfight.round.chevronLeft),
            textSize: 32,
            textColor: RESULT_COLORS.WHITE,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        const chevronRight = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: 280,
            y: -100,
            width: 60,
            height: 80,
            message: mod.Message(mod.stringkeys.gunfight.round.chevronRight),
            textSize: 32,
            textColor: RESULT_COLORS.WHITE,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Left score - Grey for draw
        const leftScoreText = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: -220,
            y: 60,
            width: 150,
            height: 150,
            message: mod.Message(mod.stringkeys.logger.chars[String(leftScore)]),
            textSize: 110,
            textColor: RESULT_COLORS.DRAW_GRAY,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Right score - Grey for draw
        const rightScoreText = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: 220,
            y: 60,
            width: 150,
            height: 150,
            message: mod.Message(mod.stringkeys.logger.chars[String(rightScoreValue)]),
            textSize: 110,
            textColor: RESULT_COLORS.DRAW_GRAY,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Left score bar - Grey for draw
        const leftBar = new UIContainer({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: -220,
            y: 140,
            width: 80,
            height: 4,
            bgColor: RESULT_COLORS.DRAW_GRAY,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.Solid,
            visible: true,
        });

        // Left team name - Grey for draw
        const leftName = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: -220,
            y: 165,
            width: 120,
            height: 35,
            message: mod.Message(leftTeamName),
            textSize: 16,
            textColor: RESULT_COLORS.DRAW_GRAY,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Right score bar - Grey for draw
        const rightBar = new UIContainer({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: 220,
            y: 140,
            width: 80,
            height: 4,
            bgColor: RESULT_COLORS.DRAW_GRAY,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.Solid,
            visible: true,
        });

        // Right team name - Grey for draw
        const rightName = new UIText({
            parent: container,
            anchor: mod.UIAnchor.Center,
            x: 220,
            y: 165,
            width: 120,
            height: 35,
            message: mod.Message(rightTeamName),
            textSize: 16,
            textColor: RESULT_COLORS.DRAW_GRAY,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.Center,
            visible: true,
        });

        // Score ticks - all grey for draw
        const totalTicksWidth = SCORE_TICKS_COUNT * TICK_WIDTH + (SCORE_TICKS_COUNT - 1) * TICK_GAP;
        const leftTicksStartX = -220 - totalTicksWidth / 2 + TICK_WIDTH / 2;
        const rightTicksStartX = 220 - totalTicksWidth / 2 + TICK_WIDTH / 2;
        const ticksY = 125;

        const leftTicks: UIContainer[] = [];
        for (let i = 0; i < SCORE_TICKS_COUNT; i++) {
            const isFilled = i < leftScore;
            const tick = new UIContainer({
                parent: container,
                anchor: mod.UIAnchor.Center,
                x: leftTicksStartX + i * (TICK_WIDTH + TICK_GAP),
                y: ticksY,
                width: TICK_WIDTH,
                height: TICK_HEIGHT,
                bgColor: isFilled ? RESULT_COLORS.DRAW_GRAY : RESULT_COLORS.DARK_BG,
                bgAlpha: 0,
                bgFill: mod.UIBgFill.Solid,
                visible: true,
            });
            leftTicks.push(tick);
        }

        const rightTicks: UIContainer[] = [];
        for (let i = 0; i < SCORE_TICKS_COUNT; i++) {
            const isFilled = i < rightScoreValue;
            const tick = new UIContainer({
                parent: container,
                anchor: mod.UIAnchor.Center,
                x: rightTicksStartX + i * (TICK_WIDTH + TICK_GAP),
                y: ticksY,
                width: TICK_WIDTH,
                height: TICK_HEIGHT,
                bgColor: isFilled ? RESULT_COLORS.DRAW_GRAY : RESULT_COLORS.DARK_BG,
                bgAlpha: 0,
                bgFill: mod.UIBgFill.Solid,
                visible: true,
            });
            rightTicks.push(tick);
        }

        const resultUI: ResultUI = {
            container,
            crownImageName,
            colorPopOverlay,
            darkBaseOverlay,
            darkGradientOverlay,
            elements: {
                title,
                subtitle: subtitleText,
                leftScore: leftScoreText,
                rightScore: rightScoreText,
                leftName,
                rightName,
                leftBar,
                rightBar,
                chevronLeft,
                chevronRight,
                leftTicks,
                rightTicks,
            },
        };

        activeResultUIs.set(playerId, resultUI);

        // Animate: color pop fades out, then content fades in
        animateColorPop(resultUI);
        animateContentFadeIn(resultUI);
    } catch {
        // Player might be invalid
    }
}

/**
 * Show round draw to all players (no score increment)
 * @param duration - How long to show the result in milliseconds (default 5000)
 */
export function showRoundDraw(duration: number = RESULT_DISPLAY_DURATION): void {
    // No score increment for draws
    const allPlayers = getAllPlayers();

    for (const player of allPlayers) {
        try {
            // Skip AI players
            if (mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier)) continue;

            showRoundDrawResult(player);
        } catch {
            // Player might be invalid
        }
    }

    // Auto-hide after duration
    Timers.setTimeout(() => {
        hideAllRoundResults();
    }, duration);
}
