import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ModuleId, SolHazardType } from '../data/campaignArc';
import {
  clampInteriorPlayerPosition,
  findNearestInteractable,
  getInteriorZoneAt,
  INTERIOR_EYE_HEIGHT,
  INTERIOR_SPAWN,
  InteriorInteractable,
  InteriorInteractableId,
  InteriorZoneInfo,
} from '../game/interiorCollision';
import {
  createInitialEvaState,
  EVA_AIRLOCK_SPAWN,
  EVA_HUD_SPAWN,
  EvaCircleCollider,
  EvaInteractable,
  EvaInteractableId,
  EvaPhysicsState,
  findNearestEvaInteractable,
  stepEvaPhysics,
} from '../game/evaPhysics';
import {
  computeTauFogDensity,
  MissionResources,
  SolAtmosphereTargets,
} from '../game/simulation';
import { HabitatInteriorWorld } from './HabitatInteriorWorld';
import {
  createBasaltRockPbrMaps,
  createContactShadowTexture,
  createDustOverlayTexture,
  createDustParticleSpriteTexture,
  createDustSheetTexture,
  createHabitatHullPbrMaps,
  createMarsRegolithTextures,
  createMliBlanketPbrMaps,
  createProceduralNoisePbrMaps,
  createRoverTrackTexture,
  createScorchDecalTexture,
  createSolarCellPbrMaps,
} from './marsTextures';

import { DonkiSeverityLevel } from '../utils/nasaApi';

export type EmergencyMode = 'none' | 'dust' | 'flare';
export type ActiveSystemGlow = Record<ModuleId, number>;

export interface DonkiSceneTelemetry {
  level: DonkiSeverityLevel;
  intensity: number;
  cmeActive: boolean;
  shieldActive: boolean;
}

export interface AtmosphereTimelineInput {
  atmosphere: SolAtmosphereTargets;
  hazardType: SolHazardType;
  activeSystemGlow: ActiveSystemGlow;
  speedMultiplier: number;
  donki?: DonkiSceneTelemetry;
}

export type RoverPhase = 'idle' | 'outbound' | 'working' | 'returning';
export type ScienceBoulderId = 'rock-delta' | 'rock-olivine' | 'rock-carbonate' | 'rock-sulfate';

export interface ProjectedModuleAnchor {
  id: ModuleId;
  x: number;
  y: number;
  visible: boolean;
}

export interface ProjectedRockAnchor {
  id: ScienceBoulderId;
  label: string;
  x: number;
  y: number;
  visible: boolean;
}

export type RoverMissionTarget =
  | { kind: 'solar' | 'moxie'; moduleId: 'solar' | 'moxie'; label: string }
  | { kind: 'rock'; rockId: ScienceBoulderId; label: string };

export type SceneViewMode = 'exterior' | 'interior' | 'eva';

export interface InteriorPlayerState {
  zone: InteriorZoneInfo;
  nearestInteractable: InteriorInteractable | null;
  pointerLocked: boolean;
}

export interface EvaPlayerState {
  nearestInteractable: EvaInteractable | null;
  pointerLocked: boolean;
}

export interface MarsSceneCallbacks {
  onModuleClick: (moduleId: ModuleId) => void;
  onHoverModule: (moduleId: ModuleId | null) => void;
  onAnchorsUpdate: (anchors: ProjectedModuleAnchor[]) => void;
  onRockClick?: (rockId: ScienceBoulderId, label: string) => void;
  onHoverRock?: (rockId: ScienceBoulderId | null) => void;
  onRockAnchorsUpdate?: (anchors: ProjectedRockAnchor[]) => void;
  onRoverPhaseChange?: (phase: RoverPhase, label: string | null) => void;
  onRoverTaskComplete?: (target: RoverMissionTarget) => void;
  onViewModeChange?: (mode: SceneViewMode) => void;
  onInteriorStateUpdate?: (state: InteriorPlayerState) => void;
  onInteriorInteract?: (id: InteriorInteractableId) => void;
  onEvaStateUpdate?: (state: EvaPlayerState) => void;
  onEvaInteract?: (id: EvaInteractableId) => void;
  onWebglError?: (reason: string) => void;
}

interface ModulePulse {
  moduleId: ModuleId;
  startTimeMs: number;
  duration: number;
}

interface NightCycleAnim {
  active: boolean;
  startTimeMs: number;
  duration: number;
  hazardType: SolHazardType;
  shieldBlockedFlare: boolean;
  completed: boolean;
  onComplete: () => void;
}

const MARTIAN_HORIZON_HEX = 0x384c66;

function detectSoftwareWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return false;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(renderer);
  } catch {
    return false;
  }
}

export function groundHeightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const angle = Math.atan2(z, x);
  // Asymmetric wind-carved sand dunes outside the leveled central outpost plateau
  const waveA = Math.sin(x * 0.19 + Math.cos(z * 0.14) * 1.15);
  const waveB = Math.sin((x * 0.72 - z * 0.68) * 0.16);
  const ridgeC = 1.0 - Math.abs(Math.sin(x * 0.085 + z * 0.105));
  const dunes = waveA * 0.24 + waveB * 0.18 + (ridgeC - 0.5) * 0.34;
  // Flat central plateau for base foundations, undulating wind-carved dunes and crater ridges outward
  const plateauWeight = THREE.MathUtils.smoothstep(r, 11.5, 25.0);
  const craterRidges =
    plateauWeight *
    (0.38 +
      Math.min(2.8, Math.max(0, r - 17) * 0.028) *
        (0.85 +
          0.32 * Math.sin(angle * 4.0 + 0.6) +
          0.18 * Math.cos(angle * 7.0 - 0.4) +
          0.1 * Math.sin(angle * 13.0 + 1.1)));
  const detail = plateauWeight * dunes + (1 - plateauWeight) * (dunes * 0.05);
  return craterRidges + detail;
}

