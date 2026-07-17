/**
 * Loadout system — weapon/attachment pools + randomized loadout picking.
 * Extracted from index.ts (2026-07-17). Pure data + pure helpers + the bag-randomizer state.
 * Custom loadouts (with attachments) are more common than stock; 50/50 primary-only vs secondary-only.
 */
import type { Loadout } from './ui/loadout-ui.ts';

// ============================================================================
// LOADOUT SYSTEM
// ============================================================================
// Custom loadouts (with attachments) are more common than stock weapons
// 50/50 chance for primary-only or secondary-only loadouts
// ============================================================================

// Attachment aliases for compression
const A = mod.WeaponAttachments;
const W = mod.Weapons;
const G = mod.Gadgets;
const SK = mod.stringkeys.gunfight.loadout;

// Build attachment slot lookup map from enum keys
const attachmentSlotMap = new Map<mod.WeaponAttachments, string>();
for (const key of Object.keys(mod.WeaponAttachments)) {
    // Skip numeric keys (reverse mapping)
    if (!isNaN(Number(key))) continue;
    const value = (mod.WeaponAttachments as unknown as Record<string, number>)[key];
    if (key.startsWith('Scope_Piggyback_')) attachmentSlotMap.set(value, 'piggyback');
    else if (key.startsWith('Scope_')) attachmentSlotMap.set(value, 'scope');
    else if (key.startsWith('Muzzle_')) attachmentSlotMap.set(value, 'muzzle');
    else if (key.startsWith('Barrel_')) attachmentSlotMap.set(value, 'barrel');
    else if (key.startsWith('Magazine_')) attachmentSlotMap.set(value, 'magazine');
    else if (key.startsWith('Ammo_')) attachmentSlotMap.set(value, 'ammo');
    else if (key.startsWith('Bottom_')) attachmentSlotMap.set(value, 'bottom');
    else if (key.startsWith('Left_')) attachmentSlotMap.set(value, 'left');
    else if (key.startsWith('Right_')) attachmentSlotMap.set(value, 'right');
    else if (key.startsWith('Top_')) attachmentSlotMap.set(value, 'top');
    else if (key.startsWith('Ergonomic_')) attachmentSlotMap.set(value, 'ergonomic');
}

// Attachment slot detection - determines which slot an attachment belongs to
function getAttachmentSlot(attachment: mod.WeaponAttachments): string {
    return attachmentSlotMap.get(attachment) || 'unknown';
}

// Fill missing attachment slots with stock defaults
export function getCompleteAttachments(
    weapon: mod.Weapons,
    customAttachments: mod.WeaponAttachments[]
): mod.WeaponAttachments[] {
    // Get stock attachments for this weapon
    const stockAttachments = getStockAttachments(weapon);

    // Determine which slots are already filled by custom attachments
    const filledSlots = new Set<string>();
    for (const att of customAttachments) {
        filledSlots.add(getAttachmentSlot(att));
    }

    // Start with custom attachments
    const result = [...customAttachments];

    // Add stock attachments for any missing slots
    for (const stockAtt of stockAttachments) {
        const slot = getAttachmentSlot(stockAtt);
        if (!filledSlots.has(slot)) {
            result.push(stockAtt);
            filledSlots.add(slot);
        }
    }

    return result;
}

// Stock attachment helper functions - using explicit conditionals for reliable matching
export function getStockAttachments(w: mod.Weapons): mod.WeaponAttachments[] {
    const attachments: mod.WeaponAttachments[] = [];

    // Add scope (most weapons use iron sights, UMG-40 uses CQB sights)
    if (w === W.SMG_UMG_40) attachments.push(A.Scope_CQB_Sights);
    else attachments.push(A.Scope_Iron_Sights);

    // Add ammo type (shotguns use buckshot, others use FMJ)
    const isShotgun =
        w === W.Shotgun_M87A1 || w === W.Shotgun_M1014 || w === W.Shotgun__185KS_K || w === W.Shotgun_DB_12;
    attachments.push(isShotgun ? A.Ammo_Buckshot : A.Ammo_FMJ);

    // Add stock barrel (explicit conditionals for reliable enum matching)
    const barrel = getStockBarrel(w);
    if (barrel !== null) attachments.push(barrel);

    // Add stock magazine (explicit conditionals for reliable enum matching)
    const magazine = getStockMagazine(w);
    if (magazine !== null) attachments.push(magazine);

    // Special underbarrel for some weapons
    if (w === W.Sidearm_M45A1) attachments.push(A.Bottom_Laser_Light_Combo_Green);
    if (w === W.DMR_LMR27) attachments.push(A.Bottom_Factory_Angled);
    if (w === W.SMG_SL9) attachments.push(A.Bottom_Factory_Angled);

    return attachments;
}

