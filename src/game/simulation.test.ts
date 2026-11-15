import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateFastForward,
  advanceOperationTick,
  advanceToNextSol,
  applyModuleActionToMission,
  calculateNightCycle,
  checkDefeatReason,
  completeRoverTaskOnMission,
  computeSolAtmosphereTargets,
  computeTauFogDensity,
  createInitialMissionState,
  deployRoverFromMission,
  FAST_FORWARD_MULTIPLIER,
  FAST_FORWARD_UNLOCK_SEC,
  getFastForwardUnlockSec,
  getSolChapter,
  hasUnresolvedCrisisAlert,
  lockInDecisionChoice,
  MAX_SOLS,
  openDecisionCards,
  OPERATION_DURATION_SEC,
  performModuleAction,
  resolveDilemmaChoice,
  resolveNightCycleStep,
  ROVER_POWER_COST_KWH,
  ROVER_ROCK_SCIENCE_PTS,
  SOL_DURATION_SEC,
  toggleFastForward,
} from './simulation';
import { VERIFIED_FALLBACK_FLARES } from '../data/nasaTelemetry';
import { computeUnlockedLogIds, NASA_ARCHIVE_ENTRIES } from '../data/campaignArc';
import {
  buildPerseveranceFhazUrl,
  buildPerseveranceLatestUrl,
  classifyDonkiSeverity,
  computeDonkiVisualState,
  DEFAULT_ARCHIVE_CME,
  HISTORICAL_X9_CME,
  HISTORICAL_X9_FLARE,
  parsePerseverancePhotoResponse,
  parsePerseverancePhotosList,
} from '../utils/nasaApi';

test('initial mission state starts at Sol 1 in Phase 1 crisis_brief with 2 tactical choices and 300s Sol duration', () => {
  const state = createInitialMissionState(VERIFIED_FALLBACK_FLARES);
  assert.equal(SOL_DURATION_SEC, 300);
  assert.equal(FAST_FORWARD_UNLOCK_SEC, 120);
  assert.equal(FAST_FORWARD_MULTIPLIER, 5);
  assert.equal(state.sol, 1);
  assert.equal(state.opPhase, 'crisis_brief');
  assert.equal(state.operationElapsedSec, 0);
  assert.equal(state.operationDurationSec, SOL_DURATION_SEC);
  assert.equal(state.decisionElapsedSec, null);
  assert.equal(state.fastForwardUnlocked, false);
  assert.equal(state.speedMultiplier, 1);
  assert.equal(state.resources.powerKwh, 88);
  assert.equal(state.resources.lifeSupportPct, 80);
  assert.equal(state.resources.crewHealthPct, 88);
  assert.equal(state.resources.waterWallCm, 16);
  assert.ok(state.pendingDilemma);
  assert.equal(state.pendingDilemma.choices.length, 2);
  assert.equal(state.debrief, null);
});

test('on-object module actions apply coupled trade-offs directly', () => {
  const state = createInitialMissionState(VERIFIED_FALLBACK_FLARES);

  // MOXIE raises O2 (+14%) but costs 12 kWh power
  const moxieRes = performModuleAction(state.resources, 'moxie');
  assert.equal(moxieRes.applied, true);
  assert.equal(moxieRes.deltaPower, -12);
  assert.equal(moxieRes.deltaLife, 14);

  // Shelter thickens Water-Wall (+6 cm) and health, while draining 14 kWh power & 5% water
  const shelterRes = performModuleAction(state.resources, 'shelter');
  assert.equal(shelterRes.applied, true);
  assert.equal(shelterRes.deltaPower, -14);
  assert.equal(shelterRes.deltaLife, -5);
  assert.equal(shelterRes.deltaShieldCm, 6);

  // Solar cleans dust (-16% from 16% -> 0%) and harvests +14 kWh for -3% cooling water
  const solarRes = performModuleAction(state.resources, 'solar');
  assert.equal(solarRes.applied, true);
  assert.ok(solarRes.deltaDust < 0);
  assert.equal(solarRes.deltaPower, 14);
  assert.equal(solarRes.deltaLife, -3);

  // Bio-Dome grows crops & boosts science (+5) while spending 10 kWh
  const bioRes = performModuleAction(state.resources, 'biodome');
  assert.equal(bioRes.applied, true);
  assert.equal(bioRes.nextResources.cropGrowth, state.resources.cropGrowth + 1);
  assert.equal(bioRes.nextResources.sciencePoints, 5);
});

