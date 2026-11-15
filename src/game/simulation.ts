import {
  DILEMMA_EVENTS,
  DilemmaChoice,
  DilemmaEvent,
  MEDA_ARCHIVE_SOLS,
  MedaSolWeather,
  NasaFlareRecord,
  VERIFIED_FALLBACK_FLARES,
} from '../data/nasaTelemetry';
import {
  CAMPAIGN_CHAPTERS,
  ModuleId,
  SolCampaignChapter,
  SolHazardType,
} from '../data/campaignArc';

export const MAX_SOLS = 10;
export const MAX_BATTERY_KWH = 120;
export const MARTIAN_DUST_HEX = 0xd97736;
export const SOL_DURATION_SEC = 300; // 5 minutes per Sol
export const OPERATION_DURATION_SEC = SOL_DURATION_SEC;
export const FAST_FORWARD_UNLOCK_EARLY_SOLS_SEC = 120; // Fast Forward locked for first 2:00 on Sol 1-2
export const FAST_FORWARD_UNLOCK_LATE_SOLS_SEC = 60; // Fast Forward locked for first 1:00 on Sol 3-10
export const FAST_FORWARD_UNLOCK_SEC = FAST_FORWARD_UNLOCK_EARLY_SOLS_SEC; // Backwards-compatible Sol 1-2 constant
export const FAST_FORWARD_MULTIPLIER = 5; // 5x simulation speed once unlocked

export function getFastForwardUnlockSec(sol: number): number {
  return sol <= 2 ? FAST_FORWARD_UNLOCK_EARLY_SOLS_SEC : FAST_FORWARD_UNLOCK_LATE_SOLS_SEC;
}

export function hasUnresolvedCrisisAlert(state: MissionState): boolean {
  return (
    state.opPhase === 'crisis_brief' ||
    state.opPhase === 'decision_cards' ||
    (state.lockedChoice === null && state.pendingDilemma !== null)
  );
}
export const ROVER_POWER_COST_KWH = 10;
export const ROVER_TRAVEL_TIME_SEC = 4; // 2s outbound + 2s return
export const ROVER_WORK_DURATION_SEC = 3; // 3s laser/maintenance pause
export const ROVER_ROCK_SCIENCE_PTS = 5;

export type RoverTaskTarget = 'solar' | 'moxie' | 'rock';

export type AtmosphereAlertMode = 'none' | 'dust' | 'flare';
export type SolOperationalPhase =
  | 'crisis_brief'
  | 'decision_cards'
  | 'operation'
  | 'sol_complete';

export interface SolAtmosphereTargets {
  solProgress: number; // 0..1
  crisisIntensity: number; // 0..1
  effectiveTau: number;
  fogDensity: number;
  sunElevation: number; // 0..1 (1 = midday high, 0 = twilight)
  nightFactor: number; // 0..1
}

function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Maps the in-game MEDA Tau dust opacity index (and active emergency state)
 * to Three.js FogExp2 density, anchored at 0.015 for clear Martian morning air.
 */
export function computeTauFogDensity(
  tau: number,
  emergencyMode: AtmosphereAlertMode = 'none'
): number {
  const safeTau = Number.isFinite(tau) ? tau : 0.35;
  const tauExcess = Math.max(0, safeTau - 0.35);
  let density = 0.015 + tauExcess * 0.016;
  if (emergencyMode === 'dust') {
    density = Math.max(density, 0.026);
  } else if (emergencyMode === 'flare') {
    density = Math.max(density, 0.0205);
  }
  return clamp(Number(density.toFixed(5)), 0.015, 0.045);
}

/**
 * Computes continuous, non-snapping atmospheric targets across the 300-second Sol timeline:
 * - 0:00 Early Phase: gradual buildup toward the upcoming weather/crisis state
 * - Decision Trigger & Peak Phase: ramps smoothly to peak intensity after choice lock-in
 * - Stabilization & Dusk: gradually stabilizes as the player's directive takes effect
 */
export function computeSolAtmosphereTargets(params: {
  elapsedSec: number;
  durationSec?: number;
  decisionElapsedSec: number | null;
  baseTau: number;
  hazardType: SolHazardType;
  emergencyMode: AtmosphereAlertMode;
}): SolAtmosphereTargets {
  const duration = Math.max(1, params.durationSec ?? SOL_DURATION_SEC);
  const solProgress = clamp(params.elapsedSec / duration, 0, 1);

  let crisisIntensity: number;
  if (params.decisionElapsedSec === null) {
    // 0:00 -> Early Phase & Decision Trigger: environment shifts slowly upward as problem builds
    crisisIntensity = 0.12 + smoothstep01(0, 0.4, solProgress) * 0.62;
  } else {
    const decisionProg = clamp(params.decisionElapsedSec / duration, 0, 0.9);
    const postSpan = Math.max(0.1, 1 - decisionProg);
    const postProgress = clamp((solProgress - decisionProg) / postSpan, 0, 1);
    const entryIntensity = 0.12 + smoothstep01(0, 0.4, decisionProg) * 0.62;

    if (postProgress < 0.22) {
      // Peak Phase: ramps smoothly from decision moment to full crisis peak (1.0)
      const ramp = smoothstep01(0, 0.22, postProgress);
      crisisIntensity = entryIntensity + (1.0 - entryIntensity) * ramp;
    } else {
      // Stabilization Phase: eases down as the chosen directive & crew actions take effect
      const stabilize = smoothstep01(0.22, 1.0, postProgress);
      crisisIntensity = 1.0 - stabilize * 0.72;
    }
  }

  // Smooth solar elevation & twilight arc over the 5-minute Sol
  const twilightBell = Math.exp(-Math.pow((solProgress - 0.84) / 0.16, 2));
  const nightFactor = clamp(twilightBell * 0.85, 0, 0.85);
  const sunElevation = clamp(1 - nightFactor * 0.88 - crisisIntensity * 0.15, 0.1, 1);

  const hazardTauBoost =
    params.hazardType === 'dust'
      ? 0.35
      : params.hazardType === 'flare'
      ? 0.16
      : 0.08;
  const effectiveTau = Number((params.baseTau + crisisIntensity * hazardTauBoost).toFixed(3));
  const baseFog = computeTauFogDensity(effectiveTau, params.emergencyMode);
  const fogDensity = clamp(
    Number((baseFog + crisisIntensity * (params.hazardType === 'dust' ? 0.008 : 0.003)).toFixed(5)),
    0.015,
    0.045
  );

  return {
    solProgress,
    crisisIntensity: clamp(crisisIntensity, 0, 1),
    effectiveTau,
    fogDensity,
    sunElevation,
    nightFactor,
  };
}

export interface MissionResources {
  powerKwh: number; // 0..120
  lifeSupportPct: number; // 0..100
  crewHealthPct: number; // 0..100
  panelDustPct: number; // 0..85
  waterWallCm: number; // 8..36
  cropGrowth: number; // 1..5
  sciencePoints: number;
}