function getStockBarrel(w: mod.Weapons): mod.WeaponAttachments | null {
    // Assault Rifles
    if (w === W.AssaultRifle_M433) return A.Barrel_145_Standard;
    if (w === W.AssaultRifle_B36A4) return A.Barrel_480mm_Factory;
    if (w === W.AssaultRifle_SOR_556_Mk2) return A.Barrel_145_Factory;
    if (w === W.AssaultRifle_AK4D) return A.Barrel_450mm_Factory;
    if (w === W.AssaultRifle_TR_7) return A.Barrel_17_Factory;
    if (w === W.AssaultRifle_KORD_6P67) return A.Barrel_415mm_Factory;
    if (w === W.AssaultRifle_NVO_228E) return A.Barrel_409mm_Factory;
    if (w === W.AssaultRifle_L85A3) return A.Barrel_518mm_Factory;
    // Shotguns
    if (w === W.Shotgun_M87A1) return A.Barrel_20_Factory;
    if (w === W.Shotgun_M1014) return A.Barrel_185_Factory;
    if (w === W.Shotgun__185KS_K) return A.Barrel_430mm_Factory;
    if (w === W.Shotgun_DB_12) return A.Barrel_189_Factory;
    // Pistols
    if (w === W.Sidearm_P18) return A.Barrel_39_Factory;
    if (w === W.Sidearm_ES_57) return A.Barrel_122mm_Factory;
    if (w === W.Sidearm_M45A1) return A.Barrel_5_Factory;
    if (w === W.Sidearm_M44) return A.Barrel_675_Factory;
    if (w === W.Sidearm_GGH_22) return A.Barrel_114mm_Factory;
    if (w === W.Sidearm_M357_Trait) return A.Barrel_5_Factory;
    // Snipers
    if (w === W.Sniper_M2010_ESR) return A.Barrel_24_Full;
    if (w === W.Sniper_SV_98) return A.Barrel_650mm_Factory;
    if (w === W.Sniper_PSR) return A.Barrel_26_Factory;
    if (w === W.Sniper_Mini_Scout) return A.Barrel_16_Factory;
    // DMRs
    if (w === W.DMR_M39_EMR) return A.Barrel_22_Factory;
    if (w === W.DMR_LMR27) return A.Barrel_215_Factory;
    if (w === W.DMR_SVK_86) return A.Barrel_560mm_Factory;
    if (w === W.DMR_SVDM) return A.Barrel_550mm_Factory;
    // LMGs
    if (w === W.LMG_L110) return A.Barrel_349mm_SB;
    if (w === W.LMG_DRS_IAR) return A.Barrel_165_Basic;
    if (w === W.LMG_M_60) return A.Barrel_17_Factory;
    if (w === W.LMG_RPKM) return A.Barrel_590mm_Factory;
    if (w === W.LMG_M123K) return A.Barrel_612mm_VMW;
    if (w === W.LMG_M250) return A.Barrel_556mm_Prototype;
    if (w === W.LMG_KTS100_MK8) return A.Barrel_508mm_Mk8;
    if (w === W.LMG_M240L) return A.Barrel_20_Lima;
    // SMGs
    if (w === W.SMG_SGX) return A.Barrel_6_Standard;
    if (w === W.SMG_PW5A3) return A.Barrel_225mm_Factory;
    if (w === W.SMG_PW7A2) return A.Barrel_180mm_Standard;
    if (w === W.SMG_UMG_40) return A.Barrel_200mm_Factory;
    if (w === W.SMG_USG_90) return A.Barrel_264mm_Factory;
    if (w === W.SMG_KV9) return A.Barrel_55_Factory;
    if (w === W.SMG_SCW_10) return A.Barrel_68_Factory;
    if (w === W.SMG_SL9) return A.Barrel_11_Heavy;
    // Carbines
    if (w === W.Carbine_M4A1) return A.Barrel_145_Carbine;
    if (w === W.Carbine_M277) return A.Barrel_16_Custom;
    if (w === W.Carbine_AK_205) return A.Barrel_314mm_Prototype;
    if (w === W.Carbine_M417_A2) return A.Barrel_165_Rifle;
    if (w === W.Carbine_GRT_BC) return A.Barrel_145_Alt;
    if (w === W.Carbine_QBZ_192) return A.Barrel_105_Factory;
    if (w === W.Carbine_SG_553R) return A.Barrel_303mm_LB;
    if (w === W.Carbine_SOR_300SC) return A.Barrel_105_Custom;
    return null;
}

