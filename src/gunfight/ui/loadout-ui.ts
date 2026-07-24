// ============================================================================
// LOADOUT UI — the "NEW LOADOUT" card AND the real equip path
// ============================================================================
// Two jobs: (1) the LoadoutUI class draws the on-screen "NEW LOADOUT" card with the
// round's weapon/gadget images; (2) its static helpers are what ACTUALLY equip the
// weapons + gadgets onto a player (the card is cosmetic, these calls are not). Also
// defines the `Loadout` interface used across the mode. The loadout DATA + random
// pick live in ../loadout.ts; this file only shows + applies the chosen loadout.
// ============================================================================
import { Timers } from 'bf6-portal-utils/timers/index.ts';
import { UIContainer } from 'bf6-portal-utils/ui/components/container/index.ts';
import { UIText } from 'bf6-portal-utils/ui/components/text/index.ts';
import { getStockAttachments } from '../loadout.ts';

// ========== DEBUG LOGGING ==========
const DEBUG_LOADOUT = false;
let _applyWeaponsCalls = 0;
let _applyGadgetsCalls = 0;
let _createImagesCalls = 0;
let _deleteImagesCalls = 0;
let _equipmentAdds = 0;
let _equipmentRemoves = 0;

function logLoadout(msg: string, ...args: any[]): void {
    if (DEBUG_LOADOUT) console.log(`[LoadoutUI] ${msg}`, ...args);
}
// ===================================

// Colors
const LOADOUT_COLORS = {
    WHITE: mod.CreateVector(1, 1, 1),
    GRAY: mod.CreateVector(0.7, 0.7, 0.7),
    DARK_BG: mod.CreateVector(0, 0, 0),
};

// Animation
const LOADOUT_FADE_DURATION = 300;
const LOADOUT_ANIMATION_TICK = 33;

// UI sizing - larger for better visibility
const LOADOUT_CONTENT_HEIGHT = 200;
const LOADOUT_BG_HEIGHT = 250;
const LOADOUT_COLUMN_WIDTH = 280;
const LOADOUT_WEAPON_IMAGE_WIDTH = 200;
const LOADOUT_WEAPON_IMAGE_HEIGHT = 80;
const LOADOUT_GADGET_IMAGE_SIZE = 80;

export interface Loadout {
    primary: mod.Weapons | null; // null = no primary weapon
    secondary: mod.Weapons | null; // null = no secondary weapon
    gadget: mod.Gadgets; // MiscGadget slot (equipment gadget)
    throwable: mod.Gadgets; // Throwable slot (grenades, etc.)
    // String keys for weapon/gadget names
    primaryName: mod.Any;
    secondaryName: mod.Any;
    gadgetName: mod.Any;
    throwableName: mod.Any;
    // Optional attachments for weapons
    primaryAttachments?: mod.WeaponAttachments[];
    secondaryAttachments?: mod.WeaponAttachments[];
}

export class LoadoutUI {
    private _receiver?: mod.Player | mod.Team;
    private _container: UIContainer;
    private _background: UIContainer;
    private _animationTimer: number | null = null;
    private _isVisible = false;
    private _instanceId: number;
    private _imagesCreated = false;

    // UI elements
    private _header: UIText;
    private _primaryLabel: UIText;
    private _primaryName: UIText;
    private _secondaryLabel: UIText;
    private _secondaryName: UIText;
    private _lethalLabel: UIText;
    private _lethalName: UIText;
    private _tacticalLabel: UIText;
    private _tacticalName: UIText;

    // Image widget names (for deletion)
    private _imageNames: string[] = [];

    // Current loadout for creating images later
    private _currentLoadout: Loadout | null = null;

    private static _nextInstanceId = 0;