export interface ExactResources {
  powerKwh: number;
  lifeSupportPct: number;
  crewHealthPct: number;
  panelDustPct: number;
}

export interface OperationRates {
  powerPerSec: number;
  lifePerSec: number;
  healthPerSec: number;
  dustPerSec: number;
  tauShift: number;
  radDoseMsv: number;
  shieldBlockedFlare: boolean;
}

export interface ModuleActionResult {
  applied: boolean;
  reason?: string;
  nextResources: MissionResources;
  deltaPower: number;
  deltaLife: number;
  deltaHealth: number;
  deltaDust: number;
  deltaShieldCm: number;
  feedbackText: string;
}

export interface NightCycleSummary {
  solarRechargeKwh: number;
  overnightDrawKwh: number;
  netPowerKwh: number;
  netLifeSupportPct: number;
  netCrewHealthPct: number;
  netDustPct: number;
  radDoseMsv: number;
  shieldBlockedFlare: boolean;
}

export interface MissionLogEntry {
  sol: number;
  headline: string;
  detail: string;
  nasaSource: string;
  tone: 'nominal' | 'caution' | 'critical';
}

export interface DebriefReport {
  outcome: 'VICTORY' | 'DEFEAT';
  defeatReason: string | null;
  solsCompleted: number;
  finalResources: MissionResources;
  crewSafetyGrade: string;
  resourceEfficiencyGrade: string;
  scienceGrade: string;
  overallRank: string;
  totalScore: number;
}