function getStockMagazine(w: mod.Weapons): mod.WeaponAttachments | null {
    // Assault Rifles
    if (w === W.AssaultRifle_M433) return A.Magazine_20rnd_Magazine;
    if (w === W.AssaultRifle_B36A4) return A.Magazine_20rnd_Magazine;
    if (w === W.AssaultRifle_SOR_556_Mk2) return A.Magazine_20rnd_Magazine;
    if (w === W.AssaultRifle_AK4D) return A.Magazine_15rnd_Magazine;
    if (w === W.AssaultRifle_TR_7) return A.Magazine_10rnd_Fast_Mag;
    if (w === W.AssaultRifle_KORD_6P67) return A.Magazine_30rnd_Magazine;
    if (w === W.AssaultRifle_NVO_228E) return A.Magazine_20rnd_Magazine;
    if (w === W.AssaultRifle_L85A3) return A.Magazine_20rnd_Magazine;
    // Shotguns
    if (w === W.Shotgun_M87A1) return A.Magazine_5_Shell_Tube;
    if (w === W.Shotgun_M1014) return A.Magazine_4_Shell_Tube;
    if (w === W.Shotgun__185KS_K) return A.Magazine_4rnd_Magazine;
    if (w === W.Shotgun_DB_12) return A.Magazine_7_Shell_Dual_Tubes;
    // Pistols
    if (w === W.Sidearm_P18) return A.Magazine_17rnd_Magazine;
    if (w === W.Sidearm_ES_57) return A.Magazine_20rnd_Magazine;
    if (w === W.Sidearm_M45A1) return A.Magazine_7rnd_Magazine;
    if (w === W.Sidearm_M44) return A.Magazine_6rnd_Speedloader;
    if (w === W.Sidearm_GGH_22) return A.Magazine_15rnd_Magazine;
    if (w === W.Sidearm_M357_Trait) return A.Magazine_8rnd_Speedloader;
    // Snipers
    if (w === W.Sniper_M2010_ESR) return A.Magazine_5rnd_Magazine;
    if (w === W.Sniper_SV_98) return A.Magazine_10rnd_Magazine;
    if (w === W.Sniper_PSR) return A.Magazine_7rnd_Magazine;
    if (w === W.Sniper_Mini_Scout) return A.Magazine_10rnd_Magazine;
    // DMRs
    if (w === W.DMR_M39_EMR) return A.Magazine_15rnd_Magazine;
    if (w === W.DMR_LMR27) return A.Magazine_10rnd_Magazine;
    if (w === W.DMR_SVK_86) return A.Magazine_10rnd_Magazine;
    if (w === W.DMR_SVDM) return A.Magazine_5rnd_Magazine;
    // LMGs
    if (w === W.LMG_L110) return A.Magazine_100rnd_Belt_Pouch;
    if (w === W.LMG_DRS_IAR) return A.Magazine_30rnd_Magazine;
    if (w === W.LMG_M_60) return A.Magazine_50rnd_Loose_Belt;
    if (w === W.LMG_RPKM) return A.Magazine_30rnd_Magazine;
    if (w === W.LMG_M123K) return A.Magazine_100rnd_Belt_Pouch;
    if (w === W.LMG_M250) return A.Magazine_50rnd_Belt_Pouch;
    if (w === W.LMG_KTS100_MK8) return A.Magazine_45rnd_Magazine;
    if (w === W.LMG_M240L) return A.Magazine_50rnd_Loose_Belt;
    // SMGs
    if (w === W.SMG_SGX) return A.Magazine_30rnd_Magazine;
    if (w === W.SMG_PW5A3) return A.Magazine_20rnd_Magazine;
    if (w === W.SMG_PW7A2) return A.Magazine_20rnd_Magazine;
    if (w === W.SMG_UMG_40) return A.Magazine_25rnd_Magazine;
    if (w === W.SMG_USG_90) return A.Magazine_50rnd_Magazine;
    if (w === W.SMG_KV9) return A.Magazine_17rnd_Magazine;
    if (w === W.SMG_SCW_10) return A.Magazine_15rnd_Magazine;
    if (w === W.SMG_SL9) return A.Magazine_30rnd_Magazine;
    // Carbines
    if (w === W.Carbine_M4A1) return A.Magazine_20rnd_Magazine;
    if (w === W.Carbine_M277) return A.Magazine_15rnd_Magazine;
    if (w === W.Carbine_AK_205) return A.Magazine_30rnd_Magazine;
    if (w === W.Carbine_M417_A2) return A.Magazine_10rnd_Magazine;
    if (w === W.Carbine_GRT_BC) return A.Magazine_30rnd_Magazine;
    if (w === W.Carbine_QBZ_192) return A.Magazine_30rnd_Magazine;
    if (w === W.Carbine_SG_553R) return A.Magazine_20rnd_Magazine;
    if (w === W.Carbine_SOR_300SC) return A.Magazine_20rnd_Magazine;
    return null;
}