test('thick Water-Wall deflects Sol 4 Solar Flare while thin wall suffers radiation damage', () => {
  const state = createInitialMissionState(VERIFIED_FALLBACK_FLARES);
  const sol4 = getSolChapter(4);
  assert.equal(sol4.hazardType, 'flare');

  const thinNight = calculateNightCycle(
    { ...state.resources, waterWallCm: 14 },
    state.weather,
    state.activeFlare,
    sol4
  );
  const thickNight = calculateNightCycle(
    { ...state.resources, waterWallCm: 26 },
    state.weather,
    state.activeFlare,
    sol4
  );

  assert.equal(thinNight.shieldBlockedFlare, false);
  assert.equal(thickNight.shieldBlockedFlare, true);
  assert.ok(thickNight.netCrewHealthPct > thinNight.netCrewHealthPct);
});

test('defeat triggers when any critical resource hits 0', () => {
  assert.ok(
    checkDefeatReason({
      powerKwh: 0,
      lifeSupportPct: 50,
      crewHealthPct: 50,
      panelDustPct: 10,
      waterWallCm: 16,
      cropGrowth: 2,
      sciencePoints: 0,
    }) !== null
  );
  assert.ok(
    checkDefeatReason({
      powerKwh: 50,
      lifeSupportPct: 0,
      crewHealthPct: 50,
      panelDustPct: 10,
      waterWallCm: 16,
      cropGrowth: 2,
      sciencePoints: 0,
    }) !== null
  );
  assert.ok(
    checkDefeatReason({
      powerKwh: 50,
      lifeSupportPct: 50,
      crewHealthPct: 0,
      panelDustPct: 10,
      waterWallCm: 16,
      cropGrowth: 2,
      sciencePoints: 0,
    }) !== null
  );
});

test('300s Sol timeline locks Fast Forward for first 120s and unlocks 5x speed multiplier afterward', () => {
  let state = createInitialMissionState(VERIFIED_FALLBACK_FLARES);
  assert.equal(state.opPhase, 'crisis_brief');

  // 0:00 Early Phase ticks smoothly up to 20s before decision
  state = advanceOperationTick(state, 20);
  assert.equal(state.operationElapsedSec, 20);
  assert.equal(state.fastForwardUnlocked, false);

  // Phase 1: Open decision cards (clock continues advancing smoothly)
  state = openDecisionCards(state);
  assert.equal(state.opPhase, 'decision_cards');
  assert.ok(state.pendingDilemma);
  assert.equal(state.pendingDilemma.choices.length, 2);
  state = advanceOperationTick(state, 10);
  assert.equal(state.operationElapsedSec, 30);
  assert.ok(state.pendingDilemma);

  // Lock in card 2 -> Phase 2 starts WITHOUT snapping operationElapsedSec back to 0
  const choice = state.pendingDilemma.choices[1];
  state = lockInDecisionChoice(state, choice);
  assert.equal(state.opPhase, 'operation');
  assert.equal(state.operationElapsedSec, 30);
  assert.equal(state.decisionElapsedSec, 30);
  assert.equal(state.lockedChoice?.id, choice.id);
  assert.equal(state.fastForwardUnlocked, false);
  assert.equal(state.speedMultiplier, 1);
  assert.ok(state.operationRates);

  // Cannot fast-forward before 120s completes
  const prematureFf = activateFastForward(state);
  assert.equal(prematureFf.fastForwardActive, false);
  assert.equal(prematureFf.speedMultiplier, 1);

  // Advance 89 seconds (30 -> 119s) -> still strictly locked at 1x speed
  const initialExactLife = state.exactResources.lifeSupportPct;
  state = advanceOperationTick(state, 89);
  assert.equal(state.opPhase, 'operation');
  assert.equal(state.operationElapsedSec, 119);
  assert.equal(state.fastForwardUnlocked, false);
  assert.notEqual(state.exactResources.lifeSupportPct, initialExactLife);

  // Module action during Phase 2 updates resources and refreshes rates
  const beforeWall = state.resources.waterWallCm;
  const { nextState: afterModule, result } = applyModuleActionToMission(state, 'shelter');
  assert.equal(result.applied, true);
  assert.equal(afterModule.resources.waterWallCm, beforeWall + 6);
  state = afterModule;

  // Advance 1 more second (119 -> 120s) -> Fast Forward unlocks, Sol still running until 300s
  state = advanceOperationTick(state, 1);
  assert.equal(state.operationElapsedSec, 120);
  assert.equal(state.opPhase, 'operation');
  assert.equal(state.fastForwardUnlocked, true);
  assert.equal(state.speedMultiplier, 1);

  // Toggle Fast Forward -> engages 5x speed multiplier rather than skipping to end
  state = toggleFastForward(state);
  assert.equal(state.fastForwardActive, true);
  assert.equal(state.speedMultiplier, 5);
  assert.equal(state.opPhase, 'operation');

  // 10 real seconds at 5x speed = 50 simulated seconds (120 -> 170s)
  state = advanceOperationTick(state, 10);
  assert.equal(state.operationElapsedSec, 170);
  assert.equal(state.opPhase, 'operation');

  // Remaining 130s takes 26 real seconds at 5x speed -> reaches 300s (sol_complete)
  state = advanceOperationTick(state, 26);
  assert.equal(state.operationElapsedSec, 300);
  assert.equal(state.opPhase, 'sol_complete');

  // Transition to Sol 2 Phase 1
  state = advanceToNextSol(state, VERIFIED_FALLBACK_FLARES);
  assert.equal(state.sol, 2);
  assert.equal(state.opPhase, 'crisis_brief');
  assert.equal(state.operationElapsedSec, 0);
  assert.equal(state.decisionElapsedSec, null);
  assert.equal(state.fastForwardUnlocked, false);
  assert.equal(state.speedMultiplier, 1);
  assert.ok(state.pendingDilemma);
});