export interface MissionState {
  sol: number;
  opPhase: SolOperationalPhase;
  operationElapsedSec: number;
  operationDurationSec: number;
  decisionElapsedSec: number | null;
  fastForwardUnlocked: boolean;
  fastForwardActive: boolean;
  speedMultiplier: number;
  lockedChoice: DilemmaChoice | null;
  operationRates: OperationRates | null;
  resources: MissionResources;
  exactResources: ExactResources;
  weather: MedaSolWeather;
  activeFlare: NasaFlareRecord;
  pendingDilemma: DilemmaEvent | null;
  usedDilemmaIds: string[];
  radiationDoseCsv: number;
  logs: MissionLogEntry[];
  debrief: DebriefReport | null;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function getSolChapter(sol: number): SolCampaignChapter {
  const index = clamp(sol - 1, 0, CAMPAIGN_CHAPTERS.length - 1);
  return CAMPAIGN_CHAPTERS[index];
}

export function getWeatherForSol(sol: number): MedaSolWeather {
  const index = clamp(sol - 1, 0, MEDA_ARCHIVE_SOLS.length - 1);
  return { ...MEDA_ARCHIVE_SOLS[index] };
}

export function pickFlareForSol(sol: number, flares: NasaFlareRecord[]): NasaFlareRecord {
  const pool = flares.length > 0 ? flares : VERIFIED_FALLBACK_FLARES;
  return pool[(sol - 1) % pool.length];
}

export function createInitialMissionState(
  flares: NasaFlareRecord[] = VERIFIED_FALLBACK_FLARES
): MissionState {
  const weather = getWeatherForSol(1);
  const activeFlare = pickFlareForSol(1, flares);
  const initialDilemma = selectNextDilemma(1, weather, activeFlare, []);
  const resources: MissionResources = {
    powerKwh: 88,
    lifeSupportPct: 80,
    crewHealthPct: 88,
    panelDustPct: 16,
    waterWallCm: 16,
    cropGrowth: 2,
    sciencePoints: 0,
  };

  return {
    sol: 1,
    opPhase: 'crisis_brief',
    operationElapsedSec: 0,
    operationDurationSec: SOL_DURATION_SEC,
    decisionElapsedSec: null,
    fastForwardUnlocked: false,
    fastForwardActive: false,
    speedMultiplier: 1,
    lockedChoice: null,
    operationRates: null,
    resources,
    exactResources: {
      powerKwh: resources.powerKwh,
      lifeSupportPct: resources.lifeSupportPct,
      crewHealthPct: resources.crewHealthPct,
      panelDustPct: resources.panelDustPct,
    },
    weather,
    activeFlare,
    pendingDilemma: initialDilemma,
    usedDilemmaIds: [],
    radiationDoseCsv: 0.01,
    logs: [
      {
        sol: 1,
        headline: 'Touchdown Confirmed at Jezero Base',
        detail:
          'All four crew members are inside the habitat. Sol 1 atmospheric monitoring is live—open decision cards to lock in your response.',
        nasaSource: `Perseverance ${weather.nasaSourceId}`,
        tone: 'nominal',
      },
    ],
    debrief: null,
  };
}

/**
 * Direct "On-Object" 3D module interactions with coupled "Zero Free Choices" trade-offs.
 */
export function performModuleAction(
  resources: MissionResources,
  moduleId: ModuleId
): ModuleActionResult {
  if (moduleId === 'solar') {
    const waterCoolCost = 3;
    if (resources.lifeSupportPct < waterCoolCost + 5) {
      return {
        applied: false,
        reason: 'Life Support water too low to cool solar wiper motors!',
        nextResources: resources,
        deltaPower: 0,
        deltaLife: 0,
        deltaHealth: 0,
        deltaDust: 0,
        deltaShieldCm: 0,
        feedbackText: 'Low Water!',
      };
    }
    const nextDust = clamp(resources.panelDustPct - 22, 0, 85);
    const dustDiff = nextDust - resources.panelDustPct;
    const solarGain = dustDiff < -5 ? 14 : 10;
    const nextPower = clamp(resources.powerKwh + solarGain, 0, MAX_BATTERY_KWH);
    const nextLife = clamp(resources.lifeSupportPct - waterCoolCost, 0, 100);
    return {
      applied: true,
      nextResources: {
        ...resources,
        powerKwh: nextPower,
        lifeSupportPct: nextLife,
        panelDustPct: nextDust,
        sciencePoints: resources.sciencePoints + 1,
      },
      deltaPower: nextPower - resources.powerKwh,
      deltaLife: nextLife - resources.lifeSupportPct,
      deltaHealth: 0,
      deltaDust: dustDiff,
      deltaShieldCm: 0,
      feedbackText:
        dustDiff < 0
          ? `+${nextPower - resources.powerKwh} kWh · Dust ${dustDiff}% · -${waterCoolCost}% H₂O`
          : `+${nextPower - resources.powerKwh} kWh Tilt Boost · -${waterCoolCost}% H₂O`,
    };
  }

  if (moduleId === 'moxie') {
    const cost = 12;
    if (resources.powerKwh < cost) {
      return {
        applied: false,
        reason: 'Need at least 12 kWh battery to run MOXIE!',
        nextResources: resources,
        deltaPower: 0,
        deltaLife: 0,
        deltaHealth: 0,
        deltaDust: 0,
        deltaShieldCm: 0,
        feedbackText: 'Need 12 kWh!',
      };
    }
    const nextPower = clamp(resources.powerKwh - cost, 0, MAX_BATTERY_KWH);
    const nextLife = clamp(resources.lifeSupportPct + 14, 0, 100);
    return {
      applied: true,
      nextResources: {
        ...resources,
        powerKwh: nextPower,
        lifeSupportPct: nextLife,
        sciencePoints: resources.sciencePoints + 2,
      },
      deltaPower: nextPower - resources.powerKwh,
      deltaLife: nextLife - resources.lifeSupportPct,
      deltaHealth: 0,
      deltaDust: 0,
      deltaShieldCm: 0,
      feedbackText: `+${nextLife - resources.lifeSupportPct}% O₂ · -${cost} kWh`,
    };
  }

  if (moduleId === 'shelter') {
    const powerCost = 14;
    const waterCost = 5;
    if (resources.powerKwh < powerCost || resources.lifeSupportPct < waterCost + 5) {
      return {
        applied: false,
        reason: 'Need 14 kWh Power & Water reserves to pump Water-Wall!',
        nextResources: resources,
        deltaPower: 0,
        deltaLife: 0,
        deltaHealth: 0,
        deltaDust: 0,
        deltaShieldCm: 0,
        feedbackText: 'Low Power/Water!',
      };
    }
    const nextPower = clamp(resources.powerKwh - powerCost, 0, MAX_BATTERY_KWH);
    const nextLife = clamp(resources.lifeSupportPct - waterCost, 0, 100);
    const nextHealth = clamp(resources.crewHealthPct + 10, 0, 100);
    const nextWall = clamp(resources.waterWallCm + 6, 8, 36);
    return {
      applied: true,
      nextResources: {
        ...resources,
        powerKwh: nextPower,
        lifeSupportPct: nextLife,
        crewHealthPct: nextHealth,
        waterWallCm: nextWall,
      },
      deltaPower: nextPower - resources.powerKwh,
      deltaLife: nextLife - resources.lifeSupportPct,
      deltaHealth: nextHealth - resources.crewHealthPct,
      deltaDust: 0,
      deltaShieldCm: nextWall - resources.waterWallCm,
      feedbackText: `Shield ${nextWall}cm · -${powerCost} kWh · -${waterCost}% H₂O`,
    };
  }

  // biodome
  const cost = 10;
  if (resources.powerKwh < cost) {
    return {
      applied: false,
      reason: 'Need at least 10 kWh battery for Bio-Dome UV lights!',
      nextResources: resources,
      deltaPower: 0,
      deltaLife: 0,
      deltaHealth: 0,
      deltaDust: 0,
      deltaShieldCm: 0,
      feedbackText: 'Need 10 kWh!',
    };
  }
  const nextPower = clamp(resources.powerKwh - cost, 0, MAX_BATTERY_KWH);
  const nextLife = clamp(resources.lifeSupportPct + 8, 0, 100);
  const nextHealth = clamp(resources.crewHealthPct + 4, 0, 100);
  return {
    applied: true,
    nextResources: {
      ...resources,
      powerKwh: nextPower,
      lifeSupportPct: nextLife,
      crewHealthPct: nextHealth,
      cropGrowth: clamp(resources.cropGrowth + 1, 1, 5),
      sciencePoints: resources.sciencePoints + 5,
    },
    deltaPower: nextPower - resources.powerKwh,
    deltaLife: nextLife - resources.lifeSupportPct,
    deltaHealth: nextHealth - resources.crewHealthPct,
    deltaDust: 0,
    deltaShieldCm: 0,
    feedbackText: `+8% O₂/Food · +5 Sci · -${cost} kWh`,
  };
}

/**
 * Simulates the Martian night cycle summary (used for tests and legacy helper).
 */
export function calculateNightCycle(
  resources: MissionResources,
  weather: MedaSolWeather,
  activeFlare: NasaFlareRecord,
  chapter: SolCampaignChapter
): NightCycleSummary {
  const tauFactor = clamp(1 - (weather.tau - 0.35) * 0.4, 0.35, 1.0);
  const dustFactor = clamp(1 - (resources.panelDustPct / 100) * 0.65, 0.38, 1.0);
  const solarRechargeKwh = Math.round(45 * tauFactor * dustFactor);
  const overnightDrawKwh = chapter.hazardType === 'cold' || weather.tempMinC <= -81 ? 26 : 22;
  const netPowerKwh = solarRechargeKwh - overnightDrawKwh;

  const netDustPct = Math.round(5 + weather.tau * 7);
  const netLifeSupportPct = -9;

  const isFlare = chapter.hazardType === 'flare' || activeFlare.radBoostMsv >= 0.7;
  const shieldStrong = resources.waterWallCm >= 22;
  const shieldBlockedFlare = isFlare && shieldStrong;

  const ambientRad = 0.67 + (isFlare ? activeFlare.radBoostMsv : 0.12);
  const shieldFactor = clamp((resources.waterWallCm - 8) / 28, 0, 1) * 0.72;
  const radDoseMsv = Number((ambientRad * (1 - shieldFactor)).toFixed(2));

  let netCrewHealthPct = -2;
  if (isFlare && !shieldStrong) {
    netCrewHealthPct = -12;
  } else if (isFlare && shieldStrong) {
    netCrewHealthPct = -1;
  }
  if (resources.lifeSupportPct < 30) {
    netCrewHealthPct -= 6;
  }

  return {
    solarRechargeKwh,
    overnightDrawKwh,
    netPowerKwh,
    netLifeSupportPct,
    netCrewHealthPct,
    netDustPct,
    radDoseMsv,
    shieldBlockedFlare,
  };
}

export function computeChoiceClimateTauShift(
  chapter: SolCampaignChapter,
  choice: DilemmaChoice | null
): number {
  let shift = 0;
  if (chapter.hazardType === 'dust') {
    shift += 0.12;
  }
  if (choice) {
    if (choice.effects.dustDelta < 0) {
      shift -= 0.08;
    } else if (choice.effects.dustDelta > 0) {
      shift += 0.16;
    }
  }
  return Number(shift.toFixed(2));
}

export function computeOperationRates(
  resources: MissionResources,
  weather: MedaSolWeather,
  activeFlare: NasaFlareRecord,
  chapter: SolCampaignChapter,
  lockedChoice: DilemmaChoice | null
): OperationRates {
  const tauFactor = clamp(1 - (weather.tau - 0.35) * 0.4, 0.35, 1.0);
  const dustFactor = clamp(1 - (resources.panelDustPct / 100) * 0.65, 0.38, 1.0);
  const solar300 = 45 * tauFactor * dustFactor;
  const draw300 = chapter.hazardType === 'cold' || weather.tempMinC <= -81 ? 26 : 22;

  const choicePowerBonus300 = lockedChoice ? lockedChoice.effects.powerKwh * 0.2 : 0;
  const choiceLifeBonus300 = lockedChoice ? lockedChoice.effects.lifeSupportPct * 0.25 : 0;

  const netPower300 = solar300 - draw300 + choicePowerBonus300;
  const cropO2Bonus = resources.cropGrowth >= 3 ? 2.5 : 0;
  const netLife300 = -9 + cropO2Bonus + choiceLifeBonus300;
  const netDust300 = 5 + weather.tau * 7;

  const isFlare = chapter.hazardType === 'flare' || activeFlare.radBoostMsv >= 0.7;
  const shieldStrong = resources.waterWallCm >= 22;
  const shieldBlockedFlare = isFlare && shieldStrong;

  const ambientRad = 0.67 + (isFlare ? activeFlare.radBoostMsv : 0.12);
  const shieldFactor = clamp((resources.waterWallCm - 8) / 28, 0, 1) * 0.72;
  const radDoseMsv = Number((ambientRad * (1 - shieldFactor)).toFixed(2));

  let netHealth300 = -2;
  if (isFlare && !shieldStrong) {
    netHealth300 = -12;
  } else if (isFlare && shieldStrong) {
    netHealth300 = -1;
  }
  if (resources.lifeSupportPct < 30) {
    netHealth300 -= 6;
  }

  return {
    powerPerSec: netPower300 / SOL_DURATION_SEC,
    lifePerSec: netLife300 / SOL_DURATION_SEC,
    healthPerSec: netHealth300 / SOL_DURATION_SEC,
    dustPerSec: netDust300 / SOL_DURATION_SEC,
    tauShift: computeChoiceClimateTauShift(chapter, lockedChoice),
    radDoseMsv,
    shieldBlockedFlare,
  };
}

export function selectNextDilemma(
  sol: number,
  weather: MedaSolWeather,
  activeFlare: NasaFlareRecord,
  usedIds: string[]
): DilemmaEvent {
  const chapter = getSolChapter(sol);
  if (chapter.dilemmaId) {
    const matched = DILEMMA_EVENTS.find((ev) => ev.id === chapter.dilemmaId);
    if (matched) return matched;
  }
  const unused = DILEMMA_EVENTS.filter((ev) => !usedIds.includes(ev.id));
  const pool = unused.length > 0 ? unused : DILEMMA_EVENTS;
  if (weather.tau >= 1.0) {
    const dustEvent = pool.find((ev) => ev.category === 'weather');
    if (dustEvent) return dustEvent;
  }
  if (activeFlare.radBoostMsv >= 0.45) {
    const radEvent = pool.find((ev) => ev.category === 'radiation');
    if (radEvent) return radEvent;
  }
  return pool[(sol - 1) % pool.length];
}

/**
 * Phase 1 transition: player clicks "Open Decision Cards" to inspect the 2 tactical choices.
 */
export function openDecisionCards(state: MissionState): MissionState {
  if (state.debrief || state.opPhase !== 'crisis_brief' || !state.pendingDilemma) {
    return state;
  }
  return {
    ...state,
    opPhase: 'decision_cards',
    fastForwardActive: false,
    speedMultiplier: 1,
  };
}

/**
 * Phase 1 -> Phase 2 transition: player locks in 1 of the 2 tactical cards.
 * Preserves the running 300-second Sol clock so atmospheric interpolation never snaps.
 */
export function lockInDecisionChoice(
  state: MissionState,
  choice: DilemmaChoice
): MissionState {
  if (state.debrief || !state.pendingDilemma) return state;
  if (state.opPhase !== 'decision_cards' && state.opPhase !== 'crisis_brief') return state;

  const chapter = getSolChapter(state.sol);
  const tauShift = computeChoiceClimateTauShift(chapter, choice);
  const shiftedTau = Number(clamp(state.weather.tau + tauShift, 0.25, 2.2).toFixed(2));
  const nextWeather: MedaSolWeather = {
    ...state.weather,
    tau: shiftedTau,
  };

  const nextExact: ExactResources = {
    powerKwh: clamp(state.exactResources.powerKwh + choice.effects.powerKwh, 0, MAX_BATTERY_KWH),
    lifeSupportPct: clamp(
      state.exactResources.lifeSupportPct + choice.effects.lifeSupportPct,
      0,
      100
    ),
    crewHealthPct: clamp(
      state.exactResources.crewHealthPct + choice.effects.crewHealthPct,
      0,
      100
    ),
    panelDustPct: clamp(state.exactResources.panelDustPct + choice.effects.dustDelta, 0, 85),
  };

  const updatedResources: MissionResources = {
    ...state.resources,
    powerKwh: Math.round(nextExact.powerKwh),
    lifeSupportPct: Math.round(nextExact.lifeSupportPct),
    crewHealthPct: Math.round(nextExact.crewHealthPct),
    panelDustPct: Math.round(nextExact.panelDustPct),
    sciencePoints: state.resources.sciencePoints + choice.effects.sciencePoints,
  };

  const defeatReason = checkDefeatReason(updatedResources);
  if (defeatReason) {
    const debrief = buildDebriefReport('DEFEAT', defeatReason, state.sol - 1, updatedResources);
    return {
      ...state,
      weather: nextWeather,
      resources: updatedResources,
      exactResources: nextExact,
      lockedChoice: choice,
      pendingDilemma: null,
      debrief,
      logs: [
        {
          sol: state.sol,
          headline: `${choice.label} — System Collapse`,
          detail: defeatReason,
          nasaSource: state.pendingDilemma.nasaSourceLabel,
          tone: 'critical',
        },
        ...state.logs,
      ],
    };
  }

  const operationRates = computeOperationRates(
    updatedResources,
    nextWeather,
    state.activeFlare,
    chapter,
    choice
  );

  const unlockSec = getFastForwardUnlockSec(state.sol);
  const unlockedAlready = state.operationElapsedSec >= unlockSec;

  return {
    ...state,
    opPhase: 'operation',
    decisionElapsedSec: state.operationElapsedSec,
    fastForwardUnlocked: unlockedAlready,
    fastForwardActive: unlockedAlready ? state.fastForwardActive : false,
    speedMultiplier: unlockedAlready ? state.speedMultiplier : 1,
    lockedChoice: choice,
    operationRates,
    weather: nextWeather,
    resources: updatedResources,
    exactResources: nextExact,
    usedDilemmaIds: [...state.usedDilemmaIds, state.pendingDilemma.id],
    logs: [
      {
        sol: state.sol,
        headline: `Sol ${state.sol} Directive Locked: ${choice.label}`,
        detail: `${choice.summary} (${choice.tradeoffHint}) · Tau ${shiftedTau}`,
        nasaSource: state.pendingDilemma.nasaSourceLabel,
        tone:
          updatedResources.powerKwh < 25 ||
          updatedResources.lifeSupportPct < 35 ||
          updatedResources.crewHealthPct < 35
            ? 'caution'
            : 'nominal',
      },
      ...state.logs,
    ],
  };
}

/**
 * Continuous 300-second Sol clock tick:
 * - During Phase 1 (crisis_brief / decision_cards), smoothly advances the early-phase clock
 *   at 1x up to (unlockSec - 1)s (119s on Sol 1-2, 59s on Sol 3-10) so the environment builds
 *   gradually without unlocking Fast Forward or ending the Sol, and auto-pauses Fast Forward.
 * - During Phase 2 (operation), enforces 1x speed until unlockSec (120s on Sol 1-2, 60s on Sol 3-10),
 *   then unlocks Fast Forward (5x) and advances metrics continuously until 300s (sol_complete).
 */
export function advanceOperationTick(state: MissionState, realDtSec: number): MissionState {
  if (state.debrief || realDtSec <= 0) return state;

  const unlockSec = getFastForwardUnlockSec(state.sol);

  if (state.opPhase === 'crisis_brief' || state.opPhase === 'decision_cards') {
    const preDecisionCap = unlockSec - 1; // 119s on Sol 1-2, 59s on Sol 3-10
    const nextElapsed = Math.min(preDecisionCap, state.operationElapsedSec + realDtSec);
    if (
      state.operationElapsedSec >= preDecisionCap &&
      !state.fastForwardActive &&
      state.speedMultiplier === 1
    ) {
      return state;
    }
    return {
      ...state,
      operationElapsedSec: Math.max(state.operationElapsedSec, nextElapsed),
      fastForwardActive: false,
      speedMultiplier: 1,
    };
  }

  if (state.opPhase !== 'operation') return state;

  // Auto-pause fast-forward if an active Crisis Alert is unresolved
  if (hasUnresolvedCrisisAlert(state)) {
    return state.fastForwardActive || state.speedMultiplier !== 1
      ? {
          ...state,
          fastForwardActive: false,
          speedMultiplier: 1,
        }
      : state;
  }

  const rates = state.operationRates;
  if (!rates) return state;

  let current = state;
  let remainingRealDt = realDtSec;

  // Step 1: Strictly enforce 1x real-time up to the Sol-specific Fast Forward unlock boundary
  if (current.operationElapsedSec < unlockSec) {
    const timeToUnlock = unlockSec - current.operationElapsedSec;
    const step1x = Math.min(remainingRealDt, timeToUnlock);
    remainingRealDt -= step1x;
    current = applyOperationStep(current, step1x, false);
    if (current.debrief) return current;
  }

  // Step 2: After unlock boundary, apply active speedMultiplier (1x or 5x) smoothly up to 300s
  if (remainingRealDt > 0 && current.opPhase === 'operation') {
    const multiplier =
      current.fastForwardUnlocked && !hasUnresolvedCrisisAlert(current)
        ? current.speedMultiplier
        : 1;
    const scaledDt = remainingRealDt * multiplier;
    const remainingSol = Math.max(0, current.operationDurationSec - current.operationElapsedSec);
    const stepScaled = Math.min(scaledDt, remainingSol);
    if (stepScaled > 0) {
      current = applyOperationStep(current, stepScaled, true);
    }
  }

  return current;
}

function applyOperationStep(
  state: MissionState,
  simDtSec: number,
  allowUnlock: boolean
): MissionState {
  const rates = state.operationRates;
  if (!rates || simDtSec <= 0) return state;

  const nextElapsed = Math.min(
    state.operationDurationSec,
    state.operationElapsedSec + simDtSec
  );

  const nextExact: ExactResources = {
    powerKwh: clamp(state.exactResources.powerKwh + rates.powerPerSec * simDtSec, 0, MAX_BATTERY_KWH),
    lifeSupportPct: clamp(
      state.exactResources.lifeSupportPct + rates.lifePerSec * simDtSec,
      0,
      100
    ),
    crewHealthPct: clamp(
      state.exactResources.crewHealthPct + rates.healthPerSec * simDtSec,
      0,
      100
    ),
    panelDustPct: clamp(state.exactResources.panelDustPct + rates.dustPerSec * simDtSec, 0, 85),
  };

  const updatedResources: MissionResources = {
    ...state.resources,
    powerKwh: Math.round(nextExact.powerKwh),
    lifeSupportPct: Math.round(nextExact.lifeSupportPct),
    crewHealthPct: Math.round(nextExact.crewHealthPct),
    panelDustPct: Math.round(nextExact.panelDustPct),
  };

  const defeatReason = checkDefeatReason(updatedResources);
  if (defeatReason) {
    const debrief = buildDebriefReport('DEFEAT', defeatReason, state.sol - 1, updatedResources);
    return {
      ...state,
      operationElapsedSec: nextElapsed,
      resources: updatedResources,
      exactResources: nextExact,
      debrief,
      logs: [
        {
          sol: state.sol,
          headline: `Sol ${state.sol} Operation Failure`,
          detail: defeatReason,
          nasaSource: `MEDA ${state.weather.nasaSourceId}`,
          tone: 'critical',
        },
        ...state.logs,
      ],
    };
  }

  const unlockSec = getFastForwardUnlockSec(state.sol);
  const crisisUnresolved = hasUnresolvedCrisisAlert(state);
  const unlocked =
    state.fastForwardUnlocked ||
    (!crisisUnresolved && (allowUnlock ? nextElapsed >= unlockSec : nextElapsed >= unlockSec));
  const completedSol = nextElapsed >= state.operationDurationSec;
  const shouldPauseFastForward = crisisUnresolved || completedSol;

  const csvDelta = (rates.radDoseMsv * 0.1 * simDtSec) / state.operationDurationSec;

  return {
    ...state,
    opPhase: completedSol ? 'sol_complete' : 'operation',
    operationElapsedSec: nextElapsed,
    fastForwardUnlocked: unlocked,
    fastForwardActive: shouldPauseFastForward ? false : state.fastForwardActive,
    speedMultiplier: shouldPauseFastForward ? 1 : state.speedMultiplier,
    radiationDoseCsv: Number((state.radiationDoseCsv + csvDelta).toFixed(4)),
    resources: updatedResources,
    exactResources: nextExact,
  };
}

/**
 * Unlocks/engages 5x Fast Forward speed multiplier once the Sol's unlock threshold has elapsed
 * (2:00 on Sol 1-2, 1:00 on Sol 3-10), provided no active Crisis Alert is unresolved.
 */
export function activateFastForward(state: MissionState): MissionState {
  if (hasUnresolvedCrisisAlert(state)) {
    return {
      ...state,
      fastForwardActive: false,
      speedMultiplier: 1,
    };
  }
  const unlockSec = getFastForwardUnlockSec(state.sol);
  if (
    !state.fastForwardUnlocked ||
    state.operationElapsedSec < unlockSec ||
    state.debrief ||
    state.opPhase !== 'operation'
  ) {
    return state;
  }
  return {
    ...state,
    fastForwardActive: true,
    speedMultiplier: FAST_FORWARD_MULTIPLIER,
  };
}

/**
 * Toggles between 1x and 5x speed once Fast Forward is unlocked, auto-pausing on unresolved Crisis Alerts.
 */
export function toggleFastForward(state: MissionState): MissionState {
  if (hasUnresolvedCrisisAlert(state)) {
    return {
      ...state,
      fastForwardActive: false,
      speedMultiplier: 1,
    };
  }
  const unlockSec = getFastForwardUnlockSec(state.sol);
  if (
    !state.fastForwardUnlocked ||
    state.operationElapsedSec < unlockSec ||
    state.debrief ||
    state.opPhase !== 'operation'
  ) {
    return state;
  }
  const nextActive = !state.fastForwardActive;
  return {
    ...state,
    fastForwardActive: nextActive,
    speedMultiplier: nextActive ? FAST_FORWARD_MULTIPLIER : 1,
  };
}

/**
 * Applies a 3D outpost module interaction during Phase 2 or Phase 3 and refreshes live rates.
 */
export function applyModuleActionToMission(
  state: MissionState,
  moduleId: ModuleId,
  options?: { flareActive?: boolean }
): { nextState: MissionState; result: ModuleActionResult } {
  const result = performModuleAction(state.resources, moduleId);
  if (!result.applied) {
    return { nextState: state, result };
  }

  const isManualExternal = moduleId === 'solar' || moduleId === 'moxie';
  const flarePenaltyActive = Boolean(options?.flareActive) && isManualExternal;
  const radHealthPenalty = flarePenaltyActive ? -5 : 0;
  const radCsvDelta = flarePenaltyActive ? 0.05 : 0;

  const adjustedResult: ModuleActionResult = flarePenaltyActive
    ? {
        ...result,
        deltaHealth: result.deltaHealth + radHealthPenalty,
        feedbackText: `${result.feedbackText} · ${radHealthPenalty}% Rad EVA`,
      }
    : result;

  const nextExact: ExactResources = {
    powerKwh: clamp(state.exactResources.powerKwh + adjustedResult.deltaPower, 0, MAX_BATTERY_KWH),
    lifeSupportPct: clamp(
      state.exactResources.lifeSupportPct + adjustedResult.deltaLife,
      0,
      100
    ),
    crewHealthPct: clamp(
      state.exactResources.crewHealthPct + adjustedResult.deltaHealth,
      0,
      100
    ),
    panelDustPct: clamp(state.exactResources.panelDustPct + adjustedResult.deltaDust, 0, 85),
  };

  const syncedResources: MissionResources = {
    ...adjustedResult.nextResources,
    powerKwh: Math.round(nextExact.powerKwh),
    lifeSupportPct: Math.round(nextExact.lifeSupportPct),
    crewHealthPct: Math.round(nextExact.crewHealthPct),
    panelDustPct: Math.round(nextExact.panelDustPct),
  };

  const chapter = getSolChapter(state.sol);
  const nextRates =
    state.opPhase === 'operation' || state.opPhase === 'sol_complete'
      ? computeOperationRates(
          syncedResources,
          state.weather,
          state.activeFlare,
          chapter,
          state.lockedChoice
        )
      : state.operationRates;

  return {
    nextState: {
      ...state,
      resources: syncedResources,
      exactResources: nextExact,
      radiationDoseCsv: Number((state.radiationDoseCsv + radCsvDelta).toFixed(3)),
      operationRates: nextRates,
    },
    result: adjustedResult,
  };
}

export interface RoverDispatchResult {
  dispatched: boolean;
  reason?: string;
  nextState: MissionState;
  deltaPower: number;
}

/**
 * Deducts 10 kWh from Power reserves when deploying the autonomous Mars Utility Rover.
 */
export function deployRoverFromMission(state: MissionState): RoverDispatchResult {
  if (state.exactResources.powerKwh < ROVER_POWER_COST_KWH) {
    return {
      dispatched: false,
      reason: `Need at least ${ROVER_POWER_COST_KWH} kWh Power to deploy Rover!`,
      nextState: state,
      deltaPower: 0,
    };
  }

  const nextExactPower = clamp(
    state.exactResources.powerKwh - ROVER_POWER_COST_KWH,
    0,
    MAX_BATTERY_KWH
  );
  const deltaPower = Math.round(nextExactPower - state.exactResources.powerKwh);

  const nextExact: ExactResources = {
    ...state.exactResources,
    powerKwh: nextExactPower,
  };

  const syncedResources: MissionResources = {
    ...state.resources,
    powerKwh: Math.round(nextExactPower),
  };

  const chapter = getSolChapter(state.sol);
  const nextRates =
    state.opPhase === 'operation' || state.opPhase === 'sol_complete'
      ? computeOperationRates(
          syncedResources,
          state.weather,
          state.activeFlare,
          chapter,
          state.lockedChoice
        )
      : state.operationRates;

  return {
    dispatched: true,
    nextState: {
      ...state,
      resources: syncedResources,
      exactResources: nextExact,
      operationRates: nextRates,
    },
    deltaPower,
  };
}

export interface RoverCompletionOutcome {
  nextState: MissionState;
  deltaPower: number;
  deltaLife: number;
  deltaHealth: number; // Strictly 0 (zero radiation penalty)
  deltaDust: number;
  deltaScience: number;
  feedbackText: string;
}

/**
 * Completes an external maintenance task or rock scan via the autonomous Rover
 * with ZERO radiation penalty to the crew (0 cSv added, 0% crew health lost).
 */
export function completeRoverTaskOnMission(
  state: MissionState,
  target: RoverTaskTarget,
  targetLabel = 'Martian Sample'
): RoverCompletionOutcome {
  let deltaLife = 0;
  let deltaDust = 0;
  let deltaScience = 0;
  let headline = '';
  let detail = '';
  let feedbackText = '';

  if (target === 'solar') {
    const nextDust = clamp(state.exactResources.panelDustPct - 25, 0, 85);
    deltaDust = Math.round(nextDust - state.exactResources.panelDustPct);
    deltaScience = 2;
    headline = `Rover Cleaned Solar Arrays (${deltaDust}% Dust)`;
    detail = 'Autonomous rover swept static red dust off panels with 0.00 cSv crew radiation penalty.';
    feedbackText = `Rover Clean ${deltaDust}% Dust · +2 Sci · 0 Rad`;
  } else if (target === 'moxie') {
    const nextLife = clamp(state.exactResources.lifeSupportPct + 14, 0, 100);
    deltaLife = Math.round(nextLife - state.exactResources.lifeSupportPct);
    deltaScience = 2;
    headline = 'Rover Serviced MOXIE Intake Filter';
    detail = `Rover laser-cleared CO₂ filter (+${deltaLife}% O₂) with 0.00 cSv crew radiation penalty.`;
    feedbackText = `Rover +${deltaLife}% O₂ · +2 Sci · 0 Rad`;
  } else {
    deltaScience = ROVER_ROCK_SCIENCE_PTS;
    headline = `Rover Analyzed ${targetLabel}`;
    detail = `ChemCam laser spectroscopy on ${targetLabel} awarded +${ROVER_ROCK_SCIENCE_PTS} Sci Pts with 0.00 cSv crew exposure.`;
    feedbackText = `+${ROVER_ROCK_SCIENCE_PTS} Sci Pts · ${targetLabel}`;
  }

  const nextExact: ExactResources = {
    ...state.exactResources,
    lifeSupportPct: clamp(state.exactResources.lifeSupportPct + deltaLife, 0, 100),
    panelDustPct: clamp(state.exactResources.panelDustPct + deltaDust, 0, 85),
  };

  const syncedResources: MissionResources = {
    ...state.resources,
    powerKwh: Math.round(nextExact.powerKwh),
    lifeSupportPct: Math.round(nextExact.lifeSupportPct),
    crewHealthPct: Math.round(nextExact.crewHealthPct),
    panelDustPct: Math.round(nextExact.panelDustPct),
    sciencePoints: state.resources.sciencePoints + deltaScience,
  };

  const chapter = getSolChapter(state.sol);
  const nextRates =
    state.opPhase === 'operation' || state.opPhase === 'sol_complete'
      ? computeOperationRates(
          syncedResources,
          state.weather,
          state.activeFlare,
          chapter,
          state.lockedChoice
        )
      : state.operationRates;

  return {
    nextState: {
      ...state,
      resources: syncedResources,
      exactResources: nextExact,
      operationRates: nextRates,
      logs: [
        {
          sol: state.sol,
          headline,
          detail,
          nasaSource: 'Mars Utility Rover · FHAZ Autonav',
          tone: 'nominal',
        },
        ...state.logs,
      ],
    },
    deltaPower: 0,
    deltaLife,
    deltaHealth: 0,
    deltaDust,
    deltaScience,
    feedbackText,
  };
}

export interface InteriorActionOutcome {
  nextState: MissionState;
  deltaLife: number;
  deltaScience: number;
  deltaCropGrowth: number;
  feedbackText: string;
}

/**
 * Zone B Manual MOXIE Intake Valve Repair: +15% O₂ & Water with 0 radiation penalty.
 */
export function performInteriorMoxieRepair(state: MissionState): InteriorActionOutcome {
  const nextLifeExact = clamp(state.exactResources.lifeSupportPct + 15, 0, 100);
  const deltaLife = Math.round(nextLifeExact - state.exactResources.lifeSupportPct);

  const nextExact: ExactResources = {
    ...state.exactResources,
    lifeSupportPct: nextLifeExact,
  };

  const syncedResources: MissionResources = {
    ...state.resources,
    lifeSupportPct: Math.round(nextLifeExact),
  };

  const chapter = getSolChapter(state.sol);
  const nextRates =
    state.opPhase === 'operation' || state.opPhase === 'sol_complete'
      ? computeOperationRates(
          syncedResources,
          state.weather,
          state.activeFlare,
          chapter,
          state.lockedChoice
        )
      : state.operationRates;

  return {
    nextState: {
      ...state,
      resources: syncedResources,
      exactResources: nextExact,
      operationRates: nextRates,
      logs: [
        {
          sol: state.sol,
          headline: 'Manual MOXIE Intake Valve Repaired',
          detail: `Zone B interior maintenance cleared CO₂ intake occlusion (+${deltaLife}% O₂ & Water).`,
          nasaSource: 'Habitat Bay B · MOXIE Telemetry',
          tone: 'nominal',
        },
        ...state.logs,
      ],
    },
    deltaLife,
    deltaScience: 0,
    deltaCropGrowth: 0,
    feedbackText: deltaLife > 0 ? `+${deltaLife}% O₂ & Water (MOXIE Valve Fixed)` : 'MOXIE Intake Optimal (100% O₂)',
  };
}

/**
 * Zone C Hydroponics Bio-Dome "Water Crops & Harvest O2": +10% O₂ & Water and +5 Sci Pts.
 */
export function performInteriorBiodomeHarvest(state: MissionState): InteriorActionOutcome {
  const nextLifeExact = clamp(state.exactResources.lifeSupportPct + 10, 0, 100);
  const deltaLife = Math.round(nextLifeExact - state.exactResources.lifeSupportPct);
  const nextCropGrowth = Math.min(6, state.resources.cropGrowth + 1);
  const deltaCropGrowth = nextCropGrowth - state.resources.cropGrowth;
  const deltaScience = 5;

  const nextExact: ExactResources = {
    ...state.exactResources,
    lifeSupportPct: nextLifeExact,
  };

  const syncedResources: MissionResources = {
    ...state.resources,
    lifeSupportPct: Math.round(nextLifeExact),
    cropGrowth: nextCropGrowth,
    sciencePoints: state.resources.sciencePoints + deltaScience,
  };

  const chapter = getSolChapter(state.sol);
  const nextRates =
    state.opPhase === 'operation' || state.opPhase === 'sol_complete'
      ? computeOperationRates(
          syncedResources,
          state.weather,
          state.activeFlare,
          chapter,
          state.lockedChoice
        )
      : state.operationRates;

  return {
    nextState: {
      ...state,
      resources: syncedResources,
      exactResources: nextExact,
      operationRates: nextRates,
      logs: [
        {
          sol: state.sol,
          headline: 'Bio-Dome Crops Watered & O₂ Harvested',
          detail: `Zone C UV hydroponic racks boosted oxygen (+${deltaLife}% O₂ & Water) and yielded +5 Sci Pts.`,
          nasaSource: 'Habitat Bay C · Hydroponics Lab',
          tone: 'nominal',
        },
        ...state.logs,
      ],
    },
    deltaLife,
    deltaScience,
    deltaCropGrowth,
    feedbackText: `+${deltaLife}% O₂ & Water · +5 Sci Pts`,
  };
}

/**
 * Phase 3 -> Next Sol: Completes the 300s Sol, settles Water-Wall slightly, triggers Victory on Sol 10,
 * or opens the next Sol's 0:00 Phase 1 Crisis Brief.
 */
export function advanceToNextSol(
  state: MissionState,
  flares: NasaFlareRecord[]
): MissionState {
  if (state.debrief) return state;

  const rates = state.operationRates;
  const nextWall = clamp(state.resources.waterWallCm - 2, 8, 36);
  const updatedResources: MissionResources = {
    ...state.resources,
    waterWallCm: nextWall,
    sciencePoints: state.resources.sciencePoints + (rates?.shieldBlockedFlare ? 4 : 2),
  };

  if (state.sol >= MAX_SOLS) {
    const debrief = buildDebriefReport('VICTORY', null, MAX_SOLS, updatedResources);
    return {
      ...state,
      resources: updatedResources,
      pendingDilemma: null,
      debrief,
      logs: [
        {
          sol: state.sol,
          headline: 'Sol 10 Complete — Supply Rocket Landed!',
          detail:
            'Jezero Base survived the full 10-Sol mission arc and welcomed the automated supply lander.',
          nasaSource: 'NASA Mars Architecture Mission Log',
          tone: 'nominal',
        },
        ...state.logs,
      ],
    };
  }

  const nextSol = state.sol + 1;
  const nextWeather = getWeatherForSol(nextSol);
  const nextFlare = pickFlareForSol(nextSol, flares);
  const nextDilemma = selectNextDilemma(nextSol, nextWeather, nextFlare, state.usedDilemmaIds);

  return {
    ...state,
    sol: nextSol,
    opPhase: 'crisis_brief',
    operationElapsedSec: 0,
    operationDurationSec: SOL_DURATION_SEC,
    decisionElapsedSec: null,
    fastForwardUnlocked: false,
    fastForwardActive: false,
    speedMultiplier: 1,
    lockedChoice: null,
    operationRates: null,
    resources: updatedResources,
    weather: nextWeather,
    activeFlare: nextFlare,
    pendingDilemma: nextDilemma,
    logs: [
      {
        sol: state.sol,
        headline: `Sol ${state.sol} Operation Completed`,
        detail: rates?.shieldBlockedFlare
          ? `Water-Wall deflected the solar flare! (${rates.radDoseMsv} mSv/Sol)`
          : `Transitioned smoothly to Sol ${nextSol} morning shift.`,
        nasaSource: `${state.weather.nasaSourceId} / ${state.activeFlare.id}`,
        tone:
          updatedResources.powerKwh < 25 ||
          updatedResources.lifeSupportPct < 35 ||
          updatedResources.crewHealthPct < 35
            ? 'caution'
            : 'nominal',
      },
      ...state.logs,
    ],
  };
}

function gradeFromNumber(score: number): string {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 58) return 'C';
  return 'D';
}