    public constructor(receiver?: mod.Player | mod.Team) {
        this._receiver = receiver;
        this._instanceId = LoadoutUI._nextInstanceId++;

        // Full-width background container (stretches to ultrawide edges)
        this._background = new UIContainer({
            anchor: mod.UIAnchor.BottomCenter,
            y: 0,
            width: 10000, // Ultra-wide support
            height: LOADOUT_BG_HEIGHT,
            bgColor: LOADOUT_COLORS.DARK_BG,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.GradientTop, // Dark at bottom, transparent at top
            visible: true,
            receiver: this._receiver,
            depth: mod.UIDepth.AboveGameUI,
        });

        // Content container (centered, holds all the loadout items)
        this._container = new UIContainer({
            anchor: mod.UIAnchor.BottomCenter,
            y: 0,
            width: LOADOUT_COLUMN_WIDTH * 4,
            height: LOADOUT_CONTENT_HEIGHT,
            bgAlpha: 0,
            bgFill: mod.UIBgFill.None,
            visible: true,
            receiver: this._receiver,
            depth: mod.UIDepth.AboveGameUI,
        });

        // Header: "NEW LOADOUT" - at the top of the loadout section
        this._header = new UIText({
            parent: this._container,
            anchor: mod.UIAnchor.BottomCenter,
            y: LOADOUT_CONTENT_HEIGHT - 10,
            width: LOADOUT_COLUMN_WIDTH * 4,
            height: 40,
            message: mod.Message(mod.stringkeys.gunfight.loadout.header),
            textSize: 24,
            textColor: LOADOUT_COLORS.WHITE,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.BottomCenter,
            visible: true,
        });

        // Column positions (centered, spaced evenly)
        const startX = -((LOADOUT_COLUMN_WIDTH * 4) / 2) + LOADOUT_COLUMN_WIDTH / 2;

        // Labels and names for each column
        // Layout from bottom: name (20), label (35), image space (above)
        const nameY = 20;
        const labelY = 45;

        // Primary column
        this._primaryLabel = this._createLabel(startX, mod.stringkeys.gunfight.loadout.primary, labelY);
        this._primaryName = this._createName(startX, nameY);

        // Secondary column
        this._secondaryLabel = this._createLabel(
            startX + LOADOUT_COLUMN_WIDTH,
            mod.stringkeys.gunfight.loadout.secondary,
            labelY
        );
        this._secondaryName = this._createName(startX + LOADOUT_COLUMN_WIDTH, nameY);

        // Gadget column (was Lethal)
        this._lethalLabel = this._createLabel(
            startX + LOADOUT_COLUMN_WIDTH * 2,
            mod.stringkeys.gunfight.loadout.gadget,
            labelY
        );
        this._lethalName = this._createName(startX + LOADOUT_COLUMN_WIDTH * 2, nameY);

        // Throwable column (was Tactical)
        this._tacticalLabel = this._createLabel(
            startX + LOADOUT_COLUMN_WIDTH * 3,
            mod.stringkeys.gunfight.loadout.throwable,
            labelY
        );
        this._tacticalName = this._createName(startX + LOADOUT_COLUMN_WIDTH * 3, nameY);
    }

    private _createLabel(xOffset: number, stringKey: mod.Any, yPos: number): UIText {
        return new UIText({
            parent: this._container,
            anchor: mod.UIAnchor.BottomCenter,
            x: xOffset,
            y: yPos,
            width: LOADOUT_COLUMN_WIDTH,
            height: 25,
            message: mod.Message(stringKey),
            textSize: 16,
            textColor: LOADOUT_COLORS.GRAY,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.BottomCenter,
            visible: true,
        });
    }

    private _createName(xOffset: number, yPos: number): UIText {
        return new UIText({
            parent: this._container,
            anchor: mod.UIAnchor.BottomCenter,
            x: xOffset,
            y: yPos,
            width: LOADOUT_COLUMN_WIDTH,
            height: 30,
            message: mod.Message(mod.stringkeys.gunfight.loadout.empty),
            textSize: 20,
            textColor: LOADOUT_COLORS.WHITE,
            textAlpha: 0,
            textAnchor: mod.UIAnchor.BottomCenter,
            visible: true,
        });
    }

