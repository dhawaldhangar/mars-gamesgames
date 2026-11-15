import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  Database,
  FastForward,
  Lock,
  Moon,
  Radio,
  RotateCcw,
  Shield,
  Sparkles,
  Sun,
  Volume2,
  VolumeX,
  Wind,
  Zap,
} from 'lucide-react';
import { DilemmaChoice, ScienceTerm, VERIFIED_FALLBACK_FLARES } from './data/nasaTelemetry';
import {
  computeUnlockedLogIds,
  ModuleId,
  ModuleUsageCounts,
} from './data/campaignArc';
import {
  advanceOperationTick,
  advanceToNextSol,
  applyModuleActionToMission,
  completeRoverTaskOnMission,
  computeSolAtmosphereTargets,
  createInitialMissionState,
  deployRoverFromMission,
  FAST_FORWARD_MULTIPLIER,
  getFastForwardUnlockSec,
  getSolChapter,
  hasUnresolvedCrisisAlert,
  lockInDecisionChoice,
  MAX_BATTERY_KWH,
  MAX_SOLS,
  MissionState,
  openDecisionCards,
  performInteriorBiodomeHarvest,
  performInteriorMoxieRepair,
  SOL_DURATION_SEC,
  toggleFastForward,
} from './game/simulation';
import {
  getInteriorZoneAt,
  INTERIOR_SPAWN,
  InteriorInteractableId,
} from './game/interiorCollision';
import { EvaInteractableId } from './game/evaPhysics';
import {
  computeDonkiVisualState,
  DEFAULT_ARCHIVE_CME,
  DonkiFetchResult,
  fetchNasaDonkiTelemetry,
  fetchPerseveranceFhazBatch,
  RoverCameraPhoto,
} from './utils/nasaApi';
import roverCamInitialImg from './assets/images/regenerated_image_1794686128270.jpg';
import { missionAudio } from './utils/audio';
import {
  ActiveSystemGlow,
  DonkiSceneTelemetry,
  EmergencyMode,
  EvaPlayerState,
  InteriorPlayerState,
  RoverMissionTarget,
  RoverPhase,
  SceneViewMode,
  ScienceBoulderId,
} from './three/MarsOutpostScene';
import { TitleScreen } from './components/TitleScreen';
import { MarsViewport, MarsViewportHandle, ModulePopup } from './components/MarsViewport';
import { CharacterPortrait } from './components/CharacterPortrait';
import { ScienceTermButton } from './components/ScienceTermButton';
import { EarthDispatchDrawer } from './components/EarthDispatchDrawer';
import { DonkiInspectorCard } from './components/DonkiInspectorCard';
import { RoverCamWidget } from './components/RoverCamWidget';
import { InteriorHudOverlay } from './components/InteriorHudOverlay';
import { EvaHudOverlay } from './components/EvaHudOverlay';
import { RoverTerminalModal } from './components/RoverTerminalModal';
import {
  DebriefModal,
  DilemmaModal,
  ScienceDecoderModal,
  ScienceLogModal,
} from './components/Modals';

type ScreenPhase = 'title' | 'playing' | 'gameover';

interface HudDeltas {
  id: number;
  power: number;
  life: number;
  health: number;
}

const INITIAL_USAGE: ModuleUsageCounts = {
  solar: 0,
  moxie: 0,
  shelter: 0,
  biodome: 0,
};

const INITIAL_ROVER_PHOTO: RoverCameraPhoto = {
  id: 0,
  sol: 1,
  imgSrc: roverCamInitialImg,
  earthDate: '2021-02-19',
  cameraName: 'FRONT_HAZCAM_LEFT_A',
  cameraFullName: 'Front Hazard Avoidance Camera - Left (Jezero Archive)',
  sourceMode: 'LOCAL_ARCHIVE',
};