test('completing 10 Sols through all 3 phases achieves VICTORY debrief', () => {
  let state = createInitialMissionState(VERIFIED_FALLBACK_FLARES);
  for (let s = 1; s <= MAX_SOLS; s++) {
    assert.equal(state.sol, s);
    state = openDecisionCards(state);
    assert.ok(state.pendingDilemma, `Expected dilemma on Sol ${s}`);

    const sortedByPower = [...state.pendingDilemma.choices].sort(
      (a, b) => b.effects.powerKwh - a.effects.powerKwh
    );
    const choice =
      state.resources.powerKwh < 50 ? sortedByPower[0] : state.pendingDilemma.choices[0];

    state = lockInDecisionChoice(state, choice);
    assert.equal(state.opPhase, 'operation');

    if (state.resources.panelDustPct > 20 && state.resources.powerKwh > 20) {
      state = applyModuleActionToMission(state, 'solar').nextState;
    }
    if (state.resources.lifeSupportPct < 60 && state.resources.powerKwh > 25) {
      state = applyModuleActionToMission(state, 'moxie').nextState;
    }
    if (
      (s === 4 || s === 5 || state.resources.crewHealthPct < 65) &&
      state.resources.waterWallCm < 24 &&
      state.resources.powerKwh > 28
    ) {
      state = applyModuleActionToMission(state, 'shelter').nextState;
    }

    state = advanceOperationTick(state, OPERATION_DURATION_SEC);
    assert.equal(state.opPhase, 'sol_complete');
    state = advanceToNextSol(state, VERIFIED_FALLBACK_FLARES);
  }

  assert.ok(state.debrief);
  assert.equal(state.debrief.outcome, 'VICTORY');
  assert.equal(state.debrief.solsCompleted, 10);
});

test('legacy resolveNightCycleStep and resolveDilemmaChoice remain consistent', () => {
  let state = createInitialMissionState(VERIFIED_FALLBACK_FLARES);
  state = resolveNightCycleStep(state, VERIFIED_FALLBACK_FLARES);
  assert.equal(state.sol, 2);
  assert.ok(state.pendingDilemma);
  state = resolveDilemmaChoice(state, state.pendingDilemma.choices[0], VERIFIED_FALLBACK_FLARES);
  assert.equal(state.sol, 3);
});

test('NASA Data Log archive unlocks progressively by Sol and 3D module interactions', () => {
  const sol1Empty = computeUnlockedLogIds(1, { solar: 0, moxie: 0, shelter: 0, biodome: 0 });
  assert.deepEqual(sol1Empty, ['geo-delta']);

  const sol1Moxie = computeUnlockedLogIds(1, { solar: 0, moxie: 1, shelter: 0, biodome: 0 });
  assert.ok(sol1Moxie.includes('isru-moxie'));
  assert.ok(!sol1Moxie.includes('isru-rad-shield'));

  const sol8Full = computeUnlockedLogIds(8, { solar: 2, moxie: 1, shelter: 2, biodome: 1 });
  assert.equal(sol8Full.length, NASA_ARCHIVE_ENTRIES.length);
});