// Stock primary weapons pool (all primaries from weapon-configs.ts)
const STOCK_PRIMARIES: { weapon: mod.Weapons; name: mod.Any }[] = [
    // Assault Rifles
    { weapon: W.AssaultRifle_M433, name: SK.weapons.m433 },
    { weapon: W.AssaultRifle_B36A4, name: SK.weapons.b36a4 },
    { weapon: W.AssaultRifle_SOR_556_Mk2, name: SK.weapons.sor556mk2 },
    { weapon: W.AssaultRifle_AK4D, name: SK.weapons.ak4d },
    { weapon: W.AssaultRifle_TR_7, name: SK.weapons.tr7 },
    { weapon: W.AssaultRifle_KORD_6P67, name: SK.weapons.kord6p67 },
    { weapon: W.AssaultRifle_NVO_228E, name: SK.weapons.nvo228e },
    { weapon: W.AssaultRifle_L85A3, name: SK.weapons.l85a3 },
    // Shotguns
    { weapon: W.Shotgun_M87A1, name: SK.weapons.m87a1 },
    { weapon: W.Shotgun_M1014, name: SK.weapons.m1014 },
    { weapon: W.Shotgun__185KS_K, name: SK.weapons['185ksk'] },
    { weapon: W.Shotgun_DB_12, name: SK.weapons.db12 },
    // Snipers
    { weapon: W.Sniper_M2010_ESR, name: SK.weapons.m2010 },
    { weapon: W.Sniper_SV_98, name: SK.weapons.sv98 },
    { weapon: W.Sniper_PSR, name: SK.weapons.psr },
    { weapon: W.Sniper_Mini_Scout, name: SK.weapons.miniscout },
    // DMRs
    { weapon: W.DMR_M39_EMR, name: SK.weapons.m39emr },
    { weapon: W.DMR_LMR27, name: SK.weapons.lmr27 },
    { weapon: W.DMR_SVK_86, name: SK.weapons.svk86 },
    { weapon: W.DMR_SVDM, name: SK.weapons.svdm },
    // LMGs
    { weapon: W.LMG_L110, name: SK.weapons.l110 },
    { weapon: W.LMG_DRS_IAR, name: SK.weapons.drsiar },
    { weapon: W.LMG_M_60, name: SK.weapons.m60 },
    { weapon: W.LMG_RPKM, name: SK.weapons.rpkm },
    { weapon: W.LMG_M123K, name: SK.weapons.m123k },
    { weapon: W.LMG_M250, name: SK.weapons.m250 },
    { weapon: W.LMG_KTS100_MK8, name: SK.weapons.kts100mk8 },
    { weapon: W.LMG_M240L, name: SK.weapons.m240l },
    // SMGs
    { weapon: W.SMG_SGX, name: SK.weapons.sgx },
    { weapon: W.SMG_PW5A3, name: SK.weapons.pw5a3 },
    { weapon: W.SMG_PW7A2, name: SK.weapons.pw7a2 },
    { weapon: W.SMG_UMG_40, name: SK.weapons.umg40 },
    { weapon: W.SMG_USG_90, name: SK.weapons.usg90 },
    { weapon: W.SMG_KV9, name: SK.weapons.kv9 },
    { weapon: W.SMG_SCW_10, name: SK.weapons.scw10 },
    { weapon: W.SMG_SL9, name: SK.weapons.sl9 },
    // Carbines
    { weapon: W.Carbine_M4A1, name: SK.weapons.m4a1 },
    { weapon: W.Carbine_M277, name: SK.weapons.m277 },
    { weapon: W.Carbine_AK_205, name: SK.weapons.ak205 },
    { weapon: W.Carbine_M417_A2, name: SK.weapons.m417a2 },
    { weapon: W.Carbine_GRT_BC, name: SK.weapons.grtbc },
    { weapon: W.Carbine_QBZ_192, name: SK.weapons.qbz192 },
    { weapon: W.Carbine_SG_553R, name: SK.weapons.sg553r },
    { weapon: W.Carbine_SOR_300SC, name: SK.weapons.sor300sc },
];