export function buildDebriefReport(
  outcome: 'VICTORY' | 'DEFEAT',
  defeatReason: string | null,
  solsCompleted: number,
  finalResources: MissionResources
): DebriefReport {
  const crewScore = clamp(
    Math.round(finalResources.crewHealthPct * 0.75 + finalResources.lifeSupportPct * 0.25),
    0,
    100
  );
  const powerPct = Math.round((finalResources.powerKwh / MAX_BATTERY_KWH) * 100);
  const efficiencyScore = clamp(
    Math.round(
      powerPct * 0.5 +
        finalResources.lifeSupportPct * 0.35 +
        (100 - finalResources.panelDustPct) * 0.15
    ),
    0,
    100
  );
  const scienceScore = clamp(Math.round((finalResources.sciencePoints / 45) * 100), 0, 100);

  const totalScore =
    outcome === 'VICTORY'
      ? Math.round(crewScore * 0.4 + efficiencyScore * 0.35 + scienceScore * 0.25)
      : Math.round((solsCompleted / MAX_SOLS) * 45);

  let overallRank = 'Cadet Operator';
  if (outcome === 'VICTORY') {
    if (totalScore >= 85) overallRank = 'Jezero Legend Commander';
    else if (totalScore >= 72) overallRank = 'Senior Mars Flight Director';
    else overallRank = 'Outpost Survival Specialist';
  } else {
    overallRank = 'Emergency Extraction Required';
  }

  return {
    outcome,
    defeatReason,
    solsCompleted,
    finalResources,
    crewSafetyGrade:
      outcome === 'DEFEAT' && finalResources.crewHealthPct <= 0 ? 'F' : gradeFromNumber(crewScore),
    resourceEfficiencyGrade:
      outcome === 'DEFEAT' && finalResources.powerKwh <= 0
        ? 'F'
        : gradeFromNumber(efficiencyScore),
    scienceGrade: gradeFromNumber(scienceScore),
    overallRank,
    totalScore,
  };
}