test('computeTauFogDensity scales monotonically with Tau dust opacity and emergency modes', () => {
  const clearMorning = computeTauFogDensity(0.35, 'none');
  const sol1 = computeTauFogDensity(0.38, 'none');
  const sol3 = computeTauFogDensity(0.72, 'none');
  const sol4Storm = computeTauFogDensity(1.35, 'dust');
  const dustAlertLowTau = computeTauFogDensity(0.44, 'dust');
  const flareAlert = computeTauFogDensity(0.54, 'flare');
  const extremeTau = computeTauFogDensity(5.0, 'dust');

  assert.equal(clearMorning, 0.015);
  assert.ok(sol1 > clearMorning);
  assert.ok(sol3 > sol1);
  assert.ok(sol4Storm > sol3);
  assert.ok(dustAlertLowTau >= 0.026);
  assert.ok(flareAlert >= 0.0205);
  assert.equal(extremeTau, 0.045);
});

test('computeSolAtmosphereTargets shifts smoothly from early buildup to peak and stabilization', () => {
  const t0 = computeSolAtmosphereTargets({
    elapsedSec: 0,
    decisionElapsedSec: null,
    baseTau: 0.72,
    hazardType: 'dust',
    emergencyMode: 'dust',
  });
  const t30Early = computeSolAtmosphereTargets({
    elapsedSec: 30,
    decisionElapsedSec: null,
    baseTau: 0.72,
    hazardType: 'dust',
    emergencyMode: 'dust',
  });
  const tPeak = computeSolAtmosphereTargets({
    elapsedSec: 90,
    decisionElapsedSec: 30,
    baseTau: 0.72,
    hazardType: 'dust',
    emergencyMode: 'dust',
  });
  const tStabilize = computeSolAtmosphereTargets({
    elapsedSec: 255,
    decisionElapsedSec: 30,
    baseTau: 0.72,
    hazardType: 'dust',
    emergencyMode: 'dust',
  });

  assert.equal(t0.solProgress, 0);
  assert.ok(t30Early.crisisIntensity > t0.crisisIntensity);
  assert.ok(tPeak.crisisIntensity >= 0.98);
  assert.ok(tPeak.fogDensity >= t30Early.fogDensity);
  assert.ok(tStabilize.crisisIntensity < tPeak.crisisIntensity);
  assert.ok(tStabilize.nightFactor > t0.nightFactor);
});

test('DONKI severity classification distinguishes quiet/C-class, M-class, and X-class/CME states', () => {
  const cFlare = {
    ...VERIFIED_FALLBACK_FLARES[0],
    classType: 'C4.8',
  };
  const mFlare = VERIFIED_FALLBACK_FLARES[0]; // M4.2

  assert.equal(classifyDonkiSeverity(cFlare, DEFAULT_ARCHIVE_CME, false), 'quiet');
  assert.equal(classifyDonkiSeverity(mFlare, DEFAULT_ARCHIVE_CME, false), 'm_class');
  assert.equal(classifyDonkiSeverity(cFlare, HISTORICAL_X9_CME, false), 'x_class');
  assert.equal(classifyDonkiSeverity(cFlare, DEFAULT_ARCHIVE_CME, true), 'x_class');

  const mState = computeDonkiVisualState(mFlare, DEFAULT_ARCHIVE_CME, false);
  assert.equal(mState.level, 'm_class');
  assert.equal(mState.isSimulatedXFlare, false);
  assert.ok(mState.intensity > 0.45 && mState.intensity <= 0.75);

  const simXState = computeDonkiVisualState(mFlare, DEFAULT_ARCHIVE_CME, true);
  assert.equal(simXState.level, 'x_class');
  assert.equal(simXState.isSimulatedXFlare, true);
  assert.equal(simXState.flare.id, HISTORICAL_X9_FLARE.id);
  assert.equal(simXState.flare.classType, 'X9.3');
  assert.equal(simXState.intensity, 1.0);
});