// Stock secondary weapons pool (all pistols from weapon-configs.ts)
const STOCK_SECONDARIES: { weapon: mod.Weapons; name: mod.Any }[] = [
    { weapon: W.Sidearm_P18, name: SK.weapons.p18 },
    { weapon: W.Sidearm_ES_57, name: SK.weapons.es57 },
    { weapon: W.Sidearm_M45A1, name: SK.weapons.m45a1 },
    { weapon: W.Sidearm_M44, name: SK.weapons.m44r },
    { weapon: W.Sidearm_GGH_22, name: SK.weapons.ggh22 },
    { weapon: W.Sidearm_M357_Trait, name: SK.weapons.m357 },
];

// Gadget pool - regular gadgets (secondary weapon allowed)
const GADGET_POOL: { gadget: mod.Gadgets; name: mod.Any; isLauncher?: boolean }[] = [
    { gadget: G.Class_Adrenaline_Injector, name: SK.gadgets.stim },
    { gadget: G.Misc_Demolition_Charge, name: SK.gadgets.c4 },
    { gadget: G.Misc_Anti_Personnel_Mine, name: SK.gadgets.claymore },
    { gadget: G.Deployable_EOD_Bot, name: SK.gadgets.eod_bot },
    { gadget: G.Deployable_Recon_Drone, name: SK.gadgets.recon_drone },
    { gadget: G.Misc_Tracer_Dart, name: SK.gadgets.tracer_dart },
    // Launchers - no secondary weapon when these are equipped
    { gadget: G.Launcher_Unguided_Rocket, name: SK.gadgets.launcher_rpg, isLauncher: true },
    { gadget: G.Launcher_Aim_Guided, name: SK.gadgets.launcher_guided, isLauncher: true },
    { gadget: G.Launcher_Breaching_Projectile, name: SK.gadgets.launcher_breaching, isLauncher: true },
    { gadget: G.Launcher_Incendiary_Airburst, name: SK.gadgets.launcher_incendiary, isLauncher: true },
    { gadget: G.Launcher_Smoke_Grenade, name: SK.gadgets.launcher_smoke, isLauncher: true },
    { gadget: G.Misc_Incendiary_Round_Shotgun, name: SK.gadgets.incendiary_shotgun, isLauncher: true },
];