export function checkDefeatReason(resources: MissionResources): string | null {
  if (resources.powerKwh <= 0) {
    return 'Battery reserves hit 0 kWh. Habitat heaters and oxygen pumps shut down during the Martian night.';
  }
  if (resources.lifeSupportPct <= 0) {
    return 'Life Support O₂ & Water dropped to 0%. Emergency ascent vehicle evacuation triggered.';
  }
  if (resources.crewHealthPct <= 0) {
    return 'Crew Radiation Shield & Health reached 0%. Crew evacuated to orbital medical bay.';
  }
  return null;
}

export function resolveNightCycleStep(
  state: MissionState,
  flares: NasaFlareRecord[]
): MissionState {
  const chapter = getSolChapter(state.sol);
  const summary = calculateNightCycle(
    state.resources,
    state.weather,
    state.activeFlare,
    chapter
  );

  const nextWall = clamp(state.resources.waterWallCm - 2, 8, 36);

  const updatedResources: MissionResources = {
    powerKwh: clamp(state.resources.powerKwh + summary.netPowerKwh, 0, MAX_BATTERY_KWH),
    lifeSupportPct: clamp(state.resources.lifeSupportPct + summary.netLifeSupportPct, 0, 100),
    crewHealthPct: clamp(state.resources.crewHealthPct + summary.netCrewHealthPct, 0, 100),
    panelDustPct: clamp(state.resources.panelDustPct + summary.netDustPct, 0, 85),
    waterWallCm: nextWall,
    cropGrowth: state.resources.cropGrowth,
    sciencePoints: state.resources.sciencePoints + (summary.shieldBlockedFlare ? 4 : 2),
  };

  const defeatReason = checkDefeatReason(updatedResources);
  if (defeatReason) {
    const debrief = buildDebriefReport('DEFEAT', defeatReason, state.sol - 1, updatedResources);
    return {
      ...state,
      resources: updatedResources,
      pendingDilemma: null,
      debrief,
      logs: [
        {
          sol: state.sol,
          headline: 'Mission Aborted — Critical Failure',
          detail: defeatReason,
          nasaSource: `MEDA ${state.weather.nasaSourceId}`,
          tone: 'critical',
        },
        ...state.logs,
      ],
    };
  }

  if (state.sol >= MAX_SOLS) {
    const debrief = buildDebriefReport('VICTORY', null, MAX_SOLS, updatedResources);
    return {
      ...state,
      resources: updatedResources,
      pendingDilemma: null,
      debrief,
      logs: [
        {
          sol: state.sol,
          headline: 'Sol 10 Complete — Supply Rocket Landed!',
          detail:
            'Jezero Base survived the full 10-Sol mission arc and welcomed the automated supply lander.',
          nasaSource: 'NASA Mars Architecture Mission Log',
          tone: 'nominal',
        },
        ...state.logs,
      ],
    };
  }

  return advanceToNextSol(
    {
      ...state,
      resources: updatedResources,
      exactResources: {
        powerKwh: updatedResources.powerKwh,
        lifeSupportPct: updatedResources.lifeSupportPct,
        crewHealthPct: updatedResources.crewHealthPct,
        panelDustPct: updatedResources.panelDustPct,
      },
    },
    flares
  );
}

export function resolveDilemmaChoice(
  state: MissionState,
  choice: DilemmaChoice,
  flares: NasaFlareRecord[]
): MissionState {
  if (!state.pendingDilemma) return state;
  const locked = lockInDecisionChoice(state, choice);
  if (locked.debrief) return locked;
  const completed = advanceOperationTick(locked, SOL_DURATION_SEC);
  if (completed.debrief) return completed;
  return advanceToNextSol(completed, flares);
}