test('deployRoverFromMission deducts 10 kWh and guards against insufficient battery', () => {
  const initial = createInitialMissionState(VERIFIED_FALLBACK_FLARES);
  const res = deployRoverFromMission(initial);
  assert.equal(res.dispatched, true);
  assert.equal(res.deltaPower, -ROVER_POWER_COST_KWH);
  assert.equal(res.nextState.resources.powerKwh, initial.resources.powerKwh - 10);

  const lowPower = {
    ...initial,
    resources: { ...initial.resources, powerKwh: 6 },
    exactResources: { ...initial.exactResources, powerKwh: 6 },
  };
  const blocked = deployRoverFromMission(lowPower);
  assert.equal(blocked.dispatched, false);
  assert.equal(blocked.deltaPower, 0);
});

test('rover completes external tasks with zero radiation penalty and awards +5 Sci Pts on rocks', () => {
  let state = createInitialMissionState(VERIFIED_FALLBACK_FLARES);
  state = openDecisionCards(state);
  state = lockInDecisionChoice(state, state.pendingDilemma!.choices[0]);

  const startHealth = state.exactResources.crewHealthPct;
  const startCsv = state.radiationDoseCsv;

  // Manual external EVA during active M4.2 flare incurs -5% health and +0.05 cSv
  const manualSolar = applyModuleActionToMission(state, 'solar', { flareActive: true });
  assert.equal(manualSolar.result.deltaHealth, -5);
  assert.equal(manualSolar.nextState.exactResources.crewHealthPct, startHealth - 5);
  assert.equal(manualSolar.nextState.radiationDoseCsv, Number((startCsv + 0.05).toFixed(3)));

  // Rover deployment + solar cleaning completes with ZERO radiation penalty
  const dispatch = deployRoverFromMission(state);
  assert.equal(dispatch.dispatched, true);
  const roverSolar = completeRoverTaskOnMission(dispatch.nextState, 'solar', 'Solar Array Field');
  assert.equal(roverSolar.deltaHealth, 0);
  assert.equal(roverSolar.nextState.exactResources.crewHealthPct, startHealth);
  assert.equal(roverSolar.nextState.radiationDoseCsv, startCsv);
  assert.ok(roverSolar.deltaDust < 0);

  // Rover rock spectroscopy awards +5 Sci Pts with 0 radiation
  const startSci = roverSolar.nextState.resources.sciencePoints;
  const roverRock = completeRoverTaskOnMission(
    roverSolar.nextState,
    'rock',
    'Delta Mudstone'
  );
  assert.equal(roverRock.deltaScience, ROVER_ROCK_SCIENCE_PTS);
  assert.equal(roverRock.nextState.resources.sciencePoints, startSci + 5);
  assert.equal(roverRock.deltaHealth, 0);
  assert.equal(roverRock.nextState.radiationDoseCsv, startCsv);
});

test('Perseverance FHAZ API URL builders and fallback response parser handle Sol and latest_photos', () => {
  assert.equal(
    buildPerseveranceFhazUrl(4),
    'https://rovers.nebulum.one/api/v1/rovers/perseverance/photos?sol=4&camera=FRONT_HAZCAM_LEFT_A'
  );
  assert.equal(
    buildPerseveranceLatestUrl(),
    'https://rovers.nebulum.one/api/v1/rovers/perseverance/latest_photos'
  );

  // Empty Sol photos array returns null so caller falls back to latest_photos
  assert.equal(parsePerseverancePhotoResponse({ photos: [] }, 'SOL_FHAZ', 4), null);

  // Latest photos fallback parses cleanly
  const parsed = parsePerseverancePhotoResponse(
    {
      latest_photos: [
        {
          id: 9912,
          sol: 1204,
          img_src: 'https://mars.nasa.gov/mars2020-raw-images/test-fhaz.jpg',
          earth_date: '2024-07-09',
          camera: {
            name: 'FRONT_HAZCAM_LEFT_A',
            full_name: 'Front Hazard Avoidance Camera - Left',
          },
        },
      ],
    },
    'LATEST_FALLBACK',
    4
  );

  assert.ok(parsed);
  assert.equal(parsed.cameraName, 'FRONT_HAZCAM_LEFT_A');
  assert.equal(parsed.earthDate, '2024-07-09');
  assert.equal(parsed.imgSrc, 'https://mars.nasa.gov/mars2020-raw-images/test-fhaz.jpg');
  assert.equal(parsed.sourceMode, 'LATEST_FALLBACK');
});