// Throwable pool (includes throwing knife)
const THROWABLE_POOL: { throwable: mod.Gadgets; name: mod.Any }[] = [
    { throwable: G.Throwable_Fragmentation_Grenade, name: SK.throwables.frag },
    { throwable: G.Throwable_Smoke_Grenade, name: SK.throwables.smoke },
    { throwable: G.Throwable_Flash_Grenade, name: SK.throwables.flash },
    { throwable: G.Throwable_Stun_Grenade, name: SK.throwables.stun },
    { throwable: G.Throwable_Incendiary_Grenade, name: SK.throwables.incendiary },
    { throwable: G.Throwable_Throwing_Knife, name: SK.throwables.throwing_knife },
    { throwable: G.Throwable_Mini_Frag_Grenade, name: SK.throwables.mini_frag },
    { throwable: G.Throwable_Anti_Vehicle_Grenade, name: SK.throwables.av_grenade },
];

// Custom primary weapons with predetermined attachments
// Secondary, gadget, and throwable are randomized at runtime
interface CustomPrimary {
    weapon: mod.Weapons;
    name: mod.Any;
    attachments: mod.WeaponAttachments[];
}

const CUSTOM_PRIMARY_POOL: CustomPrimary[] = [
    {
        weapon: W.Sniper_PSR,
        name: SK.weapons.psr,
        attachments: [
            A.Scope_TS_HD_600x,
            A.Muzzle_Long_Suppressor,
            A.Barrel_27_MK22,
            A.Left_Range_Finder,
            A.Magazine_10rnd_Magazine,
            A.Ammo_Match_Grade,
            A.Bottom_Slim_Angled,
        ],
    },
    {
        weapon: W.LMG_DRS_IAR,
        name: SK.weapons.drsiar,
        attachments: [
            A.Scope_RO_S_125x,
            A.Muzzle_Lightened_Suppressor,
            A.Barrel_145_Carbine,
            A.Bottom_Canted_Stubby,
            A.Magazine_40rnd_Fast_Mag,
            A.Top_50_mW_Blue,
        ],
    },
    {
        weapon: W.AssaultRifle_KORD_6P67,
        name: SK.weapons.kord6p67,
        attachments: [
            A.Scope_SU_123_150x,
            A.Muzzle_Double_port_Brake,
            A.Barrel_11_Heavy,
            A.Bottom_Canted_Stubby,
            A.Magazine_36rnd_Magazine,
            A.Right_50_mW_Blue,
        ],
    },
    {
        weapon: W.Carbine_M277,
        name: SK.weapons.m277,
        attachments: [
            A.Scope_PVQ_31_400x,
            A.Muzzle_Lightened_Suppressor,
            A.Barrel_11_Heavy,
            A.Bottom_Full_Angled,
            A.Magazine_25rnd_Fast_Mag,
            A.Ergonomic_Improved_Mag_Catch,
            A.Top_5_mW_Green,
        ],
    },
    {
        weapon: W.SMG_UMG_40,
        name: SK.weapons.umg40,
        attachments: [
            A.Scope_Aperture_Sight,
            A.Right_50_mW_Green,
            A.Muzzle_CQB_Suppressor,
            A.Barrel_11_Heavy,
            A.Bottom_Canted_Stubby,
            A.Magazine_30rnd_Fast_Mag,
            A.Ammo_Hollow_Point,
        ],
    },
    {
        weapon: W.Sniper_Mini_Scout,
        name: SK.weapons.miniscout,
        attachments: [
            A.Scope_S_VPS_600x,
            A.Scope_Canted_Iron_Sights,
            A.Muzzle_CQB_Suppressor,
            A.Barrel_349mm_Fluted,
            A.Right_120_mW_Blue,
            A.Bottom_Slim_Angled,
            A.Magazine_10rnd_Fast_Mag,
        ],
    },
    {
        weapon: W.Shotgun_M87A1,
        name: SK.weapons.m87a1,
        attachments: [A.Scope_Iron_Sights, A.Bottom_Full_Angled, A.Right_50_mW_Green, A.Left_Flashlight],
    },
    {
        weapon: W.Shotgun_DB_12,
        name: SK.weapons.db12,
        attachments: [A.Scope_Iron_Sights, A.Bottom_Full_Angled, A.Right_50_mW_Green],
    },
    {
        weapon: W.Sniper_SV_98,
        name: SK.weapons.sv98,
        attachments: [
            A.Scope_TS_HD_600x,
            A.Scope_Canted_Iron_Sights,
            A.Muzzle_Long_Suppressor,
            A.Barrel_27_MK22,
            A.Right_120_mW_Blue,
            A.Bottom_Slim_Angled,
            A.Magazine_10rnd_Magazine,
        ],
    },
    {
        weapon: W.SMG_KV9,
        name: SK.weapons.kv9,
        attachments: [
            A.Scope_Aperture_Sight,
            A.Right_50_mW_Green,
            A.Muzzle_CQB_Suppressor,
            A.Barrel_11_Heavy,
            A.Bottom_Canted_Stubby,
            A.Magazine_30rnd_Fast_Mag,
            A.Ammo_Hollow_Point,
        ],
    },
    {
        weapon: W.LMG_M240L,
        name: SK.weapons.m240l,
        attachments: [
            A.Scope_SU_123_150x,
            A.Muzzle_Long_Suppressor,
            A.Barrel_20_Long,
            A.Right_50_mW_Green,
            A.Bottom_Classic_Grip_Pod,
            A.Magazine_75rnd_Belt_Box,
        ],
    },
    {
        weapon: W.Carbine_GRT_BC,
        name: SK.weapons.grtbc,
        attachments: [
            A.Scope_RO_M_175x,
            A.Muzzle_Lightened_Suppressor,
            A.Right_50_mW_Blue,
            A.Bottom_Low_Profile_Stubby,
            A.Magazine_30rnd_Fast_Mag,
            A.Ergonomic_Improved_Mag_Catch,
        ],
    },
    {
        weapon: W.AssaultRifle_TR_7,
        name: SK.weapons.tr7,
        attachments: [
            A.Scope_Osa_7_100x,
            A.Muzzle_Compensated_Brake,
            A.Top_50_mW_Blue,
            A.Barrel_17_Fluted,
            A.Magazine_30rnd_Magazine,
            A.Ergonomic_Improved_Mag_Catch,
        ],
    },
    {
        weapon: W.DMR_SVDM,
        name: SK.weapons.svdm,
        attachments: [
            A.Scope_ST_Prism_500x,
            A.Magazine_20rnd_Magazine,
            A.Bottom_Slim_Angled,
            A.Barrel_565mm_Fluted,
            A.Muzzle_Lightened_Suppressor,
            A.Right_120_mW_Blue,
            A.Scope_Canted_Iron_Sights,
            A.Ergonomic_Improved_Mag_Catch,
        ],
    },
    {
        weapon: W.DMR_M39_EMR,
        name: SK.weapons.m39emr,
        attachments: [
            A.Scope_Iron_Sights,
            A.Muzzle_Linear_Comp,
            A.Barrel_16_Short,
            A.Right_50_mW_Blue,
            A.Bottom_Bipod,
            A.Magazine_15rnd_Magazine,
            A.Ammo_Hollow_Point,
        ],
    },
    {
        weapon: W.AssaultRifle_M433,
        name: SK.weapons.m433,
        attachments: [
            A.Scope_Iron_Sights,
            A.Muzzle_Double_port_Brake,
            A.Barrel_165_Fluted,
            A.Magazine_20rnd_Magazine,
            A.Ergonomic_Match_Trigger,
            A.Ammo_Polymer_Case,
            A.Left_120_mW_Blue,
            A.Right_Flashlight,
        ],
    },
    {
        weapon: W.Carbine_M417_A2,
        name: SK.weapons.m417a2,
        attachments: [
            A.Scope_GRIM_150x,
            A.Muzzle_Standard_Suppressor,
            A.Barrel_165_Basic,
            A.Magazine_20rnd_Fast_Mag,
            A.Ergonomic_Magwell_Flare,
            A.Bottom_6H64_Vertical,
            A.Top_50_mW_Blue,
        ],
    },
];