function createAngularRockGeometry(seed: number, radius: number, detail = 1): THREE.DodecahedronGeometry {
  const geo = new THREE.DodecahedronGeometry(radius, detail);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const dirHash =
      Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed * 19.3) * 43758.5453;
    const n = dirHash - Math.floor(dirHash);
    // Quantize slightly for flat sedimentary/volcanic fracture planes
    const facetScale = 0.76 + Math.floor(n * 5) * 0.11;
    v.multiplyScalar(facetScale);
    if (v.y > 0) v.y *= 0.82;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export class MarsOutpostScene {
  private container: HTMLElement;
  private callbacks: MarsSceneCallbacks;
  private isSoftwareGl: boolean;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private composer: EffectComposer | null = null;
  private composerRenderPass: RenderPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private outputPass: OutputPass | null = null;
  private pmremGenerator: THREE.PMREMGenerator | null = null;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private interiorEnvRenderTarget: THREE.WebGLRenderTarget | null = null;

  private sunLight!: THREE.DirectionalLight;
  private rimLight!: THREE.DirectionalLight;
  private hemiLight!: THREE.HemisphereLight;
  private shelterInteriorLight!: THREE.PointLight;
  private moxieLight!: THREE.PointLight;
  private biodomeLight!: THREE.PointLight;
  private readonly baseSunPos = new THREE.Vector3(-85, 28, -60);
  private sunDiscGroup!: THREE.Group;
  private sunHaloInnerMat!: THREE.SpriteMaterial;
  private sunCoronaMat!: THREE.SpriteMaterial;
  private terrainSheenUniform = { value: 1.0 };

  private skyDomeMat: THREE.ShaderMaterial | null = null;
  private skyColor = new THREE.Color(MARTIAN_HORIZON_HEX);
  private daySkyColor = new THREE.Color(MARTIAN_HORIZON_HEX);
  private dustAlertSkyColor = new THREE.Color('#8E4622');
  private flareAlertSkyColor = new THREE.Color('#2E1A3E');
  private mClassHorizonColor = new THREE.Color('#4A4573');
  private mClassZenithColor = new THREE.Color('#13193B');
  private xClassHorizonColor = new THREE.Color('#5C1D35');
  private xClassZenithColor = new THREE.Color('#150819');
  private sunsetSkyColor = new THREE.Color('#473B54');
  private nightSkyColor = new THREE.Color('#070C1B');
  private flareSkyColor = new THREE.Color('#301C42');
  private ridgeBandDayColor = new THREE.Color('#A67551');
  private ridgeBandNightColor = new THREE.Color('#181B2C');

  private calmSunColor = new THREE.Color('#FFF0D4');
  private alertSunColor = new THREE.Color('#FFA488');
  private xClassSunColor = new THREE.Color('#FF4D62');
  private calmHemiSky = new THREE.Color('#5BC0BE');
  private calmHemiGround = new THREE.Color('#8C4227');
  private xClassHemiSky = new THREE.Color('#DC2626');
  private xClassHemiGround = new THREE.Color('#4A0B14');
  private calmRimColor = new THREE.Color('#5BC0BE');
  private xClassRimColor = new THREE.Color('#FF1F4B');
  private calmWindowColor = new THREE.Color('#FEF08A');
  private calmWindowEmissive = new THREE.Color('#F59E0B');
  private calmHullColor = new THREE.Color('#EEF4F8');
  private alertHullTint = new THREE.Color('#FCA5A5');
  private alertRedColor = new THREE.Color('#FF2A2A');
  private alertAmberColor = new THREE.Color('#FF7A00');
  private calmMoxieColor = new THREE.Color('#00E5FF');
  private calmMoxieEmissive = new THREE.Color('#00B8D4');
  private calmBioColor = new THREE.Color('#A7F3D0');
  private calmBioEmissive = new THREE.Color('#10B981');
  private calmLedColor = new THREE.Color('#34D399');
  private calmLedEmissive = new THREE.Color('#10B981');
  private calmBeaconColor = new THREE.Color('#00E5FF');
  private calmBeaconEmissive = new THREE.Color('#00E5FF');
  private blackColor = new THREE.Color('#000000');
  private scratchAlertColor = new THREE.Color();
  private scratchTargetZenith = new THREE.Color('#0B132B');
  private zenithColor = new THREE.Color('#0B132B');
  private zenithDayColor = new THREE.Color('#0B132B');
  private zenithNightColor = new THREE.Color('#050814');

  private fog!: THREE.FogExp2;
  private starsPoints!: THREE.Points;
  private starsMat!: THREE.PointsMaterial;
  private auroraGroup!: THREE.Group;
  private auroraMats: THREE.ShaderMaterial[] = [];

  // Shared procedural PBR texture pairs for all MeshStandardMaterials
  private sharedMetalPbr!: { bumpMap: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture };
  private sharedRegolithPbr!: { bumpMap: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture };

  // Dynamic module references
  private solarTiltGroups: THREE.Group[] = [];
  private solarCellMat!: THREE.MeshPhysicalMaterial;
  private solarBatteryMat!: THREE.MeshStandardMaterial;
  private solarDustMat!: THREE.MeshStandardMaterial;
  private habitatDustMat!: THREE.MeshStandardMaterial;
  private solarWipers: Array<{ mesh: THREE.Mesh; baseX: number }> = [];

  private moxieFan!: THREE.Group;
  private moxieTankMat!: THREE.MeshStandardMaterial;
  private moxieBeaconMat!: THREE.MeshStandardMaterial;
  private moxieBubbles: THREE.Mesh[] = [];
  private moxieExhaustPoints!: THREE.Points;
  private moxieExhaustPositions!: Float32Array;
  private moxieExhaustSeeds: Array<{ baseX: number; baseZ: number; phase: number }> = [];

  private waterShieldMesh!: THREE.Mesh;
  private waterShieldMat!: THREE.MeshPhysicalMaterial;
  private waterShieldHexMesh!: THREE.Mesh;
  private waterShieldHexMat!: THREE.ShaderMaterial;
  private shelterHullMat!: THREE.MeshStandardMaterial;
  private shelterWindowMat!: THREE.MeshStandardMaterial;
  private shelterBeaconMat!: THREE.MeshStandardMaterial;
  private shelterRoofRedStrobeMat!: THREE.MeshStandardMaterial;
  private shelterRoofCyanStrobeMat!: THREE.MeshStandardMaterial;
  private airlockStripMat!: THREE.MeshStandardMaterial;
  private commsBeaconMat!: THREE.MeshStandardMaterial;

  private biodomeCrops: THREE.Group[] = [];
  private bioLeafMat!: THREE.MeshStandardMaterial;
  private biodomeGlassMat!: THREE.MeshPhysicalMaterial;
  private bioLedRingMat!: THREE.MeshStandardMaterial;
  private biodomeBeaconMat!: THREE.MeshStandardMaterial;
  private solarBeaconMat!: THREE.MeshStandardMaterial;
  private exteriorBaseGroup!: THREE.Group;

  private targetRing!: THREE.Mesh;
  private hoverRing!: THREE.Mesh;

  // Particle effects & drifting 3D dust-mote sheets
  private dustStormPoints!: THREE.Points;
  private dustStormMat!: THREE.PointsMaterial;
  private dustPositions!: Float32Array;
  private dustSheets: Array<{
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    baseY: number;
    speed: number;
    phase: number;
    z: number;
  }> = [];

  private flareBoltsGroup!: THREE.Group;
  private flareBolts: Array<{
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    vel: THREE.Vector3;
    speed: number;
    angle: number;
    radius: number;
    deflected: boolean;
    skyStreak: boolean;
  }> = [];

  private anchorWorldMap: Record<ModuleId, THREE.Vector3> = {
    solar: new THREE.Vector3(-7.2, 3.05, 2.2),
    moxie: new THREE.Vector3(-4.0, 3.65, -4.4),
    shelter: new THREE.Vector3(0.9, 4.45, 1.0),
    biodome: new THREE.Vector3(7.1, 3.35, 2.0),
  };

  private moduleWorldCenters: Record<ModuleId, THREE.Vector3> = {
    solar: new THREE.Vector3(-6.8, 0.2, 2.2),
    moxie: new THREE.Vector3(-3.7, 0.2, -4.4),
    shelter: new THREE.Vector3(0.9, 0.2, 1.0),
    biodome: new THREE.Vector3(6.8, 0.2, 2.0),
  };

  private hitColliders: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private projScratch = new THREE.Vector3();
  private lastAnchors: ProjectedModuleAnchor[] = [];
  private lastRockAnchors: ProjectedRockAnchor[] = [];

  // Clickable Martian science boulders
  private rockWorldCenters: Partial<Record<ScienceBoulderId, THREE.Vector3>> = {};
  private rockAnchorWorldMap: Partial<Record<ScienceBoulderId, THREE.Vector3>> = {};
  private rockRings: Partial<Record<ScienceBoulderId, THREE.Mesh>> = {};
  private hoveredRock: ScienceBoulderId | null = null;

  // Autonomous Mars Utility Rover & Sweeping Headlights + Laser Maintenance Effects
  private roverGroup!: THREE.Group;
  private roverMastGroup!: THREE.Group;
  private roverHeadlightRig!: THREE.Group;
  private roverHeadlightSpot!: THREE.SpotLight;
  private roverHeadlightTarget!: THREE.Object3D;
  private roverLaserEyeMesh!: THREE.Mesh;
  private roverLaserEyeMat!: THREE.MeshStandardMaterial;
  private roverWheels: THREE.Mesh[] = [];
  private roverLaserGroup!: THREE.Group;
  private roverLaserCore!: THREE.Mesh;
  private roverLaserGlow!: THREE.Mesh;
  private roverImpactSpot!: THREE.Mesh;
  private roverImpactLight!: THREE.PointLight;
  private roverSparksPoints!: THREE.Points;
  private roverSparkPositions!: Float32Array;
  private roverSparkVelocities: Array<{ vx: number; vy: number; vz: number; life: number }> = [];
  private readonly roverHomePos = new THREE.Vector3(3.6, 0, 4.4);
  private readonly roverHomeYaw = -0.92;
  private roverPhase: RoverPhase = 'idle';
  private roverPhaseElapsed = 0;
  private roverPhaseStartMs = 0;
  private roverMissionTarget: RoverMissionTarget | null = null;
  private roverMissionNotified = false;
  private roverStartPos = new THREE.Vector3();
  private roverStopPos = new THREE.Vector3();
  private roverAimPos = new THREE.Vector3();
  private roverEyeWorldScratch = new THREE.Vector3();
  private roverAimOscScratch = new THREE.Vector3();
  private roverBeamDirScratch = new THREE.Vector3();
  private roverMidScratch = new THREE.Vector3();
  private roverUpScratch = new THREE.Vector3(0, 1, 0);

  private pointerDownPos = { x: 0, y: 0 };
  private hoveredModule: ModuleId | null = null;
  private highlightedTarget: ModuleId | 'any' = 'moxie';

  private resources: MissionResources = {
    powerKwh: 88,
    lifeSupportPct: 80,
    crewHealthPct: 88,
    panelDustPct: 16,
    waterWallCm: 16,
    cropGrowth: 2,
    sciencePoints: 0,
  };
  private currentTau = 0.38;
  private emergencyMode: EmergencyMode = 'none';
  private emergencyBlend = 0;

  private targetAtmosphere: SolAtmosphereTargets = {
    solProgress: 0,
    crisisIntensity: 0.12,
    effectiveTau: 0.38,
    fogDensity: 0.015,
    sunElevation: 0.98,
    nightFactor: 0,
  };
  private smoothedSolProgress = 0;
  private smoothedCrisisIntensity = 0.12;
  private smoothedEffectiveTau = 0.38;
  private smoothedSunElevation = 0.98;
  private smoothedNightFactor = 0;
  private targetHazardType: SolHazardType = 'none';
  private simSpeedMultiplier = 1;
  private activeSystemGlow: ActiveSystemGlow = {
    solar: 0.35,
    moxie: 0.35,
    shelter: 0.25,
    biodome: 0.3,
  };
  private smoothedSystemGlow: ActiveSystemGlow = {
    solar: 0.35,
    moxie: 0.35,
    shelter: 0.25,
    biodome: 0.3,
  };
  private moduleBoostTimers: Record<ModuleId, number> = {
    solar: 0,
    moxie: 0,
    shelter: 0,
    biodome: 0,
  };
  private targetSunPos = new THREE.Vector3(-85, 28, -60);
  private targetSkyColor = new THREE.Color(MARTIAN_HORIZON_HEX);
  private targetDayBaseColor = new THREE.Color(MARTIAN_HORIZON_HEX);
  private targetSunColor = new THREE.Color('#FFF0D4');

  private donkiTelemetry: DonkiSceneTelemetry = {
    level: 'quiet',
    intensity: 0.15,
    cmeActive: false,
    shieldActive: false,
  };
  private smoothedDonkiM = 0;
  private smoothedDonkiX = 0;
  private smoothedShieldHex = 0;
  private shieldBoostUntilMs = 0;
  private shieldImpactPulse = 0;
  private streakNormScratch = new THREE.Vector3();
  private streakUpAxis = new THREE.Vector3(0, 1, 0);

  private activePulse: ModulePulse | null = null;
  private nightAnim: NightCycleAnim = {
    active: false,
    startTimeMs: 0,
    duration: 3.0,
    hazardType: 'none',
    shieldBlockedFlare: false,
    completed: false,
    onComplete: () => {},
  };

  private disposables: Array<{ dispose: () => void }> = [];
  private rafId: number | null = null;
  private swTimerId: number | null = null;
  private destroyed = false;
  private lastFrameTime = performance.now();
  private totalTime = 0;

  // First-Person Habitat Interior Mode state
  private viewMode: SceneViewMode = 'exterior';
  private interiorWorld!: HabitatInteriorWorld;
  private interiorCamera!: THREE.PerspectiveCamera;
  private pointerLockControls!: PointerLockControls;
  private interiorPlayer = {
    x: INTERIOR_SPAWN.x,
    z: INTERIOR_SPAWN.z,
    yaw: INTERIOR_SPAWN.yaw,
    pitch: 0,
    walkDistance: 0,
    bobOffset: 0,
  };
  private pressedKeys = new Set<string>();
  private virtualInteriorInput = { forward: 0, right: 0, turn: 0 };
  private isDraggingInteriorLook = false;
  private lastDragLookPos = { x: 0, y: 0 };
  private interiorInputPaused = false;
  private lastInteriorZoneId: string | null = null;
  private lastInteriorPromptId: InteriorInteractableId | null = null;
  private lastInteriorLocked = false;
  private lastInteriorMoveTime = performance.now();

  // Exterior First-Person EVA (Surface Suit Walk) Mode state
  private evaCamera!: THREE.PerspectiveCamera;
  private evaPointerLockControls!: PointerLockControls;
  private evaObstacles: EvaCircleCollider[] = [];
  private evaPlayer: EvaPhysicsState = createInitialEvaState(groundHeightAt, EVA_HUD_SPAWN);
  private virtualEvaInput = { forward: 0, right: 0, turn: 0 };
  private isDraggingEvaLook = false;
  private evaInputPaused = false;
  private lastEvaPromptId: EvaInteractableId | null = null;
  private lastEvaLocked = false;
  private lastEvaMoveTime = performance.now();

  // Smooth camera transition between orbital overview and first-person interior
  private cameraTransition: {
    active: boolean;
    phase: 'to_airlock' | 'to_overview';
    elapsed: number;
    duration: number;
    targetPos: THREE.Vector3;
    targetLook: THREE.Vector3;
    onComplete: (() => void) | null;
  } = {
    active: false,
    phase: 'to_airlock',
    elapsed: 0,
    duration: 0.55,
    targetPos: new THREE.Vector3(),
    targetLook: new THREE.Vector3(),
    onComplete: null,
  };
  private savedOverviewCamPos = new THREE.Vector3(0, 4.45, 21.8);
  private savedOverviewTarget = new THREE.Vector3(0, 2.85, -5.5);

  constructor(container: HTMLElement, callbacks: MarsSceneCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareWebGL();
    this.raycaster.layers.set(1);

    this.initScene();
    this.bindEvents();
    this.startLoop();
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private initScene(): void {
    const width = Math.max(this.container.clientWidth || window.innerWidth, 320);
    const height = Math.max(this.container.clientHeight || window.innerHeight, 320);

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: !this.isSoftwareGl,
        powerPreference: 'high-performance',
        alpha: false,
      });
    } catch (err) {
      this.callbacks.onWebglError?.(
        err instanceof Error ? err.message : 'Unable to initialize 3D WebGL viewport.'
      );
      return;
    }

    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.96;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;

    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Exponential Martian butterscotch-pink haze (#d97b54) synced to the horizon & Tau weather system
    const dustColor = new THREE.Color(MARTIAN_HORIZON_HEX);
    this.daySkyColor.copy(dustColor);
    this.skyColor.copy(dustColor);
    this.fog = new THREE.FogExp2(dustColor, 0.015);
    this.scene.fog = this.fog;
    this.scene.background = this.skyColor.clone();
    this.renderer.setClearColor(this.fog.color);

    // Procedural Martian Sky/Sun PMREM environment reflections for exterior,
    // while keeping RoomEnvironment untouched for the First-Person Interior.
    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();
    const roomEnv = new RoomEnvironment();
    this.interiorEnvRenderTarget = this.pmremGenerator.fromScene(roomEnv, 0.04);
    roomEnv.dispose();

    this.envRenderTarget = this.buildMarsSkyEnvironment();
    this.scene.environment = this.envRenderTarget.texture;
    this.scene.environmentIntensity = 1.15;

    // Extended far plane (360) reveals the layered Jezero Crater rim on the distant horizon
    this.camera = new THREE.PerspectiveCamera(46, width / height, 0.25, 360);
    this.applyResponsiveCamera(width, height, true);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 2.85, -5.5);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 36;
    this.controls.minPolarAngle = Math.PI * 0.18;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.update();

    this.buildLights();
    this.buildSkyDomeAndStars();
    this.buildPhysicalMartianSun();
    this.buildMarsTerrain();
    this.buildCraterRimMountains();
    this.buildMarsRocks();
    this.buildScienceBoulders();
    this.buildOutpostModules();
    this.buildStorytellingProps();
    this.buildHazardsAndRings();
    this.initInteriorWorld(width, height);
    this.initEvaControls(width, height);
    this.initPostProcessing(width, height);
    this.syncVisualState();
    this.renderCurrentView();
    this.emitProjectedAnchors();
  }

  private initPostProcessing(width: number, height: number): void {
    if (this.isSoftwareGl) return;
    this.composer = new EffectComposer(this.renderer);
    this.composerRenderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.composerRenderPass);

    // Subtle UnrealBloomPass with raised threshold so only true HDR emissive strips and beacons glow
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.36, // strength
      0.32, // radius
      1.18 // threshold
    );
    this.composer.addPass(this.bloomPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
  }

  private renderCurrentView(): void {
    const activeScene = this.viewMode === 'interior' ? this.interiorWorld.scene : this.scene;
    const activeCamera =
      this.viewMode === 'interior'
        ? this.interiorCamera
        : this.viewMode === 'eva'
        ? this.evaCamera
        : this.camera;
    if (!this.isSoftwareGl && this.composer && this.composerRenderPass) {
      this.composerRenderPass.scene = activeScene;
      this.composerRenderPass.camera = activeCamera;
      this.composer.render();
    } else {
      this.renderer.render(activeScene, activeCamera);
    }
  }

  private initInteriorWorld(width: number, height: number): void {
    this.interiorWorld = new HabitatInteriorWorld(
      this.interiorEnvRenderTarget?.texture ?? null,
      this.isSoftwareGl
    );
    this.interiorCamera = new THREE.PerspectiveCamera(62, width / height, 0.1, 180);
    this.interiorCamera.rotation.order = 'YXZ';
    this.interiorCamera.position.set(
      this.interiorPlayer.x,
      INTERIOR_EYE_HEIGHT,
      this.interiorPlayer.z
    );
    this.interiorCamera.rotation.set(this.interiorPlayer.pitch, this.interiorPlayer.yaw, 0, 'YXZ');

    this.pointerLockControls = new PointerLockControls(
      this.interiorCamera,
      this.renderer.domElement
    );
    // Keep disconnected until entering 'interior' so it never conflicts with EVA controls
    this.pointerLockControls.disconnect();
    this.pointerLockControls.addEventListener('lock', () => {
      this.emitInteriorState(true);
    });
    this.pointerLockControls.addEventListener('unlock', () => {
      this.syncYawPitchFromCamera();
      this.emitInteriorState(true);
    });
  }

  private initEvaControls(width: number, height: number): void {
    const aspect = width / height;
    this.evaCamera = new THREE.PerspectiveCamera(aspect < 1.0 ? 72 : 62, aspect, 0.1, 360);
    this.evaCamera.rotation.order = 'YXZ';
    this.evaPlayer = createInitialEvaState(groundHeightAt, EVA_HUD_SPAWN);
    this.evaCamera.position.set(this.evaPlayer.x, this.evaPlayer.y, this.evaPlayer.z);
    this.evaCamera.rotation.set(this.evaPlayer.pitch, this.evaPlayer.yaw, 0, 'YXZ');

    this.evaPointerLockControls = new PointerLockControls(
      this.evaCamera,
      this.renderer.domElement
    );
    // Keep disconnected until entering 'eva' mode
    this.evaPointerLockControls.disconnect();
    this.evaPointerLockControls.addEventListener('lock', () => {
      this.emitEvaState(true);
    });
    this.evaPointerLockControls.addEventListener('unlock', () => {
      this.syncEvaYawPitchFromCamera();
      this.emitEvaState(true);
    });
  }

  private buildMarsSkyEnvironment(): THREE.WebGLRenderTarget {
    const envScene = new THREE.Scene();
    const sunDir = this.baseSunPos.clone().normalize();

    const envSkyGeo = new THREE.SphereGeometry(50, 32, 24);
    const envSkyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        uSunDir: { value: sunDir },
        uZenith: { value: new THREE.Color('#0B132B') },
        uHorizon: { value: new THREE.Color('#384C66') },
        uRidge: { value: new THREE.Color('#A67551') },
        uGround: { value: new THREE.Color('#8C4227') },
        uGroundDeep: { value: new THREE.Color('#472013') },
        uSunTint: { value: new THREE.Color('#FFF3D6') },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uSunDir;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uRidge;
        uniform vec3 uGround;
        uniform vec3 uGroundDeep;
        uniform vec3 uSunTint;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col;
          if (h >= 0.0) {
            float curve = pow(clamp(h, 0.0, 1.0), 0.48);
            col = mix(uHorizon, uZenith, curve);
            float ridgeBand = exp(-pow((h - 0.04) / 0.075, 2.0));
            col = mix(col, uRidge, ridgeBand * 0.42);
          } else {
            float gCurve = pow(clamp(-h, 0.0, 1.0), 0.55);
            col = mix(uGround, uGroundDeep, gCurve);
          }
          float sunDot = max(dot(d, normalize(uSunDir)), 0.0);
          float mieHalo = pow(sunDot, 10.0) * 0.65;
          float corona = pow(sunDot, 140.0) * 4.2;
          col += uSunTint * (mieHalo + corona);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const envSkyMesh = new THREE.Mesh(envSkyGeo, envSkyMat);
    envScene.add(envSkyMesh);

    // High-dynamic-range solar disc in the PMREM cubemap for razor-sharp real-time reflections
    const envSunGeo = new THREE.SphereGeometry(2.8, 20, 20);
    const envSunMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#FFF3D6').multiplyScalar(22.0),
    });
    const envSunMesh = new THREE.Mesh(envSunGeo, envSunMat);
    envSunMesh.position.copy(sunDir).multiplyScalar(42);
    envScene.add(envSunMesh);

    const rt = this.pmremGenerator!.fromScene(envScene, 0.014);

    envSkyGeo.dispose();
    envSkyMat.dispose();
    envSunGeo.dispose();
    envSunMat.dispose();
    return rt;
  }

  private buildPhysicalMartianSun(): void {
    const coronaCanvas = document.createElement('canvas');
    coronaCanvas.width = 256;
    coronaCanvas.height = 256;
    const ctx = coronaCanvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(128, 128, 4, 128, 128, 128);
      grad.addColorStop(0.0, 'rgba(255, 252, 240, 1.0)');
      grad.addColorStop(0.16, 'rgba(255, 243, 214, 0.92)');
      grad.addColorStop(0.38, 'rgba(255, 214, 148, 0.42)');
      grad.addColorStop(0.68, 'rgba(245, 164, 96, 0.14)');
      grad.addColorStop(1.0, 'rgba(245, 140, 72, 0.0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);
    }
    const coronaTex = this.track(new THREE.CanvasTexture(coronaCanvas));
    coronaTex.colorSpace = THREE.SRGBColorSpace;

    this.sunDiscGroup = new THREE.Group();
    this.sunDiscGroup.position.copy(this.baseSunPos);

    // Crisp warm white-gold (#FFF3D6) Martian solar disc
    const sunCoreGeo = this.track(new THREE.SphereGeometry(2.6, 24, 24));
    const sunCoreMat = this.track(
      new THREE.MeshBasicMaterial({
        color: '#FFF3D6',
        fog: false,
        toneMapped: false,
      })
    );
    const sunCore = new THREE.Mesh(sunCoreGeo, sunCoreMat);
    this.sunDiscGroup.add(sunCore);

    // Bright inner solar halo
    this.sunHaloInnerMat = this.track(
      new THREE.SpriteMaterial({
        map: coronaTex,
        color: '#FFF3D6',
        transparent: true,
        opacity: 0.94,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    const sunInnerHalo = new THREE.Sprite(this.sunHaloInnerMat);
    sunInnerHalo.scale.set(16, 16, 1);
    this.sunDiscGroup.add(sunInnerHalo);

    // Wide dusty Martian atmospheric corona glow
    this.sunCoronaMat = this.track(
      new THREE.SpriteMaterial({
        map: coronaTex,
        color: '#FFF3D6',
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    const sunOuterCorona = new THREE.Sprite(this.sunCoronaMat);
    sunOuterCorona.scale.set(44, 44, 1);
    this.sunDiscGroup.add(sunOuterCorona);

    this.scene.add(this.sunDiscGroup);
  }

  private buildLights(): void {
    // Complementary cool-cyan sky fill paired with warm ochre-sienna ground bounce
    this.hemiLight = new THREE.HemisphereLight('#5BC0BE', '#8C4227', 0.62);
    this.scene.add(this.hemiLight);

    // Low-angle physical Martian Sun (#FFF0D4, intensity 3.2) locked to [-85, 28, -60]
    this.sunLight = new THREE.DirectionalLight('#FFF0D4', 3.2);
    this.sunLight.position.copy(this.baseSunPos);
    this.sunLight.target.position.set(0, 0, 0);
    this.scene.add(this.sunLight.target);
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 40;
    this.sunLight.shadow.camera.far = 175;
    const d = 24;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.00035;
    this.sunLight.shadow.normalBias = 0.025;
    this.sunLight.shadow.radius = 2.0;
    this.sunLight.castShadow = true;
    this.scene.add(this.sunLight);

    // Cool-blue opposite-side sky fill in calm mode; transitions to crimson alert during X-Class/CME
    this.rimLight = new THREE.DirectionalLight('#5BC0BE', 0.54);
    this.rimLight.position.set(26, 12, 22);
    this.scene.add(this.rimLight);

    this.shelterInteriorLight = new THREE.PointLight('#00E5FF', 0.78, 16, 1.4);
    this.shelterInteriorLight.position.set(0.9, 2.2, 1.4);
    this.scene.add(this.shelterInteriorLight);

    this.moxieLight = new THREE.PointLight('#00E5FF', 0.82, 14, 1.4);
    this.moxieLight.position.set(-3.7, 2.2, -3.6);
    this.scene.add(this.moxieLight);

    // Emerald Green (#10B981) Hydroponic Bio-Dome glow
    this.biodomeLight = new THREE.PointLight('#10B981', 1.65, 18, 1.25);
    this.biodomeLight.position.set(6.8, 1.85, 2.0);
    this.scene.add(this.biodomeLight);
  }

  private buildSkyDomeAndStars(): void {
    // Deep Space Indigo (#0B132B) zenith -> Dusty Blue-Slate (#384C66) horizon + muted butterscotch ridge band + Martian cirrus ice clouds
    const skyGeo = this.track(new THREE.SphereGeometry(240, 36, 24));
    this.skyDomeMat = this.track(
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uHorizonColor: { value: new THREE.Color(MARTIAN_HORIZON_HEX) },
          uZenithColor: { value: new THREE.Color('#0B132B') },
          uRidgeBandColor: { value: new THREE.Color('#A67551') },
          uRidgeBandMix: { value: 0.42 },
          uTime: { value: 0 },
          uCirrusVisibility: { value: 1.0 },
        },
        vertexShader: `
          varying vec3 vWorldDir;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldDir = normalize(position);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          uniform vec3 uHorizonColor;
          uniform vec3 uZenithColor;
          uniform vec3 uRidgeBandColor;
          uniform float uRidgeBandMix;
          uniform float uTime;
          uniform float uCirrusVisibility;
          varying vec3 vWorldDir;

          float skyHash(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
          }

          float skyNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            float a = skyHash(i);
            float b = skyHash(i + vec2(1.0, 0.0));
            float c = skyHash(i + vec2(0.0, 1.0));
            float d = skyHash(i + vec2(1.0, 1.0));
            return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
          }

          float skyFbm(vec2 p) {
            float v = 0.0;
            float a = 0.5;
            mat2 rot = mat2(0.82, 0.57, -0.57, 0.82);
            for (int i = 0; i < 4; i++) {
              v += a * skyNoise(p);
              p = rot * p * 2.08;
              a *= 0.5;
            }
            return v;
          }

          void main() {
            float h = clamp(vWorldDir.y, 0.0, 1.0);
            float curve = pow(h, 0.48);
            vec3 skyGrad = mix(uHorizonColor, uZenithColor, curve);
            // Muted butterscotch atmospheric scattering band hugged along the lower crater ridge
            float ridgeBand = exp(-pow((h - 0.032) / 0.058, 2.0));
            vec3 col = mix(skyGrad, uRidgeBandColor, ridgeBand * uRidgeBandMix);

            // High-altitude Martian CO2/water-ice cirrus wisps
            if (h > 0.05 && uCirrusVisibility > 0.02) {
              vec2 cloudUv = vWorldDir.xz / (vWorldDir.y + 0.24);
              vec2 drift = vec2(uTime * 0.0085, uTime * 0.003);
              float warp = skyFbm(cloudUv * 0.75 + drift);
              float streaks = skyFbm(vec2(cloudUv.x * 1.45 + warp * 1.35, cloudUv.y * 0.42 - warp * 0.65) + drift * 1.4);
              float wisps = smoothstep(0.52, 0.82, streaks);
              float bandMask = smoothstep(0.06, 0.19, h) * (1.0 - smoothstep(0.48, 0.86, h));
              vec3 cirrusCol = mix(vec3(0.76, 0.84, 0.94), vec3(0.92, 0.78, 0.68), smoothstep(0.32, 0.08, h));
              col = mix(col, cirrusCol, wisps * bandMask * 0.34 * uCirrusVisibility);
            }

            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
    );
    const skyDome = new THREE.Mesh(skyGeo, this.skyDomeMat);
    this.scene.add(skyDome);

    // Subtle stars visible near the Deep Space Indigo (#0B132B) zenith
    const count = 340;
    const positions = new Float32Array(count * 3);
    let seed = 109;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const theta = rand() * Math.PI * 2;
      const phi = rand() * Math.PI * 0.38;
      const r = 185;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = Math.max(38, r * Math.cos(phi));
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = this.track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.starsMat = this.track(
      new THREE.PointsMaterial({
        color: '#E2E8F0',
        size: 1.05,
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
        fog: false,
      })
    );
    this.starsPoints = new THREE.Points(geo, this.starsMat);
    this.scene.add(this.starsPoints);

    // Animated green/violet upper-sky aurora ribbons during solar flare alerts
    this.auroraGroup = new THREE.Group();
    this.auroraGroup.visible = false;
    const ribbonConfigs = [
      { z: -56, y: 14.0, x: -6, width: 82, height: 10.5, rotY: 0.14, phase: 0.0 },
      { z: -70, y: 17.2, x: 8, width: 96, height: 12.0, rotY: -0.18, phase: 2.1 },
      { z: -84, y: 15.5, x: -2, width: 106, height: 11.5, rotY: 0.05, phase: 4.3 },
    ];
    ribbonConfigs.forEach((cfg) => {
      const rGeo = this.track(new THREE.PlaneGeometry(cfg.width, cfg.height, 40, 4));
      const posAttr = rGeo.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        const px = posAttr.getX(i);
        const arcZ = Math.sin((px / cfg.width) * Math.PI * 1.4 + cfg.phase) * 7.5;
        posAttr.setZ(i, arcZ);
      }
      rGeo.computeVertexNormals();
      const rMat = this.track(
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          fog: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          uniforms: {
            uTime: { value: 0 },
            uOpacity: { value: 0 },
            uPhase: { value: cfg.phase },
            uCrimsonMix: { value: 0 },
          },
          vertexShader: `
            uniform float uTime;
            uniform float uPhase;
            varying vec2 vUv;
            void main() {
              vUv = uv;
              vec3 p = position;
              p.z += sin(p.x * 0.09 + uTime * 0.9 + uPhase) * 2.2;
              p.y += cos(p.x * 0.06 - uTime * 0.65 + uPhase) * 1.1;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
            }
          `,
          fragmentShader: `
            uniform float uTime;
            uniform float uOpacity;
            uniform float uPhase;
            uniform float uCrimsonMix;
            varying vec2 vUv;
            void main() {
              float edgeX = smoothstep(0.0, 0.22, vUv.x) * (1.0 - smoothstep(0.78, 1.0, vUv.x));
              float edgeY = pow(smoothstep(0.0, 0.35, vUv.y), 1.4) * (1.0 - smoothstep(0.35, 1.0, vUv.y));
              float curtains = 0.55 + 0.45 * sin(vUv.x * 26.0 + uTime * 1.4 + uPhase + sin(vUv.x * 8.0) * 1.8);
              float fineRays = 0.7 + 0.3 * sin(vUv.x * 64.0 - uTime * 2.2 + uPhase);
              // Rich emerald green (#34D399) lower curtains transitioning to cosmic violet (#A855F7) aloft
              vec3 greenCol = vec3(0.18, 0.92, 0.58);
              vec3 violetCol = vec3(0.66, 0.33, 0.97);
              vec3 xVioletCol = vec3(0.86, 0.26, 0.78);
              vec3 baseCol = mix(mix(greenCol, violetCol, smoothstep(0.18, 0.85, vUv.y)), mix(greenCol, xVioletCol, vUv.y), uCrimsonMix * 0.55);
              float alpha = clamp(edgeX * edgeY * curtains * fineRays * uOpacity, 0.0, 0.68);
              gl_FragColor = vec4(baseCol, alpha);
            }
          `,
        })
      );
      this.auroraMats.push(rMat);
      const rMesh = new THREE.Mesh(rGeo, rMat);
      rMesh.position.set(cfg.x, cfg.y, cfg.z);
      rMesh.rotation.y = cfg.rotY;
      this.auroraGroup.add(rMesh);
    });
    this.scene.add(this.auroraGroup);
  }

  private buildMarsTerrain(): void {
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const { map, normalMap, bumpMap, roughnessMap } = createMarsRegolithTextures(maxAniso);
    this.track(map);
    this.track(normalMap);
    this.track(bumpMap);
    this.track(roughnessMap);

    // Prepare shared procedural PBR micro-textures for rocks, metals, and terrain trims
    this.sharedRegolithPbr = createProceduralNoisePbrMaps(maxAniso, {
      seed: 331,
      baseFreq: 12,
      octaves: 4,
      roughnessMin: 0.78,
      roughnessMax: 0.98,
      repeat: 3,
      streaks: true,
    });
    this.track(this.sharedRegolithPbr.bumpMap);
    this.track(this.sharedRegolithPbr.roughnessMap);

    this.sharedMetalPbr = createProceduralNoisePbrMaps(maxAniso, {
      seed: 617,
      baseFreq: 16,
      octaves: 3,
      roughnessMin: 0.28,
      roughnessMax: 0.62,
      repeat: 2,
      streaks: true,
    });
    this.track(this.sharedMetalPbr.bumpMap);
    this.track(this.sharedMetalPbr.roughnessMap);

    const terrainGeo = this.track(new THREE.PlaneGeometry(240, 240, 144, 144));
    terrainGeo.rotateX(-Math.PI / 2);
    const pos = terrainGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, groundHeightAt(x, z));
    }
    terrainGeo.computeVertexNormals();

    // Rich Jezero Ochre-Sienna (#A65132) regolith PBR shader with wind-blown sand ripples
    // + grazing-angle Sun rim highlight & subtle mineral micro-sparkle sheen
    const terrainMat = this.track(
      new THREE.MeshStandardMaterial({
        map,
        normalMap,
        normalScale: new THREE.Vector2(1.2, 1.2),
        bumpMap,
        bumpScale: 0.18,
        roughnessMap,
        roughness: 0.88,
        metalness: 0.06,
        envMapIntensity: 0.72,
      })
    );

    terrainMat.onBeforeCompile = (shader) => {
      shader.uniforms.uSunSheenStrength = this.terrainSheenUniform;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vTerrainWorldPos;
varying vec3 vTerrainWorldNormal;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
  vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vTerrainWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uSunSheenStrength;
varying vec3 vTerrainWorldPos;
varying vec3 vTerrainWorldNormal;

float marsHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float marsValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = marsHash21(i);
  float b = marsHash21(i + vec2(1.0, 0.0));
  float c = marsHash21(i + vec2(0.0, 1.0));
  float d = marsHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float marsFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * marsValueNoise(p);
    p = rot * p * 2.05;
    a *= 0.5;
  }
  return v;
}`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  vec2 wp = vTerrainWorldPos.xz;
  float macroFbm = marsFbm(wp * 0.055);
  float midFbm = marsFbm(wp * 0.22 + vec2(4.1, -2.7));
  float windRipple = sin(wp.x * 1.9 + wp.y * 0.75 + macroFbm * 4.5) * 0.5 + 0.5;

  // Rich Jezero Ochre-Sienna (#A65132), mineral sienna, and dark volcanic basalt troughs (linear space)
  vec3 ochreCol = vec3(0.42, 0.145, 0.068);
  vec3 siennaCol = vec3(0.32, 0.095, 0.044);
  vec3 basaltCol = vec3(0.075, 0.052, 0.055);

  vec3 fbmTint = mix(siennaCol, ochreCol, smoothstep(0.28, 0.78, macroFbm * 0.7 + windRipple * 0.3));
  fbmTint = mix(fbmTint, basaltCol, smoothstep(0.60, 0.88, midFbm) * 0.58);

  // Subtle dusty compaction around the outpost plateau
  float baseZone = 1.0 - smoothstep(5.0, 15.0, length(wp));
  fbmTint = mix(fbmTint, vec3(0.34, 0.115, 0.058), baseZone * 0.25);

  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (fbmTint * 2.35), 0.52);`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  vec2 wpSpark = vTerrainWorldPos.xz;
  float macroS = marsFbm(wpSpark * 0.055);
  float ripplePhase = wpSpark.x * 1.9 + wpSpark.y * 0.75 + macroS * 4.5;
  float rippleCrest = pow(sin(ripplePhase) * 0.5 + 0.5, 2.4);
  float rippleSlope = cos(ripplePhase);
  vec3 nBase = normalize(vTerrainWorldNormal);
  vec3 rippleN = normalize(nBase + vec3(rippleSlope * 0.28, 0.0, rippleSlope * 0.11));
  vec3 sunDirT = normalize(vec3(-85.0, 28.0, -60.0));
  vec3 viewDirT = normalize(cameraPosition - vTerrainWorldPos);
  vec3 halfVecT = normalize(sunDirT + viewDirT);

  // Grazing-angle directional sun sheen along wind-carved sand ripple crests
  float rippleSpec = pow(max(dot(rippleN, halfVecT), 0.0), 18.0) * rippleCrest;
  float fresnelT = pow(1.0 - max(dot(nBase, viewDirT), 0.0), 3.2);
  float sunForward = max(dot(-viewDirT, sunDirT) * 0.5 + 0.5, 0.0);
  float grazingRim = fresnelT * (0.32 + 0.68 * sunForward);

  // Fine mineral micro-sparkle flecks catching low-angle sunlight
  vec2 grainCell = floor(wpSpark * 15.0);
  float grainHash = marsHash21(grainCell);
  float microSparkle = smoothstep(0.955, 0.996, grainHash) * pow(max(dot(rippleN, halfVecT), 0.0), 14.0);

  vec3 sheenTint = vec3(1.0, 0.84, 0.62);
  totalEmissiveRadiance += sheenTint * (rippleSpec * 0.095 + grazingRim * 0.055 + microSparkle * 0.14) * uSunSheenStrength;`
        );
    };

    const terrain = new THREE.Mesh(terrainGeo, terrainMat);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    this.scene.add(terrain);
  }

  private buildCraterRimMountains(): void {
    // Multi-octave sculpted Jezero Crater rim mountain ridges around the perimeter
    const multiOctaveRim = (angle: number, rNorm: number, seedOffset: number): number => {
      const o1 = Math.sin(angle * 5.0 + seedOffset) * 0.42 + Math.cos(angle * 3.0 - seedOffset) * 0.28;
      const o2 = Math.sin(angle * 11.0 + seedOffset * 1.7 + rNorm * 2.5) * 0.22;
      const o3 = Math.cos(angle * 23.0 - seedOffset * 0.9 + rNorm * 4.0) * 0.12;
      const o4 = Math.sin(angle * 41.0 + seedOffset * 2.3) * 0.06;
      const ridged = 1.0 - Math.abs(Math.sin(angle * 8.0 + seedOffset * 1.3));
      return THREE.MathUtils.clamp(0.45 + o1 + o2 + o3 + o4 + (ridged - 0.5) * 0.3, 0.08, 1.15);
    };

    const buildRimRing = (
      innerR: number,
      outerR: number,
      minH: number,
      maxH: number,
      colorHex: string,
      seedOffset: number
    ) => {
      const segs = 128;
      const geo = this.track(new THREE.RingGeometry(innerR, outerR, segs, 10));
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const r = Math.hypot(x, z);
        const angle = Math.atan2(z, x);
        const t = THREE.MathUtils.clamp((r - innerR) / Math.max(1, outerR - innerR), 0, 1);
        const ridgeProfile = Math.pow(Math.sin(t * Math.PI), 0.85);
        const peaks = multiOctaveRim(angle, t, seedOffset);
        // Subtle stratified mesa terrace step
        const terrace = Math.floor(peaks * 5) / 5 * 0.22 + peaks * 0.78;
        const baseY = groundHeightAt(x * 0.45, z * 0.45) * 0.38;
        const peakY = baseY + ridgeProfile * THREE.MathUtils.lerp(minH, maxH, terrace) - 0.55;
        pos.setY(i, peakY);
      }
      geo.computeVertexNormals();
      const mat = this.track(
        new THREE.MeshStandardMaterial({
          color: colorHex,
          bumpMap: this.sharedRegolithPbr.bumpMap,
          bumpScale: 0.2,
          roughnessMap: this.sharedRegolithPbr.roughnessMap,
          roughness: 0.94,
          metalness: 0.04,
          side: THREE.DoubleSide,
        })
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    };

    buildRimRing(52, 84, 5.0, 12.0, '#724433', 1.2);
    buildRimRing(78, 126, 10.5, 22.0, '#4E4A59', 3.7);
  }

  private buildMarsRocks(): void {
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const basaltPbr = createBasaltRockPbrMaps(maxAniso);
    this.track(basaltPbr.bumpMap);
    this.track(basaltPbr.roughnessMap);

    const dummy = new THREE.Object3D();
    const colorScratch = new THREE.Color();
    let seed = 77;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    // 75% Dark Volcanic Basalt Slate (#2B333E / #39424E) so boulders pop against #A65132 sand
    const rockPalette = [
      '#2B333E',
      '#39424E',
      '#2B333E',
      '#39424E',
      '#2B333E',
      '#39424E',
      '#6E3A2A',
      '#7B4431',
    ];

    const isClearOfOutpost = (x: number, z: number): boolean => {
      const r = Math.hypot(x, z);
      if (r < 11.4) return false;
      const dSolar = Math.hypot(x + 6.8, z - 2.2);
      const dBio = Math.hypot(x - 6.8, z - 2.0);
      const dMoxie = Math.hypot(x + 3.7, z + 4.4);
      const dRover = Math.hypot(x - 3.6, z - 4.4);
      const dRock1 = Math.hypot(x + 9.4, z - 5.8);
      const dRock2 = Math.hypot(x + 1.4, z - 5.8);
      const dRock3 = Math.hypot(x - 5.8, z - 5.6);
      const dRock4 = Math.hypot(x - 9.2, z - 4.4);
      return (
        dSolar > 4.6 &&
        dBio > 3.8 &&
        dMoxie > 3.5 &&
        dRover > 2.2 &&
        dRock1 > 2.0 &&
        dRock2 > 2.0 &&
        dRock3 > 2.0 &&
        dRock4 > 2.0
      );
    };

    // 1. Half-Buried Angular Volcanic Basalt Boulders (~44) with mineral facet sheen (roughness 0.65)
    const boulderGeo = this.track(createAngularRockGeometry(17, 0.85, 1));
    const boulderMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#FFFFFF',
        bumpMap: basaltPbr.bumpMap,
        bumpScale: 0.28,
        roughnessMap: basaltPbr.roughnessMap,
        roughness: 0.65,
        metalness: 0.14,
        envMapIntensity: 1.15,
      })
    );
    const boulderCoords: Array<{ x: number; z: number }> = [];
    const boulderCount = 44;
    const boulders = new THREE.InstancedMesh(boulderGeo, boulderMat, boulderCount);
    boulders.castShadow = true;
    boulders.receiveShadow = true;

    let placed = 0;
    let attempts = 0;
    while (placed < boulderCount && attempts < 400) {
      attempts++;
      const angle = (placed / boulderCount) * Math.PI * 2 + (rand() - 0.5) * 0.45;
      const dist = 12.2 + rand() * 28.0;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      if (!isClearOfOutpost(x, z)) continue;

      const scale = 0.55 + rand() * 1.35;
      const y = groundHeightAt(x, z) + scale * 0.14;
      dummy.position.set(x, y, z);
      dummy.rotation.set(rand() * 1.4, rand() * Math.PI * 2, rand() * 1.4);
      dummy.scale.set(
        scale * (0.85 + rand() * 0.55),
        scale * (0.58 + rand() * 0.35),
        scale * (0.8 + rand() * 0.5)
      );
      dummy.updateMatrix();
      boulders.setMatrixAt(placed, dummy.matrix);
      colorScratch.set(rockPalette[placed % rockPalette.length]);
      boulders.setColorAt(placed, colorScratch);
      boulderCoords.push({ x, z });
      if (scale >= 0.72) {
        this.evaObstacles.push({
          id: `boulder-${placed}`,
          x,
          z,
          radius: scale * 0.72,
        });
      }
      placed++;
    }
    boulders.count = placed;
    boulders.instanceMatrix.needsUpdate = true;
    if (boulders.instanceColor) boulders.instanceColor.needsUpdate = true;
    boulders.computeBoundingSphere();
    this.scene.add(boulders);

    // 2. Clustered Gravel & Angular Stones (~160)
    const gravelGeo = this.track(createAngularRockGeometry(53, 0.28, 0));
    const gravelMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#FFFFFF',
        bumpMap: basaltPbr.bumpMap,
        bumpScale: 0.28,
        roughnessMap: basaltPbr.roughnessMap,
        roughness: 0.65,
        metalness: 0.12,
        envMapIntensity: 1.1,
      })
    );
    const gravelCount = 160;
    const gravel = new THREE.InstancedMesh(gravelGeo, gravelMat, gravelCount);
    gravel.castShadow = true;
    gravel.receiveShadow = true;

    for (let i = 0; i < gravelCount; i++) {
      const parent = boulderCoords[i % Math.max(1, boulderCoords.length)] ?? { x: 14, z: 10 };
      const a = rand() * Math.PI * 2;
      const offsetR = 0.7 + rand() * 2.8;
      const x = parent.x + Math.cos(a) * offsetR;
      const z = parent.z + Math.sin(a) * offsetR;
      const s = 0.45 + rand() * 0.95;
      const y = groundHeightAt(x, z) + s * 0.04;

      dummy.position.set(x, y, z);
      dummy.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      dummy.scale.set(s * (0.8 + rand() * 0.5), s * 0.65, s * (0.8 + rand() * 0.5));
      dummy.updateMatrix();
      gravel.setMatrixAt(i, dummy.matrix);
      colorScratch.set(rockPalette[i % rockPalette.length]);
      gravel.setColorAt(i, colorScratch);
    }
    gravel.instanceMatrix.needsUpdate = true;
    if (gravel.instanceColor) gravel.instanceColor.needsUpdate = true;
    gravel.computeBoundingSphere();
    this.scene.add(gravel);

    // 3. Pebble Patches (~240)
    const pebbleGeo = this.track(createAngularRockGeometry(91, 0.11, 0));
    const pebbleMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#FFFFFF',
        bumpMap: basaltPbr.bumpMap,
        bumpScale: 0.28,
        roughnessMap: basaltPbr.roughnessMap,
        roughness: 0.65,
        metalness: 0.1,
        envMapIntensity: 1.05,
      })
    );
    const pebbleCount = 240;
    const pebbles = new THREE.InstancedMesh(pebbleGeo, pebbleMat, pebbleCount);
    pebbles.castShadow = true;
    pebbles.receiveShadow = true;

    for (let i = 0; i < pebbleCount; i++) {
      const patchIdx = Math.floor(i / 8);
      const patchAngle = (patchIdx * 2.39996) % (Math.PI * 2);
      const patchDist = 4.5 + ((patchIdx * 7.3) % 19.5);
      const cx = Math.cos(patchAngle) * patchDist;
      const cz = Math.sin(patchAngle) * patchDist;
      const x = cx + (rand() - 0.5) * 2.4;
      const z = cz + (rand() - 0.5) * 2.4;
      const s = 0.55 + rand() * 0.85;

      dummy.position.set(x, groundHeightAt(x, z) + 0.02, z);
      dummy.rotation.set(rand() * 2, rand() * 3, rand() * 2);
      dummy.scale.set(s * 1.1, s * 0.55, s);
      dummy.updateMatrix();
      pebbles.setMatrixAt(i, dummy.matrix);
      colorScratch.set(rockPalette[i % rockPalette.length]);
      pebbles.setColorAt(i, colorScratch);
    }
    pebbles.instanceMatrix.needsUpdate = true;
    if (pebbles.instanceColor) pebbles.instanceColor.needsUpdate = true;
    pebbles.computeBoundingSphere();
    this.scene.add(pebbles);
  }

  private buildScienceBoulders(): void {
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const basaltPbr = createBasaltRockPbrMaps(maxAniso);
    this.track(basaltPbr.bumpMap);
    this.track(basaltPbr.roughnessMap);

    const boulderConfigs: Array<{
      id: ScienceBoulderId;
      label: string;
      x: number;
      z: number;
      scale: number;
      color: string;
      seed: number;
    }> = [
      {
        id: 'rock-delta',
        label: 'Delta Mudstone',
        x: -9.4,
        z: 5.8,
        scale: 1.02,
        color: '#39424E',
        seed: 31,
      },
      {
        id: 'rock-olivine',
        label: 'Olivine Basalt',
        x: -1.4,
        z: 5.8,
        scale: 1.04,
        color: '#2B333E',
        seed: 47,
      },
      {
        id: 'rock-carbonate',
        label: 'Carbonate Outcrop',
        x: 5.8,
        z: 5.6,
        scale: 0.98,
        color: '#7B4631',
        seed: 61,
      },
      {
        id: 'rock-sulfate',
        label: 'Sulfate Vein',
        x: 9.2,
        z: 4.4,
        scale: 0.96,
        color: '#2B333E',
        seed: 83,
      },
    ];

    const ringGeo = this.track(new THREE.RingGeometry(0.95, 1.12, 24));
    ringGeo.rotateX(-Math.PI / 2);

    boulderConfigs.forEach((cfg) => {
      const y = groundHeightAt(cfg.x, cfg.z);
      const group = new THREE.Group();
      group.position.set(cfg.x, y, cfg.z);

      const mainGeo = this.track(createAngularRockGeometry(cfg.seed, 0.72, 1));
      const rockMat = this.track(
        new THREE.MeshStandardMaterial({
          color: cfg.color,
          bumpMap: basaltPbr.bumpMap,
          bumpScale: 0.28,
          roughnessMap: basaltPbr.roughnessMap,
          roughness: 0.65,
          metalness: 0.14,
          envMapIntensity: 1.15,
        })
      );
      const mainRock = new THREE.Mesh(mainGeo, rockMat);
      mainRock.position.y = 0.28 * cfg.scale;
      mainRock.scale.set(cfg.scale * 1.15, cfg.scale * 0.85, cfg.scale);
      mainRock.rotation.set(0.18, cfg.seed * 0.4, -0.14);
      mainRock.castShadow = true;
      mainRock.receiveShadow = true;
      group.add(mainRock);

      const shardGeo = this.track(createAngularRockGeometry(cfg.seed + 7, 0.34, 0));
      const shard = new THREE.Mesh(shardGeo, rockMat);
      shard.position.set(0.55 * cfg.scale, 0.14 * cfg.scale, 0.42 * cfg.scale);
      shard.scale.set(0.9, 0.7, 0.9);
      shard.castShadow = true;
      shard.receiveShadow = true;
      group.add(shard);

      const crystalMat = this.track(
        new THREE.MeshStandardMaterial({
          color: '#00E5FF',
          emissive: '#00B8D4',
          emissiveIntensity: 0.55,
          bumpMap: basaltPbr.bumpMap,
          bumpScale: 0.12,
          roughnessMap: basaltPbr.roughnessMap,
          roughness: 0.25,
          metalness: 0.4,
        })
      );
      const vein = new THREE.Mesh(
        this.track(new THREE.OctahedronGeometry(0.16 * cfg.scale, 0)),
        crystalMat
      );
      vein.position.set(-0.22 * cfg.scale, 0.56 * cfg.scale, 0.28 * cfg.scale);
      vein.castShadow = true;
      vein.receiveShadow = true;
      group.add(vein);

      const ringMat = this.track(
        new THREE.MeshBasicMaterial({
          color: '#22D3EE',
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.32,
          depthWrite: false,
        })
      );
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.y = 0.06;
      group.add(ring);
      this.rockRings[cfg.id] = ring;

      this.scene.add(group);

      const hitGeo = this.track(new THREE.CylinderGeometry(1.15, 1.25, 1.5, 12));
      const hitMat = this.track(new THREE.MeshBasicMaterial({ visible: false }));
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.set(cfg.x, y + 0.7, cfg.z);
      hit.layers.set(1);
      hit.userData.rockId = cfg.id;
      hit.userData.rockLabel = cfg.label;
      this.hitColliders.push(hit);
      this.scene.add(hit);

      this.rockWorldCenters[cfg.id] = new THREE.Vector3(cfg.x, y, cfg.z);
      this.rockAnchorWorldMap[cfg.id] = new THREE.Vector3(cfg.x, y + 1.28 * cfg.scale, cfg.z);
    });
  }

  private addHitCollider(moduleId: ModuleId, pos: THREE.Vector3, radius: number, height: number): void {
    const hitGeo = this.track(new THREE.CylinderGeometry(radius, radius * 1.08, height, 14));
    const hitMat = this.track(new THREE.MeshBasicMaterial({ visible: false }));
    const hit = new THREE.Mesh(hitGeo, hitMat);
    hit.position.set(pos.x, pos.y + height * 0.5, pos.z);
    hit.layers.set(1);
    hit.userData.moduleId = moduleId;
    this.hitColliders.push(hit);
    this.scene.add(hit);
  }

  private addGroundDecal(
    x: number,
    z: number,
    radius: number,
    tex: THREE.Texture,
    opacity = 0.72,
    yOffset = 0.025
  ): void {
    const geo = this.track(new THREE.PlaneGeometry(radius * 2, radius * 2));
    geo.rotateX(-Math.PI / 2);
    const mat = this.track(
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, groundHeightAt(x, z) + yOffset, z);
    this.scene.add(mesh);
  }

  private addDustFoundationSkirt(x: number, z: number, innerR: number, outerR: number): void {
    const y = groundHeightAt(x, z);
    const skirtGeo = this.track(new THREE.CylinderGeometry(innerR, outerR, 0.72, 24));
    const skirtMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#8C4227',
        bumpMap: this.sharedRegolithPbr.bumpMap,
        bumpScale: 0.16,
        roughnessMap: this.sharedRegolithPbr.roughnessMap,
        roughness: 0.94,
        metalness: 0.02,
      })
    );
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.position.set(x, y + 0.18, z);
    skirt.castShadow = true;
    skirt.receiveShadow = true;
    (this.exteriorBaseGroup ?? this.scene).add(skirt);
  }

  private buildTerrainTrackRibbon(
    points: THREE.Vector3[],
    width: number,
    tex: THREE.CanvasTexture
  ): void {
    const curve = new THREE.CatmullRomCurve3(points);
    const segments = 26;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3();

    const totalLen = curve.getLength();
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const pt = curve.getPoint(t);
      const tan = curve.getTangent(t).setY(0).normalize();
      right.crossVectors(tan, up).normalize().multiplyScalar(width * 0.5);

      const lx = pt.x - right.x;
      const lz = pt.z - right.z;
      const rx = pt.x + right.x;
      const rz = pt.z + right.z;

      positions.push(lx, groundHeightAt(lx, lz) + 0.045, lz);
      positions.push(rx, groundHeightAt(rx, rz) + 0.045, rz);

      const vCoord = t * (totalLen / 1.8);
      uvs.push(0, vCoord, 1, vCoord);

      if (i < segments) {
        const base = i * 2;
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }

    const geo = this.track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = this.track(
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      })
    );
    const ribbon = new THREE.Mesh(geo, mat);
    ribbon.renderOrder = 2;
    this.scene.add(ribbon);
  }

  private buildOutpostModules(): void {
    this.exteriorBaseGroup = new THREE.Group();
    this.exteriorBaseGroup.name = 'exteriorBaseGroup';
    this.exteriorBaseGroup.scale.setScalar(3.5);
    this.exteriorBaseGroup.position.set(0, -1.0, 0);
    this.scene.add(this.exteriorBaseGroup);

    const shadowTex = this.track(createContactShadowTexture());
    const scorchTex = this.track(createScorchDecalTexture());
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const solarPbr = createSolarCellPbrMaps(maxAniso);
    const hullPbr = createHabitatHullPbrMaps(maxAniso);
    const dustOverlayTex = this.track(createDustOverlayTexture(maxAniso));
    this.track(solarPbr.map);
    this.track(solarPbr.bumpMap);
    this.track(solarPbr.roughnessMap);
    this.track(hullPbr.map);
    this.track(hullPbr.bumpMap);
    this.track(hullPbr.roughnessMap);

    this.habitatDustMat = this.track(
      new THREE.MeshStandardMaterial({
        map: dustOverlayTex,
        bumpMap: this.sharedRegolithPbr.bumpMap,
        bumpScale: 0.08,
        roughnessMap: this.sharedRegolithPbr.roughnessMap,
        color: '#A65132',
        roughness: 0.96,
        metalness: 0.0,
        envMapIntensity: 0.14,
        transparent: true,
        opacity: 0.05,
        depthWrite: false,
      })
    );

    // Shared PBR aerospace engineering materials with procedural bumpMap + roughnessMap
    const hullWhite = this.track(
      new THREE.MeshStandardMaterial({
        map: hullPbr.map,
        bumpMap: hullPbr.bumpMap,
        bumpScale: 0.04,
        roughnessMap: hullPbr.roughnessMap,
        color: '#EEF4F8',
        roughness: 0.24,
        metalness: 0.48,
        envMapIntensity: 1.25,
      })
    );
    const hullSlate = this.track(
      new THREE.MeshStandardMaterial({
        color: '#334155',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.035,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.28,
        metalness: 0.72,
        envMapIntensity: 1.25,
      })
    );
    const darkMetal = this.track(
      new THREE.MeshStandardMaterial({
        color: '#1E293B',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.035,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.22,
        metalness: 0.78,
        envMapIntensity: 1.45,
      })
    );
    const accentAmber = this.track(
      new THREE.MeshStandardMaterial({
        color: '#D97706',
        emissive: '#78350F',
        emissiveIntensity: 0.06,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.025,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.28,
        metalness: 0.52,
        envMapIntensity: 1.2,
      })
    );

    // Quilted MLI gold/silver thermal insulation blankets for external pods & pressure skirt
    const goldMliPbr = createMliBlanketPbrMaps(maxAniso, 'gold');
    const silverMliPbr = createMliBlanketPbrMaps(maxAniso, 'silver');
    this.track(goldMliPbr.map);
    this.track(goldMliPbr.bumpMap);
    this.track(goldMliPbr.roughnessMap);
    this.track(silverMliPbr.map);
    this.track(silverMliPbr.bumpMap);
    this.track(silverMliPbr.roughnessMap);

    const goldMliMat = this.track(
      new THREE.MeshStandardMaterial({
        map: goldMliPbr.map,
        bumpMap: goldMliPbr.bumpMap,
        bumpScale: 0.04,
        roughnessMap: goldMliPbr.roughnessMap,
        roughness: 0.22,
        metalness: 0.85,
        envMapIntensity: 1.55,
      })
    );
    const silverMliMat = this.track(
      new THREE.MeshStandardMaterial({
        map: silverMliPbr.map,
        bumpMap: silverMliPbr.bumpMap,
        bumpScale: 0.035,
        roughnessMap: silverMliPbr.roughnessMap,
        roughness: 0.22,
        metalness: 0.78,
        envMapIntensity: 1.45,
      })
    );

    // ------------------------------------------------------------------
    // 1. WATER-WALL STORM SHELTER (Center: 0.9, y, 1.0) — Geodesic Ribs, MLI Blankets, Pressure Bulkheads, Comms Array & Recessed Airlock
    // ------------------------------------------------------------------
    const shelterPos = new THREE.Vector3(0.9, groundHeightAt(0.9, 1.0), 1.0);
    const shelterGroup = new THREE.Group();
    shelterGroup.position.copy(shelterPos);
    this.addGroundDecal(shelterPos.x, shelterPos.z, 6.7, scorchTex, 0.84, 0.03);
    this.addGroundDecal(shelterPos.x, shelterPos.z, 4.4, shadowTex, 0.68, 0.036);
    this.addDustFoundationSkirt(shelterPos.x, shelterPos.z, 3.35, 3.85);

    const baseDeckGeo = this.track(new THREE.CylinderGeometry(3.1, 3.5, 0.45, 24));
    const baseDeck = new THREE.Mesh(baseDeckGeo, hullSlate);
    baseDeck.position.y = 0.22;
    baseDeck.castShadow = true;
    baseDeck.receiveShadow = true;
    shelterGroup.add(baseDeck);

    // Lower silver MLI thermal insulation skirt belt around the habitat base
    const mliSkirt = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(2.51, 2.55, 0.42, 24)),
      silverMliMat
    );
    mliSkirt.position.y = 0.62;
    mliSkirt.castShadow = true;
    mliSkirt.receiveShadow = true;
    shelterGroup.add(mliSkirt);

    this.shelterHullMat = this.track(
      new THREE.MeshStandardMaterial({
        map: hullPbr.map,
        bumpMap: hullPbr.bumpMap,
        bumpScale: 0.045,
        roughnessMap: hullPbr.roughnessMap,
        color: '#EEF4F8',
        emissive: '#000000',
        emissiveIntensity: 0.0,
        roughness: 0.24,
        metalness: 0.45,
        envMapIntensity: 1.25,
      })
    );
    const coreHullGeo = this.track(
      new THREE.SphereGeometry(2.45, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.52)
    );
    const coreHull = new THREE.Mesh(coreHullGeo, this.shelterHullMat);
    coreHull.position.y = 0.42;
    coreHull.castShadow = true;
    coreHull.receiveShadow = true;
    shelterGroup.add(coreHull);

    // 8-meridian + 2-latitudinal ribbed geodesic structural framing
    for (let i = 0; i < 8; i++) {
      const ribGeo = this.track(new THREE.TorusGeometry(2.465, 0.042, 8, 28, Math.PI));
      const rib = new THREE.Mesh(ribGeo, darkMetal);
      rib.position.y = 0.42;
      rib.rotation.y = (i / 8) * Math.PI;
      rib.castShadow = true;
      rib.receiveShadow = true;
      shelterGroup.add(rib);
    }
    const latRing1 = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(2.19, 0.048, 8, 36)),
      darkMetal
    );
    latRing1.rotation.x = Math.PI / 2;
    latRing1.position.y = 1.54;
    latRing1.castShadow = true;
    shelterGroup.add(latRing1);

    const latRing2 = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(1.56, 0.042, 8, 32)),
      darkMetal
    );
    latRing2.rotation.x = Math.PI / 2;
    latRing2.position.y = 2.32;
    latRing2.castShadow = true;
    shelterGroup.add(latRing2);

    // Quilted Gold MLI thermal instrumentation pods around perimeter
    const mliPodGeo = this.track(new THREE.BoxGeometry(0.62, 0.46, 0.42));
    for (const ang of [Math.PI * 0.3, -Math.PI * 0.3, Math.PI * 0.85]) {
      const pod = new THREE.Mesh(mliPodGeo, goldMliMat);
      pod.position.set(Math.sin(ang) * 2.52, 0.72, Math.cos(ang) * 2.52);
      pod.rotation.y = ang;
      pod.castShadow = true;
      pod.receiveShadow = true;
      shelterGroup.add(pod);
    }

    // Side & rear pressure bulkheads with reinforced collar rings
    const bulkheadAngles = [-Math.PI * 0.48, Math.PI * 0.52, Math.PI];
    for (const bAng of bulkheadAngles) {
      const bulkhead = new THREE.Group();
      bulkhead.position.set(Math.sin(bAng) * 2.38, 0.94, Math.cos(bAng) * 2.38);
      bulkhead.rotation.y = bAng;

      const sleeve = new THREE.Mesh(
        this.track(new THREE.CylinderGeometry(0.54, 0.58, 0.62, 14)),
        hullSlate
      );
      sleeve.rotation.x = Math.PI / 2;
      sleeve.castShadow = true;
      sleeve.receiveShadow = true;
      bulkhead.add(sleeve);

      const collarRing = new THREE.Mesh(
        this.track(new THREE.TorusGeometry(0.56, 0.055, 8, 18)),
        darkMetal
      );
      collarRing.position.z = 0.28;
      bulkhead.add(collarRing);

      shelterGroup.add(bulkhead);
    }

    // Martian dust accumulation overlay shell on Storm Shelter dome
    const shelterDustGeo = this.track(
      new THREE.SphereGeometry(2.47, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.48)
    );
    const shelterDustDome = new THREE.Mesh(shelterDustGeo, this.habitatDustMat);
    shelterDustDome.position.y = 0.42;
    shelterDustDome.renderOrder = 1;
    shelterGroup.add(shelterDustDome);

    // Warm crew habitat windows without self-illuminated glare
    this.shelterWindowMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#EAB308',
        emissive: '#D97706',
        emissiveIntensity: 0.24,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.015,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.22,
        metalness: 0.16,
      })
    );
    const windowBeltGeo = this.track(new THREE.CylinderGeometry(2.48, 2.52, 0.34, 22));
    const windowBelt = new THREE.Mesh(windowBeltGeo, this.shelterWindowMat);
    windowBelt.position.y = 1.02;
    windowBelt.castShadow = true;
    windowBelt.receiveShadow = true;
    shelterGroup.add(windowBelt);

    // Recessed Pressurized Airlock Entry Portal + Porthole + Glowing Cyan (#00E5FF) Status Strips
    this.airlockStripMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#00E5FF',
        emissive: '#00E5FF',
        emissiveIntensity: 1.45,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.015,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.2,
        metalness: 0.35,
      })
    );
    const airlockShell = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.38, 1.52, 1.05)),
      hullSlate
    );
    airlockShell.position.set(0, 0.98, 2.34);
    airlockShell.castShadow = true;
    airlockShell.receiveShadow = true;
    shelterGroup.add(airlockShell);

    const airlockRoofCanopy = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.46, 0.14, 1.18)),
      goldMliMat
    );
    airlockRoofCanopy.position.set(0, 1.76, 2.38);
    airlockRoofCanopy.castShadow = true;
    shelterGroup.add(airlockRoofCanopy);

    // Recessed dark alcove & inner pressurized hatch
    const airlockRecess = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.92, 1.18, 0.18)),
      darkMetal
    );
    airlockRecess.position.set(0, 0.92, 2.81);
    shelterGroup.add(airlockRecess);

    const airlockHatch = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.74, 1.02, 0.06)),
      hullWhite
    );
    airlockHatch.position.set(0, 0.9, 2.75);
    airlockHatch.castShadow = true;
    airlockHatch.receiveShadow = true;
    shelterGroup.add(airlockHatch);

    const airlockPorthole = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.14, 0.14, 0.08, 14)),
      this.shelterWindowMat
    );
    airlockPorthole.rotation.x = Math.PI / 2;
    airlockPorthole.position.set(0, 1.12, 2.77);
    shelterGroup.add(airlockPorthole);

    // Glowing Cyan (#00E5FF) vertical & header airlock status strips
    const airlockLeftStrip = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.06, 1.18, 0.08)),
      this.airlockStripMat
    );
    airlockLeftStrip.position.set(-0.5, 0.92, 2.88);
    shelterGroup.add(airlockLeftStrip);
    const airlockRightStrip = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.06, 1.18, 0.08)),
      this.airlockStripMat
    );
    airlockRightStrip.position.set(0.5, 0.92, 2.88);
    shelterGroup.add(airlockRightStrip);
    const airlockTopStrip = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.08, 0.07, 0.08)),
      this.airlockStripMat
    );
    airlockTopStrip.position.set(0, 1.54, 2.88);
    shelterGroup.add(airlockTopStrip);

    // External Glowing Cyan Water-Wall Reservoir Tanks flanking the dome base
    const waterTankGeo = this.track(new THREE.CylinderGeometry(0.24, 0.24, 1.08, 12));
    for (const xTank of [-2.48, 2.48]) {
      const wTank = new THREE.Mesh(waterTankGeo, this.airlockStripMat);
      wTank.position.set(xTank, 0.86, 1.92);
      wTank.castShadow = true;
      wTank.receiveShadow = true;
      shelterGroup.add(wTank);
    }

    // Rooftop Communications Antenna Array with Dual Strobes (Red + Cyan)
    const roofCupola = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.62, 0.78, 0.24, 16)),
      hullSlate
    );
    roofCupola.position.y = 2.84;
    roofCupola.castShadow = true;
    shelterGroup.add(roofCupola);

    const mastGeo = this.track(new THREE.CylinderGeometry(0.065, 0.12, 1.45, 8));
    const mast = new THREE.Mesh(mastGeo, darkMetal);
    mast.position.y = 3.56;
    mast.castShadow = true;
    mast.receiveShadow = true;
    shelterGroup.add(mast);

    const crossBoom = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.95, 0.055, 0.055)),
      darkMetal
    );
    crossBoom.position.y = 3.92;
    crossBoom.castShadow = true;
    shelterGroup.add(crossBoom);

    // Miniature roof uplink dish
    const roofDishGeo = this.track(
      new THREE.LatheGeometry(
        [
          new THREE.Vector2(0, 0),
          new THREE.Vector2(0.18, 0.04),
          new THREE.Vector2(0.36, 0.16),
        ],
        16
      )
    );
    const roofDish = new THREE.Mesh(roofDishGeo, hullWhite);
    roofDish.position.set(-0.34, 3.22, 0.18);
    roofDish.rotation.set(0.55, 0.35, 0);
    roofDish.castShadow = true;
    shelterGroup.add(roofDish);

    // Twin whip antennas
    const whipGeo = this.track(new THREE.CylinderGeometry(0.014, 0.02, 0.85, 6));
    const whip1 = new THREE.Mesh(whipGeo, hullWhite);
    whip1.position.set(0.38, 4.3, 0.06);
    const whip2 = new THREE.Mesh(whipGeo, hullWhite);
    whip2.position.set(-0.38, 4.24, -0.06);
    shelterGroup.add(whip1, whip2);

    this.shelterBeaconMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#00E5FF',
        emissive: '#00E5FF',
        emissiveIntensity: 1.35,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.01,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.2,
      })
    );
    const beaconGeo = this.track(new THREE.SphereGeometry(0.15, 12, 12));
    const beacon = new THREE.Mesh(beaconGeo, this.shelterBeaconMat);
    beacon.position.y = 4.34;
    shelterGroup.add(beacon);

    this.shelterRoofRedStrobeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#FF3B3B',
        emissive: '#FF2424',
        emissiveIntensity: 1.8,
        roughness: 0.18,
      })
    );
    const redStrobe = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.075, 10, 10)),
      this.shelterRoofRedStrobeMat
    );
    redStrobe.position.set(-0.46, 3.98, 0);
    shelterGroup.add(redStrobe);

    this.shelterRoofCyanStrobeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#22D3EE',
        emissive: '#00E5FF',
        emissiveIntensity: 1.8,
        roughness: 0.18,
      })
    );
    const cyanStrobe = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.075, 10, 10)),
      this.shelterRoofCyanStrobeMat
    );
    cyanStrobe.position.set(0.46, 3.98, 0);
    shelterGroup.add(cyanStrobe);

    // Water-pump toroidal collar
    const collarGeo = this.track(new THREE.TorusGeometry(2.85, 0.18, 10, 28));
    const collar = new THREE.Mesh(collarGeo, darkMetal);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.48;
    collar.castShadow = true;
    collar.receiveShadow = true;
    shelterGroup.add(collar);

    // Outer Translucent Glowing Cyan (#00E5FF) Water-Wall Geodesic Dome Glass
    const shieldGeo = this.track(
      new THREE.SphereGeometry(2.88, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.56)
    );
    this.waterShieldMat = this.track(
      new THREE.MeshPhysicalMaterial({
        color: '#B8F4FF',
        emissive: '#006B84',
        emissiveIntensity: 0.1,
        transmission: this.isSoftwareGl ? 0 : 0.6,
        ior: 1.5,
        thickness: 0.26,
        transparent: this.isSoftwareGl,
        opacity: this.isSoftwareGl ? 0.36 : 1.0,
        roughness: 0.08,
        metalness: 0.1,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        specularIntensity: 1.0,
        envMapIntensity: 2.0,
        depthWrite: !this.isSoftwareGl,
      })
    );
    this.waterShieldMesh = new THREE.Mesh(shieldGeo, this.waterShieldMat);
    this.waterShieldMesh.position.y = 0.36;
    this.waterShieldMesh.renderOrder = 2;
    shelterGroup.add(this.waterShieldMesh);

    // Translucent cyan-blue hexagonal Water-Wall energy shimmer dome
    const hexShieldGeo = this.track(
      new THREE.SphereGeometry(3.04, 36, 22, 0, Math.PI * 2, 0, Math.PI * 0.56)
    );
    this.waterShieldHexMat = this.track(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uStrength: { value: 0.0 },
          uImpactPulse: { value: 0.0 },
          uImpactPoint: { value: new THREE.Vector3(0.9, 2.8, 1.0) },
        },
        vertexShader: `
          varying vec3 vWorldPos;
          varying vec3 vWorldNormal;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            vWorldNormal = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          uniform float uTime;
          uniform float uStrength;
          uniform float uImpactPulse;
          uniform vec3 uImpactPoint;
          varying vec3 vWorldPos;
          varying vec3 vWorldNormal;
          varying vec2 vUv;

          float hexDist(vec2 p) {
            p = abs(p);
            float c = dot(p, normalize(vec2(1.0, 1.7320508)));
            return max(c, p.x);
          }

          float hexGrid(vec2 uv) {
            vec2 r = vec2(1.0, 1.7320508);
            vec2 h = r * 0.5;
            vec2 a = mod(uv, r) - h;
            vec2 b = mod(uv - h, r) - h;
            vec2 gv = dot(a, a) < dot(b, b) ? a : b;
            return 0.5 - hexDist(gv);
          }

          void main() {
            if (uStrength <= 0.01) discard;
            vec3 viewDir = normalize(cameraPosition - vWorldPos);
            float fresnel = pow(1.0 - abs(dot(normalize(vWorldNormal), viewDir)), 1.9);

            float dHex = hexGrid(vUv * vec2(22.0, 11.0));
            float hexEdge = 1.0 - smoothstep(0.015, 0.075, dHex);
            float waterWave = 0.5 + 0.5 * sin(vWorldPos.y * 5.2 - uTime * 3.8 + vWorldPos.x * 1.4);
            float shimmer = 0.65 + 0.35 * sin(uTime * 4.5 + vUv.x * 18.0 + vUv.y * 10.0);

            float hitDist = distance(vWorldPos, uImpactPoint);
            float impactRing = exp(-hitDist * 1.45) * uImpactPulse;
            float impactWave = (0.5 + 0.5 * sin(hitDist * 9.0 - uTime * 16.0)) * impactRing;

            vec3 deepCyan = vec3(0.0, 0.72, 0.92);
            vec3 brightAqua = vec3(0.0, 0.90, 1.0);
            vec3 col = mix(deepCyan, brightAqua, clamp(hexEdge * 0.75 + fresnel * 0.45 + impactRing, 0.0, 1.0));

            float alpha = (hexEdge * (0.34 + waterWave * 0.28) + fresnel * 0.36 + waterWave * 0.08 + impactWave * 0.65)
              * uStrength * shimmer;
            gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.88));
          }
        `,
      })
    );
    this.waterShieldHexMesh = new THREE.Mesh(hexShieldGeo, this.waterShieldHexMat);
    this.waterShieldHexMesh.position.y = 0.36;
    this.waterShieldHexMesh.renderOrder = 5;
    this.waterShieldHexMesh.visible = false;
    shelterGroup.add(this.waterShieldHexMesh);

    this.exteriorBaseGroup.add(shelterGroup);
    this.addHitCollider('shelter', shelterPos, 3.4, 4.1);
    this.moduleWorldCenters.shelter.copy(shelterPos);
    this.anchorWorldMap.shelter.set(shelterPos.x + 0.15, shelterPos.y + 4.45, shelterPos.z);

    // ------------------------------------------------------------------
    // 2. SOLAR ARRAY FIELD (Left: -6.8, y, 2.2) — Deep Cobalt Blue (#0D3B66) Photovoltaic Weave
    // ------------------------------------------------------------------
    const solarPos = new THREE.Vector3(-6.8, groundHeightAt(-6.8, 2.2), 2.2);
    const solarGroup = new THREE.Group();
    solarGroup.position.copy(solarPos);
    this.addGroundDecal(solarPos.x, solarPos.z - 0.1, 4.9, shadowTex, 0.65, 0.022);

    const junctionGeo = this.track(new THREE.BoxGeometry(1.5, 0.7, 1.1));
    const junction = new THREE.Mesh(junctionGeo, hullSlate);
    junction.position.set(2.2, 0.35, 0.05);
    junction.castShadow = true;
    junction.receiveShadow = true;
    solarGroup.add(junction);

    this.solarBatteryMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#F59E0B',
        emissive: '#B45309',
        emissiveIntensity: 0.14,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.025,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.34,
        metalness: 0.35,
      })
    );
    const batteryCellGeo = this.track(new THREE.BoxGeometry(0.46, 0.55, 0.46));
    const batteryCell = new THREE.Mesh(batteryCellGeo, this.solarBatteryMat);
    batteryCell.position.set(2.2, 0.88, 0.05);
    batteryCell.castShadow = true;
    batteryCell.receiveShadow = true;
    solarGroup.add(batteryCell);

    // Gentle pulsing solar telemetry beacon on junction box
    this.solarBeaconMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#00E5FF',
        emissive: '#00E5FF',
        emissiveIntensity: 1.35,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.01,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.2,
      })
    );
    const solarBeacon = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.09, 10, 10)),
      this.solarBeaconMat
    );
    solarBeacon.position.set(2.2, 1.24, 0.05);
    solarGroup.add(solarBeacon);

    const frontPostGeo = this.track(new THREE.CylinderGeometry(0.11, 0.17, 1.15, 10));
    const rearPostGeo = this.track(new THREE.CylinderGeometry(0.11, 0.17, 1.65, 10));
    const pedestalRingGeo = this.track(new THREE.CylinderGeometry(0.26, 0.34, 0.16, 12));
    const actuatorGeo = this.track(new THREE.CylinderGeometry(0.045, 0.055, 0.56, 8));
    const crossbarGeo = this.track(new THREE.BoxGeometry(5.6, 0.12, 0.14));

    const panelFrameMat = hullWhite;
    this.solarCellMat = this.track(
      new THREE.MeshPhysicalMaterial({
        map: solarPbr.map,
        bumpMap: solarPbr.bumpMap,
        bumpScale: 0.035,
        roughnessMap: solarPbr.roughnessMap,
        roughness: 0.12,
        metalness: 0.85,
        clearcoat: 0.8,
        clearcoatRoughness: 0.07,
        envMapIntensity: 1.65,
        emissive: '#0D3B66',
        emissiveIntensity: 0.04,
      })
    );
    this.solarDustMat = this.track(
      new THREE.MeshStandardMaterial({
        map: dustOverlayTex,
        bumpMap: this.sharedRegolithPbr.bumpMap,
        bumpScale: 0.06,
        roughnessMap: this.sharedRegolithPbr.roughnessMap,
        color: '#A65132',
        roughness: 0.96,
        metalness: 0.0,
        envMapIntensity: 0.12,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      })
    );

    const panelFrameGeo = this.track(new THREE.BoxGeometry(2.08, 0.09, 1.48));
    const panelCellGeo = this.track(new THREE.BoxGeometry(1.9, 0.11, 1.3));
    const dustOverlayGeo = this.track(new THREE.PlaneGeometry(1.88, 1.28));
    const wiperGeo = this.track(new THREE.BoxGeometry(0.1, 0.08, 1.36));

    const panelCols = [-2.35, 0, 2.35];
    const rowConfigs = [
      { z: 1.05, y: 1.15, postGeo: frontPostGeo, postY: 0.58 },
      { z: -1.15, y: 1.65, postGeo: rearPostGeo, postY: 0.82 },
    ];

    rowConfigs.forEach((row) => {
      const tiltGroup = new THREE.Group();
      tiltGroup.position.set(0, row.y, row.z);
      tiltGroup.rotation.x = 0.38;

      const crossbar = new THREE.Mesh(crossbarGeo, darkMetal);
      crossbar.position.set(0, -0.08, 0);
      crossbar.castShadow = true;
      crossbar.receiveShadow = true;
      tiltGroup.add(crossbar);

      panelCols.forEach((xOffset) => {
        const pedestalBase = new THREE.Mesh(pedestalRingGeo, hullSlate);
        pedestalBase.position.set(xOffset, 0.08, row.z);
        pedestalBase.castShadow = true;
        pedestalBase.receiveShadow = true;
        solarGroup.add(pedestalBase);

        const post = new THREE.Mesh(row.postGeo, darkMetal);
        post.position.set(xOffset, row.postY, row.z);
        post.castShadow = true;
        post.receiveShadow = true;
        solarGroup.add(post);

        const trackingGear = new THREE.Mesh(
          this.track(new THREE.CylinderGeometry(0.18, 0.18, 0.18, 12)),
          accentAmber
        );
        trackingGear.position.set(xOffset, row.y - 0.14, row.z);
        solarGroup.add(trackingGear);

        const actuator = new THREE.Mesh(actuatorGeo, hullSlate);
        actuator.position.set(xOffset, row.y - 0.32, row.z - 0.18);
        actuator.rotation.x = 0.55;
        actuator.castShadow = true;
        solarGroup.add(actuator);

        const frame = new THREE.Mesh(panelFrameGeo, panelFrameMat);
        frame.position.set(xOffset, 0, 0);
        frame.castShadow = true;
        frame.receiveShadow = true;
        tiltGroup.add(frame);

        const cell = new THREE.Mesh(panelCellGeo, this.solarCellMat);
        cell.position.set(xOffset, 0.02, 0);
        cell.castShadow = true;
        cell.receiveShadow = true;
        tiltGroup.add(cell);

        const dustOverlay = new THREE.Mesh(dustOverlayGeo, this.solarDustMat);
        dustOverlay.rotation.x = -Math.PI / 2;
        dustOverlay.position.set(xOffset, 0.09, 0);
        dustOverlay.renderOrder = 1;
        tiltGroup.add(dustOverlay);

        const wiper = new THREE.Mesh(wiperGeo, accentAmber);
        wiper.position.set(xOffset - 0.88, 0.125, 0);
        wiper.castShadow = true;
        wiper.receiveShadow = true;
        tiltGroup.add(wiper);
        this.solarWipers.push({ mesh: wiper, baseX: xOffset });
      });

      this.solarTiltGroups.push(tiltGroup);
      solarGroup.add(tiltGroup);
    });

    this.exteriorBaseGroup.add(solarGroup);
    this.addHitCollider('solar', solarPos, 4.1, 3.0);
    this.moduleWorldCenters.solar.copy(solarPos);
    this.anchorWorldMap.solar.set(solarPos.x - 0.5, solarPos.y + 3.05, solarPos.z);

    // ------------------------------------------------------------------
    // 3. MOXIE & LIFE SUPPORT CORE (Back-Left: -3.7, y, -4.4)
    // ------------------------------------------------------------------
    const moxiePos = new THREE.Vector3(-3.7, groundHeightAt(-3.7, -4.4), -4.4);
    const moxieGroup = new THREE.Group();
    moxieGroup.position.copy(moxiePos);
    this.addGroundDecal(moxiePos.x, moxiePos.z, 5.1, scorchTex, 0.72, 0.03);
    this.addGroundDecal(moxiePos.x, moxiePos.z, 3.4, shadowTex, 0.65, 0.036);
    this.addDustFoundationSkirt(moxiePos.x, moxiePos.z, 2.1, 2.45);

    const moxiePad = new THREE.Mesh(this.track(new THREE.BoxGeometry(3.8, 0.4, 2.8)), hullSlate);
    moxiePad.position.y = 0.2;
    moxiePad.castShadow = true;
    moxiePad.receiveShadow = true;
    moxieGroup.add(moxiePad);

    const moxieBody = new THREE.Mesh(this.track(new THREE.BoxGeometry(2.3, 1.65, 1.8)), hullWhite);
    moxieBody.position.set(-0.35, 1.18, 0);
    moxieBody.castShadow = true;
    moxieBody.receiveShadow = true;
    moxieGroup.add(moxieBody);

    // 3 cyan (#00E5FF) O2/Water tanks with restrained self-illumination
    this.moxieTankMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#00E5FF',
        emissive: '#007C91',
        emissiveIntensity: 0.22,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.02,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.26,
        metalness: 0.44,
      })
    );
    const tankGeo = this.track(new THREE.CylinderGeometry(0.32, 0.32, 1.85, 14));
    for (let i = 0; i < 3; i++) {
      const tank = new THREE.Mesh(tankGeo, this.moxieTankMat);
      tank.position.set(1.22, 1.32, -0.58 + i * 0.58);
      tank.castShadow = true;
      tank.receiveShadow = true;
      moxieGroup.add(tank);
    }

    // Intake CO2 turbine fan on roof
    const intakeHood = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.62, 0.72, 0.45, 16)),
      darkMetal
    );
    intakeHood.position.set(-0.35, 2.22, 0);
    intakeHood.castShadow = true;
    intakeHood.receiveShadow = true;
    moxieGroup.add(intakeHood);

    // Gentle pulsing cyan beacon on MOXIE roof
    this.moxieBeaconMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#00E5FF',
        emissive: '#00E5FF',
        emissiveIntensity: 1.1,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.01,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.2,
      })
    );
    const moxieBeacon = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.09, 10, 10)),
      this.moxieBeaconMat
    );
    moxieBeacon.position.set(-1.35, 2.15, 0.72);
    moxieGroup.add(moxieBeacon);

    this.moxieFan = new THREE.Group();
    this.moxieFan.position.set(-0.35, 2.48, 0);
    const bladeGeo = this.track(new THREE.BoxGeometry(0.98, 0.05, 0.16));
    const blade1 = new THREE.Mesh(bladeGeo, accentAmber);
    const blade2 = new THREE.Mesh(bladeGeo, accentAmber);
    blade2.rotation.y = Math.PI / 2;
    this.moxieFan.add(blade1, blade2);
    moxieGroup.add(this.moxieFan);

    // Side cooling radiator fin bank & twin exhaust vent stacks with animated exhaust plumes
    const finGeo = this.track(new THREE.BoxGeometry(0.06, 0.96, 1.25));
    for (let f = 0; f < 5; f++) {
      const fin = new THREE.Mesh(finGeo, darkMetal);
      fin.position.set(-1.55 + f * 0.12, 1.18, 0);
      fin.castShadow = true;
      moxieGroup.add(fin);
    }

    const exhaustStackGeo = this.track(new THREE.CylinderGeometry(0.11, 0.14, 0.72, 10));
    for (const exZ of [-0.52, 0.52]) {
      const stack = new THREE.Mesh(exhaustStackGeo, darkMetal);
      stack.position.set(-1.12, 2.28, exZ);
      stack.castShadow = true;
      moxieGroup.add(stack);
    }

    // Soft radial-sprite wispy CO2 exhaust plumes from twin stacks
    const exhaustSprite = this.track(createDustParticleSpriteTexture());
    const exhaustCount = 16;
    this.moxieExhaustPositions = new Float32Array(exhaustCount * 3);
    this.moxieExhaustSeeds = [];
    for (let i = 0; i < exhaustCount; i++) {
      const exZ = i % 2 === 0 ? -0.52 : 0.52;
      const phase = ((i >> 1) / (exhaustCount / 2)) + (exZ > 0 ? 0.18 : 0);
      this.moxieExhaustSeeds.push({ baseX: -1.12, baseZ: exZ, phase });
      this.moxieExhaustPositions[i * 3] = -1.12;
      this.moxieExhaustPositions[i * 3 + 1] = 2.68 + (phase % 1) * 1.4;
      this.moxieExhaustPositions[i * 3 + 2] = exZ;
    }
    const exhaustGeo = this.track(new THREE.BufferGeometry());
    exhaustGeo.setAttribute('position', new THREE.BufferAttribute(this.moxieExhaustPositions, 3));
    const exhaustMat = this.track(
      new THREE.PointsMaterial({
        map: exhaustSprite,
        color: '#CFE8F3',
        size: 0.72,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
      })
    );
    this.moxieExhaustPoints = new THREE.Points(exhaustGeo, exhaustMat);
    moxieGroup.add(this.moxieExhaustPoints);

    // Subtle rising O2 condensation micro-vapor above MOXIE tanks
    const bubbleGeo = this.track(new THREE.SphereGeometry(0.04, 8, 8));
    const bubbleMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#67E8F9',
        emissive: '#00E5FF',
        emissiveIntensity: 0.55,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      })
    );
    for (let i = 0; i < 8; i++) {
      const b = new THREE.Mesh(bubbleGeo, bubbleMat);
      b.position.set(1.06 + (i % 3) * 0.22, 2.15 + (i / 8) * 1.85, -0.34 + ((i * 7) % 5) * 0.16);
      b.userData.phase = i * 0.74;
      this.moxieBubbles.push(b);
      moxieGroup.add(b);
    }

    this.exteriorBaseGroup.add(moxieGroup);
    this.addHitCollider('moxie', moxiePos, 2.6, 3.2);
    this.moduleWorldCenters.moxie.copy(moxiePos);
    this.anchorWorldMap.moxie.set(moxiePos.x - 0.5, moxiePos.y + 3.65, moxiePos.z);

    // ------------------------------------------------------------------
    // 4. HYDROPONIC BIO-DOME (Right: 6.8, y, 2.0) — Translucent Ribbed Greenhouse + Emerald Vertical Crop Racks
    // ------------------------------------------------------------------
    const bioPos = new THREE.Vector3(6.8, groundHeightAt(6.8, 2.0), 2.0);
    const bioGroup = new THREE.Group();
    bioGroup.position.copy(bioPos);
    this.addGroundDecal(bioPos.x, bioPos.z, 5.3, scorchTex, 0.68, 0.03);
    this.addGroundDecal(bioPos.x, bioPos.z, 3.6, shadowTex, 0.65, 0.036);
    this.addDustFoundationSkirt(bioPos.x, bioPos.z, 2.75, 3.18);

    const bioBase = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(2.55, 2.85, 0.45, 24)),
      hullSlate
    );
    bioBase.position.y = 0.22;
    bioBase.castShadow = true;
    bioBase.receiveShadow = true;
    bioGroup.add(bioBase);

    const soilTray = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(2.15, 2.15, 0.16, 20)),
      this.track(
        new THREE.MeshStandardMaterial({
          color: '#1E293B',
          emissive: '#064E3B',
          emissiveIntensity: 0.05,
          bumpMap: this.sharedRegolithPbr.bumpMap,
          bumpScale: 0.12,
          roughnessMap: this.sharedRegolithPbr.roughnessMap,
          roughness: 0.88,
        })
      )
    );
    soilTray.position.y = 0.48;
    soilTray.castShadow = true;
    soilTray.receiveShadow = true;
    bioGroup.add(soilTray);

    this.bioLeafMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#047857',
        emissive: '#059669',
        emissiveIntensity: 0.12,
        bumpMap: this.sharedRegolithPbr.bumpMap,
        bumpScale: 0.05,
        roughnessMap: this.sharedRegolithPbr.roughnessMap,
        roughness: 0.48,
      })
    );
    const rackLedMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#34D399',
        emissive: '#10B981',
        emissiveIntensity: 1.55,
        roughness: 0.2,
      })
    );

    // 3 detailed vertical emerald-lit crop rack towers visible through the glass dome
    const rackPostGeo = this.track(new THREE.BoxGeometry(0.06, 1.35, 0.06));
    const rackShelfGeo = this.track(new THREE.BoxGeometry(1.18, 0.06, 0.46));
    const rackLedGeo = this.track(new THREE.BoxGeometry(1.08, 0.035, 0.08));
    const foliageGeo = this.track(new THREE.DodecahedronGeometry(0.14, 1));

    const towerLayout = [
      { x: -0.78, z: -0.58, rotY: 0.35 },
      { x: 0.78, z: -0.58, rotY: -0.35 },
      { x: 0.0, z: 0.72, rotY: 0 },
    ];
    towerLayout.forEach((tw) => {
      const rack = new THREE.Group();
      rack.position.set(tw.x, 0.56, tw.z);
      rack.rotation.y = tw.rotY;

      for (const px of [-0.55, 0.55]) {
        for (const pz of [-0.2, 0.2]) {
          const post = new THREE.Mesh(rackPostGeo, darkMetal);
          post.position.set(px, 0.68, pz);
          rack.add(post);
        }
      }

      for (let tier = 0; tier < 3; tier++) {
        const ty = 0.2 + tier * 0.44;
        const shelf = new THREE.Mesh(rackShelfGeo, hullSlate);
        shelf.position.y = ty;
        rack.add(shelf);

        const ledBar = new THREE.Mesh(rackLedGeo, rackLedMat);
        ledBar.position.y = ty + 0.32;
        rack.add(ledBar);

        for (let c = 0; c < 4; c++) {
          const plant = new THREE.Mesh(foliageGeo, this.bioLeafMat);
          plant.position.set(-0.38 + c * 0.25, ty + 0.14, (c % 2 === 0 ? 1 : -1) * 0.06);
          plant.scale.set(1.1, 0.85, 1.0);
          rack.add(plant);
        }
      }

      this.biodomeCrops.push(rack);
      bioGroup.add(rack);
    });

    // Emerald LED Grow Light Ring inside dome
    this.bioLedRingMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#34D399',
        emissive: '#10B981',
        emissiveIntensity: 1.15,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.015,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.25,
      })
    );
    const ledRing = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(1.52, 0.055, 8, 28)),
      this.bioLedRingMat
    );
    ledRing.rotation.x = Math.PI / 2;
    ledRing.position.y = 2.02;
    bioGroup.add(ledRing);

    // External geodesic structural greenhouse ribs around Bio-Dome
    for (let i = 0; i < 6; i++) {
      const bioRib = new THREE.Mesh(
        this.track(new THREE.TorusGeometry(2.435, 0.036, 8, 28, Math.PI)),
        hullWhite
      );
      bioRib.position.y = 0.42;
      bioRib.rotation.y = (i / 6) * Math.PI;
      bioRib.castShadow = true;
      bioGroup.add(bioRib);
    }
    const bioCollar = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(2.44, 0.075, 8, 32)),
      darkMetal
    );
    bioCollar.rotation.x = Math.PI / 2;
    bioCollar.position.y = 0.45;
    bioGroup.add(bioCollar);

    // Gentle pulsing Emerald beacon at Bio-Dome apex
    this.biodomeBeaconMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#10B981',
        emissive: '#10B981',
        emissiveIntensity: 1.25,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.01,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.2,
      })
    );
    const bioBeacon = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.11, 10, 10)),
      this.biodomeBeaconMat
    );
    bioBeacon.position.y = 2.94;
    bioGroup.add(bioBeacon);

    // Translucent ribbed greenhouse glass (real transmission on GPU, smooth alpha glass on Software GL)
    this.biodomeGlassMat = this.track(
      new THREE.MeshPhysicalMaterial({
        color: '#D1FAE5',
        emissive: '#059669',
        emissiveIntensity: 0.04,
        transmission: this.isSoftwareGl ? 0 : 0.6,
        ior: 1.5,
        thickness: 0.35,
        transparent: this.isSoftwareGl,
        opacity: this.isSoftwareGl ? 0.38 : 1.0,
        roughness: 0.08,
        metalness: 0.1,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        specularIntensity: 1.0,
        envMapIntensity: 2.0,
        depthWrite: !this.isSoftwareGl,
      })
    );
    const glassDome = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(2.42, 26, 18, 0, Math.PI * 2, 0, Math.PI * 0.54)),
      this.biodomeGlassMat
    );
    glassDome.position.y = 0.42;
    glassDome.receiveShadow = true;
    glassDome.renderOrder = 3;
    bioGroup.add(glassDome);

    // Martian dust accumulation layer on Bio-Dome glass
    const bioDustDome = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(2.445, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5)),
      this.habitatDustMat
    );
    bioDustDome.position.y = 0.42;
    bioDustDome.renderOrder = 4;
    bioGroup.add(bioDustDome);

    this.exteriorBaseGroup.add(bioGroup);
    this.addHitCollider('biodome', bioPos, 2.7, 3.0);
    this.moduleWorldCenters.biodome.copy(bioPos);
    this.anchorWorldMap.biodome.set(bioPos.x + 0.35, bioPos.y + 3.35, bioPos.z);

    // ------------------------------------------------------------------
    // 5. CONNECTING PRESSURIZED AIRLOCK TUNNELS WITH GLOWING CYAN STRIPS
    // ------------------------------------------------------------------
    const connectTunnel = (
      a: THREE.Vector3,
      b: THREE.Vector3,
      radius: number,
      mat: THREE.Material,
      addDustSleeve = false
    ) => {
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir.clone().normalize()
      );
      const tunnelGeo = this.track(new THREE.CylinderGeometry(radius, radius, len, 14));
      const tunnel = new THREE.Mesh(tunnelGeo, mat);
      tunnel.position.set(mid.x, Math.max(a.y, b.y) + radius + 0.1, mid.z);
      tunnel.quaternion.copy(q);
      tunnel.castShadow = true;
      tunnel.receiveShadow = true;
      this.exteriorBaseGroup.add(tunnel);

      // Glowing Cyan (#00E5FF) airlock collar rings along pressurized tunnel
      const collarRingGeo = this.track(new THREE.TorusGeometry(radius + 0.025, 0.032, 8, 18));
      collarRingGeo.rotateX(Math.PI / 2);
      for (const offsetFrac of [-0.26, 0.26]) {
        const ring = new THREE.Mesh(collarRingGeo, this.airlockStripMat);
        ring.position.copy(tunnel.position).addScaledVector(dir, offsetFrac);
        ring.quaternion.copy(q);
        this.exteriorBaseGroup.add(ring);
      }

      if (addDustSleeve) {
        const dustSleeveGeo = this.track(
          new THREE.CylinderGeometry(radius + 0.015, radius + 0.015, len * 0.92, 12, 1, true)
        );
        const sleeve = new THREE.Mesh(dustSleeveGeo, this.habitatDustMat);
        sleeve.position.copy(tunnel.position);
        sleeve.quaternion.copy(q);
        sleeve.renderOrder = 2;
        this.exteriorBaseGroup.add(sleeve);
      }
    };

    connectTunnel(shelterPos, moxiePos, 0.48, hullWhite, true);
    connectTunnel(shelterPos, bioPos, 0.48, hullWhite, true);
  }

  private buildStorytellingProps(): void {
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const shadowTex = this.track(createContactShadowTexture());
    const trackTex = this.track(createRoverTrackTexture(maxAniso));

    const cableMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#1E293B',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.025,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.55,
        metalness: 0.45,
      })
    );
    const cableStripeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#EA580C',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.025,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.45,
        metalness: 0.25,
      })
    );
    const steelMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#475569',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.03,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.24,
        metalness: 0.8,
        envMapIntensity: 1.38,
      })
    );
    const darkTitaniumMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#1E293B',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.03,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.22,
        metalness: 0.82,
        envMapIntensity: 1.45,
      })
    );
    const whiteAvionicsMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#EEF4F8',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.025,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.22,
        metalness: 0.75,
        envMapIntensity: 1.45,
      })
    );
    const goldFoilMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#F59E0B',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.04,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.2,
        metalness: 0.88,
        envMapIntensity: 1.6,
      })
    );

    // ------------------------------------------------------------------
    // 1. ROVER TRACKS & FOOTPRINT TRAILS CONNECTING MODULES
    // ------------------------------------------------------------------
    this.buildTerrainTrackRibbon(
      [
        new THREE.Vector3(-4.8, 0, 3.5),
        new THREE.Vector3(-2.8, 0, 4.1),
        new THREE.Vector3(-0.6, 0, 4.3),
        new THREE.Vector3(1.4, 0, 4.3),
        new THREE.Vector3(3.2, 0, 4.4),
      ],
      1.15,
      trackTex
    );
    this.buildTerrainTrackRibbon(
      [
        new THREE.Vector3(3.6, 0, 4.4),
        new THREE.Vector3(4.9, 0, 4.1),
        new THREE.Vector3(6.1, 0, 3.4),
        new THREE.Vector3(6.8, 0, 2.5),
      ],
      1.15,
      trackTex
    );
    this.buildTerrainTrackRibbon(
      [
        new THREE.Vector3(-4.8, 0, 3.5),
        new THREE.Vector3(-7.6, 0, 1.2),
        new THREE.Vector3(-10.5, 0, -2.4),
        new THREE.Vector3(-13.8, 0, -6.8),
      ],
      1.12,
      trackTex
    );

    // ------------------------------------------------------------------
    // 2. GROUND-HUGGING POWER CABLES
    // ------------------------------------------------------------------
    const addGroundCable = (waypoints: Array<[number, number]>, mat: THREE.Material) => {
      const pts = waypoints.map(([x, z]) => new THREE.Vector3(x, groundHeightAt(x, z) + 0.06, z));
      const curve = new THREE.CatmullRomCurve3(pts);
      const cableGeo = this.track(new THREE.TubeGeometry(curve, 24, 0.065, 8, false));
      const cable = new THREE.Mesh(cableGeo, mat);
      cable.castShadow = true;
      cable.receiveShadow = true;
      this.scene.add(cable);

      const clampGeo = this.track(new THREE.BoxGeometry(0.18, 0.1, 0.18));
      for (const t of [0.22, 0.5, 0.78]) {
        const p = curve.getPoint(t);
        const clamp = new THREE.Mesh(clampGeo, steelMat);
        clamp.position.set(p.x, p.y - 0.01, p.z);
        clamp.castShadow = true;
        clamp.receiveShadow = true;
        this.scene.add(clamp);
      }
    };

    addGroundCable(
      [
        [-4.5, 2.2],
        [-3.2, 1.9],
        [-1.8, 1.6],
        [-0.6, 1.2],
      ],
      cableStripeMat
    );
    addGroundCable(
      [
        [-4.5, 2.0],
        [-4.8, 0.2],
        [-4.4, -1.8],
        [-3.9, -3.3],
      ],
      cableMat
    );
    addGroundCable(
      [
        [2.6, 1.3],
        [3.9, 1.6],
        [4.9, 1.8],
      ],
      cableStripeMat
    );

    // ------------------------------------------------------------------
    // 3. COMMS DISH WITH GENTLE PULSING BEACON (Back-Right: 5.05, y, -4.1)
    // ------------------------------------------------------------------
    const commsPos = new THREE.Vector3(5.05, groundHeightAt(5.05, -4.1), -4.1);
    const commsGroup = new THREE.Group();
    commsGroup.position.copy(commsPos);
    this.addGroundDecal(commsPos.x, commsPos.z, 1.65, shadowTex, 0.6, 0.03);

    const commsPad = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.95, 1.1, 0.22, 12)),
      steelMat
    );
    commsPad.position.y = 0.11;
    commsPad.castShadow = true;
    commsPad.receiveShadow = true;
    commsGroup.add(commsPad);

    const commsBox = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.7, 0.55, 0.55)), whiteAvionicsMat);
    commsBox.position.set(0.32, 0.48, 0);
    commsBox.castShadow = true;
    commsBox.receiveShadow = true;
    commsGroup.add(commsBox);

    const pedestal = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.14, 0.22, 1.55, 10)),
      darkTitaniumMat
    );
    pedestal.position.set(-0.12, 0.95, 0);
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    commsGroup.add(pedestal);

    const dishProfile = [
      new THREE.Vector2(0.0, 0.0),
      new THREE.Vector2(0.35, 0.08),
      new THREE.Vector2(0.7, 0.24),
      new THREE.Vector2(0.98, 0.48),
    ];
    const dishGeo = this.track(new THREE.LatheGeometry(dishProfile, 20));
    const dishHolder = new THREE.Group();
    dishHolder.position.set(-0.12, 1.85, 0);
    dishHolder.rotation.set(-0.55, -0.35, 0);

    const dishMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#EEF4F8',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.025,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.22,
        metalness: 0.75,
        envMapIntensity: 1.4,
        side: THREE.DoubleSide,
      })
    );
    const dishMesh = new THREE.Mesh(dishGeo, dishMat);
    dishMesh.castShadow = true;
    dishMesh.receiveShadow = true;
    dishHolder.add(dishMesh);

    const feedHorn = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.05, 0.09, 0.72, 8)),
      goldFoilMat
    );
    feedHorn.position.y = 0.42;
    feedHorn.castShadow = true;
    dishHolder.add(feedHorn);
    commsGroup.add(dishHolder);

    const beaconPole = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.04, 0.06, 2.2, 8)),
      darkTitaniumMat
    );
    beaconPole.position.set(0.5, 1.3, -0.15);
    beaconPole.castShadow = true;
    commsGroup.add(beaconPole);

    this.commsBeaconMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#EF4444',
        emissive: '#FF2424',
        emissiveIntensity: 1.8,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.01,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.2,
      })
    );
    const redBeacon = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.11, 10, 10)),
      this.commsBeaconMat
    );
    redBeacon.position.set(0.5, 2.45, -0.15);
    commsGroup.add(redBeacon);

    this.exteriorBaseGroup.add(commsGroup);

    // ------------------------------------------------------------------
    // 4. EXTERNAL O2 / H2O STORAGE TANK RACK (Foreground-Left: -3.55, y, 4.35)
    // ------------------------------------------------------------------
    const rackPos = new THREE.Vector3(-3.55, groundHeightAt(-3.55, 4.35), 4.35);
    const rackGroup = new THREE.Group();
    rackGroup.position.copy(rackPos);
    rackGroup.rotation.y = 0.28;
    this.addGroundDecal(rackPos.x, rackPos.z, 1.65, shadowTex, 0.62, 0.03);

    const skid = new THREE.Mesh(this.track(new THREE.BoxGeometry(2.0, 0.16, 1.2)), steelMat);
    skid.position.y = 0.08;
    skid.castShadow = true;
    skid.receiveShadow = true;
    rackGroup.add(skid);

    const o2TankMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#00E5FF',
        emissive: '#007C91',
        emissiveIntensity: 0.1,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.02,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.28,
        metalness: 0.5,
      })
    );
    const h2oTankMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#0EA5E9',
        emissive: '#0369A1',
        emissiveIntensity: 0.08,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.02,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.28,
        metalness: 0.52,
      })
    );
    const hTankGeo = this.track(new THREE.CylinderGeometry(0.26, 0.26, 1.35, 12));
    hTankGeo.rotateZ(Math.PI / 2);
    const frostCollarGeo = this.track(new THREE.TorusGeometry(0.27, 0.032, 8, 16));
    frostCollarGeo.rotateY(Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const hTank = new THREE.Mesh(hTankGeo, i === 0 ? o2TankMat : h2oTankMat);
      hTank.position.set(-0.22, 0.48 + i * 0.42, 0.22);
      hTank.castShadow = true;
      hTank.receiveShadow = true;
      rackGroup.add(hTank);

      for (const cxOff of [-0.62, -0.22, 0.18]) {
        const collar = new THREE.Mesh(frostCollarGeo, steelMat);
        collar.position.set(cxOff, 0.48 + i * 0.42, 0.22);
        rackGroup.add(collar);
      }
    }

    const vTank = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.28, 0.28, 1.25, 14)),
      whiteAvionicsMat
    );
    vTank.position.set(0.58, 0.78, -0.2);
    vTank.castShadow = true;
    vTank.receiveShadow = true;
    rackGroup.add(vTank);

    const pipeAmberMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#D97706',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.02,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.4,
        metalness: 0.5,
      })
    );
    const pipeCollar = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.06, 0.06, 1.05, 8)),
      pipeAmberMat
    );
    pipeCollar.position.set(0.15, 0.68, -0.2);
    pipeCollar.castShadow = true;
    rackGroup.add(pipeCollar);

    const valveWheel = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(0.12, 0.025, 8, 14)),
      pipeAmberMat
    );
    valveWheel.position.set(0.15, 0.92, 0.36);
    rackGroup.add(valveWheel);

    this.exteriorBaseGroup.add(rackGroup);

    // Curved connecting cryogenic feed pipes linking tank farm to Main Habitat & MOXIE Core
    const addCryoPipe = (waypoints: Array<[number, number, number]>, mat: THREE.Material) => {
      const pts = waypoints.map(([x, h, z]) => new THREE.Vector3(x, groundHeightAt(x, z) + h, z));
      const curve = new THREE.CatmullRomCurve3(pts);
      const geo = this.track(new THREE.TubeGeometry(curve, 22, 0.048, 8, false));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    };
    addCryoPipe(
      [
        [-3.1, 0.36, 4.1],
        [-2.1, 0.22, 3.4],
        [-1.1, 0.28, 2.3],
      ],
      o2TankMat
    );
    addCryoPipe(
      [
        [-3.7, 0.34, 3.8],
        [-4.2, 0.18, 1.2],
        [-4.0, 0.22, -1.6],
        [-3.8, 0.32, -3.2],
      ],
      h2oTankMat
    );

    // ------------------------------------------------------------------
    // 5. AUTONOMOUS 6-WHEEL MARS UTILITY ROVER (Parked next to Habitat Dome)
    // ------------------------------------------------------------------
    this.roverHomePos.set(3.6, groundHeightAt(3.6, 4.4), 4.4);
    this.roverGroup = new THREE.Group();
    this.roverGroup.position.copy(this.roverHomePos);
    this.roverGroup.rotation.y = this.roverHomeYaw;

    const roverShadowGeo = this.track(new THREE.PlaneGeometry(2.6, 2.2));
    roverShadowGeo.rotateX(-Math.PI / 2);
    const roverShadowMat = this.track(
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    );
    const roverShadow = new THREE.Mesh(roverShadowGeo, roverShadowMat);
    roverShadow.position.y = 0.03;
    this.roverGroup.add(roverShadow);

    const roverBody = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.22, 0.42, 0.78)),
      whiteAvionicsMat
    );
    roverBody.position.y = 0.48;
    roverBody.castShadow = true;
    roverBody.receiveShadow = true;
    this.roverGroup.add(roverBody);

    const foilPanel = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.76, 0.44, 0.81)),
      goldFoilMat
    );
    foilPanel.position.set(-0.08, 0.48, 0);
    foilPanel.castShadow = true;
    foilPanel.receiveShadow = true;
    this.roverGroup.add(foilPanel);

    const topDeck = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.12, 0.06, 0.7)),
      darkTitaniumMat
    );
    topDeck.position.set(0, 0.71, 0);
    topDeck.castShadow = true;
    topDeck.receiveShadow = true;
    this.roverGroup.add(topDeck);

    const wheelGeo = this.track(new THREE.CylinderGeometry(0.19, 0.19, 0.14, 14));
    wheelGeo.rotateX(Math.PI / 2);
    const hubGeo = this.track(new THREE.CylinderGeometry(0.085, 0.085, 0.155, 10));
    hubGeo.rotateX(Math.PI / 2);
    const wheelMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#18181B',
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.04,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.78,
        metalness: 0.25,
      })
    );
    this.roverWheels = [];
    for (const xW of [-0.48, 0.0, 0.48]) {
      for (const zW of [-0.47, 0.47]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.position.set(xW, 0.19, zW);
        wheel.castShadow = true;
        wheel.receiveShadow = true;
        const hub = new THREE.Mesh(hubGeo, goldFoilMat);
        wheel.add(hub);
        this.roverGroup.add(wheel);
        this.roverWheels.push(wheel);
      }
    }

    const mainStrutGeo = this.track(new THREE.BoxGeometry(0.98, 0.055, 0.055));
    const diagStrutGeo = this.track(new THREE.BoxGeometry(0.46, 0.048, 0.048));
    for (const zS of [-0.41, 0.41]) {
      const mainStrut = new THREE.Mesh(mainStrutGeo, darkTitaniumMat);
      mainStrut.position.set(0, 0.28, zS);
      this.roverGroup.add(mainStrut);

      const frontArm = new THREE.Mesh(diagStrutGeo, steelMat);
      frontArm.position.set(0.24, 0.37, zS);
      frontArm.rotation.z = -0.58;
      this.roverGroup.add(frontArm);

      const rearArm = new THREE.Mesh(diagStrutGeo, steelMat);
      rearArm.position.set(-0.24, 0.37, zS);
      rearArm.rotation.z = 0.58;
      this.roverGroup.add(rearArm);
    }

    this.roverMastGroup = new THREE.Group();
    this.roverMastGroup.position.set(0.38, 0.72, 0.14);

    const mastPole = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.04, 0.052, 0.62, 8)),
      whiteAvionicsMat
    );
    mastPole.position.set(0, 0.31, 0);
    mastPole.castShadow = true;
    this.roverMastGroup.add(mastPole);

    const camHead = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.24, 0.15, 0.3)),
      whiteAvionicsMat
    );
    camHead.position.set(0.04, 0.65, 0);
    camHead.castShadow = true;
    this.roverMastGroup.add(camHead);

    this.roverLaserEyeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#EF4444',
        emissive: '#FF2424',
        emissiveIntensity: 1.8,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.01,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.15,
      })
    );
    this.roverLaserEyeMesh = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.048, 0.048, 0.055, 10)),
      this.roverLaserEyeMat
    );
    this.roverLaserEyeMesh.rotation.z = Math.PI / 2;
    this.roverLaserEyeMesh.position.set(0.17, 0.65, 0);
    this.roverMastGroup.add(this.roverLaserEyeMesh);

    const fhazLensMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#00E5FF',
        emissive: '#00B8D4',
        emissiveIntensity: 0.85,
        bumpMap: this.sharedMetalPbr.bumpMap,
        bumpScale: 0.01,
        roughnessMap: this.sharedMetalPbr.roughnessMap,
        roughness: 0.18,
      })
    );
    const fhazCam = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.08, 0.07, 0.16)),
      darkTitaniumMat
    );
    fhazCam.position.set(0.62, 0.42, 0);
    this.roverGroup.add(fhazCam);
    const fhazEye = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.025, 0.025, 0.03, 8)),
      fhazLensMat
    );
    fhazEye.rotation.z = Math.PI / 2;
    fhazEye.position.set(0.665, 0.42, 0);
    this.roverGroup.add(fhazEye);

    this.roverGroup.add(this.roverMastGroup);

    // Sweeping front rover headlights + subtle volumetric beam cones + ground SpotLight
    this.roverHeadlightRig = new THREE.Group();
    this.roverHeadlightRig.position.set(0.62, 0.46, 0);

    const lampLensMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#E0F2FE',
        emissive: '#BAE6FD',
        emissiveIntensity: 1.9,
        roughness: 0.15,
      })
    );
    const coneMat = this.track(
      new THREE.MeshBasicMaterial({
        color: '#CCFBF1',
        transparent: true,
        opacity: 0.17,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    const beamConeGeo = this.track(new THREE.CylinderGeometry(0.035, 0.42, 3.4, 12, 1, true));
    beamConeGeo.translate(0, -1.7, 0);
    beamConeGeo.rotateZ(Math.PI / 2);

    for (const zLamp of [-0.23, 0.23]) {
      const pod = new THREE.Mesh(
        this.track(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 10)),
        darkTitaniumMat
      );
      pod.rotation.z = Math.PI / 2;
      pod.position.set(0, 0, zLamp);
      this.roverHeadlightRig.add(pod);

      const lens = new THREE.Mesh(
        this.track(new THREE.CylinderGeometry(0.044, 0.044, 0.02, 10)),
        lampLensMat
      );
      lens.rotation.z = Math.PI / 2;
      lens.position.set(0.045, 0, zLamp);
      this.roverHeadlightRig.add(lens);

      const cone = new THREE.Mesh(beamConeGeo, coneMat);
      cone.position.set(0.06, 0, zLamp);
      cone.rotation.z = -0.18;
      this.roverHeadlightRig.add(cone);
    }

    this.roverHeadlightTarget = new THREE.Object3D();
    this.roverHeadlightTarget.position.set(4.5, -0.45, 0);
    this.roverHeadlightRig.add(this.roverHeadlightTarget);

    this.roverHeadlightSpot = new THREE.SpotLight('#E0F7FA', 3.4, 16, Math.PI * 0.22, 0.55, 1.4);
    this.roverHeadlightSpot.position.set(0.05, 0.05, 0);
    this.roverHeadlightSpot.target = this.roverHeadlightTarget;
    this.roverHeadlightRig.add(this.roverHeadlightSpot);
    this.roverGroup.add(this.roverHeadlightRig);

    const rtg = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.11, 0.14, 0.46, 8)),
      darkTitaniumMat
    );
    rtg.position.set(-0.7, 0.54, 0);
    rtg.rotation.z = 0.95;
    rtg.castShadow = true;
    rtg.receiveShadow = true;
    this.roverGroup.add(rtg);

    this.scene.add(this.roverGroup);

    // Red Laser Beam & Maintenance Spark Particle System
    this.roverLaserGroup = new THREE.Group();
    this.roverLaserGroup.visible = false;

    const beamGeo = this.track(new THREE.CylinderGeometry(0.022, 0.022, 1, 8));
    const coreBeamMat = this.track(
      new THREE.MeshBasicMaterial({
        color: '#FF3B3B',
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.roverLaserCore = new THREE.Mesh(beamGeo, coreBeamMat);
    this.roverLaserGroup.add(this.roverLaserCore);

    const glowBeamGeo = this.track(new THREE.CylinderGeometry(0.065, 0.065, 1, 8));
    const glowBeamMat = this.track(
      new THREE.MeshBasicMaterial({
        color: '#FF6B6B',
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.roverLaserGlow = new THREE.Mesh(glowBeamGeo, glowBeamMat);
    this.roverLaserGroup.add(this.roverLaserGlow);

    const impactMat = this.track(
      new THREE.MeshBasicMaterial({
        color: '#FCA5A5',
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.roverImpactSpot = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.15, 10, 10)),
      impactMat
    );
    this.roverLaserGroup.add(this.roverImpactSpot);

    this.roverImpactLight = new THREE.PointLight('#FF2A2A', 2.4, 6.5, 1.5);
    this.roverLaserGroup.add(this.roverImpactLight);

    const sparkCount = 24;
    this.roverSparkPositions = new Float32Array(sparkCount * 3);
    this.roverSparkVelocities = [];
    for (let i = 0; i < sparkCount; i++) {
      const ang = (i / sparkCount) * Math.PI * 2;
      this.roverSparkVelocities.push({
        vx: Math.cos(ang) * (0.9 + (i % 3) * 0.45),
        vy: 0.8 + (i % 4) * 0.55,
        vz: Math.sin(ang) * (0.9 + (i % 3) * 0.45),
        life: (i / sparkCount),
      });
    }
    const sparkGeo = this.track(new THREE.BufferGeometry());
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.roverSparkPositions, 3));
    const sparkMat = this.track(
      new THREE.PointsMaterial({
        color: '#FF6B4A',
        size: 0.16,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.roverSparksPoints = new THREE.Points(sparkGeo, sparkMat);
    this.roverSparksPoints.frustumCulled = false;
    this.roverLaserGroup.add(this.roverSparksPoints);

    this.scene.add(this.roverLaserGroup);
  }

  private buildHazardsAndRings(): void {
    const ringGeo = this.track(new THREE.RingGeometry(2.85, 3.25, 36));
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = this.track(
      new THREE.MeshBasicMaterial({
        color: '#22D3EE',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      })
    );
    this.targetRing = new THREE.Mesh(ringGeo, ringMat);
    this.scene.add(this.targetRing);

    const hoverGeo = this.track(new THREE.RingGeometry(2.6, 2.82, 36));
    hoverGeo.rotateX(-Math.PI / 2);
    const hoverMat = this.track(
      new THREE.MeshBasicMaterial({
        color: '#FBBF24',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      })
    );
    this.hoverRing = new THREE.Mesh(hoverGeo, hoverMat);
    this.hoverRing.visible = false;
    this.scene.add(this.hoverRing);

    // Subtle wind-blown Martian dust particles using soft radial sprite
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const dustSprite = this.track(createDustParticleSpriteTexture());
    const dustCount = 220;
    this.dustPositions = new Float32Array(dustCount * 3);
    let seed = 211;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < dustCount; i++) {
      this.dustPositions[i * 3] = (rand() - 0.5) * 38;
      this.dustPositions[i * 3 + 1] = 0.4 + rand() * 6.2;
      this.dustPositions[i * 3 + 2] = (rand() - 0.5) * 28;
    }
    const dustGeo = this.track(new THREE.BufferGeometry());
    dustGeo.setAttribute('position', new THREE.BufferAttribute(this.dustPositions, 3));
    this.dustStormMat = this.track(
      new THREE.PointsMaterial({
        map: dustSprite,
        color: '#E5B494',
        size: 0.55,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      })
    );
    this.dustStormPoints = new THREE.Points(dustGeo, this.dustStormMat);
    this.scene.add(this.dustStormPoints);

    // Animated 3D low-opacity dust-mote sheets drifting across the ground with the wind
    const dustSheetTex = this.track(createDustSheetTexture(maxAniso));
    const sheetGeo = this.track(new THREE.PlaneGeometry(14, 5.2));
    this.dustSheets = [];
    const sheetConfigs = [
      { x: -12, y: 0.65, z: 5.2, speed: 1.35, phase: 0.2, tiltX: -Math.PI * 0.42 },
      { x: 4, y: 0.85, z: 3.1, speed: 1.15, phase: 1.4, tiltX: -Math.PI * 0.44 },
      { x: -4, y: 1.05, z: -2.6, speed: 1.5, phase: 2.7, tiltX: -Math.PI * 0.41 },
      { x: 11, y: 0.72, z: -6.4, speed: 1.25, phase: 3.9, tiltX: -Math.PI * 0.43 },
      { x: -16, y: 1.35, z: 1.2, speed: 1.65, phase: 4.8, tiltX: -Math.PI * 0.39 },
      { x: 0, y: 0.58, z: 7.4, speed: 1.1, phase: 5.5, tiltX: -Math.PI * 0.45 },
    ];
    sheetConfigs.forEach((cfg) => {
      const sheetMat = this.track(
        new THREE.MeshBasicMaterial({
          map: dustSheetTex,
          color: '#E7BC9E',
          transparent: true,
          opacity: 0.14,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      const sheetMesh = new THREE.Mesh(sheetGeo, sheetMat);
      sheetMesh.position.set(cfg.x, groundHeightAt(cfg.x, cfg.z) + cfg.y, cfg.z);
      sheetMesh.rotation.set(cfg.tiltX, 0.08, 0);
      sheetMesh.renderOrder = 3;
      this.scene.add(sheetMesh);
      this.dustSheets.push({
        mesh: sheetMesh,
        mat: sheetMat,
        baseY: cfg.y,
        speed: cfg.speed,
        phase: cfg.phase,
        z: cfg.z,
      });
    });

    // Solar Flare & CME Radiation Particle Streaks (atmospheric + dome-targeted)
    this.flareBoltsGroup = new THREE.Group();
    this.flareBoltsGroup.visible = false;
    const boltGeo = this.track(new THREE.CylinderGeometry(0.038, 0.014, 2.35, 6));
    const streakCount = 32;
    for (let i = 0; i < streakCount; i++) {
      const boltMat = this.track(
        new THREE.MeshBasicMaterial({
          color: '#FB7185',
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      const bolt = new THREE.Mesh(boltGeo, boltMat);
      const angle = (i / streakCount) * Math.PI * 2;
      const skyStreak = i >= 14;
      const radius = skyStreak ? 4.5 + (i % 7) * 2.4 : 0.6 + (i % 4) * 0.78;
      bolt.position.set(
        0.9 + Math.cos(angle) * radius + (skyStreak ? 2.5 : 1.8),
        10.5 + (i % 6) * 2.1,
        1.0 + Math.sin(angle) * radius - (skyStreak ? 2.0 : 1.0)
      );
      const vel = new THREE.Vector3(-0.34, -1.0, 0.16).normalize();
      bolt.quaternion.setFromUnitVectors(this.streakUpAxis, vel);
      this.flareBoltsGroup.add(bolt);
      this.flareBolts.push({
        mesh: bolt,
        mat: boltMat,
        vel,
        speed: 12 + (i % 5) * 2.4,
        angle,
        radius,
        deflected: false,
        skyStreak,
      });
    }
    this.scene.add(this.flareBoltsGroup);
  }

  public updateMissionVisuals(
    resources: MissionResources,
    tau: number,
    targetModule: ModuleId | 'any',
    emergencyMode: EmergencyMode = 'none',
    timeline?: AtmosphereTimelineInput
  ): void {
    this.resources = resources;
    this.currentTau = tau;
    this.highlightedTarget = targetModule;
    this.emergencyMode = emergencyMode;

    if (timeline) {
      this.targetAtmosphere = timeline.atmosphere;
      this.targetHazardType = timeline.hazardType;
      this.activeSystemGlow = timeline.activeSystemGlow;
      this.simSpeedMultiplier = Math.max(1, timeline.speedMultiplier || 1);
      if (timeline.donki) {
        this.donkiTelemetry = timeline.donki;
      }
    } else {
      this.targetAtmosphere = {
        solProgress: 0,
        crisisIntensity: emergencyMode !== 'none' ? 0.65 : 0.15,
        effectiveTau: tau,
        fogDensity: computeTauFogDensity(tau, emergencyMode),
        sunElevation: 0.95,
        nightFactor: 0,
      };
    }

    this.syncVisualState();
  }

  private syncVisualState(): void {
    if (!this.waterShieldMesh) return;

    const wallRatio = THREE.MathUtils.clamp((this.resources.waterWallCm - 8) / 28, 0, 1);
    const shieldScale = 0.96 + wallRatio * 0.16;
    if (!this.activePulse || this.activePulse.moduleId !== 'shelter') {
      this.waterShieldMesh.scale.set(shieldScale, shieldScale, shieldScale);
    }
    if (this.isSoftwareGl) {
      this.waterShieldMat.opacity = 0.24 + wallRatio * 0.38;
    } else {
      this.waterShieldMat.transmission = 0.68 - wallRatio * 0.16;
    }

    const dustRatio = THREE.MathUtils.clamp(this.resources.panelDustPct / 85, 0, 1);
    this.solarDustMat.opacity = THREE.MathUtils.clamp(dustRatio * 0.86, 0.03, 0.88);
    if (this.habitatDustMat) {
      const stormBoost = this.smoothedEffectiveTau >= 0.85 ? 0.28 : 0;
      const baseDust = Math.max(0, dustRatio - 0.12) * 0.65;
      this.habitatDustMat.opacity = THREE.MathUtils.clamp(baseDust + stormBoost, 0.04, 0.78);
    }

    const cropScale = 0.55 + (this.resources.cropGrowth - 1) * 0.24;
    for (let i = 0; i < this.biodomeCrops.length; i++) {
      const s = cropScale * (i % 2 === 0 ? 1.0 : 0.86);
      this.biodomeCrops[i].scale.set(s, s * 1.12, s);
    }

    if (this.highlightedTarget === 'any') {
      this.targetRing.visible = false;
    } else {
      this.targetRing.visible = true;
      const center = this.moduleWorldCenters[this.highlightedTarget];
      this.targetRing.position.set(center.x, center.y + 0.07, center.z);
    }

    if (this.fog && this.totalTime === 0) {
      this.fog.density = this.targetAtmosphere.fogDensity;
      this.smoothedSolProgress = this.targetAtmosphere.solProgress;
      this.smoothedCrisisIntensity = this.targetAtmosphere.crisisIntensity;
      this.smoothedEffectiveTau = this.targetAtmosphere.effectiveTau;
      this.smoothedSunElevation = this.targetAtmosphere.sunElevation;
      this.smoothedNightFactor = this.targetAtmosphere.nightFactor;
    }
  }

  public triggerModuleFeedback(moduleId: ModuleId): void {
    this.activePulse = {
      moduleId,
      startTimeMs: performance.now(),
      duration: 1.25,
    };
    this.moduleBoostTimers[moduleId] = performance.now() + 6500;
    if (moduleId === 'shelter') {
      this.shieldBoostUntilMs = performance.now() + 11000;
      this.shieldImpactPulse = Math.max(this.shieldImpactPulse, 0.9);
    }
  }

  public triggerNightCycle(
    hazardType: SolHazardType,
    shieldBlockedFlare: boolean,
    onComplete: () => void,
    durationSec = 3.0
  ): void {
    if (this.nightAnim.active) return;
    this.nightAnim = {
      active: true,
      startTimeMs: performance.now(),
      duration: Math.max(0.5, durationSec),
      hazardType,
      shieldBlockedFlare,
      completed: false,
      onComplete,
    };
    if (hazardType === 'flare') {
      this.flareBoltsGroup.visible = true;
      for (let i = 0; i < this.flareBolts.length; i++) {
        const b = this.flareBolts[i];
        b.mesh.position.set(
          Math.cos(b.angle) * b.radius,
          7 + (i % 4) * 1.6,
          Math.sin(b.angle) * b.radius
        );
        b.mesh.rotation.set(0, 0, 0);
        b.deflected = false;
      }
    }
  }

  private bindEvents(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.handlePointerDown);
    dom.addEventListener('pointerup', this.handlePointerUp);
    dom.addEventListener('pointermove', this.handlePointerMove);
    dom.addEventListener('webglcontextlost', this.handleContextLost);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleWindowBlur);
  }

  private handleWindowBlur = (): void => {
    this.flushInteriorInputStep();
    this.flushEvaInputStep();
    this.pressedKeys.clear();
    this.isDraggingInteriorLook = false;
    this.isDraggingEvaLook = false;
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (this.viewMode === 'exterior') return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (this.viewMode === 'interior') {
      if (!this.pressedKeys.has(e.code)) {
        this.flushInteriorInputStep();
        this.pressedKeys.add(e.code);
      }

      if (e.code === 'KeyE' && !e.repeat && !this.interiorInputPaused) {
        const nearest = this.computeNearestInteriorInteractable();
        if (nearest) {
          e.preventDefault();
          this.interiorWorld?.triggerStationFeedback(nearest.interactable.id);
          this.callbacks.onInteriorInteract?.(nearest.interactable.id);
        }
      }
      return;
    }

    if (this.viewMode === 'eva') {
      if (!this.pressedKeys.has(e.code)) {
        this.flushEvaInputStep();
        this.pressedKeys.add(e.code);
      }

      if (e.code === 'KeyE' && !e.repeat && !this.evaInputPaused) {
        const nearest = this.computeNearestEvaInteractable();
        if (nearest) {
          e.preventDefault();
          this.callbacks.onEvaInteract?.(nearest.interactable.id);
        }
      }
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (this.pressedKeys.has(e.code)) {
      if (this.viewMode === 'interior') this.flushInteriorInputStep();
      else if (this.viewMode === 'eva') this.flushEvaInputStep();
      this.pressedKeys.delete(e.code);
    }
  };

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
    this.callbacks.onWebglError?.('3D WebGL context was interrupted.');
  };

  private applyResponsiveCamera(width: number, height: number, resetPos = false): void {
    const aspect = width / height;
    const isPortrait = aspect < 1.0;
    this.camera.fov = isPortrait ? 65 : 46;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    if (this.interiorCamera) {
      this.interiorCamera.fov = isPortrait ? 72 : 62;
      this.interiorCamera.aspect = aspect;
      this.interiorCamera.updateProjectionMatrix();
    }
    if (this.evaCamera) {
      this.evaCamera.fov = isPortrait ? 72 : 62;
      this.evaCamera.aspect = aspect;
      this.evaCamera.updateProjectionMatrix();
    }
    if (resetPos) {
      if (isPortrait) {
        this.camera.position.set(0, 7.6, 30.5);
        this.controls?.target.set(0, 2.4, -4.5);
      } else {
        this.camera.position.set(0, 4.45, 21.8);
        this.controls?.target.set(0, 2.85, -5.5);
      }
    }
  }

  private handleResize = (): void => {
    if (this.destroyed || !this.renderer) return;
    const width = Math.max(this.container.clientWidth || window.innerWidth, 320);
    const height = Math.max(this.container.clientHeight || window.innerHeight, 320);
    this.applyResponsiveCamera(width, height, true);
    this.controls.update();
    this.renderer.setSize(width, height);
    this.composer?.setSize(width, height);
    this.bloomPass?.resolution.set(width, height);
    this.renderCurrentView();
    if (this.viewMode === 'exterior') {
      this.emitProjectedAnchors();
    }
  };

  public deployRover(target: RoverMissionTarget): boolean {
    if (this.roverPhase !== 'idle' || !this.roverGroup) return false;

    const targetCenter =
      target.kind === 'rock'
        ? this.rockWorldCenters[target.rockId]
        : this.moduleWorldCenters[target.moduleId];
    if (!targetCenter) return false;

    this.roverMissionTarget = target;
    this.roverMissionNotified = false;
    this.roverStartPos.copy(this.roverHomePos);

    const standOff = target.kind === 'rock' ? 1.55 : target.kind === 'solar' ? 3.2 : 2.35;
    const toTargetX = targetCenter.x - this.roverHomePos.x;
    const toTargetZ = targetCenter.z - this.roverHomePos.z;
    const dist = Math.max(0.01, Math.hypot(toTargetX, toTargetZ));
    const stopDist = Math.max(0.4, dist - standOff);

    const stopX = this.roverHomePos.x + (toTargetX / dist) * stopDist;
    const stopZ = this.roverHomePos.z + (toTargetZ / dist) * stopDist;
    this.roverStopPos.set(stopX, groundHeightAt(stopX, stopZ), stopZ);

    const aimYOffset = target.kind === 'rock' ? 0.45 : target.kind === 'solar' ? 1.15 : 1.05;
    this.roverAimPos.set(targetCenter.x, targetCenter.y + aimYOffset, targetCenter.z);

    this.roverPhase = 'outbound';
    this.roverPhaseElapsed = 0;
    this.roverPhaseStartMs = performance.now();
    this.callbacks.onRoverPhaseChange?.('outbound', target.label);
    return true;
  }

  public getRoverPhase(): RoverPhase {
    return this.roverPhase;
  }

  private updatePointerNdc(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private pickTarget(e: PointerEvent): {
    moduleId: ModuleId | null;
    rockId: ScienceBoulderId | null;
    rockLabel: string | null;
  } {
    this.updatePointerNdc(e);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(this.hitColliders, false);
    if (hits.length === 0) return { moduleId: null, rockId: null, rockLabel: null };
    const ud = hits[0].object.userData;
    return {
      moduleId: (ud.moduleId as ModuleId) ?? null,
      rockId: (ud.rockId as ScienceBoulderId) ?? null,
      rockLabel: (ud.rockLabel as string) ?? null,
    };
  }

  public beginCameraTransitionTo(
    mode: SceneViewMode,
    onMidpoint: () => void,
    evaSpawnSource: 'hud' | 'airlock' = 'hud'
  ): void {
    if (this.viewMode === mode) return;
    if (mode === 'interior') {
      if (this.viewMode === 'eva') {
        onMidpoint();
        return;
      }
      this.savedOverviewCamPos.copy(this.camera.position);
      this.savedOverviewTarget.copy(this.controls.target);
      this.controls.enabled = false;
      this.cameraTransition.active = true;
      this.cameraTransition.phase = 'to_airlock';
      this.cameraTransition.elapsed = 0;
      this.cameraTransition.duration = this.isSoftwareGl ? 0.14 : 0.44;
      this.cameraTransition.targetPos.set(0.9, 1.85, 6.2);
      this.cameraTransition.targetLook.set(0.9, 1.35, 2.8);
      this.cameraTransition.onComplete = onMidpoint;
    } else if (mode === 'eva') {
      if (this.viewMode === 'interior') {
        onMidpoint();
        return;
      }
      this.savedOverviewCamPos.copy(this.camera.position);
      this.savedOverviewTarget.copy(this.controls.target);
      const spawn = evaSpawnSource === 'airlock' ? EVA_AIRLOCK_SPAWN : EVA_HUD_SPAWN;
      const spawnY = groundHeightAt(spawn.x, spawn.z) + 1.75;
      this.controls.enabled = false;
      this.cameraTransition.active = true;
      this.cameraTransition.phase = 'to_airlock';
      this.cameraTransition.elapsed = 0;
      this.cameraTransition.duration = this.isSoftwareGl ? 0.14 : 0.42;
      this.cameraTransition.targetPos.set(spawn.x, spawnY, spawn.z);
      this.cameraTransition.targetLook.set(
        spawn.x - Math.sin(spawn.yaw) * 6.0,
        spawnY - 0.15,
        spawn.z - Math.cos(spawn.yaw) * 6.0
      );
      this.cameraTransition.onComplete = onMidpoint;
    } else {
      if (this.viewMode === 'eva') {
        this.camera.position.set(
          this.evaPlayer.x,
          Math.max(2.0, this.evaPlayer.y + 0.6),
          this.evaPlayer.z + 1.2
        );
        this.controls.target.set(
          this.evaPlayer.x - Math.sin(this.evaPlayer.yaw) * 4,
          1.4,
          this.evaPlayer.z - Math.cos(this.evaPlayer.yaw) * 4
        );
      } else {
        this.camera.position.set(0.9, 2.15, 7.6);
        this.controls.target.set(0.9, 1.45, 2.6);
      }
      onMidpoint();
      this.controls.enabled = false;
      this.cameraTransition.active = true;
      this.cameraTransition.phase = 'to_overview';
      this.cameraTransition.elapsed = 0;
      this.cameraTransition.duration = this.isSoftwareGl ? 0.18 : 0.52;
      this.cameraTransition.targetPos.copy(this.savedOverviewCamPos);
      this.cameraTransition.targetLook.copy(this.savedOverviewTarget);
      this.cameraTransition.onComplete = null;
    }
  }

  public cancelCameraTransition(): void {
    this.cameraTransition.active = false;
    this.cameraTransition.onComplete = null;
    if (this.controls) {
      this.controls.enabled = this.viewMode === 'exterior';
    }
  }

  public setViewMode(mode: SceneViewMode, evaSpawnSource: 'hud' | 'airlock' = 'hud'): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.pressedKeys.clear();
    this.isDraggingInteriorLook = false;
    this.isDraggingEvaLook = false;
    this.hoverRing.visible = false;
    this.hoveredModule = null;
    this.hoveredRock = null;

    // Safely detach both PointerLockControls before connecting the active one
    this.unlockInteriorPointer();
    this.unlockEvaPointer();
    this.pointerLockControls?.disconnect();
    this.evaPointerLockControls?.disconnect();

    if (mode === 'interior') {
      this.controls.enabled = false;
      this.pointerLockControls?.connect(this.renderer.domElement);
      this.interiorPlayer = {
        x: INTERIOR_SPAWN.x,
        z: INTERIOR_SPAWN.z,
        yaw: INTERIOR_SPAWN.yaw,
        pitch: 0,
        walkDistance: 0,
        bobOffset: 0,
      };
      this.interiorCamera.position.set(
        this.interiorPlayer.x,
        INTERIOR_EYE_HEIGHT,
        this.interiorPlayer.z
      );
      this.interiorCamera.rotation.set(0, INTERIOR_SPAWN.yaw, 0, 'YXZ');
      this.renderer.domElement.style.cursor = 'crosshair';
      this.interiorWorld.update(0.016, {
        resources: this.resources,
        emergencyActive: this.emergencyMode !== 'none',
        moxieCrisisActive:
          this.emergencyMode !== 'none' ||
          this.targetHazardType !== 'none' ||
          this.resources.lifeSupportPct < 65 ||
          this.donkiTelemetry.level !== 'quiet',
        skyColor: this.skyColor,
        zenithColor: this.zenithColor,
        nightFactor: this.smoothedNightFactor,
      });
      this.emitInteriorState(true);
    } else if (mode === 'eva') {
      this.controls.enabled = false;
      this.evaPointerLockControls?.connect(this.renderer.domElement);
      const spawn = evaSpawnSource === 'airlock' ? EVA_AIRLOCK_SPAWN : EVA_HUD_SPAWN;
      this.evaPlayer = createInitialEvaState(groundHeightAt, spawn);
      this.virtualEvaInput = { forward: 0, right: 0, turn: 0 };
      this.evaCamera.position.set(this.evaPlayer.x, this.evaPlayer.y, this.evaPlayer.z);
      this.evaCamera.rotation.set(0, this.evaPlayer.yaw, 0, 'YXZ');
      this.renderer.domElement.style.cursor = 'crosshair';
      this.emitEvaState(true);
    } else {
      this.controls.enabled = !this.cameraTransition.active;
      this.renderer.domElement.style.cursor = 'grab';
      this.emitProjectedAnchors();
    }

    this.lastInteriorMoveTime = performance.now();
    this.lastEvaMoveTime = performance.now();
    if (mode === 'exterior') {
      this.controls.update();
    }
    this.renderCurrentView();

    this.callbacks.onViewModeChange?.(mode);
  }

  public getViewMode(): SceneViewMode {
    return this.viewMode;
  }

  public setInteriorInputPaused(paused: boolean): void {
    this.interiorInputPaused = paused;
    if (paused) {
      this.pressedKeys.clear();
      this.isDraggingInteriorLook = false;
      this.virtualInteriorInput = { forward: 0, right: 0, turn: 0 };
      this.unlockInteriorPointer();
    }
    this.lastInteriorMoveTime = performance.now();
  }

  public setEvaInputPaused(paused: boolean): void {
    this.evaInputPaused = paused;
    if (paused) {
      this.pressedKeys.clear();
      this.isDraggingEvaLook = false;
      this.virtualEvaInput = { forward: 0, right: 0, turn: 0 };
      this.unlockEvaPointer();
    }
    this.lastEvaMoveTime = performance.now();
  }

  public unlockInteriorPointer(): void {
    try {
      if (this.pointerLockControls?.isLocked) {
        this.pointerLockControls.unlock();
      }
    } catch {
      // Ignore pointer lock API restrictions
    }
  }

  public unlockEvaPointer(): void {
    try {
      if (this.evaPointerLockControls?.isLocked) {
        this.evaPointerLockControls.unlock();
      }
    } catch {
      // Ignore pointer lock API restrictions
    }
  }

  public setVirtualInteriorInput(input: { forward: number; right: number; turn: number }): void {
    this.flushInteriorInputStep();
    this.virtualInteriorInput = input;
  }

  public setVirtualEvaInput(input: { forward: number; right: number; turn: number }): void {
    this.flushEvaInputStep();
    this.virtualEvaInput = input;
  }

  public triggerInteriorFeedback(id: InteriorInteractableId): void {
    this.interiorWorld?.triggerStationFeedback(id);
  }

  private syncYawPitchFromCamera(): void {
    if (!this.interiorCamera) return;
    this.interiorPlayer.yaw = this.interiorCamera.rotation.y;
    this.interiorPlayer.pitch = THREE.MathUtils.clamp(
      this.interiorCamera.rotation.x,
      -Math.PI * 0.42,
      Math.PI * 0.42
    );
  }

  private syncEvaYawPitchFromCamera(): void {
    if (!this.evaCamera) return;
    this.evaPlayer.yaw = this.evaCamera.rotation.y;
    this.evaPlayer.pitch = THREE.MathUtils.clamp(
      this.evaCamera.rotation.x,
      -Math.PI * 0.42,
      Math.PI * 0.42
    );
  }

  private computeNearestInteriorInteractable(): {
    interactable: InteriorInteractable;
    distance: number;
  } | null {
    const yaw = this.pointerLockControls?.isLocked
      ? this.interiorCamera.rotation.y
      : this.interiorPlayer.yaw;
    const lookX = -Math.sin(yaw);
    const lookZ = -Math.cos(yaw);
    return findNearestInteractable(
      this.interiorPlayer.x,
      this.interiorPlayer.z,
      lookX,
      lookZ
    );
  }

  private computeNearestEvaInteractable(): {
    interactable: EvaInteractable;
    distance: number;
  } | null {
    const yaw = this.evaPointerLockControls?.isLocked
      ? this.evaCamera.rotation.y
      : this.evaPlayer.yaw;
    const lookX = -Math.sin(yaw);
    const lookZ = -Math.cos(yaw);
    const roverPos = this.roverGroup
      ? { x: this.roverGroup.position.x, z: this.roverGroup.position.z }
      : { x: this.roverHomePos.x, z: this.roverHomePos.z };
    return findNearestEvaInteractable(
      this.evaPlayer.x,
      this.evaPlayer.z,
      lookX,
      lookZ,
      roverPos
    );
  }

  private emitInteriorState(force = false): void {
    const zone = getInteriorZoneAt(this.interiorPlayer.x, this.interiorPlayer.z);
    const nearest = this.computeNearestInteriorInteractable();
    const nearestId = nearest?.interactable.id ?? null;
    const locked = Boolean(this.pointerLockControls?.isLocked);

    if (
      force ||
      zone.id !== this.lastInteriorZoneId ||
      nearestId !== this.lastInteriorPromptId ||
      locked !== this.lastInteriorLocked
    ) {
      this.lastInteriorZoneId = zone.id;
      this.lastInteriorPromptId = nearestId;
      this.lastInteriorLocked = locked;
      this.interiorWorld?.setHighlightedInteractable(nearestId);
      this.callbacks.onInteriorStateUpdate?.({
        zone,
        nearestInteractable: nearest?.interactable ?? null,
        pointerLocked: locked,
      });
    }
  }

  private emitEvaState(force = false): void {
    const nearest = this.computeNearestEvaInteractable();
    const nearestId = nearest?.interactable.id ?? null;
    const locked = Boolean(this.evaPointerLockControls?.isLocked);

    if (force || nearestId !== this.lastEvaPromptId || locked !== this.lastEvaLocked) {
      this.lastEvaPromptId = nearestId;
      this.lastEvaLocked = locked;
      this.callbacks.onEvaStateUpdate?.({
        nearestInteractable: nearest?.interactable ?? null,
        pointerLocked: locked,
      });
    }
  }

  private flushInteriorInputStep(now = performance.now()): void {
    if (this.viewMode !== 'interior' || this.interiorInputPaused) {
      this.lastInteriorMoveTime = now;
      return;
    }
    const elapsedSec = Math.min(2.0, Math.max(0, (now - this.lastInteriorMoveTime) / 1000));
    this.lastInteriorMoveTime = now;
    if (elapsedSec > 0.0005) {
      this.updateInteriorMovement(elapsedSec);
    }
  }

  private flushEvaInputStep(now = performance.now()): void {
    if (this.viewMode !== 'eva' || this.evaInputPaused) {
      this.lastEvaMoveTime = now;
      return;
    }
    const elapsedSec = Math.min(2.0, Math.max(0, (now - this.lastEvaMoveTime) / 1000));
    this.lastEvaMoveTime = now;
    if (elapsedSec > 0.0005) {
      this.updateEvaMovement(elapsedSec);
    }
  }

  private updateEvaMovement(totalDt: number): void {
    if (this.viewMode !== 'eva' || this.evaInputPaused) return;

    const subSteps = Math.max(1, Math.ceil(totalDt / 0.05));
    const stepDt = totalDt / subSteps;

    const fwdKey =
      (this.pressedKeys.has('KeyW') || this.pressedKeys.has('ArrowUp') ? 1 : 0) -
      (this.pressedKeys.has('KeyS') || this.pressedKeys.has('ArrowDown') ? 1 : 0);
    const strafeKey =
      (this.pressedKeys.has('KeyD') || this.pressedKeys.has('ArrowRight') ? 1 : 0) -
      (this.pressedKeys.has('KeyA') || this.pressedKeys.has('ArrowLeft') ? 1 : 0);

    const moveForward = THREE.MathUtils.clamp(fwdKey + this.virtualEvaInput.forward, -1, 1);
    const moveRight = THREE.MathUtils.clamp(strafeKey + this.virtualEvaInput.right, -1, 1);
    const roverPos = this.roverGroup
      ? { x: this.roverGroup.position.x, z: this.roverGroup.position.z }
      : { x: this.roverHomePos.x, z: this.roverHomePos.z };

    for (let s = 0; s < subSteps; s++) {
      if (this.evaPointerLockControls?.isLocked) {
        this.syncEvaYawPitchFromCamera();
      }

      this.evaPlayer = stepEvaPhysics(
        this.evaPlayer,
        {
          forward: moveForward,
          right: moveRight,
          turn: this.evaPointerLockControls?.isLocked ? 0 : this.virtualEvaInput.turn,
        },
        stepDt,
        groundHeightAt,
        this.evaObstacles,
        roverPos
      );

      if (!this.evaPointerLockControls?.isLocked) {
        this.evaCamera.rotation.set(
          this.evaPlayer.pitch,
          this.evaPlayer.yaw,
          this.evaPlayer.strafeTilt,
          'YXZ'
        );
      } else {
        this.evaCamera.rotation.z = this.evaPlayer.strafeTilt;
      }
    }

    this.evaCamera.position.set(this.evaPlayer.x, this.evaPlayer.y, this.evaPlayer.z);
    this.emitEvaState(false);
  }

  private updateInteriorMovement(totalDt: number): void {
    if (this.viewMode !== 'interior' || this.interiorInputPaused) return;

    const subSteps = Math.max(1, Math.ceil(totalDt / 0.05));
    const stepDt = totalDt / subSteps;

    const fwdKey =
      (this.pressedKeys.has('KeyW') || this.pressedKeys.has('ArrowUp') ? 1 : 0) -
      (this.pressedKeys.has('KeyS') || this.pressedKeys.has('ArrowDown') ? 1 : 0);
    const strafeKey =
      (this.pressedKeys.has('KeyD') || this.pressedKeys.has('ArrowRight') ? 1 : 0) -
      (this.pressedKeys.has('KeyA') || this.pressedKeys.has('ArrowLeft') ? 1 : 0);

    const moveForward = THREE.MathUtils.clamp(fwdKey + this.virtualInteriorInput.forward, -1, 1);
    const moveRight = THREE.MathUtils.clamp(strafeKey + this.virtualInteriorInput.right, -1, 1);

    for (let s = 0; s < subSteps; s++) {
      if (this.pointerLockControls?.isLocked) {
        this.syncYawPitchFromCamera();
      } else if (this.virtualInteriorInput.turn !== 0) {
        this.interiorPlayer.yaw -= this.virtualInteriorInput.turn * stepDt * 2.1;
        this.interiorCamera.rotation.set(
          this.interiorPlayer.pitch,
          this.interiorPlayer.yaw,
          0,
          'YXZ'
        );
      }

      if (Math.abs(moveForward) > 0.01 || Math.abs(moveRight) > 0.01) {
        const len = Math.hypot(moveForward, moveRight);
        const nf = len > 1 ? moveForward / len : moveForward;
        const nr = len > 1 ? moveRight / len : moveRight;

        const yaw = this.interiorPlayer.yaw;
        const fwdX = -Math.sin(yaw);
        const fwdZ = -Math.cos(yaw);
        const rightX = Math.cos(yaw);
        const rightZ = -Math.sin(yaw);

        const speed = 4.8;
        const dx = (fwdX * nf + rightX * nr) * speed * stepDt;
        const dz = (fwdZ * nf + rightZ * nr) * speed * stepDt;

        const prevX = this.interiorPlayer.x;
        const prevZ = this.interiorPlayer.z;
        const clamped = clampInteriorPlayerPosition(prevX, prevZ, prevX + dx, prevZ + dz);
        this.interiorPlayer.x = clamped.x;
        this.interiorPlayer.z = clamped.z;

        const stepDist = Math.hypot(clamped.x - prevX, clamped.z - prevZ);
        if (stepDist > 0.0005) {
          this.interiorPlayer.walkDistance += stepDist;
          this.interiorPlayer.bobOffset = Math.sin(this.interiorPlayer.walkDistance * 2.2) * 0.042;
        } else {
          this.interiorPlayer.bobOffset = THREE.MathUtils.lerp(
            this.interiorPlayer.bobOffset,
            0,
            Math.min(1, stepDt * 10)
          );
        }
      } else {
        this.interiorPlayer.bobOffset = THREE.MathUtils.lerp(
          this.interiorPlayer.bobOffset,
          0,
          Math.min(1, stepDt * 10)
        );
      }
    }

    this.interiorCamera.position.set(
      this.interiorPlayer.x,
      INTERIOR_EYE_HEIGHT + this.interiorPlayer.bobOffset,
      this.interiorPlayer.z
    );

    this.emitInteriorState(false);
  }

  private handlePointerDown = (e: PointerEvent): void => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
    if (this.viewMode === 'interior' && !this.interiorInputPaused && !this.pointerLockControls?.isLocked) {
      this.isDraggingInteriorLook = true;
      this.lastDragLookPos = { x: e.clientX, y: e.clientY };
    } else if (this.viewMode === 'eva' && !this.evaInputPaused && !this.evaPointerLockControls?.isLocked) {
      this.isDraggingEvaLook = true;
      this.lastDragLookPos = { x: e.clientX, y: e.clientY };
    }
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (this.viewMode === 'interior') {
      if (this.isDraggingInteriorLook && !this.pointerLockControls?.isLocked && !this.interiorInputPaused) {
        const dx = e.clientX - this.lastDragLookPos.x;
        const dy = e.clientY - this.lastDragLookPos.y;
        this.lastDragLookPos = { x: e.clientX, y: e.clientY };
        this.interiorPlayer.yaw -= dx * 0.0042;
        this.interiorPlayer.pitch = THREE.MathUtils.clamp(
          this.interiorPlayer.pitch - dy * 0.0036,
          -Math.PI * 0.42,
          Math.PI * 0.42
        );
        this.interiorCamera.rotation.set(
          this.interiorPlayer.pitch,
          this.interiorPlayer.yaw,
          0,
          'YXZ'
        );
        this.emitInteriorState(false);
      }
      return;
    }

    if (this.viewMode === 'eva') {
      if (this.isDraggingEvaLook && !this.evaPointerLockControls?.isLocked && !this.evaInputPaused) {
        const dx = e.clientX - this.lastDragLookPos.x;
        const dy = e.clientY - this.lastDragLookPos.y;
        this.lastDragLookPos = { x: e.clientX, y: e.clientY };
        this.evaPlayer.yaw -= dx * 0.0042;
        this.evaPlayer.pitch = THREE.MathUtils.clamp(
          this.evaPlayer.pitch - dy * 0.0036,
          -Math.PI * 0.42,
          Math.PI * 0.42
        );
        this.evaCamera.rotation.set(
          this.evaPlayer.pitch,
          this.evaPlayer.yaw,
          this.evaPlayer.strafeTilt,
          'YXZ'
        );
        this.emitEvaState(false);
      }
      return;
    }

    if (this.nightAnim.active) return;
    const { moduleId, rockId } = this.pickTarget(e);
    if (moduleId !== this.hoveredModule || rockId !== this.hoveredRock) {
      this.hoveredModule = moduleId;
      this.hoveredRock = rockId;
      this.renderer.domElement.style.cursor = moduleId || rockId ? 'pointer' : 'grab';
      if (moduleId) {
        const center = this.moduleWorldCenters[moduleId];
        this.hoverRing.position.set(center.x, center.y + 0.08, center.z);
        this.hoverRing.visible = true;
      } else if (rockId && this.rockWorldCenters[rockId]) {
        const center = this.rockWorldCenters[rockId]!;
        this.hoverRing.position.set(center.x, center.y + 0.08, center.z);
        this.hoverRing.visible = true;
      } else {
        this.hoverRing.visible = false;
      }

      (Object.keys(this.rockRings) as ScienceBoulderId[]).forEach((id) => {
        const ring = this.rockRings[id];
        if (ring) {
          const mat = ring.material as THREE.MeshBasicMaterial;
          mat.opacity = id === rockId ? 0.85 : 0.32;
          mat.color.set(id === rockId ? '#FBBF24' : '#22D3EE');
        }
      });

      this.callbacks.onHoverModule(moduleId);
      this.callbacks.onHoverRock?.(rockId);
    }
  };

  private handlePointerUp = (e: PointerEvent): void => {
    this.isDraggingInteriorLook = false;
    this.isDraggingEvaLook = false;
    const travel = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
    if (travel > 6) return;

    if (this.viewMode === 'interior') {
      if (this.interiorInputPaused) return;
      this.updatePointerNdc(e);
      this.raycaster.setFromCamera(this.pointerNdc, this.interiorCamera);
      const hits = this.raycaster.intersectObjects(this.interiorWorld.interactableColliders, false);
      if (hits.length > 0 && hits[0].distance <= 4.5) {
        const id = hits[0].object.userData.interactableId as InteriorInteractableId | undefined;
        if (id) {
          this.interiorWorld.triggerStationFeedback(id);
          this.callbacks.onInteriorInteract?.(id);
          return;
        }
      }

      if (!this.pointerLockControls.isLocked) {
        try {
          this.pointerLockControls.lock();
        } catch {
          // Pointer lock optional; drag-look and virtual buttons remain active
        }
      }
      return;
    }

    if (this.viewMode === 'eva') {
      if (this.evaInputPaused) return;
      if (!this.evaPointerLockControls.isLocked) {
        try {
          this.evaPointerLockControls.lock();
        } catch {
          // Pointer lock optional; drag-look and virtual buttons remain active
        }
      }
      return;
    }

    if (this.nightAnim.active) return;
    const { moduleId, rockId, rockLabel } = this.pickTarget(e);
    if (moduleId) {
      this.callbacks.onModuleClick(moduleId);
    } else if (rockId && rockLabel) {
      this.callbacks.onRockClick?.(rockId, rockLabel);
    }
  };

  private startLoop(): void {
    const scheduleNext = () => {
      if (this.destroyed) return;
      if (this.isSoftwareGl) {
        this.afterDraw(() => {
          if (!this.destroyed) this.tick();
        });
      } else {
        this.rafId = requestAnimationFrame(() => this.tick());
      }
    };
    scheduleNext();
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync === 'function') {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (this.destroyed) return;
        const status = sync ? gl.clientWaitSync(sync, 0, 0) : gl.ALREADY_SIGNALED;
        if (status !== gl.TIMEOUT_EXPIRED) {
          if (sync) gl.deleteSync(sync);
          const delayMs = this.viewMode !== 'exterior' ? 24 : 80;
          this.swTimerId = window.setTimeout(cb, delayMs);
        } else {
          this.swTimerId = window.setTimeout(poll, 16);
        }
      };
      this.swTimerId = window.setTimeout(poll, 16);
    } else {
      this.swTimerId = window.setTimeout(cb, this.viewMode !== 'exterior' ? 32 : 90);
    }
  }

  private tick(): void {
    if (this.destroyed || !this.renderer) return;

    const now = performance.now();
    const rawDt = Math.max(0.001, (now - this.lastFrameTime) / 1000);
    const dt = Math.min(rawDt, 0.1);
    this.lastFrameTime = now;
    this.totalTime += dt;

    this.updateAnimations(dt);
    this.updateRoverAnimation(Math.min(rawDt, 0.25), now);

    if (this.viewMode === 'interior') {
      this.flushInteriorInputStep(now);
      const moxieCrisisActive =
        this.emergencyMode !== 'none' ||
        this.targetHazardType !== 'none' ||
        this.resources.lifeSupportPct < 65 ||
        this.donkiTelemetry.level !== 'quiet';
      this.interiorWorld.update(dt, {
        resources: this.resources,
        emergencyActive: this.emergencyMode !== 'none',
        moxieCrisisActive,
        skyColor: this.skyColor,
        zenithColor: this.zenithColor,
        nightFactor: this.smoothedNightFactor,
      });
      this.renderCurrentView();
    } else if (this.viewMode === 'eva') {
      this.flushEvaInputStep(now);
      this.renderCurrentView();
    } else {
      if (this.cameraTransition.active) {
        this.cameraTransition.elapsed += Math.min(rawDt, this.isSoftwareGl ? 0.2 : 0.1);
        const lambda = this.isSoftwareGl ? 14.0 : 9.0;
        this.camera.position.x = THREE.MathUtils.damp(
          this.camera.position.x,
          this.cameraTransition.targetPos.x,
          lambda,
          dt
        );
        this.camera.position.y = THREE.MathUtils.damp(
          this.camera.position.y,
          this.cameraTransition.targetPos.y,
          lambda,
          dt
        );
        this.camera.position.z = THREE.MathUtils.damp(
          this.camera.position.z,
          this.cameraTransition.targetPos.z,
          lambda,
          dt
        );
        this.controls.target.x = THREE.MathUtils.damp(
          this.controls.target.x,
          this.cameraTransition.targetLook.x,
          lambda,
          dt
        );
        this.controls.target.y = THREE.MathUtils.damp(
          this.controls.target.y,
          this.cameraTransition.targetLook.y,
          lambda,
          dt
        );
        this.controls.target.z = THREE.MathUtils.damp(
          this.controls.target.z,
          this.cameraTransition.targetLook.z,
          lambda,
          dt
        );
        this.camera.lookAt(this.controls.target);

        const dist = this.camera.position.distanceTo(this.cameraTransition.targetPos);
        if (this.cameraTransition.elapsed >= this.cameraTransition.duration || dist < 0.08) {
          this.camera.position.copy(this.cameraTransition.targetPos);
          this.controls.target.copy(this.cameraTransition.targetLook);
          const done = this.cameraTransition.onComplete;
          this.cameraTransition.active = false;
          this.cameraTransition.onComplete = null;
          this.controls.enabled = this.viewMode === 'exterior';
          done?.();
        }
      } else {
        this.controls.update();
      }
      this.renderCurrentView();
      this.emitProjectedAnchors();
    }

    if (this.isSoftwareGl) {
      this.afterDraw(() => {
        if (!this.destroyed) this.tick();
      });
    } else {
      this.rafId = requestAnimationFrame(() => this.tick());
    }
  }

  private updateAnimations(dt: number): void {
    const nowMs = performance.now();
    const speedScale = 1 + Math.min(2.5, (this.simSpeedMultiplier - 1) * 0.45);
    const smoothAlpha = 1 - Math.exp(-3.2 * dt);
    const colorAlpha = 1 - Math.exp(-2.8 * dt);

    // Smoothly interpolate Sol timeline atmosphere targets frame-by-frame
    this.smoothedSolProgress = THREE.MathUtils.lerp(
      this.smoothedSolProgress,
      this.targetAtmosphere.solProgress,
      smoothAlpha
    );
    this.smoothedCrisisIntensity = THREE.MathUtils.lerp(
      this.smoothedCrisisIntensity,
      this.targetAtmosphere.crisisIntensity,
      smoothAlpha
    );
    this.smoothedEffectiveTau = THREE.MathUtils.lerp(
      this.smoothedEffectiveTau,
      this.targetAtmosphere.effectiveTau,
      smoothAlpha
    );
    this.smoothedSunElevation = THREE.MathUtils.lerp(
      this.smoothedSunElevation,
      this.targetAtmosphere.sunElevation,
      smoothAlpha
    );
    this.smoothedNightFactor = THREE.MathUtils.lerp(
      this.smoothedNightFactor,
      this.targetAtmosphere.nightFactor,
      smoothAlpha
    );

    const moduleIds: ModuleId[] = ['solar', 'moxie', 'shelter', 'biodome'];
    for (const id of moduleIds) {
      const boostLeft = Math.max(0, (this.moduleBoostTimers[id] - nowMs) / 6500);
      const targetGlow = THREE.MathUtils.clamp(
        Math.max(this.activeSystemGlow[id] ?? 0, boostLeft * 0.95),
        0,
        1
      );
      this.smoothedSystemGlow[id] = THREE.MathUtils.lerp(
        this.smoothedSystemGlow[id],
        targetGlow,
        smoothAlpha
      );
    }

    // Gentle pulsing beacons & roof red/cyan comms strobes across base modules
    const gentlePulseA = 0.5 + 0.5 * Math.sin(this.totalTime * 2.4);
    const gentlePulseB = 0.5 + 0.5 * Math.sin(this.totalTime * 2.4 + 1.8);
    const strobeRed = Math.pow(0.5 + 0.5 * Math.sin(this.totalTime * 5.6), 4);
    const strobeCyan = Math.pow(0.5 + 0.5 * Math.sin(this.totalTime * 5.6 + Math.PI), 4);
    if (this.commsBeaconMat) {
      this.commsBeaconMat.emissiveIntensity = 0.45 + gentlePulseA * 1.9;
    }
    if (this.shelterRoofRedStrobeMat) {
      this.shelterRoofRedStrobeMat.emissiveIntensity = 0.25 + strobeRed * 2.4;
    }
    if (this.shelterRoofCyanStrobeMat) {
      this.shelterRoofCyanStrobeMat.emissiveIntensity = 0.25 + strobeCyan * 2.2;
    }
    if (this.moxieBeaconMat) {
      this.moxieBeaconMat.emissiveIntensity = 0.55 + gentlePulseB * 1.35;
    }
    if (this.biodomeBeaconMat) {
      this.biodomeBeaconMat.emissiveIntensity = 0.55 + gentlePulseA * 1.35;
    }
    if (this.solarBeaconMat) {
      this.solarBeaconMat.emissiveIntensity = 0.55 + gentlePulseB * 1.25;
    }
    if (this.airlockStripMat) {
      this.airlockStripMat.emissiveIntensity = 1.1 + gentlePulseA * 0.55;
    }

    // Ambient MOXIE turbine rotation, rising O2 bubbles, and twin exhaust vent plumes
    const moxieActivity = this.smoothedSystemGlow.moxie;
    this.moxieFan.rotation.y += dt * (4.0 + moxieActivity * 4.5) * speedScale;
    const bubbleSpeed =
      (this.activePulse?.moduleId === 'moxie' ? 3.2 : 0.95 + moxieActivity * 1.15) * speedScale;
    for (let i = 0; i < this.moxieBubbles.length; i++) {
      const b = this.moxieBubbles[i];
      b.position.y += dt * bubbleSpeed;
      if (b.position.y > 4.4) b.position.y = 2.05;
      b.position.x = 1.05 + (i % 3) * 0.2 + Math.sin(this.totalTime * 3 + b.userData.phase) * 0.08;
    }
    for (let i = 0; i < this.moxieExhaustSeeds.length; i++) {
      const seed = this.moxieExhaustSeeds[i];
      const cyc = (this.totalTime * 0.65 * speedScale + seed.phase) % 1;
      this.moxieExhaustPositions[i * 3] = seed.baseX + cyc * 0.55;
      this.moxieExhaustPositions[i * 3 + 1] = 2.68 + cyc * 1.65;
      this.moxieExhaustPositions[i * 3 + 2] = seed.baseZ + Math.sin(this.totalTime * 2.1 + i) * 0.08;
    }
    if (this.moxieExhaustPoints) {
      this.moxieExhaustPoints.geometry.attributes.position.needsUpdate = true;
    }

    // Sweeping rover headlights across the Martian regolith
    if (this.roverHeadlightRig) {
      if (this.roverPhase === 'idle') {
        this.roverHeadlightRig.rotation.y = Math.sin(this.totalTime * 0.85) * 0.34;
        this.roverHeadlightSpot.intensity = 2.8 + this.smoothedNightFactor * 1.6;
      } else {
        this.roverHeadlightRig.rotation.y = Math.sin(this.totalTime * 2.1) * 0.1;
        this.roverHeadlightSpot.intensity = 4.0 + this.smoothedNightFactor * 1.4;
      }
    }

    // Gentle solar tilt & target ring pulse
    const tiltAngle =
      0.34 + (1 - this.smoothedSunElevation) * 0.16 + Math.sin(this.totalTime * 0.6) * 0.04;
    for (let i = 0; i < this.solarTiltGroups.length; i++) {
      this.solarTiltGroups[i].rotation.x = tiltAngle;
    }
    if (this.targetRing.visible) {
      const pulse = 1 + Math.sin(this.totalTime * 3.8) * 0.045;
      this.targetRing.scale.set(pulse, 1, pulse);
    }

    // Active module click feedback animation
    if (this.activePulse) {
      const elapsedSec = (nowMs - this.activePulse.startTimeMs) / 1000;
      const p = Math.min(elapsedSec / this.activePulse.duration, 1);

      if (this.activePulse.moduleId === 'solar') {
        const sweep = Math.sin(p * Math.PI * 2) * 0.88;
        for (let i = 0; i < this.solarWipers.length; i++) {
          const w = this.solarWipers[i];
          w.mesh.position.x = w.baseX + sweep;
        }
      } else if (this.activePulse.moduleId === 'shelter') {
        const ripple = Math.sin(p * Math.PI) * 0.12;
        const baseScale = 0.96 + ((this.resources.waterWallCm - 8) / 28) * 0.16;
        const s = baseScale + ripple;
        this.waterShieldMesh.scale.set(s, s, s);
      }

      if (p >= 1) {
        for (let i = 0; i < this.solarWipers.length; i++) {
          const w = this.solarWipers[i];
          w.mesh.position.x = w.baseX - 0.88;
        }
        this.activePulse = null;
        this.syncVisualState();
      }
    }

    // Subtle wind-blown Martian dust drift & animated 3D dust-mote sheets
    const stormStrength = THREE.MathUtils.clamp(
      (this.smoothedEffectiveTau - 0.45) * 0.85 +
        (this.targetHazardType === 'dust' ? this.smoothedCrisisIntensity * 0.75 : 0),
      0,
      1.25
    );
    const windSpeed = (1.6 + stormStrength * 10.5) * speedScale;
    const targetDustOpacity = THREE.MathUtils.clamp(
      0.16 + this.smoothedEffectiveTau * 0.22 + stormStrength * 0.34,
      0.14,
      0.72
    );
    this.dustStormMat.opacity = THREE.MathUtils.lerp(
      this.dustStormMat.opacity,
      targetDustOpacity,
      smoothAlpha
    );
    for (let i = 0; i < this.dustPositions.length; i += 3) {
      this.dustPositions[i] += dt * windSpeed;
      if (this.dustPositions[i] > 19) this.dustPositions[i] = -19;
    }
    this.dustStormPoints.geometry.attributes.position.needsUpdate = true;

    const targetSheetOpacity = THREE.MathUtils.clamp(
      0.11 + stormStrength * 0.16 + (this.smoothedEffectiveTau - 0.35) * 0.09,
      0.09,
      0.32
    );
    for (let i = 0; i < this.dustSheets.length; i++) {
      const sheet = this.dustSheets[i];
      sheet.mesh.position.x += dt * windSpeed * sheet.speed * 0.75;
      if (sheet.mesh.position.x > 25) sheet.mesh.position.x = -25;
      sheet.mesh.position.y =
        groundHeightAt(sheet.mesh.position.x, sheet.z) +
        sheet.baseY +
        Math.sin(this.totalTime * 0.9 + sheet.phase) * 0.14;
      sheet.mat.opacity = THREE.MathUtils.lerp(sheet.mat.opacity, targetSheetOpacity, smoothAlpha);
    }

    // DONKI space-weather smooth transitions (Quiet -> M-Class Amber-Violet -> X-Class/CME Red-Alert)
    const targetDonkiM =
      this.donkiTelemetry.level === 'm_class'
        ? 1
        : this.donkiTelemetry.level === 'x_class'
        ? 0.4
        : 0;
    const targetDonkiX = this.donkiTelemetry.level === 'x_class' ? 1 : 0;
    this.smoothedDonkiM = THREE.MathUtils.lerp(this.smoothedDonkiM, targetDonkiM, smoothAlpha);
    this.smoothedDonkiX = THREE.MathUtils.lerp(this.smoothedDonkiX, targetDonkiX, smoothAlpha);

    const shieldBoostActive = nowMs < this.shieldBoostUntilMs;
    const shieldStrong = this.donkiTelemetry.shieldActive || this.resources.waterWallCm >= 20 || shieldBoostActive;
    const targetShieldHex = shieldBoostActive
      ? 1.0
      : shieldStrong
      ? 0.78
      : this.smoothedDonkiM > 0.25 || this.smoothedDonkiX > 0.15
      ? 0.22
      : 0.08;
    this.smoothedShieldHex = THREE.MathUtils.lerp(
      this.smoothedShieldHex,
      targetShieldHex,
      smoothAlpha
    );
    this.shieldImpactPulse = Math.max(0, this.shieldImpactPulse - dt * 1.9);

    if (this.waterShieldHexMat) {
      this.waterShieldHexMat.uniforms.uTime.value = this.totalTime;
      this.waterShieldHexMat.uniforms.uStrength.value = this.smoothedShieldHex;
      this.waterShieldHexMat.uniforms.uImpactPulse.value = this.shieldImpactPulse;
      this.waterShieldHexMesh.visible = this.smoothedShieldHex > 0.02;
    }

    // Subtle upper-sky green/violet aurora ribbons during M4.2, X-Class, and Sol flare alerts
    const solFlareActive =
      this.emergencyMode === 'flare' || this.targetHazardType === 'flare'
        ? 0.45 + this.smoothedCrisisIntensity * 0.45
        : 0;
    const auroraVisibility = Math.max(
      this.smoothedDonkiM * 0.62,
      this.smoothedDonkiX * 0.95,
      solFlareActive
    );
    if (this.auroraGroup) {
      this.auroraGroup.visible = auroraVisibility > 0.03;
      for (let i = 0; i < this.auroraMats.length; i++) {
        this.auroraMats[i].uniforms.uTime.value = this.totalTime;
        this.auroraMats[i].uniforms.uOpacity.value = auroraVisibility * (0.65 + 0.12 * i);
        this.auroraMats[i].uniforms.uCrimsonMix.value = this.smoothedDonkiX;
      }
    }

    // Radiation particle streaks: active during X-Class/CME impact or Sol flare crisis peak
    const flarePeakActive =
      !this.nightAnim.active &&
      (this.smoothedDonkiX > 0.12 ||
        ((this.targetHazardType === 'flare' || this.emergencyMode === 'flare') &&
          this.smoothedCrisisIntensity > 0.52));
    this.flareBoltsGroup.visible = this.nightAnim.active
      ? this.nightAnim.hazardType === 'flare'
      : flarePeakActive;

    const shelterDomeCenter = this.moduleWorldCenters.shelter;
    if (flarePeakActive) {
      const deflectEnabled = shieldStrong;
      for (let i = 0; i < this.flareBolts.length; i++) {
        const bolt = this.flareBolts[i];
        const streakSpeed = bolt.speed * (0.8 + this.smoothedDonkiX * 0.55);
        bolt.mesh.position.addScaledVector(bolt.vel, dt * streakSpeed);

        if (!bolt.deflected && !bolt.skyStreak && deflectEnabled) {
          const dx = bolt.mesh.position.x - shelterDomeCenter.x;
          const dy = bolt.mesh.position.y - (shelterDomeCenter.y + 0.45);
          const dz = bolt.mesh.position.z - shelterDomeCenter.z;
          const dist = Math.hypot(dx, dy, dz);
          if (dist <= 3.35) {
            bolt.deflected = true;
            this.streakNormScratch.set(dx, Math.max(0.25, dy), dz).normalize();
            bolt.vel.reflect(this.streakNormScratch).normalize();
            bolt.vel.y = Math.abs(bolt.vel.y) + 0.35;
            bolt.vel.normalize();
            bolt.mesh.quaternion.setFromUnitVectors(this.streakUpAxis, bolt.vel);
            bolt.mat.color.set('#67E8F9');
            bolt.mat.opacity = 1.0;
            this.waterShieldHexMat.uniforms.uImpactPoint.value.set(
              bolt.mesh.position.x,
              bolt.mesh.position.y,
              bolt.mesh.position.z
            );
            this.shieldImpactPulse = 1.0;
          }
        }

        const outOfBounds =
          bolt.mesh.position.y < (bolt.deflected ? -1 : 0.6) ||
          bolt.mesh.position.y > 22 ||
          Math.abs(bolt.mesh.position.x) > 24;
        if (outOfBounds) {
          bolt.deflected = false;
          bolt.vel.set(-0.34, -1.0, 0.16).normalize();
          bolt.mesh.quaternion.setFromUnitVectors(this.streakUpAxis, bolt.vel);
          bolt.mat.color.set(this.smoothedDonkiX > 0.35 ? '#FF4D6D' : '#FB7185');
          bolt.mat.opacity = 0.92;
          const spawnOffset = bolt.skyStreak ? 3.5 : 2.1;
          bolt.mesh.position.set(
            shelterDomeCenter.x + Math.cos(bolt.angle) * bolt.radius + spawnOffset,
            10.5 + (i % 6) * 2.0,
            shelterDomeCenter.z + Math.sin(bolt.angle) * bolt.radius - spawnOffset * 0.45
          );
        }
      }
    }

    const targetEmergency =
      this.emergencyMode !== 'none' || this.donkiTelemetry.level === 'x_class'
        ? THREE.MathUtils.clamp(
            Math.max(0.2 + this.smoothedCrisisIntensity * 0.8, this.smoothedDonkiX),
            0,
            1
          )
        : Math.max(this.smoothedCrisisIntensity * 0.25, this.smoothedDonkiM * 0.35);
    this.emergencyBlend = THREE.MathUtils.lerp(this.emergencyBlend, targetEmergency, smoothAlpha);
    const alertPulse = 0.5 + 0.5 * Math.sin(this.totalTime * 4.8);
    this.scratchAlertColor.lerpColors(this.alertRedColor, this.alertAmberColor, alertPulse);

    const nightDustBoost = this.nightAnim.active && this.nightAnim.hazardType === 'dust' ? 0.004 : 0;
    const targetFogDensity =
      this.targetAtmosphere.fogDensity + nightDustBoost + this.smoothedDonkiX * 0.0045;
    this.fog.density = THREE.MathUtils.lerp(this.fog.density, targetFogDensity, smoothAlpha);

    if (!this.nightAnim.active) {
      const hazardTintColor =
        this.emergencyMode === 'flare' || this.targetHazardType === 'flare'
          ? this.flareAlertSkyColor
          : this.dustAlertSkyColor;
      const hazardMix =
        this.emergencyMode !== 'none'
          ? THREE.MathUtils.clamp(this.smoothedCrisisIntensity * 0.85, 0, 0.9)
          : THREE.MathUtils.clamp(this.smoothedCrisisIntensity * 0.35, 0, 0.35);
      this.targetDayBaseColor.lerpColors(this.daySkyColor, hazardTintColor, hazardMix);

      // Apply DONKI M-Class amber-violet & X-Class red-alert sky shifts
      if (this.smoothedDonkiM > 0.01) {
        this.targetDayBaseColor.lerp(this.mClassHorizonColor, this.smoothedDonkiM * 0.72);
      }
      if (this.smoothedDonkiX > 0.01) {
        this.targetDayBaseColor.lerp(this.xClassHorizonColor, this.smoothedDonkiX * 0.88);
      }

      if (this.smoothedNightFactor < 0.45) {
        this.targetSkyColor.lerpColors(
          this.targetDayBaseColor,
          this.sunsetSkyColor,
          this.smoothedNightFactor / 0.45
        );
      } else {
        this.targetSkyColor.lerpColors(
          this.sunsetSkyColor,
          this.nightSkyColor,
          (this.smoothedNightFactor - 0.45) / 0.55
        );
      }
      if (this.targetHazardType === 'flare' && this.smoothedCrisisIntensity > 0.55) {
        const auroraMix = (this.smoothedCrisisIntensity - 0.55) * 0.65;
        this.targetSkyColor.lerp(this.flareSkyColor, auroraMix);
      }

      this.skyColor.lerp(this.targetSkyColor, colorAlpha);
      (this.scene.background as THREE.Color).copy(this.skyColor);
      this.fog.color.copy(this.skyColor);
      this.renderer.setClearColor(this.fog.color);

      if (this.skyDomeMat) {
        this.skyDomeMat.uniforms.uHorizonColor.value.copy(this.skyColor);
        this.scratchTargetZenith.copy(this.zenithDayColor);
        if (this.smoothedDonkiM > 0.01) {
          this.scratchTargetZenith.lerp(this.mClassZenithColor, this.smoothedDonkiM * 0.82);
        }
        if (this.smoothedDonkiX > 0.01) {
          this.scratchTargetZenith.lerp(this.xClassZenithColor, this.smoothedDonkiX * 0.92);
        }
        this.zenithColor.lerpColors(
          this.scratchTargetZenith,
          this.zenithNightColor,
          THREE.MathUtils.clamp(this.smoothedNightFactor * 1.15, 0, 1)
        );
        this.skyDomeMat.uniforms.uZenithColor.value.copy(this.zenithColor);
        this.skyDomeMat.uniforms.uRidgeBandColor.value.lerpColors(
          this.ridgeBandDayColor,
          this.ridgeBandNightColor,
          THREE.MathUtils.clamp(this.smoothedNightFactor * 1.1, 0, 1)
        );
        this.skyDomeMat.uniforms.uRidgeBandMix.value = THREE.MathUtils.lerp(
          0.42,
          0.12,
          THREE.MathUtils.clamp(this.smoothedNightFactor + this.smoothedDonkiX * 0.5, 0, 1)
        );
        this.skyDomeMat.uniforms.uTime.value = this.totalTime;
        this.skyDomeMat.uniforms.uCirrusVisibility.value = THREE.MathUtils.clamp(
          1.0 - this.smoothedNightFactor * 0.55 - stormStrength * 0.65,
          0.15,
          1.0
        );
      }

      // Unified low-angle Sun direction anchored at [-85, 28, -60]
      this.targetSunPos.set(
        this.baseSunPos.x,
        Math.max(8, this.baseSunPos.y - this.smoothedNightFactor * 16),
        this.baseSunPos.z
      );
      this.sunLight.position.lerp(this.targetSunPos, smoothAlpha);
      if (this.sunDiscGroup) {
        this.sunDiscGroup.position.copy(this.sunLight.position);
        const sunFade = THREE.MathUtils.clamp(
          (1 - this.smoothedNightFactor * 0.78) * (1 - stormStrength * 0.48),
          0.12,
          1
        );
        this.sunHaloInnerMat.opacity = 0.94 * sunFade;
        this.sunCoronaMat.opacity = 0.5 * sunFade;
      }
      this.terrainSheenUniform.value = THREE.MathUtils.clamp(
        (1 - this.smoothedNightFactor * 0.85) * (1 - stormStrength * 0.52),
        0.15,
        1.0
      );

      this.targetSunColor.lerpColors(
        this.calmSunColor,
        this.alertSunColor,
        THREE.MathUtils.clamp(this.emergencyBlend * 0.7 + this.smoothedNightFactor * 0.5, 0, 1)
      );
      if (this.smoothedDonkiX > 0.01) {
        this.targetSunColor.lerp(this.xClassSunColor, this.smoothedDonkiX * 0.75);
      }
      this.sunLight.color.lerp(this.targetSunColor, colorAlpha);

      const targetSunIntensity = THREE.MathUtils.lerp(
        3.2,
        0.72,
        THREE.MathUtils.clamp(this.smoothedNightFactor * 0.82 + this.emergencyBlend * 0.38, 0, 1)
      );
      this.sunLight.intensity = THREE.MathUtils.lerp(
        this.sunLight.intensity,
        targetSunIntensity,
        smoothAlpha
      );

      // Cool-blue sky fill opposite the Sun in calm conditions, pulsing crimson during X-Class / CME Impact
      if (this.rimLight) {
        const rimPulse = 0.65 + 0.35 * Math.sin(this.totalTime * 5.2);
        this.rimLight.color.lerpColors(
          this.calmRimColor,
          this.xClassRimColor,
          THREE.MathUtils.clamp(this.smoothedDonkiX * 1.1, 0, 1)
        );
        this.rimLight.intensity = THREE.MathUtils.lerp(
          0.54,
          4.4 * rimPulse,
          this.smoothedDonkiX
        );
      }

      this.hemiLight.color.lerpColors(this.calmHemiSky, this.xClassHemiSky, this.smoothedDonkiX * 0.7);
      this.hemiLight.groundColor.lerpColors(
        this.calmHemiGround,
        this.xClassHemiGround,
        this.smoothedDonkiX * 0.85
      );
      const targetHemiIntensity = THREE.MathUtils.lerp(
        0.62,
        0.28,
        THREE.MathUtils.clamp(this.smoothedNightFactor * 0.75 + this.emergencyBlend * 0.4, 0, 1)
      );
      this.hemiLight.intensity = THREE.MathUtils.lerp(
        this.hemiLight.intensity,
        targetHemiIntensity,
        smoothAlpha
      );

      const targetEnvIntensity = THREE.MathUtils.lerp(
        1.15,
        0.42,
        THREE.MathUtils.clamp(this.emergencyBlend * 0.65 + this.smoothedNightFactor * 0.5, 0, 1)
      );
      this.scene.environmentIntensity = THREE.MathUtils.lerp(
        this.scene.environmentIntensity,
        targetEnvIntensity,
        smoothAlpha
      );

      const targetStarsOpacity = THREE.MathUtils.clamp(
        Math.max(
          0.18,
          (this.smoothedNightFactor - 0.15) * 1.35,
          this.smoothedDonkiM * 0.35,
          this.smoothedDonkiX * 0.6
        ),
        0.15,
        0.95
      );
      this.starsMat.opacity = THREE.MathUtils.lerp(this.starsMat.opacity, targetStarsOpacity, smoothAlpha);

      // Active Base Glow + X-Class electrical interior flicker
      const solarPulse = 0.5 + 0.5 * Math.sin(this.totalTime * 2.8);
      const moxiePulse = 0.5 + 0.5 * Math.sin(this.totalTime * 3.4 + 1.1);
      const shelterPulse = 0.5 + 0.5 * Math.sin(this.totalTime * 3.0 + 2.2);
      const bioPulse = 0.5 + 0.5 * Math.sin(this.totalTime * 2.6 + 3.3);
      const xFlicker =
        1.0 -
        this.smoothedDonkiX *
          0.62 *
          Math.max(0, Math.sin(this.totalTime * 23.0) * Math.cos(this.totalTime * 13.7));

      const solarGlow = this.smoothedSystemGlow.solar;
      const moxieGlow = this.smoothedSystemGlow.moxie;
      const shelterGlow = this.smoothedSystemGlow.shelter;
      const bioGlow = this.smoothedSystemGlow.biodome;

      const solarActionBoost = this.activePulse?.moduleId === 'solar' ? 0.38 : 0;
      this.solarCellMat.emissiveIntensity =
        0.04 + solarGlow * (0.08 + solarPulse * 0.1) + solarActionBoost;
      this.solarBatteryMat.emissiveIntensity =
        0.12 + solarGlow * (0.16 + solarPulse * 0.18) + solarActionBoost;

      const wallRatio = THREE.MathUtils.clamp((this.resources.waterWallCm - 8) / 28, 0, 1);
      const shelterActionBoost = this.activePulse?.moduleId === 'shelter' ? 0.45 : 0;
      this.waterShieldMat.emissiveIntensity =
        0.12 +
        wallRatio * 0.24 +
        shelterGlow * (0.12 + shelterPulse * 0.2) +
        shelterActionBoost +
        this.shieldImpactPulse * 0.45;

      this.shelterInteriorLight.color.lerpColors(
        this.calmWindowEmissive,
        this.scratchAlertColor,
        this.emergencyBlend * 0.85
      );
      this.shelterInteriorLight.intensity =
        (0.75 +
          this.smoothedNightFactor * 0.95 +
          shelterGlow * (0.25 + shelterPulse * 0.3) +
          this.emergencyBlend * (1.8 + alertPulse * 1.2)) *
        xFlicker;

      this.shelterHullMat.color.lerpColors(
        this.calmHullColor,
        this.alertHullTint,
        this.emergencyBlend * 0.35
      );
      this.shelterHullMat.emissive.lerpColors(
        this.blackColor,
        this.scratchAlertColor,
        Math.max(this.emergencyBlend * 0.35, this.smoothedDonkiX * 0.4)
      );
      this.shelterHullMat.emissiveIntensity = Math.max(
        this.emergencyBlend * (0.08 + alertPulse * 0.12),
        this.smoothedDonkiX * (0.08 + alertPulse * 0.12)
      );

      this.shelterWindowMat.color.lerpColors(
        this.calmWindowColor,
        this.scratchAlertColor,
        this.emergencyBlend * 0.8
      );
      this.shelterWindowMat.emissive.lerpColors(
        this.calmWindowEmissive,
        this.alertRedColor,
        this.emergencyBlend * 0.8
      );
      this.shelterWindowMat.emissiveIntensity =
        (0.24 +
          this.smoothedNightFactor * 0.42 +
          shelterGlow * (0.1 + shelterPulse * 0.14) +
          this.emergencyBlend * (0.18 + alertPulse * 0.28)) *
        xFlicker;

      this.shelterBeaconMat.color.lerpColors(
        this.calmBeaconColor,
        this.alertRedColor,
        this.emergencyBlend
      );
      this.shelterBeaconMat.emissive.lerpColors(
        this.calmBeaconEmissive,
        this.alertRedColor,
        this.emergencyBlend
      );
      this.shelterBeaconMat.emissiveIntensity =
        1.3 + shelterGlow * 0.35 + this.emergencyBlend * (0.5 + alertPulse * 0.85);

      const o2Ratio = THREE.MathUtils.clamp(this.resources.lifeSupportPct / 100, 0.15, 1);
      const moxieActionBoost = this.activePulse?.moduleId === 'moxie' ? 0.5 : 0;
      this.moxieLight.color.lerpColors(
        this.calmMoxieEmissive,
        this.scratchAlertColor,
        this.emergencyBlend * 0.8
      );
      this.moxieLight.intensity =
        (0.75 + moxieGlow * (0.35 + moxiePulse * 0.35) + this.emergencyBlend * (1.7 + alertPulse * 1.1)) *
        (0.8 + 0.2 * xFlicker);

      this.moxieTankMat.color.lerpColors(
        this.calmMoxieColor,
        this.scratchAlertColor,
        this.emergencyBlend * 0.72
      );
      this.moxieTankMat.emissive.lerpColors(
        this.calmMoxieEmissive,
        this.scratchAlertColor,
        this.emergencyBlend * 0.75
      );
      this.moxieTankMat.emissiveIntensity =
        0.14 + o2Ratio * 0.22 + moxieGlow * (0.14 + moxiePulse * 0.22) + moxieActionBoost;

      const bioActionBoost = this.activePulse?.moduleId === 'biodome' ? 0.45 : 0;
      const bioAlertBlend =
        this.emergencyMode !== 'none' || this.smoothedDonkiX > 0.15 ? this.emergencyBlend : 0;
      this.biodomeLight.color.lerpColors(
        this.calmBioEmissive,
        this.scratchAlertColor,
        bioAlertBlend * 0.72
      );
      this.biodomeLight.intensity =
        1.65 +
        bioGlow * (0.55 + bioPulse * 0.45) +
        bioActionBoost * 1.0 +
        bioAlertBlend * (1.5 + alertPulse * 1.0);

      this.biodomeGlassMat.color.lerpColors(
        this.calmBioColor,
        this.scratchAlertColor,
        bioAlertBlend * 0.6
      );
      this.biodomeGlassMat.emissive.lerpColors(
        this.calmBioEmissive,
        this.scratchAlertColor,
        bioAlertBlend * 0.65
      );
      this.biodomeGlassMat.emissiveIntensity =
        0.05 +
        bioGlow * (0.08 + bioPulse * 0.12) +
        bioActionBoost * 0.28 +
        bioAlertBlend * (0.12 + alertPulse * 0.14);

      this.bioLedRingMat.color.lerpColors(
        this.calmLedColor,
        this.alertRedColor,
        bioAlertBlend * 0.78
      );
      this.bioLedRingMat.emissive.lerpColors(
        this.calmLedEmissive,
        this.alertRedColor,
        bioAlertBlend * 0.78
      );
      this.bioLedRingMat.emissiveIntensity =
        1.3 +
        bioGlow * (0.4 + bioPulse * 0.45) +
        bioActionBoost * 0.5 +
        bioAlertBlend * (0.35 + alertPulse * 0.5);

      this.bioLeafMat.emissiveIntensity =
        0.1 + bioGlow * (0.1 + bioPulse * 0.12) + bioActionBoost * 0.22;
    }

    // Legacy Night Cycle Animation helper (if invoked directly)
    if (this.nightAnim.active) {
      const elapsedSec = (performance.now() - this.nightAnim.startTimeMs) / 1000;
      const t = Math.min(elapsedSec / this.nightAnim.duration, 1);
      const nightFactor = Math.sin(t * Math.PI);

      this.sunLight.position.set(
        this.baseSunPos.x,
        Math.max(4, this.baseSunPos.y * (1 - nightFactor * 0.85)),
        this.baseSunPos.z
      );
      if (this.sunDiscGroup) {
        this.sunDiscGroup.position.copy(this.sunLight.position);
      }
      this.sunLight.intensity = THREE.MathUtils.lerp(3.2, 0.55, nightFactor);
      this.hemiLight.intensity = THREE.MathUtils.lerp(0.62, 0.26, nightFactor);

      if (nightFactor < 0.45) {
        this.skyColor.lerpColors(this.daySkyColor, this.sunsetSkyColor, nightFactor / 0.45);
      } else {
        this.skyColor.lerpColors(this.sunsetSkyColor, this.nightSkyColor, (nightFactor - 0.45) / 0.55);
      }
      if (this.nightAnim.hazardType === 'flare' && nightFactor > 0.4) {
        const auroraPulse = 0.35 + 0.25 * Math.sin(this.totalTime * 12);
        this.skyColor.lerp(this.flareSkyColor, auroraPulse);
      }
      (this.scene.background as THREE.Color).copy(this.skyColor);
      this.fog.color.copy(this.skyColor);
      this.renderer.setClearColor(this.fog.color);

      this.starsMat.opacity = Math.max(0.18, (nightFactor - 0.25) * 1.45);
      this.shelterInteriorLight.intensity = 0.75 + nightFactor * 1.8;
      this.shelterWindowMat.emissiveIntensity = 0.24 + nightFactor * 0.72;
      this.shelterBeaconMat.emissiveIntensity = 1.3 + Math.sin(this.totalTime * 3.0) * 0.6;

      if (this.nightAnim.hazardType === 'flare') {
        for (const bolt of this.flareBolts) {
          if (!bolt.deflected) {
            bolt.mesh.position.y -= dt * bolt.speed;
            const impactY = this.nightAnim.shieldBlockedFlare ? 3.2 : 1.6;
            if (bolt.mesh.position.y <= impactY) {
              if (this.nightAnim.shieldBlockedFlare) {
                bolt.deflected = true;
                bolt.mesh.rotation.z = 0.9;
              } else {
                bolt.mesh.position.y = 8.8;
                this.waterShieldMat.emissive.set('#EF4444');
              }
            }
          } else {
            bolt.mesh.position.y += dt * 7.5;
            bolt.mesh.position.x += Math.cos(bolt.angle) * dt * 6;
            bolt.mesh.position.z += Math.sin(bolt.angle) * dt * 6;
            if (bolt.mesh.position.y > 9.5) {
              bolt.deflected = false;
              bolt.mesh.rotation.set(0, 0, 0);
              bolt.mesh.position.set(
                Math.cos(bolt.angle) * bolt.radius,
                8.5,
                Math.sin(bolt.angle) * bolt.radius
              );
            }
          }
        }
      }

      if (t >= 1 && !this.nightAnim.completed) {
        this.nightAnim.completed = true;
        this.nightAnim.active = false;
        this.flareBoltsGroup.visible = false;
        this.waterShieldMat.emissive.set('#006B84');
        this.sunLight.position.copy(this.baseSunPos);
        if (this.sunDiscGroup) {
          this.sunDiscGroup.position.copy(this.baseSunPos);
        }
        this.sunLight.intensity = 3.2;
        this.hemiLight.intensity = 0.62;
        this.starsMat.opacity = 0.22;
        this.shelterInteriorLight.intensity = 0.78;
        this.shelterWindowMat.emissiveIntensity = 0.24;
        (this.scene.background as THREE.Color).copy(this.daySkyColor);
        this.fog.color.copy(this.daySkyColor);
        this.renderer.setClearColor(this.fog.color);
        this.syncVisualState();
        this.nightAnim.onComplete();
      }
    }
  }

  private emitProjectedAnchors(): void {
    const width = this.renderer.domElement.clientWidth || window.innerWidth;
    const height = this.renderer.domElement.clientHeight || window.innerHeight;
    const moduleIds: ModuleId[] = ['solar', 'moxie', 'shelter', 'biodome'];

    const next: ProjectedModuleAnchor[] = moduleIds.map((id) => {
      this.projScratch.copy(this.anchorWorldMap[id]).project(this.camera);
      const visible =
        this.projScratch.z >= -1 &&
        this.projScratch.z <= 1 &&
        this.projScratch.x >= -0.92 &&
        this.projScratch.x <= 0.92 &&
        this.projScratch.y >= -0.88 &&
        this.projScratch.y <= 0.92;

      return {
        id,
        x: Math.round(((this.projScratch.x + 1) * 0.5) * width),
        y: Math.round(((-this.projScratch.y + 1) * 0.5) * height),
        visible,
      };
    });

    const changed =
      this.lastAnchors.length !== next.length ||
      next.some((item, idx) => {
        const prev = this.lastAnchors[idx];
        return (
          prev.visible !== item.visible ||
          Math.abs(prev.x - item.x) >= 1.5 ||
          Math.abs(prev.y - item.y) >= 1.5
        );
      });

    if (changed) {
      this.lastAnchors = next;
      this.callbacks.onAnchorsUpdate(next);
    }

    if (this.callbacks.onRockAnchorsUpdate) {
      const rockIds: ScienceBoulderId[] = [
        'rock-delta',
        'rock-olivine',
        'rock-carbonate',
        'rock-sulfate',
      ];
      const nextRocks: ProjectedRockAnchor[] = rockIds
        .map((id) => {
          const wp = this.rockAnchorWorldMap[id];
          if (!wp) return null;
          this.projScratch.copy(wp).project(this.camera);
          const visible =
            this.projScratch.z >= -1 &&
            this.projScratch.z <= 1 &&
            this.projScratch.x >= -0.92 &&
            this.projScratch.x <= 0.92 &&
            this.projScratch.y >= -0.86 &&
            this.projScratch.y <= 0.9;
          const labelMap: Record<ScienceBoulderId, string> = {
            'rock-delta': 'Delta Mudstone',
            'rock-olivine': 'Olivine Basalt',
            'rock-carbonate': 'Carbonate Outcrop',
            'rock-sulfate': 'Sulfate Vein',
          };
          return {
            id,
            label: labelMap[id],
            x: Math.round(((this.projScratch.x + 1) * 0.5) * width),
            y: Math.round(((-this.projScratch.y + 1) * 0.5) * height),
            visible,
          };
        })
        .filter((x): x is ProjectedRockAnchor => x !== null);

      const rocksChanged =
        this.lastRockAnchors.length !== nextRocks.length ||
        nextRocks.some((item, idx) => {
          const prev = this.lastRockAnchors[idx];
          return (
            prev.visible !== item.visible ||
            Math.abs(prev.x - item.x) >= 1.5 ||
            Math.abs(prev.y - item.y) >= 1.5
          );
        });
      if (rocksChanged) {
        this.lastRockAnchors = nextRocks;
        this.callbacks.onRockAnchorsUpdate(nextRocks);
      }
    }
  }

  private lerpYaw(current: number, target: number, alpha: number): number {
    let diff = target - current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return current + diff * alpha;
  }

  private updateRoverAnimation(dt: number, nowMs = performance.now()): void {
    if (!this.roverGroup || this.roverPhase === 'idle') return;

    this.roverPhaseElapsed = Math.max(0, (nowMs - this.roverPhaseStartMs) / 1000);
    const outboundDuration = 2.0; // 2s out + 2s back = 4s total travel time
    const workDuration = 3.0; // 3s pause with red laser & maintenance particles
    const returnDuration = 2.0;

    if (this.roverPhase === 'outbound') {
      const t = Math.min(1, this.roverPhaseElapsed / outboundDuration);
      const eased = t * t * (3 - 2 * t);
      const prevX = this.roverGroup.position.x;
      const prevZ = this.roverGroup.position.z;

      this.roverGroup.position.lerpVectors(this.roverStartPos, this.roverStopPos, eased);
      this.roverGroup.position.y = groundHeightAt(
        this.roverGroup.position.x,
        this.roverGroup.position.z
      );

      const dx = this.roverStopPos.x - this.roverStartPos.x;
      const dz = this.roverStopPos.z - this.roverStartPos.z;
      const travelYaw = Math.atan2(-dz, dx);
      this.roverGroup.rotation.y = this.lerpYaw(
        this.roverGroup.rotation.y,
        travelYaw,
        Math.min(1, dt * 8)
      );

      const stepDist = Math.hypot(
        this.roverGroup.position.x - prevX,
        this.roverGroup.position.z - prevZ
      );
      for (let i = 0; i < this.roverWheels.length; i++) {
        this.roverWheels[i].rotation.z -= stepDist / 0.19;
      }

      if (t >= 1) {
        this.roverPhase = 'working';
        this.roverPhaseElapsed = 0;
        this.roverPhaseStartMs = nowMs;
        this.callbacks.onRoverPhaseChange?.('working', this.roverMissionTarget?.label ?? null);
      }
    } else if (this.roverPhase === 'working') {
      const t = Math.min(1, this.roverPhaseElapsed / workDuration);

      // Face target cleanly & pan articulated mast while firing red laser
      const dx = this.roverAimPos.x - this.roverGroup.position.x;
      const dz = this.roverAimPos.z - this.roverGroup.position.z;
      const aimYaw = Math.atan2(-dz, dx);
      this.roverGroup.rotation.y = this.lerpYaw(
        this.roverGroup.rotation.y,
        aimYaw,
        Math.min(1, dt * 10)
      );
      this.roverMastGroup.rotation.y = Math.sin(this.roverPhaseElapsed * 3.8) * 0.18;
      this.roverLaserEyeMat.emissiveIntensity = 3.2 + Math.sin(this.roverPhaseElapsed * 16) * 0.8;

      this.roverGroup.updateMatrixWorld(true);
      this.roverLaserEyeMesh.getWorldPosition(this.roverEyeWorldScratch);

      // Sweep laser impact point slightly across the target surface
      this.roverAimOscScratch.copy(this.roverAimPos);
      this.roverAimOscScratch.x += Math.sin(this.roverPhaseElapsed * 4.5) * 0.22;
      this.roverAimOscScratch.y += Math.cos(this.roverPhaseElapsed * 3.2) * 0.1;

      this.roverBeamDirScratch.subVectors(this.roverAimOscScratch, this.roverEyeWorldScratch);
      const beamLen = Math.max(0.1, this.roverBeamDirScratch.length());
      this.roverBeamDirScratch.normalize();

      this.roverMidScratch
        .addVectors(this.roverEyeWorldScratch, this.roverAimOscScratch)
        .multiplyScalar(0.5);

      this.roverLaserGroup.visible = true;
      this.roverLaserCore.position.copy(this.roverMidScratch);
      this.roverLaserCore.scale.set(1, beamLen, 1);
      this.roverLaserCore.quaternion.setFromUnitVectors(
        this.roverUpScratch,
        this.roverBeamDirScratch
      );

      this.roverLaserGlow.position.copy(this.roverMidScratch);
      this.roverLaserGlow.scale.set(1, beamLen, 1);
      this.roverLaserGlow.quaternion.copy(this.roverLaserCore.quaternion);

      const pulse = 0.85 + 0.35 * Math.sin(this.roverPhaseElapsed * 22);
      this.roverImpactSpot.position.copy(this.roverAimOscScratch);
      this.roverImpactSpot.scale.set(pulse, pulse, pulse);
      this.roverImpactLight.position.copy(this.roverAimOscScratch);

      // Update pooled spark particles radiating from laser impact point
      for (let i = 0; i < this.roverSparkVelocities.length; i++) {
        const sp = this.roverSparkVelocities[i];
        sp.life += dt * 2.1;
        if (sp.life >= 1) sp.life -= 1;
        const l = sp.life;
        this.roverSparkPositions[i * 3] = this.roverAimOscScratch.x + sp.vx * l * 0.65;
        this.roverSparkPositions[i * 3 + 1] =
          this.roverAimOscScratch.y + (sp.vy * l - 1.4 * l * l) * 0.55;
        this.roverSparkPositions[i * 3 + 2] = this.roverAimOscScratch.z + sp.vz * l * 0.65;
      }
      this.roverSparksPoints.geometry.attributes.position.needsUpdate = true;

      if (t >= 1) {
        this.roverLaserGroup.visible = false;
        this.roverMastGroup.rotation.y = 0;
        this.roverLaserEyeMat.emissiveIntensity = 1.8;
        if (!this.roverMissionNotified && this.roverMissionTarget) {
          this.roverMissionNotified = true;
          this.callbacks.onRoverTaskComplete?.(this.roverMissionTarget);
        }
        this.roverPhase = 'returning';
        this.roverPhaseElapsed = 0;
        this.roverPhaseStartMs = nowMs;
        this.callbacks.onRoverPhaseChange?.('returning', this.roverMissionTarget?.label ?? null);
      }
    } else if (this.roverPhase === 'returning') {
      const t = Math.min(1, this.roverPhaseElapsed / returnDuration);
      const eased = t * t * (3 - 2 * t);
      const prevX = this.roverGroup.position.x;
      const prevZ = this.roverGroup.position.z;

      this.roverGroup.position.lerpVectors(this.roverStopPos, this.roverHomePos, eased);
      this.roverGroup.position.y = groundHeightAt(
        this.roverGroup.position.x,
        this.roverGroup.position.z
      );

      if (t < 0.82) {
        const dx = this.roverHomePos.x - this.roverStopPos.x;
        const dz = this.roverHomePos.z - this.roverStopPos.z;
        const returnYaw = Math.atan2(-dz, dx);
        this.roverGroup.rotation.y = this.lerpYaw(
          this.roverGroup.rotation.y,
          returnYaw,
          Math.min(1, dt * 8)
        );
      } else {
        this.roverGroup.rotation.y = this.lerpYaw(
          this.roverGroup.rotation.y,
          this.roverHomeYaw,
          Math.min(1, dt * 8)
        );
      }

      const stepDist = Math.hypot(
        this.roverGroup.position.x - prevX,
        this.roverGroup.position.z - prevZ
      );
      for (let i = 0; i < this.roverWheels.length; i++) {
        this.roverWheels[i].rotation.z -= stepDist / 0.19;
      }

      if (t >= 1) {
        this.roverGroup.position.copy(this.roverHomePos);
        this.roverGroup.rotation.y = this.roverHomeYaw;
        this.roverPhase = 'idle';
        this.roverPhaseElapsed = 0;
        this.roverMissionTarget = null;
        this.callbacks.onRoverPhaseChange?.('idle', null);
      }
    }
  }

  public dispose(): void {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.swTimerId !== null) clearTimeout(this.swTimerId);

    const dom = this.renderer?.domElement;
    if (dom) {
      dom.removeEventListener('pointerdown', this.handlePointerDown);
      dom.removeEventListener('pointerup', this.handlePointerUp);
      dom.removeEventListener('pointermove', this.handlePointerMove);
      dom.removeEventListener('webglcontextlost', this.handleContextLost);
      dom.remove();
    }
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleWindowBlur);

    this.pointerLockControls?.dispose();
    this.evaPointerLockControls?.dispose();
    this.interiorWorld?.dispose();
    this.controls?.dispose();
    this.bloomPass?.dispose();
    this.outputPass?.dispose();
    this.composer?.dispose();
    this.envRenderTarget?.dispose();
    this.interiorEnvRenderTarget?.dispose();
    this.pmremGenerator?.dispose();
    for (const item of this.disposables) {
      item.dispose();
    }
    this.disposables = [];
    this.renderer?.dispose();
  }
}