test('parsePerseverancePhotosList extracts multiple unique FHAZ images for the gallery strip', () => {
  const photos = parsePerseverancePhotosList(
    {
      photos: [
        {
          id: 188,
          sol: 1,
          img_src: 'https://mars.nasa.gov/fhaz-1.jpg',
          earth_date: '2021-02-19',
          camera: { name: 'FRONT_HAZCAM_LEFT_A', full_name: 'Front Hazard Avoidance Camera - Left' },
        },
        {
          id: 189,
          sol: 1,
          img_src: 'https://mars.nasa.gov/fhaz-1.jpg',
          earth_date: '2021-02-19',
          camera: { name: 'FRONT_HAZCAM_LEFT_A', full_name: 'Front Hazard Avoidance Camera - Left' },
        },
        {
          id: 194,
          sol: 1,
          img_src: 'https://mars.nasa.gov/fhaz-2.jpg',
          earth_date: '2021-02-19',
          camera: { name: 'FRONT_HAZCAM_LEFT_A', full_name: 'Front Hazard Avoidance Camera - Left' },
        },
        {
          id: 195,
          sol: 1,
          img_src: 'https://mars.nasa.gov/fhaz-3.jpg',
          earth_date: '2021-02-19',
          camera: { name: 'FRONT_HAZCAM_LEFT_A', full_name: 'Front Hazard Avoidance Camera - Left' },
        },
      ],
    },
    'SOL_FHAZ',
    1,
    4
  );

  assert.equal(photos.length, 3);
  assert.deepEqual(
    photos.map((p) => p.id),
    [188, 194, 195]
  );
});

import {
  clampInteriorPlayerPosition,
  findNearestInteractable,
  getInteriorZoneAt,
  INTERIOR_SPAWN,
} from './interiorCollision';
import {
  performInteriorBiodomeHarvest,
  performInteriorMoxieRepair,
} from './simulation';

test('interior collision keeps player inside 3 connected zones and blocks furniture overlap', () => {
  // Spawn starts in Zone A (Central Command Dome)
  const spawnZone = getInteriorZoneAt(INTERIOR_SPAWN.x, INTERIOR_SPAWN.z);
  assert.equal(spawnZone.id, 'command_dome');

  // Cannot walk out past Zone A outer shell wall
  const outerWall = clampInteriorPlayerPosition(0, 6.0, 0, 14.0);
  assert.ok(Math.hypot(outerWall.x, outerWall.z) < 8.1);

  // Can traverse West Bulkhead Corridor cleanly from Zone A into Zone B (MOXIE Bay)
  const westAirlock = clampInteriorPlayerPosition(-7.0, 0, -11.0, 0);
  assert.equal(getInteriorZoneAt(westAirlock.x, westAirlock.z).id, 'west_airlock');
  const moxieBay = clampInteriorPlayerPosition(-14.0, 0, -18.5, 0);
  assert.equal(getInteriorZoneAt(moxieBay.x, moxieBay.z).id, 'moxie_bay');

  // Can traverse East Bulkhead Corridor cleanly from Zone A into Zone C (Hydroponics Bio-Dome)
  const eastAirlock = clampInteriorPlayerPosition(7.0, 0, 11.0, 0);
  assert.equal(getInteriorZoneAt(eastAirlock.x, eastAirlock.z).id, 'east_airlock');
  const bioDome = clampInteriorPlayerPosition(14.0, 0, 18.5, 0);
  assert.equal(getInteriorZoneAt(bioDome.x, bioDome.z).id, 'biodome');

  // Pushes player out of the central Holographic Mars Map table at (0, 0)
  const pushed = clampInteriorPlayerPosition(0, 2.6, 0, 0.5);
  assert.ok(Math.hypot(pushed.x, pushed.z) >= 1.86);
});

test('interior contextual interactable prompts activate within 3 units when facing stations', () => {
  // Standing near Rover Terminal in Zone A facing -Z
  const roverPrompt = findNearestInteractable(0, -3.5, 0, -1);
  assert.ok(roverPrompt);
  assert.equal(roverPrompt.interactable.id, 'rover_terminal');

  // Standing near MOXIE generator in Zone B facing West/North-West
  const moxiePrompt = findNearestInteractable(-19.5, -1.0, -1, -0.2);
  assert.ok(moxiePrompt);
  assert.equal(moxiePrompt.interactable.id, 'moxie_unit');

  // Standing near Hydroponics Plant Racks in Zone C facing North
  const bioPrompt = findNearestInteractable(20.0, -0.4, 0, -1);
  assert.ok(bioPrompt);
  assert.equal(bioPrompt.interactable.id, 'crop_racks');

  // Far from all stations in corridor returns null
  const corridorNone = findNearestInteractable(-11.5, 0, -1, 0);
  assert.equal(corridorNone, null);
});