// Custom secondary weapons with predetermined attachments (primary empty)
interface CustomSecondary {
    weapon: mod.Weapons;
    name: mod.Any;
    attachments: mod.WeaponAttachments[];
}

const CUSTOM_SECONDARY_POOL: CustomSecondary[] = [
    {
        weapon: W.Sidearm_ES_57,
        name: SK.weapons.es57,
        attachments: [A.Scope_RO_S_125x, A.Muzzle_CQB_Suppressor, A.Barrel_5_Pencil, A.Ergonomic_Improved_Mag_Catch],
    },
    {
        weapon: W.Sidearm_M44,
        name: SK.weapons.m44r,
        attachments: [A.Scope_Iron_Sights, A.Barrel_65_Extended, A.Ammo_Hollow_Point],
    },
    {
        weapon: W.Sidearm_M45A1,
        name: SK.weapons.m45a1,
        attachments: [
            A.Scope_R_MR_100x,
            A.Muzzle_Single_port_Brake,
            A.Barrel_5_Pencil,
            A.Magazine_11rnd_Magazine,
            A.Ergonomic_Improved_Mag_Catch,
        ],
    },
];

// Helper to pick random from array (simple random, allows repeats)
function randomFrom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

// Shuffle bag system - picks without replacement until all items used, then refills
let remainingCustomPrimaries: CustomPrimary[] = [];
let remainingCustomSecondaries: CustomSecondary[] = [];
let remainingStockPrimaries: { weapon: mod.Weapons; name: mod.Any }[] = [];
let remainingStockSecondaries: { weapon: mod.Weapons; name: mod.Any }[] = [];