    public setLoadout(loadout: Loadout): void {
        this._currentLoadout = loadout;

        // Set weapon/gadget names from loadout
        this._primaryName.message = mod.Message(loadout.primaryName);
        this._secondaryName.message = mod.Message(loadout.secondaryName);
        this._lethalName.message = mod.Message(loadout.gadgetName);
        this._tacticalName.message = mod.Message(loadout.throwableName);
    }

    /**
     * Creates a weapon package from an attachments array
     */
    private _createWeaponPackage(attachments: mod.WeaponAttachments[]): mod.WeaponPackage {
        const pkg = mod.CreateNewWeaponPackage();
        for (const attachment of attachments) {
            mod.AddAttachmentToWeaponPackage(attachment, pkg);
        }
        return pkg;
    }

    private _createImages(): void {
        if (this._imagesCreated || !this._currentLoadout) return;

        _createImagesCalls++;
        logLoadout('_createImages', { callNumber: _createImagesCalls, instanceId: this._instanceId });

        // Clear any existing images first
        this._deleteImages();

        const containerWidget = this._container.uiWidget;
        if (!containerWidget) return;

        const startX = -((LOADOUT_COLUMN_WIDTH * 4) / 2) + LOADOUT_COLUMN_WIDTH / 2;
        const imageY = 75; // Position above the labels

        const loadout = this._currentLoadout;

        try {
            // Primary weapon image (only if not null)
            if (loadout.primary !== null) {
                const primaryImgName = `loadout_primary_${this._instanceId}`;
                // Use custom attachments if provided, otherwise use stock attachments
                const primaryAttachments =
                    loadout.primaryAttachments && loadout.primaryAttachments.length > 0
                        ? loadout.primaryAttachments
                        : getStockAttachments(loadout.primary);
                const primaryPkg = this._createWeaponPackage(primaryAttachments);
                mod.AddUIWeaponImage(
                    primaryImgName,
                    mod.CreateVector(startX, imageY, 0),
                    mod.CreateVector(LOADOUT_WEAPON_IMAGE_WIDTH, LOADOUT_WEAPON_IMAGE_HEIGHT, 1),
                    mod.UIAnchor.BottomCenter,
                    loadout.primary,
                    containerWidget,
                    primaryPkg
                );
                this._imageNames.push(primaryImgName);
            }

            // Secondary weapon image (only if not null)
            if (loadout.secondary !== null) {
                const secondaryImgName = `loadout_secondary_${this._instanceId}`;
                // Use custom attachments if provided, otherwise use stock attachments
                const secondaryAttachments =
                    loadout.secondaryAttachments && loadout.secondaryAttachments.length > 0
                        ? loadout.secondaryAttachments
                        : getStockAttachments(loadout.secondary);
                const secondaryPkg = this._createWeaponPackage(secondaryAttachments);
                mod.AddUIWeaponImage(
                    secondaryImgName,
                    mod.CreateVector(startX + LOADOUT_COLUMN_WIDTH, imageY, 0),
                    mod.CreateVector(LOADOUT_WEAPON_IMAGE_WIDTH, LOADOUT_WEAPON_IMAGE_HEIGHT, 1),
                    mod.UIAnchor.BottomCenter,
                    loadout.secondary,
                    containerWidget,
                    secondaryPkg
                );
                this._imageNames.push(secondaryImgName);
            }

            // Gadget image (larger)
            const gadgetImgName = `loadout_gadget_${this._instanceId}`;
            mod.AddUIGadgetImage(
                gadgetImgName,
                mod.CreateVector(startX + LOADOUT_COLUMN_WIDTH * 2, imageY, 0),
                mod.CreateVector(LOADOUT_GADGET_IMAGE_SIZE, LOADOUT_GADGET_IMAGE_SIZE, 1),
                mod.UIAnchor.BottomCenter,
                loadout.gadget,
                containerWidget
            );
            this._imageNames.push(gadgetImgName);

            // Throwable image (larger)
            const throwableImgName = `loadout_throwable_${this._instanceId}`;
            mod.AddUIGadgetImage(
                throwableImgName,
                mod.CreateVector(startX + LOADOUT_COLUMN_WIDTH * 3, imageY, 0),
                mod.CreateVector(LOADOUT_GADGET_IMAGE_SIZE, LOADOUT_GADGET_IMAGE_SIZE, 1),
                mod.UIAnchor.BottomCenter,
                loadout.throwable,
                containerWidget
            );
            this._imageNames.push(throwableImgName);

            this._imagesCreated = true;
        } catch (e) {
            // Images failed
        }
    }