function formatMmSs(totalSeconds: number): string {
  const clamped = Math.max(0, Math.ceil(totalSeconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatRate(perSec: number, unit: string): string {
  const rounded = Math.abs(perSec) < 0.005 ? 0 : perSec;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(2)} ${unit}/s`;
}

export default function App() {
  const [phase, setPhase] = useState<ScreenPhase>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('autostart') === '1') return 'playing';
    }
    return 'title';
  });

  const [donkiResult, setDonkiResult] = useState<DonkiFetchResult>({
    flares: VERIFIED_FALLBACK_FLARES,
    cme: DEFAULT_ARCHIVE_CME,
    mode: 'VERIFIED_ARCHIVE_FALLBACK',
    fetchedAt: 'Archive Ready',
    statusNote: 'Initialized with verified NASA CCMC DONKI & Perseverance MEDA telemetry.',
  });

  const [mission, setMission] = useState<MissionState>(() =>
    createInitialMissionState(VERIFIED_FALLBACK_FLARES)
  );
  const [moduleUsage, setModuleUsage] = useState<ModuleUsageCounts>(INITIAL_USAGE);
  const [isNightCycle, setIsNightCycle] = useState(false);
  const [muted, setMuted] = useState(false);
  const [showScienceLog, setShowScienceLog] = useState(false);
  const [donkiFeedOpen, setDonkiFeedOpen] = useState(false);
  const [simulateXFlare, setSimulateXFlare] = useState(false);
  const [shieldBoostActive, setShieldBoostActive] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [decryptedSols, setDecryptedSols] = useState<number[]>([]);
  const [activeTerm, setActiveTerm] = useState<ScienceTerm | null>(null);
  const [activePopup, setActivePopup] = useState<ModulePopup | null>(null);
  const [hudDeltas, setHudDeltas] = useState<HudDeltas | null>(null);
  const [roverPhase, setRoverPhase] = useState<RoverPhase>('idle');
  const [roverTargetLabel, setRoverTargetLabel] = useState<string | null>(null);
  const [roverPhoto, setRoverPhoto] = useState<RoverCameraPhoto | null>(INITIAL_ROVER_PHOTO);
  const [roverPhotoHistory, setRoverPhotoHistory] = useState<RoverCameraPhoto[]>([
    INITIAL_ROVER_PHOTO,
  ]);
  const [roverPhotoLoading, setRoverPhotoLoading] = useState(false);
  const [roverCamCollapsed, setRoverCamCollapsed] = useState(false);
  const [analyzedRockIds, setAnalyzedRockIds] = useState<ScienceBoulderId[]>([]);

  // First-Person Habitat Interior & Exterior EVA Mode state
  const [viewMode, setViewMode] = useState<SceneViewMode>('exterior');
  const [viewFadeActive, setViewFadeActive] = useState(false);
  const [roverTerminalOpen, setRoverTerminalOpen] = useState(false);
  const [interiorStatusBanner, setInteriorStatusBanner] = useState<{
    id: number;
    text: string;
    positive: boolean;
  } | null>(null);
  const [interiorState, setInteriorState] = useState<InteriorPlayerState>(() => ({
    zone: getInteriorZoneAt(INTERIOR_SPAWN.x, INTERIOR_SPAWN.z),
    nearestInteractable: null,
    pointerLocked: false,
  }));
  const [evaStatusBanner, setEvaStatusBanner] = useState<{
    id: number;
    text: string;
    positive: boolean;
  } | null>(null);
  const [evaState, setEvaState] = useState<EvaPlayerState>({
    nearestInteractable: null,
    pointerLocked: false,
  });

  const viewportRef = useRef<MarsViewportHandle | null>(null);
  const popupTimerRef = useRef<number | null>(null);
  const deltaTimerRef = useRef<number | null>(null);
  const shieldTimerRef = useRef<number | null>(null);
  const viewFadeTimerRef = useRef<number | null>(null);
  const interiorBannerTimerRef = useRef<number | null>(null);
  const evaBannerTimerRef = useRef<number | null>(null);
  const sol10TriggeredRef = useRef(false);
  const prevOpPhaseRef = useRef(mission.opPhase);
  const missionRef = useRef(mission);
  missionRef.current = mission;
  const roverPhaseRef = useRef(roverPhase);
  roverPhaseRef.current = roverPhase;
  const roverPhotoHistoryRef = useRef(roverPhotoHistory);
  roverPhotoHistoryRef.current = roverPhotoHistory;
  const isNightCycleRef = useRef(isNightCycle);
  isNightCycleRef.current = isNightCycle;

  const clearTimers = useCallback(() => {
    if (popupTimerRef.current !== null) {
      window.clearTimeout(popupTimerRef.current);
      popupTimerRef.current = null;
    }
    if (deltaTimerRef.current !== null) {
      window.clearTimeout(deltaTimerRef.current);
      deltaTimerRef.current = null;
    }
    if (shieldTimerRef.current !== null) {
      window.clearTimeout(shieldTimerRef.current);
      shieldTimerRef.current = null;
    }
    if (viewFadeTimerRef.current !== null) {
      window.clearTimeout(viewFadeTimerRef.current);
      viewFadeTimerRef.current = null;
    }
    if (interiorBannerTimerRef.current !== null) {
      window.clearTimeout(interiorBannerTimerRef.current);
      interiorBannerTimerRef.current = null;
    }
    if (evaBannerTimerRef.current !== null) {
      window.clearTimeout(evaBannerTimerRef.current);
      evaBannerTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    document.body.dataset.state = mission.debrief ? 'gameover' : phase;
  }, [phase, mission.debrief]);

  useEffect(() => {
    let active = true;
    fetchNasaDonkiTelemetry().then((res) => {
      if (!active) return;
      setDonkiResult(res);
    });
    return () => {
      active = false;
    };
  }, []);

  const chapter = useMemo(() => getSolChapter(mission.sol), [mission.sol]);

  const donkiVisualState = useMemo(
    () => computeDonkiVisualState(mission.activeFlare, donkiResult.cme, simulateXFlare),
    [mission.activeFlare, donkiResult.cme, simulateXFlare]
  );

  const shieldActive = mission.resources.waterWallCm >= 20 || shieldBoostActive;

  const donkiTelemetry: DonkiSceneTelemetry = useMemo(
    () => ({
      level: donkiVisualState.level,
      intensity: donkiVisualState.intensity,
      cmeActive: donkiVisualState.cme.impactActive,
      shieldActive,
    }),
    [donkiVisualState, shieldActive]
  );

  const emergencyMode: EmergencyMode = useMemo(() => {
    const severeSolarFlare =
      chapter.hazardType === 'flare' ||
      (mission.sol >= 4 && /^[MX]/i.test(mission.activeFlare.classType));
    if (severeSolarFlare) return 'flare';
    if (chapter.hazardType === 'dust' || mission.weather.tau >= 0.85) return 'dust';
    return 'none';
  }, [chapter.hazardType, mission.sol, mission.activeFlare.classType, mission.weather.tau]);

  const unlockedLogIds = useMemo(
    () => computeUnlockedLogIds(mission.sol, moduleUsage),
    [mission.sol, moduleUsage]
  );

  const atmosphereTargets = useMemo(
    () =>
      computeSolAtmosphereTargets({
        elapsedSec: mission.operationElapsedSec,
        durationSec: mission.operationDurationSec,
        decisionElapsedSec: mission.decisionElapsedSec,
        baseTau: mission.weather.tau,
        hazardType: chapter.hazardType,
        emergencyMode,
      }),
    [
      mission.operationElapsedSec,
      mission.operationDurationSec,
      mission.decisionElapsedSec,
      mission.weather.tau,
      chapter.hazardType,
      emergencyMode,
    ]
  );

  const activeSystemGlow: ActiveSystemGlow = useMemo(() => {
    const isWorking = mission.opPhase === 'operation' || mission.opPhase === 'sol_complete';
    const rates = mission.operationRates;
    const choiceId = mission.lockedChoice?.id ?? '';

    const solarActive = isWorking
      ? rates && rates.powerPerSec > 0
        ? 0.85
        : mission.resources.panelDustPct < 60
        ? 0.55
        : 0.35
      : 0.22;
    const moxieActive = isWorking
      ? choiceId.includes('moxie') || (rates && rates.lifePerSec > -0.025)
        ? 0.88
        : 0.62
      : 0.25;
    const shelterActive = isWorking
      ? emergencyMode === 'flare' || mission.resources.waterWallCm >= 22
        ? 0.86
        : 0.5
      : 0.2;
    const biodomeActive = isWorking
      ? Math.min(0.9, 0.38 + mission.resources.cropGrowth * 0.1)
      : 0.22;

    return {
      solar: solarActive,
      moxie: moxieActive,
      shelter: shelterActive,
      biodome: biodomeActive,
    };
  }, [
    mission.opPhase,
    mission.operationRates,
    mission.lockedChoice,
    mission.resources.panelDustPct,
    mission.resources.waterWallCm,
    mission.resources.cropGrowth,
    emergencyMode,
  ]);

  // Drive synthesized Martian ambient wind soundscape based on mission state
  useEffect(() => {
    missionAudio.setAmbientCondition({
      active: phase === 'playing' && !mission.debrief,
      isDustStorm: emergencyMode === 'dust' || atmosphereTargets.effectiveTau >= 1.0,
      isEmergency: emergencyMode !== 'none',
    });
  }, [phase, mission.debrief, emergencyMode, atmosphereTargets.effectiveTau]);

  // Continuous 5-minute (300s) Sol timeline loop: runs smoothly from 0:00 across Phase 1 & Phase 2
  useEffect(() => {
    if (
      phase !== 'playing' ||
      mission.opPhase === 'sol_complete' ||
      mission.debrief ||
      isNightCycle
    ) {
      return;
    }

    let lastTime = performance.now();
    const intervalId = window.setInterval(() => {
      const now = performance.now();
      const dtSec = Math.min((now - lastTime) / 1000, 1.0);
      lastTime = now;
      if (dtSec <= 0) return;

      setMission((prev) => {
        const next = advanceOperationTick(prev, dtSec);
        if (!prev.debrief && next.debrief) {
          missionAudio.playMissionComplete(false);
        }
        return next;
      });
    }, 250);

    return () => window.clearInterval(intervalId);
  }, [phase, mission.opPhase, mission.debrief, isNightCycle]);

  // Play chime when 300s Sol finishes and End Sol / Next Operation unlocks
  useEffect(() => {
    if (prevOpPhaseRef.current === 'operation' && mission.opPhase === 'sol_complete') {
      missionAudio.playTelemetryChime();
    }
    prevOpPhaseRef.current = mission.opPhase;
  }, [mission.opPhase]);

  const showModulePopup = useCallback(
    (moduleId: ModuleId | ScienceBoulderId, text: string, positive: boolean) => {
      if (popupTimerRef.current !== null) {
        window.clearTimeout(popupTimerRef.current);
      }
      setActivePopup({
        id: Date.now() + Math.random(),
        moduleId,
        text,
        positive,
      });
      popupTimerRef.current = window.setTimeout(() => {
        setActivePopup(null);
        popupTimerRef.current = null;
      }, 3200);
    },
    []
  );

  const showHudDeltaBadges = useCallback((power: number, life: number, health: number) => {
    if (deltaTimerRef.current !== null) {
      window.clearTimeout(deltaTimerRef.current);
    }
    setHudDeltas({
      id: Date.now() + Math.random(),
      power,
      life,
      health,
    });
    deltaTimerRef.current = window.setTimeout(() => {
      setHudDeltas(null);
      deltaTimerRef.current = null;
    }, 3200);
  }, []);

  const showInteriorBanner = useCallback((text: string, positive: boolean) => {
    if (interiorBannerTimerRef.current !== null) {
      window.clearTimeout(interiorBannerTimerRef.current);
    }
    setInteriorStatusBanner({ id: Date.now() + Math.random(), text, positive });
    interiorBannerTimerRef.current = window.setTimeout(() => {
      setInteriorStatusBanner(null);
      interiorBannerTimerRef.current = null;
    }, 3200);
  }, []);

  const showEvaBanner = useCallback((text: string, positive: boolean) => {
    if (evaBannerTimerRef.current !== null) {
      window.clearTimeout(evaBannerTimerRef.current);
    }
    setEvaStatusBanner({ id: Date.now() + Math.random(), text, positive });
    evaBannerTimerRef.current = window.setTimeout(() => {
      setEvaStatusBanner(null);
      evaBannerTimerRef.current = null;
    }, 3200);
  }, []);

  const transitionViewMode = useCallback(
    (nextMode: SceneViewMode, evaSpawnSource: 'hud' | 'airlock' = 'hud') => {
      if (viewFadeTimerRef.current !== null) {
        window.clearTimeout(viewFadeTimerRef.current);
        viewFadeTimerRef.current = null;
      }

      if (nextMode === 'interior' || nextMode === 'eva') {
        if (viewportRef.current) {
          viewportRef.current.beginCameraTransitionTo(
            nextMode,
            () => {
              setViewFadeActive(true);
              viewFadeTimerRef.current = window.setTimeout(() => {
                viewportRef.current?.setViewMode(nextMode, evaSpawnSource);
                setViewMode(nextMode);
                viewFadeTimerRef.current = window.setTimeout(() => {
                  setViewFadeActive(false);
                  viewFadeTimerRef.current = null;
                }, 220);
              }, 150);
            },
            evaSpawnSource
          );
        } else {
          setViewMode(nextMode);
        }
        return;
      }

      setViewFadeActive(true);
      viewFadeTimerRef.current = window.setTimeout(() => {
        if (viewportRef.current) {
          viewportRef.current.beginCameraTransitionTo('exterior', () => {
            viewportRef.current?.setViewMode('exterior');
            setViewMode('exterior');
          });
        } else {
          setViewMode('exterior');
        }
        viewFadeTimerRef.current = window.setTimeout(() => {
          setViewFadeActive(false);
          viewFadeTimerRef.current = null;
        }, 220);
      }, 150);
    },
    []
  );

  const enterInteriorMode = useCallback(() => {
    if (isNightCycleRef.current || missionRef.current.debrief) return;
    missionAudio.playShieldSurge();
    setDispatchOpen(false);
    setDonkiFeedOpen(false);
    setRoverTerminalOpen(false);
    transitionViewMode('interior');
  }, [transitionViewMode]);

  const exitInteriorMode = useCallback(() => {
    missionAudio.playClick();
    setRoverTerminalOpen(false);
    transitionViewMode('exterior');
  }, [transitionViewMode]);

  const enterEvaMode = useCallback(
    (spawnSource: 'hud' | 'airlock' = 'hud') => {
      if (isNightCycleRef.current || missionRef.current.debrief) return;
      missionAudio.playShieldSurge();
      setDispatchOpen(false);
      setDonkiFeedOpen(false);
      setRoverTerminalOpen(false);
      transitionViewMode('eva', spawnSource);
    },
    [transitionViewMode]
  );

  const exitEvaMode = useCallback(() => {
    missionAudio.playClick();
    setRoverTerminalOpen(false);
    transitionViewMode('exterior');
  }, [transitionViewMode]);

  const startMission = useCallback(() => {
    clearTimers();
    sol10TriggeredRef.current = false;
    viewportRef.current?.cancelCameraTransition();
    setMission(createInitialMissionState(donkiResult.flares));
    setModuleUsage(INITIAL_USAGE);
    setDecryptedSols([]);
    setDispatchOpen(false);
    setDonkiFeedOpen(false);
    setShieldBoostActive(false);
    setIsNightCycle(false);
    setActivePopup(null);
    setHudDeltas(null);
    setRoverPhase('idle');
    setRoverTargetLabel(null);
    setRoverPhoto(INITIAL_ROVER_PHOTO);
    setRoverPhotoHistory([INITIAL_ROVER_PHOTO]);
    setRoverPhotoLoading(false);
    setAnalyzedRockIds([]);
    setRoverTerminalOpen(false);
    setInteriorStatusBanner(null);
    setEvaStatusBanner(null);
    setViewFadeActive(false);
    setViewMode('exterior');
    viewportRef.current?.setViewMode('exterior');
    setPhase('playing');
    setShowScienceLog(false);
    setActiveTerm(null);
  }, [clearTimers, donkiResult.flares]);

  // Auto-trigger / highlight interior transition upon surviving to Sol 10
  useEffect(() => {
    if (
      phase === 'playing' &&
      mission.sol === MAX_SOLS &&
      !mission.debrief &&
      !sol10TriggeredRef.current
    ) {
      sol10TriggeredRef.current = true;
      if (viewMode === 'exterior') {
        enterInteriorMode();
      }
      showInteriorBanner(
        'Sol 10 Milestone — Welcome inside Jezero Command Habitat!',
        true
      );
    }
  }, [phase, mission.sol, mission.debrief, viewMode, enterInteriorMode, showInteriorBanner]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (phase === 'title' && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        missionAudio.playSolAdvance();
        startMission();
        return;
      }
      if (e.key === 'Escape') {
        if (roverTerminalOpen) setRoverTerminalOpen(false);
        else if (activeTerm) setActiveTerm(null);
        else if (showScienceLog) setShowScienceLog(false);
        else if (donkiFeedOpen) setDonkiFeedOpen(false);
        else if (dispatchOpen) setDispatchOpen(false);
        else if (viewMode === 'interior' && !interiorState.pointerLocked) {
          exitInteriorMode();
        } else if (viewMode === 'eva' && !evaState.pointerLocked) {
          exitEvaMode();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    phase,
    roverTerminalOpen,
    activeTerm,
    showScienceLog,
    donkiFeedOpen,
    dispatchOpen,
    viewMode,
    interiorState.pointerLocked,
    evaState.pointerLocked,
    exitInteriorMode,
    exitEvaMode,
    startMission,
  ]);

  const isSolarFlareActive =
    emergencyMode === 'flare' || donkiVisualState.level !== 'quiet';

  const handleModuleAction = useCallback(
    (moduleId: ModuleId) => {
      if (
        isNightCycle ||
        mission.debrief ||
        (mission.opPhase !== 'operation' && mission.opPhase !== 'sol_complete')
      ) {
        return;
      }

      const { nextState, result } = applyModuleActionToMission(mission, moduleId, {
        flareActive: isSolarFlareActive,
      });
      if (!result.applied) {
        missionAudio.playWarningKlaxon();
        showModulePopup(moduleId, result.feedbackText, false);
        return;
      }

      if (moduleId === 'moxie') missionAudio.playMoxieTurbine();
      else if (moduleId === 'solar') missionAudio.playSolarServoSweep();
      else if (moduleId === 'shelter') {
        missionAudio.playShieldSurge();
        setShieldBoostActive(true);
        if (shieldTimerRef.current !== null) {
          window.clearTimeout(shieldTimerRef.current);
        }
        shieldTimerRef.current = window.setTimeout(() => {
          setShieldBoostActive(false);
          shieldTimerRef.current = null;
        }, 11000);
      } else missionAudio.playBiodomeMist();

      viewportRef.current?.triggerModulePulse(moduleId);
      setMission(nextState);
      setModuleUsage((prev) => ({ ...prev, [moduleId]: prev[moduleId] + 1 }));
      showModulePopup(moduleId, result.feedbackText, true);
      showHudDeltaBadges(result.deltaPower, result.deltaLife, result.deltaHealth);
    },
    [isNightCycle, mission, isSolarFlareActive, showModulePopup, showHudDeltaBadges]
  );

  const handleDeployRover = useCallback(
    (target: RoverMissionTarget) => {
      const current = missionRef.current;
      if (
        isNightCycleRef.current ||
        current.debrief ||
        roverPhaseRef.current !== 'idle'
      ) {
        return;
      }

      const targetAnchorId = target.kind === 'rock' ? target.rockId : target.moduleId;
      const dispatch = deployRoverFromMission(current);
      if (!dispatch.dispatched) {
        missionAudio.playWarningKlaxon();
        showModulePopup(targetAnchorId, dispatch.reason ?? 'Need 10 kWh!', false);
        showInteriorBanner(dispatch.reason ?? 'Need 10 kWh Power to deploy Rover!', false);
        return;
      }

      const started = viewportRef.current?.deployRover(target);
      if (!started) return;

      missionAudio.playRoverDispatch();
      setMission(dispatch.nextState);
      showModulePopup(targetAnchorId, `Rover En Route (${target.label})`, true);
      showInteriorBanner(`Exterior Rover Dispatched -> ${target.label} (-10 kWh)`, true);
      showHudDeltaBadges(dispatch.deltaPower, 0, 0);
    },
    [showModulePopup, showInteriorBanner, showHudDeltaBadges]
  );

  const handleRefreshRoverFeed = useCallback(() => {
    const current = missionRef.current;
    setRoverPhotoLoading(true);
    const seenIds = roverPhotoHistoryRef.current
      .filter((p) => p.id > 0)
      .map((p) => p.id);
    fetchPerseveranceFhazBatch(current.sol, 'Terminal Downlink', seenIds)
      .then((batch) => {
        setRoverPhoto(batch.primary);
        setRoverPhotoHistory((prev) => {
          const combined = [batch.primary, ...prev, ...batch.gallery];
          const unique: RoverCameraPhoto[] = [];
          const seen = new Set<number>();
          for (const item of combined) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            unique.push(item);
          }
          return unique.slice(0, 4);
        });
      })
      .finally(() => {
        setRoverPhotoLoading(false);
      });
  }, []);

  const handleInteriorInteract = useCallback(
    (id: InteriorInteractableId) => {
      const current = missionRef.current;
      if (current.debrief) return;

      if (id === 'airlock_exit') {
        enterEvaMode('airlock');
        return;
      }

      if (id === 'rover_terminal') {
        viewportRef.current?.unlockInteriorPointer();
        missionAudio.playClick();
        setRoverTerminalOpen(true);
        return;
      }

      if (id === 'holo_map') {
        missionAudio.playTelemetryChime();
        showInteriorBanner(
          `Jezero Holomap · Sol ${current.sol}/${MAX_SOLS} · Tau ${current.weather.tau.toFixed(2)} · ${current.resources.sciencePoints} Sci Pts`,
          true
        );
        return;
      }

      if (id === 'moxie_unit') {
        const outcome = performInteriorMoxieRepair(current);
        missionAudio.playMoxieTurbine();
        viewportRef.current?.triggerInteriorFeedback('moxie_unit');
        setMission(outcome.nextState);
        setModuleUsage((prev) => ({ ...prev, moxie: prev.moxie + 1 }));
        showHudDeltaBadges(0, outcome.deltaLife, 0);
        showInteriorBanner(outcome.feedbackText, true);
        return;
      }

      if (id === 'crop_racks') {
        const outcome = performInteriorBiodomeHarvest(current);
        missionAudio.playBiodomeMist();
        viewportRef.current?.triggerInteriorFeedback('crop_racks');
        setMission(outcome.nextState);
        setModuleUsage((prev) => ({ ...prev, biodome: prev.biodome + 1 }));
        showHudDeltaBadges(0, outcome.deltaLife, 0);
        showInteriorBanner(outcome.feedbackText, true);
        return;
      }

      if (id === 'water_tanks') {
        const { nextState, result } = applyModuleActionToMission(current, 'shelter', {
          flareActive: false,
        });
        if (!result.applied) {
          missionAudio.playWarningKlaxon();
          showInteriorBanner(result.feedbackText, false);
          return;
        }
        missionAudio.playShieldSurge();
        setMission(nextState);
        setModuleUsage((prev) => ({ ...prev, shelter: prev.shelter + 1 }));
        showHudDeltaBadges(result.deltaPower, result.deltaLife, result.deltaHealth);
        showInteriorBanner(result.feedbackText, true);
      }
    },
    [enterEvaMode, showHudDeltaBadges, showInteriorBanner]
  );

  const handleEvaInteract = useCallback(
    (id: EvaInteractableId) => {
      const current = missionRef.current;
      if (current.debrief) return;

      if (id === 'eva_airlock') {
        enterInteriorMode();
        return;
      }

      if (id === 'eva_rover') {
        viewportRef.current?.unlockEvaPointer();
        missionAudio.playClick();
        setRoverTerminalOpen(true);
        handleRefreshRoverFeed();
        return;
      }

      if (current.opPhase !== 'operation' && current.opPhase !== 'sol_complete') {
        missionAudio.playWarningKlaxon();
        showEvaBanner('Lock in Sol Decision Card first (Orbital View)', false);
        return;
      }

      if (id === 'eva_solar') {
        const { nextState, result } = applyModuleActionToMission(current, 'solar', {
          flareActive: isSolarFlareActive,
        });
        if (!result.applied) {
          missionAudio.playWarningKlaxon();
          showEvaBanner(result.feedbackText, false);
          return;
        }
        missionAudio.playSolarServoSweep();
        viewportRef.current?.triggerModulePulse('solar');
        setMission(nextState);
        setModuleUsage((prev) => ({ ...prev, solar: prev.solar + 1 }));
        showHudDeltaBadges(result.deltaPower, result.deltaLife, result.deltaHealth);
        showEvaBanner(result.feedbackText, true);
        return;
      }

      if (id === 'eva_moxie') {
        const { nextState, result } = applyModuleActionToMission(current, 'moxie', {
          flareActive: isSolarFlareActive,
        });
        if (!result.applied) {
          missionAudio.playWarningKlaxon();
          showEvaBanner(result.feedbackText, false);
          return;
        }
        missionAudio.playMoxieTurbine();
        viewportRef.current?.triggerModulePulse('moxie');
        setMission(nextState);
        setModuleUsage((prev) => ({ ...prev, moxie: prev.moxie + 1 }));
        showHudDeltaBadges(result.deltaPower, result.deltaLife, result.deltaHealth);
        showEvaBanner(result.feedbackText, true);
      }
    },
    [
      enterInteriorMode,
      handleRefreshRoverFeed,
      isSolarFlareActive,
      showEvaBanner,
      showHudDeltaBadges,
    ]
  );

  const handleRoverPhaseChange = useCallback((nextPhase: RoverPhase, label: string | null) => {
    setRoverPhase(nextPhase);
    setRoverTargetLabel(label);
    if (nextPhase === 'working') {
      missionAudio.playRoverLaserScan();
    }
  }, []);

  const handleRoverTaskComplete = useCallback(
    (target: RoverMissionTarget) => {
      const current = missionRef.current;
      const previewOutcome = completeRoverTaskOnMission(current, target.kind, target.label);

      setMission((prev) => completeRoverTaskOnMission(prev, target.kind, target.label).nextState);

      if (target.kind === 'rock') {
        const rockId = target.rockId;
        setAnalyzedRockIds((prev) => (prev.includes(rockId) ? prev : [...prev, rockId]));
      } else {
        const modId = target.moduleId;
        viewportRef.current?.triggerModulePulse(modId);
        setModuleUsage((prev) => ({ ...prev, [modId]: prev[modId] + 1 }));
      }

      missionAudio.playTelemetryChime();
      const targetAnchorId = target.kind === 'rock' ? target.rockId : target.moduleId;
      showModulePopup(targetAnchorId, previewOutcome.feedbackText, true);
      showHudDeltaBadges(
        previewOutcome.deltaPower,
        previewOutcome.deltaLife,
        previewOutcome.deltaHealth
      );

      setRoverPhotoLoading(true);
      const seenIds = roverPhotoHistoryRef.current
        .filter((p) => p.id > 0)
        .map((p) => p.id);
      fetchPerseveranceFhazBatch(current.sol, target.label, seenIds)
        .then((batch) => {
          setRoverPhoto(batch.primary);
          setRoverPhotoHistory((prev) => {
            const combined = [batch.primary, ...prev, ...batch.gallery];
            const unique: RoverCameraPhoto[] = [];
            const seen = new Set<number>();
            for (const item of combined) {
              if (seen.has(item.id)) continue;
              seen.add(item.id);
              unique.push(item);
            }
            return unique.slice(0, 4);
          });
          setRoverCamCollapsed(false);
        })
        .finally(() => {
          setRoverPhotoLoading(false);
        });
    },
    [showModulePopup, showHudDeltaBadges]
  );

  const handleOpenDecisionCards = () => {
    if (isNightCycle || mission.debrief || mission.opPhase !== 'crisis_brief') return;
    missionAudio.playClick();
    setMission((prev) => openDecisionCards(prev));
  };

  const handleChooseDilemma = (choice: DilemmaChoice) => {
    const next = lockInDecisionChoice(mission, choice);
    setMission(next);
    if (next.debrief) {
      missionAudio.playMissionComplete(next.debrief.outcome === 'VICTORY');
      return;
    }
    showHudDeltaBadges(
      choice.effects.powerKwh,
      choice.effects.lifeSupportPct,
      choice.effects.crewHealthPct
    );
    if (chapter.hazardType !== 'none' || choice.effects.dustDelta > 0) {
      missionAudio.playHazardImpact();
    } else {
      missionAudio.playTelemetryChime();
    }
  };

  const handleToggleFastForward = () => {
    if (
      !mission.fastForwardUnlocked ||
      hasUnresolvedCrisisAlert(mission) ||
      mission.debrief ||
      mission.opPhase !== 'operation'
    ) {
      return;
    }
    missionAudio.playClick();
    setMission((prev) => toggleFastForward(prev));
  };

  const handleAdvanceNextSol = () => {
    if (isNightCycle || mission.debrief || mission.opPhase !== 'sol_complete') return;
    setDispatchOpen(false);
    if (chapter.hazardType !== 'none') {
      missionAudio.playHazardImpact();
    } else {
      missionAudio.playSolAdvance();
    }

    setMission((prev) => {
      const next = advanceToNextSol(prev, donkiResult.flares);
      if (next.debrief) {
        missionAudio.playMissionComplete(next.debrief.outcome === 'VICTORY');
      } else if (
        next.resources.powerKwh < 30 ||
        next.resources.lifeSupportPct < 35 ||
        next.resources.crewHealthPct < 35
      ) {
        missionAudio.playWarningKlaxon();
      }
      return next;
    });
  };

  const handleMarkDecrypted = useCallback((solNum: number) => {
    setDecryptedSols((prev) => (prev.includes(solNum) ? prev : [...prev, solNum]));
  }, []);

  const toggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    missionAudio.setMuted(nextMuted);
    if (!nextMuted) missionAudio.playClick();
  };

  const isDecisionModalOpen = mission.opPhase === 'decision_cards' && Boolean(mission.pendingDilemma);
  const modalOpen = Boolean(
    isDecisionModalOpen ||
      mission.debrief ||
      showScienceLog ||
      activeTerm ||
      roverTerminalOpen
  );

  useEffect(() => {
    viewportRef.current?.setInteriorInputPaused(modalOpen);
    viewportRef.current?.setEvaInputPaused(modalOpen);
  }, [modalOpen]);

  if (phase === 'title') {
    return <TitleScreen onStart={startMission} nasaStatusNote={donkiResult.statusNote} />;
  }

  const powerPct = Math.round((mission.exactResources.powerKwh / MAX_BATTERY_KWH) * 100);
  const lifePct = Math.round(mission.exactResources.lifeSupportPct);
  const healthPct = Math.round(mission.exactResources.crewHealthPct);
  const isEmergency = emergencyMode !== 'none' || donkiVisualState.level === 'x_class';
  const emBorderClass =
    donkiVisualState.level === 'x_class'
      ? 'hud-em-static-x'
      : donkiVisualState.level === 'm_class'
      ? 'hud-em-static-m'
      : '';
  const hasUnreadDispatch = !decryptedSols.includes(mission.sol);
  const isInterior = viewMode === 'interior';
  const isEvaMode = viewMode === 'eva';

  const isPhase1 = mission.opPhase === 'crisis_brief' || mission.opPhase === 'decision_cards';
  const isPhase2Or3 = mission.opPhase === 'operation' || mission.opPhase === 'sol_complete';
  const remainingSec = Math.max(0, mission.operationDurationSec - mission.operationElapsedSec);
  const fastForwardUnlockSec = getFastForwardUnlockSec(mission.sol);
  const fastForwardWaitSec = Math.max(0, fastForwardUnlockSec - mission.operationElapsedSec);
  const crisisAlertUnresolved = hasUnresolvedCrisisAlert(mission);
  const opProgressPct = Math.min(
    100,
    Math.round((mission.operationElapsedSec / mission.operationDurationSec) * 100)
  );

  const phaseLabel =
    mission.opPhase === 'crisis_brief'
      ? 'Phase 1 · Early Shift'
      : mission.opPhase === 'decision_cards'
      ? 'Phase 1 · Tactical Cards'
      : mission.opPhase === 'operation'
      ? mission.fastForwardActive
        ? `Phase 2 · ${FAST_FORWARD_MULTIPLIER}x Fast Forward`
        : 'Phase 2 · Live Operation'
      : 'Phase 3 · Ready to Advance';

  return (
    <div
      data-emergency={emergencyMode}
      data-donki-level={donkiVisualState.level}
      data-op-phase={mission.opPhase}
      data-view-mode={viewMode}
      className="relative w-screen h-screen overflow-hidden bg-[#070B14] text-slate-100 select-none"
    >
      {/* Full-Screen 3D Mars Outpost (Orbital Exterior, Walkable Habitat Interior & Exterior EVA Walk) */}
      <MarsViewport
        ref={viewportRef}
        resources={mission.resources}
        tau={atmosphereTargets.effectiveTau}
        targetModule={chapter.targetModule}
        emergencyMode={emergencyMode}
        atmosphere={atmosphereTargets}
        hazardType={chapter.hazardType}
        activeSystemGlow={activeSystemGlow}
        donkiTelemetry={donkiTelemetry}
        speedMultiplier={mission.speedMultiplier}
        isNightCycle={isNightCycle}
        disabled={modalOpen || isPhase1}
        activePopup={activePopup}
        roverPhase={roverPhase}
        analyzedRockIds={analyzedRockIds}
        viewMode={viewMode}
        highlightDomeInteriorEntry={mission.sol >= MAX_SOLS}
        onModuleAction={handleModuleAction}
        onEnterInterior={enterInteriorMode}
        onDeployRover={handleDeployRover}
        onRoverPhaseChange={handleRoverPhaseChange}
        onRoverTaskComplete={handleRoverTaskComplete}
        onViewModeChange={setViewMode}
        onInteriorStateUpdate={setInteriorState}
        onInteriorInteract={handleInteriorInteract}
        onEvaStateUpdate={setEvaState}
        onEvaInteract={handleEvaInteract}
      />

      {/* Smooth Airlock Transition Fade Overlay */}
      <div
        aria-hidden="true"
        className={`pointer-events-none fixed inset-0 z-40 bg-[#050811] transition-opacity duration-200 ${
          viewFadeActive ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Minimal Translucent Top HUD Bar */}
      <header className="relative z-20 pointer-events-none px-2.5 sm:px-5 pt-2 sm:pt-2.5">
        <div
          data-testid="top-hud-bar"
          className={`pointer-events-auto w-[98%] max-w-[1440px] mx-auto rounded-xl px-2.5 py-1.5 shadow-xl flex flex-col gap-1.5 border transition-colors ${emBorderClass} ${
            isEmergency
              ? 'bg-[#19090E]/92 border-rose-500/80 shadow-[0_0_24px_rgba(239,68,68,0.24)]'
              : donkiVisualState.level === 'm_class'
              ? 'bg-[#100918]/92 border-fuchsia-400/55 shadow-[0_0_20px_rgba(192,132,252,0.16)]'
              : 'bg-[#070B14]/90 border-slate-700/80'
          }`}
        >
          {/* Row 1: Sol, Operational Phase, Emergency Banner, MEDA Weather & Utility Buttons */}
          <div className="flex items-center justify-between gap-2 overflow-x-auto pb-0.5 sm:pb-0">
            <div className="flex items-center gap-x-1.5 gap-y-0.5 min-w-0 flex-nowrap shrink-0">
              <h1 className="text-[11.5px] font-bold tracking-tight text-white whitespace-nowrap">
                OUTPOST COMMAND
              </h1>
              <span
                data-testid="hud-sol-counter"
                className="text-[10.5px] font-mono font-semibold text-cyan-300 whitespace-nowrap"
              >
                <ScienceTermButton termKey="sol" onSelectTerm={setActiveTerm} /> {mission.sol}/
                {MAX_SOLS}
              </span>
              <span
                data-testid="hud-phase-badge"
                className={`inline-flex items-center gap-1 px-1 py-0.5 rounded border text-[9.5px] font-mono font-semibold whitespace-nowrap ${
                  mission.opPhase === 'sol_complete'
                    ? 'bg-emerald-950/90 border-emerald-400/70 text-emerald-200'
                    : mission.opPhase === 'operation'
                    ? 'bg-cyan-950/90 border-cyan-400/70 text-cyan-200'
                    : 'bg-amber-950/90 border-amber-400/70 text-amber-200'
                }`}
              >
                {phaseLabel}
              </span>
              {isEmergency && (
                <span
                  data-testid="emergency-protocol-badge"
                  className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-rose-950/90 border border-rose-500/80 text-[9.5px] font-mono font-bold text-rose-200 whitespace-nowrap"
                >
                  <AlertTriangle className="w-2.5 h-2.5 text-amber-400 shrink-0" aria-hidden="true" />
                  <span>
                    {donkiVisualState.level === 'x_class' || emergencyMode === 'flare'
                      ? 'FLARE'
                      : 'DUST'}
                  </span>
                </span>
              )}
              <span className="hidden md:inline-flex items-center gap-1 text-[10px] font-mono text-slate-300 whitespace-nowrap">
                <span data-testid="hud-sol-clock" className="text-cyan-300 font-semibold">
                  {formatMmSs(mission.operationElapsedSec)}/{formatMmSs(SOL_DURATION_SEC)}
                </span>
                <span className="text-slate-600">·</span>
                <span>{mission.weather.tempMinC}°C</span>
                <span className="text-slate-600">·</span>
                <span>
                  <ScienceTermButton termKey="tau" label="Tau" onSelectTerm={setActiveTerm} />{' '}
                  {atmosphereTargets.effectiveTau.toFixed(2)}
                </span>
              </span>
              <button
                type="button"
                data-testid="donki-telemetry-pill"
                aria-expanded={donkiFeedOpen}
                onClick={() => {
                  missionAudio.playClick();
                  setDonkiFeedOpen((prev) => !prev);
                }}
                title="Inspect Live NASA DONKI Event & 3D Space Weather"
                className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded border text-[10px] font-mono font-bold cursor-pointer transition-colors whitespace-nowrap ${
                  donkiVisualState.level === 'x_class'
                    ? 'bg-rose-950/90 border-rose-400 text-rose-200 hover:bg-rose-900'
                    : donkiVisualState.level === 'm_class'
                    ? 'bg-fuchsia-950/75 border-fuchsia-400/70 text-amber-200 hover:bg-fuchsia-900/75'
                    : 'bg-slate-800/90 border-slate-600 text-amber-300 hover:border-cyan-400'
                }`}
              >
                <Sun className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                <span>{donkiVisualState.flare.classType}</span>
                {donkiVisualState.cme.impactActive && (
                  <span className="text-[9px] text-rose-300">·CME</span>
                )}
              </button>
            </div>

            <div className="flex items-center gap-1.5 shrink-0 flex-nowrap">
              {viewMode === 'exterior' && (
                <>
                  <button
                    type="button"
                    data-testid="hud-enter-interior-btn"
                    disabled={isNightCycle || Boolean(mission.debrief)}
                    onClick={enterInteriorMode}
                    title="Enter Habitat Interior (First-Person Exploration)"
                    className="h-[26px] inline-flex items-center justify-center gap-1 px-2 rounded-md text-[10.5px] font-semibold border cursor-pointer whitespace-nowrap transition-colors bg-[#0F1E33] hover:bg-[#162B47] border-cyan-400/75 text-cyan-100 disabled:opacity-45"
                  >
                    <span>Enter Hab</span>
                  </button>
                  <button
                    type="button"
                    data-testid="hud-eva-walk-btn"
                    disabled={isNightCycle || Boolean(mission.debrief)}
                    onClick={() => enterEvaMode('hud')}
                    title="Step onto Martian Terrain in Exterior EVA First-Person Mode"
                    className="h-[26px] inline-flex items-center justify-center gap-1 px-2 rounded-md text-[10.5px] font-semibold border cursor-pointer whitespace-nowrap transition-colors bg-[#1D1528] hover:bg-[#2B1E3B] border-amber-400/75 text-amber-100 disabled:opacity-45"
                  >
                    <span>👨‍🚀 EVA Walk</span>
                  </button>
                </>
              )}
              <button
                type="button"
                data-testid="nasa-data-log-btn"
                aria-expanded={donkiFeedOpen}
                onClick={() => {
                  missionAudio.playClick();
                  setDonkiFeedOpen((prev) => !prev);
                }}
                className={`h-[26px] inline-flex items-center justify-center gap-1 px-2 rounded-md text-[10.5px] font-semibold border cursor-pointer whitespace-nowrap transition-colors ${
                  donkiFeedOpen
                    ? 'bg-cyan-500/20 border-cyan-400 text-cyan-100'
                    : 'bg-slate-800 hover:bg-slate-700 text-cyan-300 border-slate-700'
                }`}
              >
                <Database className="w-3 h-3" aria-hidden="true" />
                <span>Logs</span>
                <span className="font-mono text-[9.5px] text-emerald-300">
                  ({unlockedLogIds.length}/9)
                </span>
              </button>
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? 'Unmute sound effects' : 'Mute sound effects'}
                className="h-[26px] w-[26px] flex items-center justify-center rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
              >
                {muted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  missionAudio.playClick();
                  startMission();
                }}
                aria-label="Restart mission"
                className="h-[26px] inline-flex items-center justify-center gap-1 px-2 rounded-md bg-slate-800 hover:bg-slate-700 text-[10.5px] font-semibold text-slate-200 border border-slate-700 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                <span className="hidden sm:inline">Reset</span>
              </button>
            </div>
          </div>

          {/* Row 2: The 3 Coupled Resource Bars */}
          <div className="grid grid-cols-3 gap-2">
            {/* 1. Power Grid */}
            <div
              className={`relative bg-[#0B1220] border rounded-lg px-2 py-1 ${
                isEmergency ? 'border-rose-800/80' : 'border-slate-800'
              }`}
            >
              <div className="flex items-center justify-between gap-1 text-[10.5px] sm:text-[11px]">
                <span className="inline-flex items-center gap-1 font-medium text-amber-200 truncate">
                  <Zap className="w-3 h-3 text-amber-400 shrink-0" aria-hidden="true" />
                  <span className="hidden sm:inline">Power</span>
                </span>
                <span
                  data-testid="meter-power-value"
                  className="font-mono font-bold text-white tabular-nums whitespace-nowrap"
                >
                  {mission.opPhase === 'operation'
                    ? mission.exactResources.powerKwh.toFixed(1)
                    : mission.resources.powerKwh}{' '}
                  <span className="text-[9.5px] text-slate-400">kWh</span>
                </span>
              </div>
              <div className="mt-0.5 h-1 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-200 ${
                    powerPct < 25 ? 'bg-rose-500' : 'bg-amber-400'
                  }`}
                  style={{ width: `${powerPct}%` }}
                />
              </div>
              {mission.opPhase === 'operation' && mission.operationRates && (
                <p className="mt-0.5 text-[9.5px] font-mono text-slate-400 text-right tabular-nums leading-none">
                  {formatRate(mission.operationRates.powerPerSec, 'kWh')}
                </p>
              )}
              {hudDeltas && hudDeltas.power !== 0 && (
                <span
                  key={`p-${hudDeltas.id}`}
                  data-testid="hud-delta-power"
                  className={`anim-float-pop absolute -bottom-4 right-2 text-[10.5px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#070B14] border ${
                    hudDeltas.power > 0
                      ? 'text-emerald-300 border-emerald-500/60'
                      : 'text-amber-300 border-amber-500/60'
                  }`}
                >
                  {hudDeltas.power > 0 ? `+${hudDeltas.power}` : hudDeltas.power} kWh
                </span>
              )}
            </div>

            {/* 2. Life Support O2 & Water */}
            <div
              className={`relative bg-[#0B1220] border rounded-lg px-2 py-1 ${
                isEmergency ? 'border-rose-800/80' : 'border-slate-800'
              }`}
            >
              <div className="flex items-center justify-between gap-1 text-[10.5px] sm:text-[11px]">
                <span className="inline-flex items-center gap-1 font-medium text-cyan-200 truncate">
                  <Wind className="w-3 h-3 text-cyan-400 shrink-0" aria-hidden="true" />
                  <span className="hidden sm:inline">O₂ & Water</span>
                </span>
                <span
                  data-testid="meter-life-value"
                  className="font-mono font-bold text-white tabular-nums whitespace-nowrap"
                >
                  {mission.opPhase === 'operation'
                    ? `${mission.exactResources.lifeSupportPct.toFixed(1)}%`
                    : `${lifePct}%`}
                </span>
              </div>
              <div className="mt-0.5 h-1 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-200 ${
                    lifePct < 30 ? 'bg-rose-500' : 'bg-cyan-400'
                  }`}
                  style={{ width: `${lifePct}%` }}
                />
              </div>
              {mission.opPhase === 'operation' && mission.operationRates && (
                <p className="mt-0.5 text-[9.5px] font-mono text-slate-400 text-right tabular-nums leading-none">
                  {formatRate(mission.operationRates.lifePerSec, '%')}
                </p>
              )}
              {hudDeltas && hudDeltas.life !== 0 && (
                <span
                  key={`l-${hudDeltas.id}`}
                  data-testid="hud-delta-life"
                  className={`anim-float-pop absolute -bottom-4 right-2 text-[10.5px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#070B14] border ${
                    hudDeltas.life > 0
                      ? 'text-cyan-300 border-cyan-500/60'
                      : 'text-amber-300 border-amber-500/60'
                  }`}
                >
                  {hudDeltas.life > 0 ? `+${hudDeltas.life}%` : `${hudDeltas.life}%`}
                </span>
              )}
            </div>

            {/* 3. Radiation Shield & Crew Health */}
            <div
              className={`relative bg-[#0B1220] border rounded-lg px-2 py-1 ${
                isEmergency ? 'border-rose-800/80' : 'border-slate-800'
              }`}
            >
              <div className="flex items-center justify-between gap-1 text-[10.5px] sm:text-[11px]">
                <span className="inline-flex items-center gap-1 font-medium text-emerald-200 truncate">
                  <Shield className="w-3 h-3 text-emerald-400 shrink-0" aria-hidden="true" />
                  <span className="hidden sm:inline">Shield & Crew</span>
                </span>
                <span
                  data-testid="meter-health-value"
                  className="font-mono font-bold text-white tabular-nums whitespace-nowrap"
                >
                  {mission.opPhase === 'operation'
                    ? `${mission.exactResources.crewHealthPct.toFixed(1)}%`
                    : `${healthPct}%`}{' '}
                  <span
                    data-testid="meter-health-csv"
                    className="hidden md:inline text-[9.5px] text-sky-300"
                  >
                    ({mission.resources.waterWallCm}cm·{mission.radiationDoseCsv.toFixed(2)}cSv)
                  </span>
                </span>
              </div>
              <div className="mt-0.5 h-1 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-200 ${
                    healthPct < 35 ? 'bg-rose-500' : 'bg-emerald-400'
                  }`}
                  style={{ width: `${healthPct}%` }}
                />
              </div>
              {mission.opPhase === 'operation' && mission.operationRates && (
                <p className="mt-0.5 text-[9.5px] font-mono text-slate-400 text-right tabular-nums leading-none">
                  {formatRate(mission.operationRates.healthPerSec, '%')}
                </p>
              )}
              {hudDeltas && hudDeltas.health !== 0 && (
                <span
                  key={`h-${hudDeltas.id}`}
                  data-testid="hud-delta-health"
                  className={`anim-float-pop absolute -bottom-4 right-2 text-[10.5px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#070B14] border ${
                    hudDeltas.health > 0
                      ? 'text-emerald-300 border-emerald-500/60'
                      : 'text-rose-300 border-rose-500/60'
                  }`}
                >
                  {hudDeltas.health > 0 ? `+${hudDeltas.health}%` : `${hudDeltas.health}%`}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Non-Intrusive Live NASA DONKI Feed Inspector Card */}
      <DonkiInspectorCard
        open={donkiFeedOpen && !modalOpen}
        donkiResult={donkiResult}
        weatherState={donkiVisualState}
        waterWallCm={mission.resources.waterWallCm}
        shieldActive={shieldActive}
        unlockedCount={unlockedLogIds.length}
        onToggleSimulateXFlare={() => setSimulateXFlare((prev) => !prev)}
        onOpenArchive={() => {
          setDonkiFeedOpen(false);
          setShowScienceLog(true);
        }}
        onClose={() => setDonkiFeedOpen(false)}
      />

      {/* Collapsible Floating Rover Cam (FHAZ) HUD Widget (Exterior View) */}
      <RoverCamWidget
        currentSol={mission.sol}
        roverPhase={roverPhase}
        targetLabel={roverTargetLabel}
        photo={roverPhoto}
        photoHistory={roverPhotoHistory}
        loading={roverPhotoLoading}
        collapsed={roverCamCollapsed}
        hiddenByInspector={(donkiFeedOpen && !modalOpen) || modalOpen || viewMode !== 'exterior'}
        canDeploy={!isNightCycle && !modalOpen && isPhase2Or3}
        powerKwh={mission.resources.powerKwh}
        onToggleCollapse={() => setRoverCamCollapsed((prev) => !prev)}
        onSelectPhoto={(selected) => setRoverPhoto(selected)}
        onQuickDeploy={handleDeployRover}
      />

      {/* First-Person Habitat Interior HUD (Top telemetry bar remains visible above) */}
      {isInterior && !modalOpen && (
        <InteriorHudOverlay
          interiorState={interiorState}
          statusBanner={interiorStatusBanner}
          moxieCrisisActive={
            emergencyMode !== 'none' ||
            chapter.hazardType !== 'none' ||
            mission.resources.lifeSupportPct < 65 ||
            donkiVisualState.level !== 'quiet'
          }
          isSol10Highlight={mission.sol >= MAX_SOLS}
          onExitInterior={exitInteriorMode}
          onTriggerInteract={handleInteriorInteract}
          onVirtualInputChange={(input) => viewportRef.current?.setVirtualInteriorInput(input)}
        />
      )}

      {/* Exterior First-Person EVA Helmet Visor HUD */}
      {isEvaMode && !modalOpen && (
        <EvaHudOverlay
          evaState={evaState}
          suitO2Pct={mission.resources.lifeSupportPct}
          externalTempC={mission.weather.tempMinC}
          radiationDoseCsv={mission.radiationDoseCsv}
          flareActive={isSolarFlareActive}
          dustSquallActive={
            emergencyMode === 'dust' ||
            chapter.hazardType === 'dust' ||
            atmosphereTargets.effectiveTau >= 1.0
          }
          flareClassType={donkiVisualState.flare.classType}
          tauValue={atmosphereTargets.effectiveTau}
          statusBanner={evaStatusBanner}
          onExitToOrbital={exitEvaMode}
          onEnterHabitat={enterInteriorMode}
          onTriggerInteract={handleEvaInteract}
          onVirtualInputChange={(input) => viewportRef.current?.setVirtualEvaInput(input)}
        />
      )}


      {/* Bottom Dock: Optional Earth Audio Dispatch Drawer + Operational Phase Console (Exterior View) */}
      {viewMode === 'exterior' && (
        <footer className="fixed bottom-2 sm:bottom-2.5 inset-x-2.5 sm:inset-x-5 z-20 pointer-events-none">
          <EarthDispatchDrawer
            open={dispatchOpen && !isNightCycle}
            currentSol={mission.sol}
            emergencyMode={emergencyMode}
            decryptedSols={decryptedSols}
            onMarkDecrypted={handleMarkDecrypted}
            onClose={() => setDispatchOpen(false)}
          />

        <div
          data-testid="story-banner"
          className={`pointer-events-auto max-w-3xl mx-auto rounded-xl p-2 sm:p-2.5 shadow-2xl flex flex-col gap-1.5 border transition-colors ${emBorderClass} ${
            isEmergency
              ? 'bg-[#19090E]/94 border-rose-500/80'
              : donkiVisualState.level === 'm_class'
              ? 'bg-[#100918]/92 border-fuchsia-400/55'
              : 'bg-[#070B14]/92 border-slate-700/85'
          }`}
        >
          {/* Phase 2 / Phase 3 5-Minute Sol Timeline & Progress Bar */}
          {isPhase2Or3 && (
            <div
              data-testid="operation-timer-panel"
              className="rounded-lg bg-[#0B1220] border border-slate-800 px-2.5 py-1 flex flex-col gap-1"
            >
              <div className="flex items-center justify-between gap-2 text-[11px] min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Clock
                    className={`w-3 h-3 shrink-0 ${
                      mission.opPhase === 'sol_complete' ? 'text-emerald-400' : 'text-cyan-400'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="font-mono font-semibold text-white truncate">
                    {mission.opPhase === 'sol_complete'
                      ? 'Sol Complete — Ready'
                      : mission.fastForwardActive
                      ? `${FAST_FORWARD_MULTIPLIER}× Fast Forward`
                      : 'Sol Operation'}
                  </span>
                  {mission.lockedChoice && (
                    <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] font-mono text-amber-200 truncate">
                      {mission.lockedChoice.label}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums shrink-0 whitespace-nowrap">
                  <span
                    data-testid="operation-speed-badge"
                    className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                      mission.fastForwardActive
                        ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                        : 'bg-slate-800 border-slate-700 text-slate-300'
                    }`}
                  >
                    {mission.speedMultiplier}x
                  </span>
                  <span data-testid="operation-timer-text" className="text-cyan-300 font-bold">
                    {mission.opPhase === 'sol_complete'
                      ? '00:00 remaining'
                      : `${formatMmSs(remainingSec)} remaining`}
                  </span>
                  <span className="text-slate-400">{opProgressPct}%</span>
                </div>
              </div>

              <div
                role="progressbar"
                aria-label="5-Minute Sol Progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={opProgressPct}
                className="h-1.5 rounded-full bg-slate-800 overflow-hidden"
              >
                <div
                  data-testid="operation-progress-fill"
                  className={`h-full rounded-full transition-all duration-200 ${
                    mission.opPhase === 'sol_complete'
                      ? 'bg-emerald-400'
                      : mission.fastForwardActive
                      ? 'bg-amber-400'
                      : 'bg-cyan-400'
                  }`}
                  style={{ width: `${opProgressPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Main Command Row: Briefing / Crisis Alert + Phase Action Controls */}
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <CharacterPortrait speaker={chapter.speaker} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                  <strong className="text-xs text-white">{chapter.speakerName}</strong>
                  <span
                    className={
                      isEmergency ? 'text-rose-300 font-mono' : 'text-amber-300 font-mono'
                    }
                  >
                    {chapter.arcTitle}
                  </span>
                  <span className="text-slate-400 hidden lg:inline">· {chapter.commNote}</span>
                </div>

                {isPhase1 && mission.pendingDilemma ? (
                  <div
                    data-testid="crisis-alert-box"
                    className="rounded-lg bg-amber-950/35 border border-amber-500/40 px-2 py-1 text-[11px] text-slate-200 leading-snug"
                  >
                    <span className="font-mono font-bold text-amber-300 uppercase mr-1.5">
                      Crisis Alert:
                    </span>
                    <strong className="text-white">{mission.pendingDilemma.title} — </strong>
                    <span>{mission.pendingDilemma.description}</span>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-200 leading-snug line-clamp-2">
                    {isNightCycle
                      ? `Simulating Sol ${mission.sol} sunset & overnight transition across Jezero Crater...`
                      : chapter.storyPrompt}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-400 pt-0.5">
                  <button
                    type="button"
                    data-testid="toggle-dispatch-btn"
                    disabled={isNightCycle}
                    onClick={() => {
                      missionAudio.playClick();
                      setDispatchOpen((prev) => !prev);
                    }}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10px] cursor-pointer transition-colors whitespace-nowrap ${
                      dispatchOpen
                        ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                        : hasUnreadDispatch
                        ? 'bg-amber-500/15 border-amber-400/70 text-amber-200 hover:bg-amber-500/25'
                        : 'bg-[#0B1220] border-slate-700 text-cyan-300 hover:border-cyan-400'
                    }`}
                  >
                    <Radio className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                    <span>{dispatchOpen ? 'Hide DSN' : 'DSN Dispatch'}</span>
                    {hasUnreadDispatch && !dispatchOpen && (
                      <span className="text-amber-300 font-bold">· NEW</span>
                    )}
                  </button>
                  <ScienceTermButton termKey="moxie" onSelectTerm={setActiveTerm} />
                  <ScienceTermButton termKey="waterwall" onSelectTerm={setActiveTerm} />
                  <ScienceTermButton termKey="hydroponics" onSelectTerm={setActiveTerm} />
                  <ScienceTermButton termKey="commdelay" onSelectTerm={setActiveTerm} />
                  <span className="font-mono text-cyan-300 ml-auto whitespace-nowrap">
                    {mission.resources.sciencePoints} Sci Pts
                  </span>
                </div>
              </div>
            </div>

            {/* Phase-Specific Right Action Area */}
            <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 shrink-0">
              {isPhase1 && (
                <button
                  type="button"
                  data-testid="open-decision-cards-btn"
                  disabled={isNightCycle || isDecisionModalOpen}
                  onClick={handleOpenDecisionCards}
                  className="w-full md:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs transition-colors cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-amber-300"
                >
                  <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Open Decision Cards</span>
                </button>
              )}

              {isPhase2Or3 && (
                <>
                  <button
                    type="button"
                    data-testid="fast-forward-btn"
                    disabled={
                      !mission.fastForwardUnlocked ||
                      crisisAlertUnresolved ||
                      mission.opPhase !== 'operation' ||
                      isNightCycle ||
                      modalOpen
                    }
                    onClick={handleToggleFastForward}
                    className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg font-semibold text-xs border transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                      mission.fastForwardUnlocked &&
                      !crisisAlertUnresolved &&
                      mission.opPhase === 'operation' &&
                      !isNightCycle
                        ? mission.fastForwardActive
                          ? 'bg-cyan-500/20 hover:bg-cyan-500/30 border-cyan-400 text-cyan-100 cursor-pointer'
                          : 'bg-slate-800 hover:bg-slate-700 border-cyan-400/70 text-cyan-200 cursor-pointer'
                        : 'bg-[#0B1220] border-slate-800 text-slate-500 opacity-65 cursor-not-allowed'
                    }`}
                  >
                    {mission.fastForwardUnlocked ? (
                      <FastForward className="w-3.5 h-3.5 shrink-0 text-cyan-300" aria-hidden="true" />
                    ) : (
                      <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span>
                      {mission.opPhase === 'sol_complete'
                        ? 'Sol Complete'
                        : !mission.fastForwardUnlocked
                        ? `5x Fast-Forward (${formatMmSs(fastForwardWaitSec)})`
                        : mission.fastForwardActive
                        ? `${FAST_FORWARD_MULTIPLIER}x Speed Active`
                        : `${FAST_FORWARD_MULTIPLIER}x Fast-Forward`}
                    </span>
                  </button>

                  {mission.opPhase === 'sol_complete' && (
                    <button
                      type="button"
                      data-testid="end-sol-btn"
                      disabled={isNightCycle || modalOpen}
                      onClick={handleAdvanceNextSol}
                      className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg font-semibold text-xs transition-colors cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-cyan-300 bg-emerald-400 hover:bg-emerald-300 text-slate-950"
                    >
                      <Moon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      <span>End Sol / Next Operation</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        </footer>
      )}

      {/* Modals */}
      {roverTerminalOpen && (
        <RoverTerminalModal
          currentSol={mission.sol}
          powerKwh={mission.resources.powerKwh}
          roverPhase={roverPhase}
          targetLabel={roverTargetLabel}
          photo={roverPhoto}
          photoHistory={roverPhotoHistory}
          loading={roverPhotoLoading}
          canDeploy={!isNightCycle && !mission.debrief}
          analyzedRockIds={analyzedRockIds}
          onClose={() => setRoverTerminalOpen(false)}
          onDeployRover={handleDeployRover}
          onSelectPhoto={(selected) => setRoverPhoto(selected)}
          onRefreshFeed={handleRefreshRoverFeed}
        />
      )}

      {isDecisionModalOpen && mission.pendingDilemma && !mission.debrief && (
        <DilemmaModal
          dilemma={mission.pendingDilemma}
          sol={mission.sol}
          onChoose={handleChooseDilemma}
          onOpenScienceLog={() => setShowScienceLog(true)}
        />
      )}

      {showScienceLog && (
        <ScienceLogModal
          donkiResult={donkiResult}
          activeSol={mission.sol}
          unlockedLogIds={unlockedLogIds}
          onClose={() => setShowScienceLog(false)}
        />
      )}

      {activeTerm && (
        <ScienceDecoderModal term={activeTerm} onClose={() => setActiveTerm(null)} />
      )}

      {mission.debrief && (
        <DebriefModal debrief={mission.debrief} onReplay={startMission} />
      )}
    </div>
  );
}