function pickFromBag<T>(remaining: T[], source: T[]): T {
    if (remaining.length === 0) {
        remaining.push(...source);
    }
    const index = Math.floor(Math.random() * remaining.length);
    return remaining.splice(index, 1)[0];
}

// Generate a random loadout
// 40% chance for custom primary, 60% chance for stock
// Secondary, gadget, and throwable are always randomized
// Custom secondaries always keep secondary even with launcher, stock secondaries removed with launcher
export function getRandomLoadout(): Loadout {
    const gadget = randomFrom(GADGET_POOL);
    const throwable = randomFrom(THROWABLE_POOL);
    const isLauncher = gadget.isLauncher === true;

    // Pick random secondary (50% custom, 50% stock)
    // Custom secondaries are kept even with launcher, stock secondaries are removed with launcher
    let secondary: mod.Weapons | null = null;
    let secondaryName: mod.Any = SK.throwables.none;
    let secondaryAttachments: mod.WeaponAttachments[] | undefined;
    let isCustomSecondary = false;

    if (Math.random() < 0.5 && CUSTOM_SECONDARY_POOL.length > 0) {
        // Custom secondary - always kept, even with launcher
        const customSec = pickFromBag(remainingCustomSecondaries, CUSTOM_SECONDARY_POOL);
        secondary = customSec.weapon;
        secondaryName = customSec.name;
        secondaryAttachments = getCompleteAttachments(customSec.weapon, customSec.attachments);
        isCustomSecondary = true;
    } else if (!isLauncher) {
        // Stock secondary - only given if no launcher
        const stockSec = pickFromBag(remainingStockSecondaries, STOCK_SECONDARIES);
        secondary = stockSec.weapon;
        secondaryName = stockSec.name;
        secondaryAttachments = getStockAttachments(stockSec.weapon);
    }
    // If launcher and not custom secondary, secondary stays null

    // 40% custom primary, 60% stock primary
    if (Math.random() < 0.4) {
        const customPri = pickFromBag(remainingCustomPrimaries, CUSTOM_PRIMARY_POOL);
        return {
            primary: customPri.weapon,
            secondary: secondary as mod.Weapons,
            gadget: gadget.gadget,
            throwable: throwable.throwable,
            primaryName: customPri.name,
            secondaryName: secondaryName,
            gadgetName: gadget.name,
            throwableName: throwable.name,
            primaryAttachments: getCompleteAttachments(customPri.weapon, customPri.attachments),
            secondaryAttachments: secondaryAttachments,
        };
    }

    // Stock primary (always has secondary already selected above)
    const stockPri = pickFromBag(remainingStockPrimaries, STOCK_PRIMARIES);
    return {
        primary: stockPri.weapon,
        secondary: secondary as mod.Weapons,
        gadget: gadget.gadget,
        throwable: throwable.throwable,
        primaryName: stockPri.name,
        secondaryName: secondaryName,
        gadgetName: gadget.name,
        throwableName: throwable.name,
        primaryAttachments: getStockAttachments(stockPri.weapon),
        secondaryAttachments: secondaryAttachments,
    };
}