    private _deleteImages(): void {
        if (this._imageNames.length > 0) {
            _deleteImagesCalls++;
            logLoadout('_deleteImages', { callNumber: _deleteImagesCalls, imageCount: this._imageNames.length });
        }

        for (const name of this._imageNames) {
            try {
                const widget = mod.FindUIWidgetWithName(name);
                if (widget) {
                    mod.DeleteUIWidget(widget);
                }
            } catch (e) {
                // Widget not found or already deleted
            }
        }
        this._imageNames = [];
        this._imagesCreated = false;
    }

    public async fadeIn(): Promise<void> {
        if (this._isVisible) return;
        this._isVisible = true;

        // Create images when fading in
        this._createImages();

        return new Promise<void>((resolve) => {
            let elapsed = 0;

            this._animationTimer = Timers.setInterval(() => {
                elapsed += LOADOUT_ANIMATION_TICK;
                const progress = Math.min(elapsed / LOADOUT_FADE_DURATION, 1);

                this._setAlpha(progress);

                if (progress >= 1) {
                    this._clearTimer();
                    resolve();
                }
            }, LOADOUT_ANIMATION_TICK);
        });
    }

    public async fadeOut(): Promise<void> {
        if (!this._isVisible) return;

        return new Promise<void>((resolve) => {
            let elapsed = 0;

            this._animationTimer = Timers.setInterval(() => {
                elapsed += LOADOUT_ANIMATION_TICK;
                const progress = Math.min(elapsed / LOADOUT_FADE_DURATION, 1);

                this._setAlpha(1 - progress);

                if (progress >= 1) {
                    this._isVisible = false;
                    // Delete images when fully faded out
                    this._deleteImages();
                    this._clearTimer();
                    resolve();
                }
            }, LOADOUT_ANIMATION_TICK);
        });
    }

    public hide(): void {
        this._setAlpha(0);
        this._deleteImages();
        this._isVisible = false;
    }

    private _setAlpha(alpha: number): void {
        this._background.bgAlpha = alpha * 0.8;
        this._header.textAlpha = alpha;
        this._primaryLabel.textAlpha = alpha;
        this._primaryName.textAlpha = alpha;
        this._secondaryLabel.textAlpha = alpha;
        this._secondaryName.textAlpha = alpha;
        this._lethalLabel.textAlpha = alpha;
        this._lethalName.textAlpha = alpha;
        this._tacticalLabel.textAlpha = alpha;
        this._tacticalName.textAlpha = alpha;
    }

    private _clearTimer(): void {
        if (this._animationTimer !== null) {
            Timers.clearInterval(this._animationTimer);
            this._animationTimer = null;
        }
    }

    public destroy(): void {
        this._clearTimer();
        this._deleteImages();
        this._background.delete();
        this._container.delete();
    }

    public get isVisible(): boolean {
        return this._isVisible;
    }