test('interior manual MOXIE repair (+15% O2) and Bio-Dome harvest (+10% O2, +5 Sci Pts) update simulation cleanly', () => {
  let state = createInitialMissionState(VERIFIED_FALLBACK_FLARES);
  state = {
    ...state,
    resources: { ...state.resources, lifeSupportPct: 60, sciencePoints: 10 },
    exactResources: { ...state.exactResources, lifeSupportPct: 60 },
  };

  const moxieFixed = performInteriorMoxieRepair(state);
  assert.equal(moxieFixed.deltaLife, 15);
  assert.equal(moxieFixed.nextState.resources.lifeSupportPct, 75);

  const harvested = performInteriorBiodomeHarvest(moxieFixed.nextState);
  assert.equal(harvested.deltaLife, 10);
  assert.equal(harvested.deltaScience, 5);
  assert.equal(harvested.nextState.resources.lifeSupportPct, 85);
  assert.equal(harvested.nextState.resources.sciencePoints, 15);
});

test('Sol shift timer unlocks 5x Fast-Forward at 2:00 on Sol 1-2 and 1:00 on Sol 3-10, auto-pausing on unresolved Crisis Alerts', () => {
  assert.equal(getFastForwardUnlockSec(1), 120);
  assert.equal(getFastForwardUnlockSec(2), 120);
  for (let sol = 3; sol <= MAX_SOLS; sol++) {
    assert.equal(getFastForwardUnlockSec(sol), 60);
  }

  // Advance to Sol 3
  let state = createInitialMissionState(VERIFIED_FALLBACK_FLARES);
  for (let s = 1; s < 3; s++) {
    state = openDecisionCards(state);
    state = lockInDecisionChoice(state, state.pendingDilemma!.choices[0]);
    state = advanceOperationTick(state, SOL_DURATION_SEC);
    state = advanceToNextSol(state, VERIFIED_FALLBACK_FLARES);
  }
  assert.equal(state.sol, 3);
  assert.equal(state.opPhase, 'crisis_brief');
  assert.equal(hasUnresolvedCrisisAlert(state), true);

  // During Phase 1 on Sol 3, clock caps at 59s and cannot engage fast-forward
  state = advanceOperationTick(state, 120);
  assert.equal(state.operationElapsedSec, 59);
  assert.equal(state.fastForwardUnlocked, false);
  const blockedDuringCrisis = activateFastForward({
    ...state,
    fastForwardUnlocked: true,
    fastForwardActive: true,
    speedMultiplier: 5,
  });
  assert.equal(blockedDuringCrisis.fastForwardActive, false);
  assert.equal(blockedDuringCrisis.speedMultiplier, 1);

  // Lock in Sol 3 decision card -> 1 more second (59 -> 60s) unlocks 5x Fast-Forward
  state = openDecisionCards(state);
  state = lockInDecisionChoice(state, state.pendingDilemma!.choices[0]);
  assert.equal(hasUnresolvedCrisisAlert(state), false);
  assert.equal(state.fastForwardUnlocked, false);

  state = advanceOperationTick(state, 1);
  assert.equal(state.operationElapsedSec, 60);
  assert.equal(state.fastForwardUnlocked, true);

  state = toggleFastForward(state);
  assert.equal(state.fastForwardActive, true);
  assert.equal(state.speedMultiplier, 5);

  // If an unresolved Crisis Alert appears while fast-forward was active, advanceOperationTick auto-pauses to 1x
  const simulatedUnresolvedAlert = {
    ...state,
    lockedChoice: null,
    pendingDilemma: VERIFIED_FALLBACK_FLARES ? state.pendingDilemma : null,
  };
  const autoPaused = advanceOperationTick(simulatedUnresolvedAlert, 2);
  assert.equal(autoPaused.fastForwardActive, false);
  assert.equal(autoPaused.speedMultiplier, 1);

  // Otherwise 5x fast-forward finishes remaining 240s in 48 real seconds
  state = advanceOperationTick(state, 48);
  assert.equal(state.operationElapsedSec, 300);
  assert.equal(state.opPhase, 'sol_complete');
  assert.equal(state.fastForwardActive, false);
  assert.equal(state.speedMultiplier, 1);
});