    /**
     * Applies weapons only to a player (primary + secondary) and heals
     * Called at round start during freeze
     */
    public static applyWeaponsToPlayer(player: mod.Player, loadout: Loadout): void {
        _applyWeaponsCalls++;
        const playerId = mod.GetObjId(player);
        logLoadout('applyWeaponsToPlayer', {
            playerId,
            callNumber: _applyWeaponsCalls,
            primary: loadout.primary,
            secondary: loadout.secondary,
        });

        try {
            // Heal player to full health
            mod.Heal(player, 1000);

            // Remove any existing equipment from previous round (ignore errors for empty slots)
            _equipmentRemoves += 4;
            try {
                mod.RemoveEquipment(player, mod.InventorySlots.MiscGadget);
            } catch {}
            try {
                mod.RemoveEquipment(player, mod.InventorySlots.Throwable);
            } catch {}
            try {
                mod.RemoveEquipment(player, mod.InventorySlots.PrimaryWeapon);
            } catch {}
            try {
                mod.RemoveEquipment(player, mod.InventorySlots.SecondaryWeapon);
            } catch {}

            // Add melee weapon (knife) - always available
            _equipmentRemoves++;
            try {
                mod.RemoveEquipment(player, mod.InventorySlots.MeleeWeapon);
            } catch {}
            _equipmentAdds++;
            mod.AddEquipment(player, mod.Gadgets.Melee_Combat_Knife, mod.InventorySlots.MeleeWeapon);

            // Add primary weapon - always create package with attachments
            if (loadout.primary !== null) {
                _equipmentAdds++;
                const primaryPackage = mod.CreateNewWeaponPackage();
                const primaryAttachments =
                    loadout.primaryAttachments && loadout.primaryAttachments.length > 0
                        ? loadout.primaryAttachments
                        : getStockAttachments(loadout.primary);
                for (const attachment of primaryAttachments) {
                    mod.AddAttachmentToWeaponPackage(attachment, primaryPackage);
                }
                mod.AddEquipment(player, loadout.primary, primaryPackage);
            }

            // Add secondary weapon - always create package with attachments
            if (loadout.secondary !== null) {
                _equipmentAdds++;
                const secondaryPackage = mod.CreateNewWeaponPackage();
                const secondaryAttachments =
                    loadout.secondaryAttachments && loadout.secondaryAttachments.length > 0
                        ? loadout.secondaryAttachments
                        : getStockAttachments(loadout.secondary);
                for (const attachment of secondaryAttachments) {
                    mod.AddAttachmentToWeaponPackage(attachment, secondaryPackage);
                }
                mod.AddEquipment(player, loadout.secondary, secondaryPackage);
            }

            logLoadout('LOADOUT STATS', {
                totalApplyWeaponsCalls: _applyWeaponsCalls,
                totalApplyGadgetsCalls: _applyGadgetsCalls,
                totalEquipmentAdds: _equipmentAdds,
                totalEquipmentRemoves: _equipmentRemoves,
            });
        } catch (e) {
            // Equipment application failed
            logLoadout('applyWeaponsToPlayer FAILED', { playerId, error: e });
        }
    }

    /**
     * Applies gadgets and throwables to a player
     * Called after freeze ends so players can't use them during countdown
     */
    public static applyGadgetsToPlayer(player: mod.Player, loadout: Loadout): void {
        _applyGadgetsCalls++;
        const playerId = mod.GetObjId(player);
        logLoadout('applyGadgetsToPlayer', {
            playerId,
            callNumber: _applyGadgetsCalls,
            gadget: loadout.gadget,
            throwable: loadout.throwable,
        });

        try {
            _equipmentAdds += 2;
            // Add gadget (misc gadget slot - equipment gadget)
            mod.AddEquipment(player, loadout.gadget, mod.InventorySlots.MiscGadget);
            // Add throwable (throwable slot - grenades, etc.)
            mod.AddEquipment(player, loadout.throwable, mod.InventorySlots.Throwable);
        } catch (e) {
            // Equipment application failed
            logLoadout('applyGadgetsToPlayer FAILED', { playerId, error: e });
        }
    }

    /**
     * Applies the full loadout to a player (weapons + gadgets + heal)
     * Use applyWeaponsToPlayer + applyGadgetsToPlayer for delayed gadget application
     */
    public static applyLoadoutToPlayer(player: mod.Player, loadout: Loadout): void {
        LoadoutUI.applyWeaponsToPlayer(player, loadout);
        LoadoutUI.applyGadgetsToPlayer(player, loadout);
    }
}
