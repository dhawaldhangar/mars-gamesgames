import * as THREE from 'three';
import {
  InteriorInteractableId,
  INTERIOR_INTERACTABLES,
} from '../game/interiorCollision';
import { MissionResources } from '../game/simulation';
import {
  createAcousticWallPbrMaps,
  createDustParticleSpriteTexture,
  createGratedDeckPbrMaps,
  createLiveTelemetryScreen,
  createProceduralNoisePbrMaps,
  LiveTelemetryScreenHandle,
} from './marsTextures';

export interface InteriorUpdateInput {
  resources: MissionResources;
  emergencyActive: boolean;
  moxieCrisisActive: boolean;
  skyColor: THREE.Color;
  zenithColor: THREE.Color;
  nightFactor: number;
}

function createSignTexture(line1: string, line2: string, borderColor: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#0B1220';
  ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, 500, 116);

  ctx.fillStyle = '#F8FAFC';
  ctx.textAlign = 'center';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText(line1, 256, 56);

  ctx.fillStyle = borderColor;
  ctx.font = 'bold 22px monospace';
  ctx.fillText(line2, 256, 94);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class HabitatInteriorWorld {
  public readonly scene: THREE.Scene;
  public readonly interactableColliders: THREE.Mesh[] = [];

  private disposables: Array<{ dispose: () => void }> = [];
  private isSoftwareGl: boolean;

  // Dynamic lights & backdrop synced with Mars atmosphere / crises
  private exteriorSkyMat!: THREE.ShaderMaterial;
  private exteriorHorizonColor = new THREE.Color('#384C66');
  private exteriorZenithColor = new THREE.Color('#0B132B');
  private moxieCrisisLight!: THREE.PointLight;
  private moxieBeaconMat!: THREE.MeshStandardMaterial;
  private moxieCoreMat!: THREE.MeshStandardMaterial;
  private moxieImpeller!: THREE.Group;
  private moxieValveWheel!: THREE.Group;
  private moxieValveSpinBoost = 0;

  // Holographic Mars Table
  private holoSpinGroup!: THREE.Group;
  private holoRingMesh!: THREE.Mesh;

  // Crewmates (Commander Maya & Flight Engineer)
  private crewmates: Array<{
    root: THREE.Group;
    head: THREE.Group;
    leftArm: THREE.Group;
    rightArm: THREE.Group;
    phase: number;
  }> = [];

  // Live Multi-Monitor Telemetry Screens
  private liveScreens: LiveTelemetryScreenHandle[] = [];
  private telemetryRedrawTimer = 0;

  // Water-Wall tanks & Bio-Dome towers + mist + interior light-beam dust motes
  private waterTankMats: THREE.MeshStandardMaterial[] = [];
  private waterTankBubbles: THREE.Mesh[] = [];
  private batteryLedMats: THREE.MeshStandardMaterial[] = [];
  private biodomeCropClusters: THREE.Group[] = [];
  private biodomeMistPoints!: THREE.Points;
  private biodomeMistPositions!: Float32Array;
  private biodomeEmeraldLight!: THREE.PointLight;
  private biodomePulseBoost = 0;

  private dustMotePoints!: THREE.Points;
  private dustMotePositions!: Float32Array;
  private dustMoteSeeds: Array<{ baseX: number; baseY: number; baseZ: number; speed: number; phase: number }> = [];

  // Shared PBR material sets
  private floorMat!: THREE.MeshStandardMaterial;
  private upperDeckMat!: THREE.MeshStandardMaterial;
  private acousticWallMat!: THREE.MeshStandardMaterial;
  private hullWhite!: THREE.MeshStandardMaterial;
  private darkTitanium!: THREE.MeshStandardMaterial;
  private cyanLedMat!: THREE.MeshStandardMaterial;
  private amberLedMat!: THREE.MeshStandardMaterial;
  private emeraldLedMat!: THREE.MeshStandardMaterial;

  // Highlight ring for looked-at / nearby interactable
  private promptHighlightRing!: THREE.Mesh;
  private promptHighlightMat!: THREE.MeshBasicMaterial;

  private totalTime = 0;

  constructor(envMap: THREE.Texture | null, isSoftwareGl: boolean) {
    this.isSoftwareGl = isSoftwareGl;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#384C66');
    if (envMap) {
      this.scene.environment = envMap;
      this.scene.environmentIntensity = 0.48;
    }

    this.initSharedMaterials();
    this.buildInteriorLighting();
    this.buildExteriorPanoramaBackdrop();
    this.buildZoneACommandDome();
    this.buildAirlockCorridors();
    this.buildZoneBMoxieBay();
    this.buildZoneCHydroponicsBiodome();
    this.buildInteriorLightBeamDustMotes();
    this.buildInteractableColliders();
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private initSharedMaterials(): void {
    const gratedDeck = createGratedDeckPbrMaps(8);
    this.track(gratedDeck.map);
    this.track(gratedDeck.bumpMap);
    this.track(gratedDeck.roughnessMap);

    const acousticWall = createAcousticWallPbrMaps(8);
    this.track(acousticWall.map);
    this.track(acousticWall.bumpMap);
    this.track(acousticWall.roughnessMap);

    const metalNoise = createProceduralNoisePbrMaps(8, {
      seed: 419,
      baseFreq: 14,
      octaves: 3,
      roughnessMin: 0.28,
      roughnessMax: 0.62,
      repeat: 2,
      streaks: true,
    });
    this.track(metalNoise.bumpMap);
    this.track(metalNoise.roughnessMap);

    this.floorMat = this.track(
      new THREE.MeshStandardMaterial({
        map: gratedDeck.map,
        bumpMap: gratedDeck.bumpMap,
        bumpScale: 0.04,
        roughnessMap: gratedDeck.roughnessMap,
        color: '#CBD5E1',
        roughness: 0.48,
        metalness: 0.56,
      })
    );

    this.upperDeckMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#334155',
        bumpMap: metalNoise.bumpMap,
        bumpScale: 0.025,
        roughnessMap: metalNoise.roughnessMap,
        roughness: 0.44,
        metalness: 0.55,
      })
    );

    this.acousticWallMat = this.track(
      new THREE.MeshStandardMaterial({
        map: acousticWall.map,
        bumpMap: acousticWall.bumpMap,
        bumpScale: 0.045,
        roughnessMap: acousticWall.roughnessMap,
        color: '#D2DBE5',
        roughness: 0.74,
        metalness: 0.06,
      })
    );

    this.hullWhite = this.track(
      new THREE.MeshStandardMaterial({
        color: '#D5DFE8',
        bumpMap: metalNoise.bumpMap,
        bumpScale: 0.02,
        roughnessMap: metalNoise.roughnessMap,
        roughness: 0.42,
        metalness: 0.28,
      })
    );

    this.darkTitanium = this.track(
      new THREE.MeshStandardMaterial({
        color: '#1E293B',
        bumpMap: metalNoise.bumpMap,
        bumpScale: 0.03,
        roughnessMap: metalNoise.roughnessMap,
        roughness: 0.34,
        metalness: 0.82,
      })
    );

    this.cyanLedMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#38BDF8',
        emissive: '#00E5FF',
        emissiveIntensity: 1.45,
        roughness: 0.2,
      })
    );

    this.amberLedMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#FBBF24',
        emissive: '#F59E0B',
        emissiveIntensity: 1.35,
        roughness: 0.22,
      })
    );

    this.emeraldLedMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#34D399',
        emissive: '#10B981',
        emissiveIntensity: 1.45,
        roughness: 0.2,
      })
    );
  }

  private buildInteriorLighting(): void {
    // Balanced warm overhead interior fill + cool cyan console glow sheltered from exterior Mars harshness
    const hemi = new THREE.HemisphereLight('#DCEBFF', '#1E2636', this.isSoftwareGl ? 0.92 : 0.72);
    this.scene.add(hemi);

    const sunThroughWindows = new THREE.DirectionalLight('#FFEEDB', 0.76);
    sunThroughWindows.position.set(16, 18, 12);
    this.scene.add(sunThroughWindows);

    // Warm overhead task illumination in Command Dome
    const warmTaskLight = new THREE.PointLight('#FFF1D6', this.isSoftwareGl ? 1.45 : 1.55, 24, 1.2);
    warmTaskLight.position.set(0, 6.2, -1.2);
    this.scene.add(warmTaskLight);

    // Cool cyan console & holo accent glow in Command Dome
    const holoConsoleGlow = new THREE.PointLight('#22D3EE', 1.1, 14, 1.35);
    holoConsoleGlow.position.set(0, 2.2, -2.5);
    this.scene.add(holoConsoleGlow);

    if (!this.isSoftwareGl) {
      const zoneBCyan = new THREE.PointLight('#38BDF8', 1.15, 18, 1.2);
      zoneBCyan.position.set(-20.0, 4.4, 0);
      this.scene.add(zoneBCyan);
    }

    // Zone B flashing red/amber crisis emergency light
    this.moxieCrisisLight = new THREE.PointLight('#FF2A2A', 0, 20, 1.2);
    this.moxieCrisisLight.position.set(-20.2, 3.8, -1.0);
    this.scene.add(this.moxieCrisisLight);

    // Zone C Hydroponics Bio-Dome rich Emerald grow light
    this.biodomeEmeraldLight = new THREE.PointLight('#10B981', 1.95, 20, 1.15);
    this.biodomeEmeraldLight.position.set(20.0, 4.5, 0);
    this.scene.add(this.biodomeEmeraldLight);
  }

  private buildExteriorPanoramaBackdrop(): void {
    const skyGeo = this.track(new THREE.SphereGeometry(120, 32, 18));
    this.exteriorSkyMat = this.track(
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          uHorizonColor: { value: this.exteriorHorizonColor },
          uZenithColor: { value: this.exteriorZenithColor },
        },
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uHorizonColor;
          uniform vec3 uZenithColor;
          varying vec3 vDir;
          void main() {
            float h = clamp(vDir.y, 0.0, 1.0);
            vec3 col = mix(uHorizonColor, uZenithColor, pow(h, 0.55));
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
    );
    const skyMesh = new THREE.Mesh(skyGeo, this.exteriorSkyMat);
    this.scene.add(skyMesh);

    // Seamless Martian terrain ground extending from under the habitat (r=0.1, y=-0.55) to crater rim (r=118)
    const groundRingGeo = this.track(new THREE.RingGeometry(0.1, 118, 72, 12));
    groundRingGeo.rotateX(-Math.PI / 2);
    const gPos = groundRingGeo.attributes.position;
    for (let i = 0; i < gPos.count; i++) {
      const x = gPos.getX(i);
      const z = gPos.getZ(i);
      const r = Math.hypot(x, z);
      const ang = Math.atan2(z, x);
      let yOffset = -0.55;
      if (r > 24 && r <= 56) {
        const duneT = Math.min(1, (r - 24) / 10);
        const dunes =
          (Math.sin(x * 0.14) * Math.cos(z * 0.14) * 0.45 +
            Math.sin(x * 0.08 + z * 0.06) * 0.35) *
          duneT;
        yOffset = -0.45 + dunes;
      } else if (r > 56) {
        const rimT = (r - 56) / 62;
        const rim =
          rimT *
          (6.5 + 3.4 * Math.sin(ang * 5.0) + 1.9 * Math.cos(ang * 11.0) + Math.sin(ang * 2.0) * 1.4);
        yOffset = -0.45 + rim;
      }
      gPos.setY(i, yOffset);
    }
    groundRingGeo.computeVertexNormals();
    const groundNoise = createProceduralNoisePbrMaps(8, {
      seed: 733,
      baseFreq: 18,
      octaves: 4,
      roughnessMin: 0.84,
      roughnessMax: 0.98,
      repeat: 10,
    });
    this.track(groundNoise.bumpMap);
    this.track(groundNoise.roughnessMap);
    const marsGroundMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#9C4D30',
        bumpMap: groundNoise.bumpMap,
        bumpScale: 0.16,
        roughnessMap: groundNoise.roughnessMap,
        roughness: 0.94,
        metalness: 0.02,
      })
    );
    const outerTerrain = new THREE.Mesh(groundRingGeo, marsGroundMat);
    this.scene.add(outerTerrain);
  }

  private addPressurizedHatchPortal(
    x: number,
    z: number,
    rotY: number,
    accentMat: THREE.Material
  ): void {
    const portal = new THREE.Group();
    portal.position.set(x, 0, z);
    portal.rotation.y = rotY;

    // Thick armored bulkhead surround
    const frameLeft = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.32, 2.95, 0.46)),
      this.darkTitanium
    );
    frameLeft.position.set(-1.32, 1.48, 0);
    const frameRight = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.32, 2.95, 0.46)),
      this.darkTitanium
    );
    frameRight.position.set(1.32, 1.48, 0);
    const frameHeader = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(2.96, 0.36, 0.48)),
      this.darkTitanium
    );
    frameHeader.position.set(0, 2.86, 0);
    portal.add(frameLeft, frameRight, frameHeader);

    // Chamfered heavy pressurized inner ring
    const ringArch = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(1.22, 0.09, 10, 24, Math.PI)),
      this.hullWhite
    );
    ringArch.position.set(0, 1.65, 0);
    portal.add(ringArch);

    // Retracted split sliding blast door leaves on both jambs + locking dog-latches
    const leafGeo = this.track(new THREE.BoxGeometry(0.32, 2.45, 0.24));
    const latchGeo = this.track(new THREE.CylinderGeometry(0.055, 0.055, 0.28, 8));
    latchGeo.rotateX(Math.PI / 2);
    for (const side of [-1, 1]) {
      const leaf = new THREE.Mesh(leafGeo, this.hullWhite);
      leaf.position.set(side * 1.05, 1.24, 0);
      portal.add(leaf);

      for (const ly of [0.7, 1.4, 2.1]) {
        const latch = new THREE.Mesh(latchGeo, this.amberLedMat);
        latch.position.set(side * 0.94, ly, 0);
        portal.add(latch);
      }
    }

    // Illuminated LED portal frame strips
    const stripSideGeo = this.track(new THREE.BoxGeometry(0.06, 2.52, 0.5));
    const leftLed = new THREE.Mesh(stripSideGeo, accentMat);
    leftLed.position.set(-1.16, 1.32, 0);
    const rightLed = new THREE.Mesh(stripSideGeo, accentMat);
    rightLed.position.set(1.16, 1.32, 0);
    const topLed = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(2.38, 0.06, 0.52)),
      accentMat
    );
    topLed.position.set(0, 2.68, 0);
    portal.add(leftLed, rightLed, topLed);

    this.scene.add(portal);
  }

  private buildCurvedTelemetryDesk(opts: {
    x: number;
    z: number;
    rotY: number;
    accentHex: string;
    centerTitle: string;
    centerSub: string;
    leftTitle: string;
    rightTitle: string;
    leftMode: 'power' | 'life' | 'health' | 'water' | 'rover';
    centerMode: 'power' | 'life' | 'health' | 'water' | 'rover';
    rightMode: 'power' | 'life' | 'health' | 'water' | 'rover';
    wide?: boolean;
  }): void {
    const deskGroup = new THREE.Group();
    deskGroup.position.set(opts.x, 0, opts.z);
    deskGroup.rotation.y = opts.rotY;

    const scaleX = opts.wide ? 1.15 : 1.0;

    // Angled modular desk pedestal + beveled work surface
    const deskBase = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(2.2 * scaleX, 0.94, 0.84)),
      this.acousticWallMat
    );
    deskBase.position.y = 0.47;
    deskGroup.add(deskBase);

    const deskTop = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(2.36 * scaleX, 0.08, 0.96)),
      this.darkTitanium
    );
    deskTop.position.y = 0.98;
    deskGroup.add(deskTop);

    // Front glowing floor under-desk LED trim
    const floorLed = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(2.1 * scaleX, 0.035, 0.06)),
      opts.accentHex === '#F59E0B' ? this.amberLedMat : this.cyanLedMat
    );
    floorLed.position.set(0, 0.03, 0.45);
    deskGroup.add(floorLed);

    // Slanted keyboard / tactical control deck pad
    const keyDeck = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.55 * scaleX, 0.05, 0.34)),
      this.darkTitanium
    );
    keyDeck.position.set(0, 1.04, 0.18);
    keyDeck.rotation.x = 0.14;
    deskGroup.add(keyDeck);

    // Curved 3-panel multi-monitor telemetry rig (center + angled left & right wing monitors)
    const monitorPanels: Array<{
      ox: number;
      oz: number;
      yaw: number;
      w: number;
      h: number;
      title: string;
      sub: string;
      mode: 'power' | 'life' | 'health' | 'water' | 'rover';
    }> = [
      {
        ox: 0,
        oz: -0.22,
        yaw: 0,
        w: 1.06 * scaleX,
        h: 0.66,
        title: opts.centerTitle,
        sub: opts.centerSub,
        mode: opts.centerMode,
      },
      {
        ox: -0.94 * scaleX,
        oz: -0.04,
        yaw: 0.42,
        w: 0.84 * scaleX,
        h: 0.62,
        title: opts.leftTitle,
        sub: 'LIVE WAVEFORM',
        mode: opts.leftMode,
      },
      {
        ox: 0.94 * scaleX,
        oz: -0.04,
        yaw: -0.42,
        w: 0.84 * scaleX,
        h: 0.62,
        title: opts.rightTitle,
        sub: 'LIVE WAVEFORM',
        mode: opts.rightMode,
      },
    ];

    monitorPanels.forEach((p) => {
      const holder = new THREE.Group();
      holder.position.set(p.ox, 1.48, p.oz);
      holder.rotation.y = p.yaw;
      holder.rotation.x = 0.14;

      const bezel = new THREE.Mesh(
        this.track(new THREE.BoxGeometry(p.w + 0.08, p.h + 0.08, 0.06)),
        this.darkTitanium
      );
      holder.add(bezel);

      const liveScreen = createLiveTelemetryScreen(p.title, p.sub, opts.accentHex, p.mode);
      this.track(liveScreen.texture);
      this.liveScreens.push(liveScreen);

      const screenMat = this.track(
        new THREE.MeshBasicMaterial({
          map: liveScreen.texture,
          color: '#CBD5E1',
        })
      );
      const screenMesh = new THREE.Mesh(
        this.track(new THREE.PlaneGeometry(p.w, p.h)),
        screenMat
      );
      screenMesh.position.z = 0.036;
      holder.add(screenMesh);

      deskGroup.add(holder);
    });

    this.scene.add(deskGroup);
  }

  private buildZoneACommandDome(): void {
    // Main circular grated metallic deck (r = 9.0)
    const mainFloor = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(9.0, 9.0, 0.2, 48)),
      this.floorMat
    );
    mainFloor.position.y = -0.1;
    this.scene.add(mainFloor);

    // Raised outer gallery ring (r = 6.55..8.95)
    const outerRing = new THREE.Mesh(
      this.track(new THREE.RingGeometry(6.55, 8.95, 48)),
      this.upperDeckMat
    );
    outerRing.rotation.x = -Math.PI / 2;
    outerRing.position.y = 0.03;
    this.scene.add(outerRing);

    // Floor-level cyan & amber LED strip lighting rings + walkway guide strips
    const holoFloorRing = new THREE.Mesh(
      this.track(new THREE.RingGeometry(1.98, 2.12, 40)),
      this.cyanLedMat
    );
    holoFloorRing.rotation.x = -Math.PI / 2;
    holoFloorRing.position.y = 0.025;
    this.scene.add(holoFloorRing);

    const galleryLedRing = new THREE.Mesh(
      this.track(new THREE.RingGeometry(6.48, 6.56, 48)),
      this.amberLedMat
    );
    galleryLedRing.rotation.x = -Math.PI / 2;
    galleryLedRing.position.y = 0.035;
    this.scene.add(galleryLedRing);

    // Segmented padded acoustic knee walls + structural pillars + panoramic viewport glazing
    const segCount = 24;
    const wallSegGeo = this.track(new THREE.BoxGeometry(2.45, 1.38, 0.36));
    const pillarGeo = this.track(new THREE.BoxGeometry(0.28, 3.45, 0.38));
    const windowGlassMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#BAE6FD',
        transparent: true,
        opacity: 0.14,
        roughness: 0.12,
        metalness: 0.1,
        depthWrite: false,
      })
    );
    const windowPaneGeo = this.track(new THREE.BoxGeometry(2.35, 1.98, 0.08));

    for (let i = 0; i < segCount; i++) {
      const ang = (i / segCount) * Math.PI * 2;
      const wx = Math.cos(ang) * 8.75;
      const wz = Math.sin(ang) * 8.75;

      const isWestPortal = wx < -6.5 && Math.abs(wz) < 2.25;
      const isEastPortal = wx > 6.5 && Math.abs(wz) < 2.25;
      if (isWestPortal || isEastPortal) continue;

      const wall = new THREE.Mesh(wallSegGeo, this.acousticWallMat);
      wall.position.set(wx, 0.69, wz);
      wall.rotation.y = -ang + Math.PI / 2;
      this.scene.add(wall);

      const pillar = new THREE.Mesh(pillarGeo, this.darkTitanium);
      pillar.position.set(Math.cos(ang + 0.13) * 8.78, 1.72, Math.sin(ang + 0.13) * 8.78);
      pillar.rotation.y = -(ang + 0.13) + Math.PI / 2;
      this.scene.add(pillar);

      const pane = new THREE.Mesh(windowPaneGeo, windowGlassMat);
      pane.position.set(wx, 2.36, wz);
      pane.rotation.y = -ang + Math.PI / 2;
      this.scene.add(pane);
    }

    // Illuminated Blue Water-Wall Radiation Shielding Tanks lining the Zone A outer perimeter walls (r = 8.28)
    const perimeterTankCapGeo = this.track(new THREE.CylinderGeometry(0.28, 0.3, 0.14, 12));
    const perimeterTankBodyGeo = this.track(new THREE.CylinderGeometry(0.23, 0.23, 1.18, 14));
    const perimeterTankMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#0EA5E9',
        emissive: '#0369A1',
        emissiveIntensity: 0.32,
        transparent: true,
        opacity: 0.78,
        roughness: 0.16,
        metalness: 0.18,
      })
    );
    this.waterTankMats.push(perimeterTankMat);

    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2 + 0.12;
      const tx = Math.cos(ang) * 8.26;
      const tz = Math.sin(ang) * 8.26;
      // Keep West/East corridors, South Airlock Exit, and North Rover Terminal bay clear
      if (Math.abs(tz) < 2.4 && Math.abs(tx) > 6.0) continue;
      if (tz > 6.4 && Math.abs(tx) < 2.2) continue;
      if (tz < -5.8 && Math.abs(tx) < 2.2) continue;

      const tGroup = new THREE.Group();
      tGroup.position.set(tx, 0, tz);

      const botCap = new THREE.Mesh(perimeterTankCapGeo, this.darkTitanium);
      botCap.position.y = 0.08;
      const topCap = new THREE.Mesh(perimeterTankCapGeo, this.darkTitanium);
      topCap.position.y = 1.38;
      const body = new THREE.Mesh(perimeterTankBodyGeo, perimeterTankMat);
      body.position.y = 0.73;

      tGroup.add(botCap, topCap, body);
      this.scene.add(tGroup);
    }

    // Upper fascia ring & curved geodesic structural ribs + purlin rings along dome ceiling
    const fasciaRing = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(8.8, 0.24, 10, 48)),
      this.hullWhite
    );
    fasciaRing.rotation.x = Math.PI / 2;
    fasciaRing.position.y = 3.45;
    this.scene.add(fasciaRing);

    const domeCeilingShellMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#E2E8F0',
        roughness: 0.42,
        metalness: 0.22,
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.34,
      })
    );
    const domeShell = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(8.85, 32, 14, 0, Math.PI * 2, 0, Math.PI * 0.5)),
      domeCeilingShellMat
    );
    domeShell.position.y = 3.45;
    domeShell.scale.set(1, 0.62, 1);
    this.scene.add(domeShell);

    // 8 thick curved structural ceiling ribs
    for (let i = 0; i < 8; i++) {
      const rib = new THREE.Mesh(
        this.track(new THREE.TorusGeometry(8.72, 0.125, 8, 36, Math.PI)),
        this.darkTitanium
      );
      rib.position.y = 3.45;
      rib.scale.set(1, 0.62, 1);
      rib.rotation.y = (i / 8) * Math.PI;
      this.scene.add(rib);
    }

    // Concentric ceiling purlin rings & overhead utility conduits
    const purlinRing1 = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(7.2, 0.085, 8, 40)),
      this.hullWhite
    );
    purlinRing1.rotation.x = Math.PI / 2;
    purlinRing1.position.y = 6.35;
    this.scene.add(purlinRing1);

    // Glowing overhead LED task halo ring in Command Dome
    const ceilingRing = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(4.85, 0.095, 8, 36)),
      this.cyanLedMat
    );
    ceilingRing.rotation.x = Math.PI / 2;
    ceilingRing.position.y = 7.75;
    this.scene.add(ceilingRing);

    // Overhead volumetric light shaft cones descending toward center tactical table
    const beamConeMat = this.track(
      new THREE.MeshBasicMaterial({
        color: '#E0F2FE',
        transparent: true,
        opacity: 0.045,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    const beamCone = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.9, 3.6, 5.4, 20, 1, true)),
      beamConeMat
    );
    beamCone.position.set(0, 4.95, 0);
    this.scene.add(beamCone);

    // Pressurized Airlock Hatches at West (MOXIE) and East (Bio-Dome) portals + South Exit
    this.addPressurizedHatchPortal(-8.45, 0, Math.PI / 2, this.cyanLedMat);
    this.addPressurizedHatchPortal(8.45, 0, -Math.PI / 2, this.emeraldLedMat);

    // Directional Bay Signage over West (MOXIE) and East (Bio-Dome) portals
    const westSignMat = this.track(
      new THREE.MeshBasicMaterial({
        map: this.track(createSignTexture('ZONE B: MOXIE BAY', '<- LIFE SUPPORT & WATER-WALL', '#22D3EE')),
      })
    );
    const westSign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(2.6, 0.65)), westSignMat);
    westSign.position.set(-8.12, 3.22, 0);
    westSign.rotation.y = Math.PI / 2;
    this.scene.add(westSign);

    const eastSignMat = this.track(
      new THREE.MeshBasicMaterial({
        map: this.track(createSignTexture('ZONE C: BIO-DOME', 'HYDROPONICS & CROPS ->', '#10B981')),
      })
    );
    const eastSign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(2.6, 0.65)), eastSignMat);
    eastSign.position.set(8.12, 3.22, 0);
    eastSign.rotation.y = -Math.PI / 2;
    this.scene.add(eastSign);

    // South Airlock Exit Hatch (z = +8.45)
    const airlockFrame = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(2.35, 2.8, 0.44)),
      this.darkTitanium
    );
    airlockFrame.position.set(0, 1.4, 8.45);
    this.scene.add(airlockFrame);

    const airlockDoor = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.65, 2.35, 0.48)),
      this.hullWhite
    );
    airlockDoor.position.set(0, 1.22, 8.45);
    this.scene.add(airlockDoor);

    const airlockDoorRing = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(0.45, 0.045, 8, 18)),
      this.amberLedMat
    );
    airlockDoorRing.position.set(0, 1.35, 8.2);
    this.scene.add(airlockDoorRing);

    const exitSignMat = this.track(
      new THREE.MeshBasicMaterial({
        map: this.track(createSignTexture('MAIN AIRLOCK', '[E] EXIT TO EXTERIOR', '#F59E0B')),
      })
    );
    const exitSign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(2.2, 0.56)), exitSignMat);
    exitSign.position.set(0, 2.95, 8.18);
    exitSign.rotation.y = Math.PI;
    this.scene.add(exitSign);

    // ------------------------------------------------------------------
    // CENTRAL HOLOGRAPHIC MARS TACTICAL TABLE (0, 0, 0)
    // ------------------------------------------------------------------
    const tableGroup = new THREE.Group();
    const pedestal = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(1.38, 1.56, 0.96, 18)),
      this.acousticWallMat
    );
    pedestal.position.y = 0.48;
    tableGroup.add(pedestal);

    const rimTable = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(1.42, 0.085, 10, 32)),
      this.darkTitanium
    );
    rimTable.rotation.x = Math.PI / 2;
    rimTable.position.y = 0.98;
    tableGroup.add(rimTable);

    const emitterGlassMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#0B2538',
        emissive: '#0891B2',
        emissiveIntensity: 0.28,
        roughness: 0.16,
        metalness: 0.3,
      })
    );
    const emitterGlass = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(1.26, 1.26, 0.04, 28)),
      emitterGlassMat
    );
    emitterGlass.position.y = 0.99;
    tableGroup.add(emitterGlass);

    const emitterTrimRing = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(1.25, 0.025, 8, 32)),
      this.cyanLedMat
    );
    emitterTrimRing.rotation.x = Math.PI / 2;
    emitterTrimRing.position.y = 1.015;
    tableGroup.add(emitterTrimRing);

    this.holoSpinGroup = new THREE.Group();
    this.holoSpinGroup.position.y = 1.36;

    const holoTerrainGeo = this.track(new THREE.CylinderGeometry(1.08, 1.12, 0.24, 28, 4));
    const hPos = holoTerrainGeo.attributes.position;
    for (let i = 0; i < hPos.count; i++) {
      const vx = hPos.getX(i);
      const vy = hPos.getY(i);
      const vz = hPos.getZ(i);
      if (vy > 0.05) {
        const r = Math.hypot(vx, vz);
        const rimBoost = r > 0.75 ? (r - 0.75) * 0.65 : 0;
        const deltaRidge = Math.sin(vx * 4.2) * Math.cos(vz * 4.2) * 0.08;
        hPos.setY(i, vy + rimBoost + deltaRidge);
      }
    }
    holoTerrainGeo.computeVertexNormals();
    const holoMat = this.track(
      new THREE.MeshBasicMaterial({
        color: '#22D3EE',
        wireframe: true,
        transparent: true,
        opacity: 0.78,
      })
    );
    const holoMapMesh = new THREE.Mesh(holoTerrainGeo, holoMat);
    this.holoSpinGroup.add(holoMapMesh);

    const holoOutpostPin = new THREE.Mesh(
      this.track(new THREE.OctahedronGeometry(0.12, 0)),
      this.track(
        new THREE.MeshBasicMaterial({ color: '#F59E0B', transparent: true, opacity: 0.95 })
      )
    );
    holoOutpostPin.position.y = 0.36;
    this.holoSpinGroup.add(holoOutpostPin);

    this.holoRingMesh = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(1.24, 0.028, 8, 36)),
      this.track(new THREE.MeshBasicMaterial({ color: '#38BDF8', transparent: true, opacity: 0.72 }))
    );
    this.holoRingMesh.rotation.x = Math.PI / 2;
    this.holoSpinGroup.add(this.holoRingMesh);

    tableGroup.add(this.holoSpinGroup);
    this.scene.add(tableGroup);

    // ------------------------------------------------------------------
    // CURVED MULTI-MONITOR ROVER CONTROL TERMINAL DESK (0, 0, -5.8)
    // ------------------------------------------------------------------
    this.buildCurvedTelemetryDesk({
      x: 0,
      z: -5.8,
      rotY: 0,
      accentHex: '#22D3EE',
      centerTitle: 'ROVER // FHAZ',
      centerSub: 'PRESS [E] CAM & DEPLOY',
      leftTitle: 'ARRAY kWh',
      rightTitle: 'WATER-WALL',
      leftMode: 'power',
      centerMode: 'rover',
      rightMode: 'water',
      wide: true,
    });

    // ------------------------------------------------------------------
    // 2 CURVED MULTI-MONITOR CREW CONSOLES + ANIMATED ASTRONAUTS
    // ------------------------------------------------------------------
    const buildCrewStation = (
      x: number,
      z: number,
      rotY: number,
      stripeHex: string,
      screenTitle: string,
      leftMode: 'power' | 'life' | 'health' | 'water' | 'rover',
      centerMode: 'power' | 'life' | 'health' | 'water' | 'rover',
      rightMode: 'power' | 'life' | 'health' | 'water' | 'rover',
      phase: number
    ) => {
      this.buildCurvedTelemetryDesk({
        x,
        z,
        rotY,
        accentHex: stripeHex,
        centerTitle: screenTitle,
        centerSub: 'TELEMETRY LINK ACTIVE',
        leftTitle: leftMode === 'power' ? 'GRID LOAD' : 'O2 PARTIAL',
        rightTitle: rightMode === 'health' ? 'CREW RAD' : 'SHIELD CM',
        leftMode,
        centerMode,
        rightMode,
      });

      const suitMat = this.hullWhite;
      const stripeMat = this.track(
        new THREE.MeshStandardMaterial({
          color: stripeHex,
          emissive: stripeHex,
          emissiveIntensity: 0.12,
          roughness: 0.38,
        })
      );
      const visorMat = this.track(
        new THREE.MeshStandardMaterial({
          color: '#F59E0B',
          roughness: 0.12,
          metalness: 0.92,
        })
      );

      const crewRoot = new THREE.Group();
      const dirX = Math.sin(rotY);
      const dirZ = Math.cos(rotY);
      crewRoot.position.set(x + dirX * 1.0, 0, z + dirZ * 1.0);
      crewRoot.rotation.y = rotY + Math.PI;

      const legGeo = this.track(new THREE.CylinderGeometry(0.1, 0.12, 0.76, 8));
      const leftLeg = new THREE.Mesh(legGeo, suitMat);
      leftLeg.position.set(-0.15, 0.38, 0);
      const rightLeg = new THREE.Mesh(legGeo, suitMat);
      rightLeg.position.set(0.15, 0.38, 0);
      crewRoot.add(leftLeg, rightLeg);

      const torso = new THREE.Mesh(
        this.track(new THREE.BoxGeometry(0.46, 0.56, 0.28)),
        suitMat
      );
      torso.position.y = 1.04;
      crewRoot.add(torso);

      const chestBand = new THREE.Mesh(
        this.track(new THREE.BoxGeometry(0.48, 0.14, 0.3)),
        stripeMat
      );
      chestBand.position.y = 1.12;
      crewRoot.add(chestBand);

      const backpack = new THREE.Mesh(
        this.track(new THREE.BoxGeometry(0.36, 0.46, 0.18)),
        this.darkTitanium
      );
      backpack.position.set(0, 1.06, -0.2);
      crewRoot.add(backpack);

      const headGroup = new THREE.Group();
      headGroup.position.set(0, 1.48, 0);
      const helmet = new THREE.Mesh(
        this.track(new THREE.SphereGeometry(0.2, 12, 10)),
        suitMat
      );
      headGroup.add(helmet);
      const visor = new THREE.Mesh(
        this.track(new THREE.SphereGeometry(0.175, 10, 8, 0, Math.PI, 0.2, 1.1)),
        visorMat
      );
      visor.position.set(0, 0.02, 0.055);
      headGroup.add(visor);
      crewRoot.add(headGroup);

      const armGeo = this.track(new THREE.CylinderGeometry(0.075, 0.08, 0.48, 8));
      armGeo.translate(0, -0.2, 0);

      const leftArm = new THREE.Group();
      leftArm.position.set(-0.3, 1.24, 0.04);
      leftArm.rotation.x = -0.92;
      leftArm.add(new THREE.Mesh(armGeo, suitMat));
      crewRoot.add(leftArm);

      const rightArm = new THREE.Group();
      rightArm.position.set(0.3, 1.24, 0.04);
      rightArm.rotation.x = -0.92;
      rightArm.add(new THREE.Mesh(armGeo, suitMat));
      crewRoot.add(rightArm);

      this.scene.add(crewRoot);
      this.crewmates.push({ root: crewRoot, head: headGroup, leftArm, rightArm, phase });
    };

    buildCrewStation(-4.35, -4.15, 0.52, '#F59E0B', 'CMDR MAYA // OPS', 'power', 'life', 'health', 0.0);
    buildCrewStation(4.35, -4.15, -0.52, '#22D3EE', 'FLIGHT ENG // ISRU', 'life', 'power', 'water', 2.2);
  }

  private buildAirlockCorridors(): void {
    const buildCorridor = (startX: number, endX: number, accentMat: THREE.Material) => {
      const length = Math.abs(endX - startX);
      const midX = (startX + endX) * 0.5;

      // Grated metallic floor & acoustic ceiling slabs
      const floor = new THREE.Mesh(
        this.track(new THREE.BoxGeometry(length, 0.18, 3.6)),
        this.floorMat
      );
      floor.position.set(midX, -0.09, 0);
      this.scene.add(floor);

      // Floor-level center & side cyan/amber LED strip lighting
      const guide = new THREE.Mesh(
        this.track(new THREE.BoxGeometry(length - 0.6, 0.03, 0.18)),
        accentMat
      );
      guide.position.set(midX, 0.02, 0);
      this.scene.add(guide);

      for (const sideZ of [-1.45, 1.45]) {
        const sideLed = new THREE.Mesh(
          this.track(new THREE.BoxGeometry(length - 0.6, 0.03, 0.06)),
          this.amberLedMat
        );
        sideLed.position.set(midX, 0.025, sideZ);
        this.scene.add(sideLed);
      }

      const ceiling = new THREE.Mesh(
        this.track(new THREE.BoxGeometry(length, 0.22, 3.6)),
        this.acousticWallMat
      );
      ceiling.position.set(midX, 3.25, 0);
      this.scene.add(ceiling);

      // Padded acoustic corridor walls
      const wallGeo = this.track(new THREE.BoxGeometry(length, 3.25, 0.22));
      const northWall = new THREE.Mesh(wallGeo, this.acousticWallMat);
      northWall.position.set(midX, 1.62, -1.75);
      const southWall = new THREE.Mesh(wallGeo, this.acousticWallMat);
      southWall.position.set(midX, 1.62, 1.75);
      this.scene.add(northWall, southWall);

      // Pressurized bulkhead arch ribs
      const ribCount = 5;
      for (let i = 0; i < ribCount; i++) {
        const rx = startX + ((endX - startX) * (i + 0.5)) / ribCount;
        const leftPost = new THREE.Mesh(
          this.track(new THREE.BoxGeometry(0.24, 3.15, 0.22)),
          this.darkTitanium
        );
        leftPost.position.set(rx, 1.58, -1.56);
        const rightPost = new THREE.Mesh(
          this.track(new THREE.BoxGeometry(0.24, 3.15, 0.22)),
          this.darkTitanium
        );
        rightPost.position.set(rx, 1.58, 1.56);
        const topBeam = new THREE.Mesh(
          this.track(new THREE.BoxGeometry(0.24, 0.24, 3.34)),
          this.darkTitanium
        );
        topBeam.position.set(rx, 3.04, 0);
        const lightStrip = new THREE.Mesh(
          this.track(new THREE.BoxGeometry(0.14, 0.07, 2.2)),
          accentMat
        );
        lightStrip.position.set(rx, 2.9, 0);
        this.scene.add(leftPost, rightPost, topBeam, lightStrip);
      }
    };

    buildCorridor(-15.8, -7.8, this.cyanLedMat);
    buildCorridor(7.8, 15.8, this.emeraldLedMat);
  }

  private buildZoneBMoxieBay(): void {
    const cx = -20.0;

    // Grated deck floor + floor LED perimeter trim
    const floor = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(5.8, 5.8, 0.2, 32)),
      this.floorMat
    );
    floor.position.set(cx, -0.1, 0);
    this.scene.add(floor);

    const floorLed = new THREE.Mesh(
      this.track(new THREE.RingGeometry(4.95, 5.05, 36)),
      this.cyanLedMat
    );
    floorLed.rotation.x = -Math.PI / 2;
    floorLed.position.set(cx, 0.02, 0);
    this.scene.add(floorLed);

    // Acoustic padded bay walls (skip East corridor portal opening)
    const wallCount = 16;
    const wallGeo = this.track(new THREE.BoxGeometry(2.35, 3.6, 0.3));
    for (let i = 0; i < wallCount; i++) {
      const ang = (i / wallCount) * Math.PI * 2;
      const wx = cx + Math.cos(ang) * 5.65;
      const wz = Math.sin(ang) * 5.65;
      if (wx > cx + 4.3 && Math.abs(wz) < 2.05) continue;
      const wall = new THREE.Mesh(wallGeo, this.acousticWallMat);
      wall.position.set(wx, 1.8, wz);
      wall.rotation.y = -ang + Math.PI / 2;
      this.scene.add(wall);
    }

    // Domed industrial ceiling cap with curved structural beams
    const ceiling = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(5.2, 5.8, 1.4, 24)),
      this.darkTitanium
    );
    ceiling.position.set(cx, 4.3, 0);
    this.scene.add(ceiling);

    // Pressurized hatch at West Corridor -> Zone B entrance
    this.addPressurizedHatchPortal(-15.1, 0, Math.PI / 2, this.cyanLedMat);

    // ------------------------------------------------------------------
    // PHYSICAL MOXIE OXYGEN GENERATOR MACHINE (-21.6, 0, -1.5)
    // ------------------------------------------------------------------
    const moxieGroup = new THREE.Group();
    moxieGroup.position.set(-21.6, 0, -1.5);
    moxieGroup.rotation.y = 0.45;

    const moxieSkid = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(2.3, 0.24, 1.7)),
      this.darkTitanium
    );
    moxieSkid.position.y = 0.12;
    moxieGroup.add(moxieSkid);

    const moxieCabinet = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.9, 1.95, 1.35)),
      this.hullWhite
    );
    moxieCabinet.position.y = 1.2;
    moxieGroup.add(moxieCabinet);

    this.moxieCoreMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#22D3EE',
        emissive: '#06B6D4',
        emissiveIntensity: 0.55,
        roughness: 0.22,
      })
    );
    const electrolysisCore = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.36, 0.36, 1.15, 14)),
      this.moxieCoreMat
    );
    electrolysisCore.position.set(-0.35, 1.28, 0.62);
    moxieGroup.add(electrolysisCore);

    // Spinning CO2 Intake Impeller on front-top
    this.moxieImpeller = new THREE.Group();
    this.moxieImpeller.position.set(0.45, 2.25, 0);
    const bladeGeo = this.track(new THREE.BoxGeometry(0.75, 0.06, 0.14));
    const bladeMat = this.track(
      new THREE.MeshStandardMaterial({ color: '#F59E0B', roughness: 0.3, metalness: 0.6 })
    );
    const b1 = new THREE.Mesh(bladeGeo, bladeMat);
    const b2 = new THREE.Mesh(bladeGeo, bladeMat);
    b2.rotation.y = Math.PI / 2;
    this.moxieImpeller.add(b1, b2);
    moxieGroup.add(this.moxieImpeller);

    // Red/Amber Manual Intake Valve Wheel (spins on [E] manual repair)
    this.moxieValveWheel = new THREE.Group();
    this.moxieValveWheel.position.set(0.42, 1.28, 0.72);
    const valveRim = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(0.24, 0.045, 8, 18)),
      this.track(
        new THREE.MeshStandardMaterial({
          color: '#EF4444',
          emissive: '#B91C1C',
          emissiveIntensity: 0.25,
          roughness: 0.34,
        })
      )
    );
    const valveSpoke = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.44, 0.05, 0.05)),
      this.darkTitanium
    );
    const valveSpoke2 = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.05, 0.44, 0.05)),
      this.darkTitanium
    );
    this.moxieValveWheel.add(valveRim, valveSpoke, valveSpoke2);
    moxieGroup.add(this.moxieValveWheel);

    // Emergency alarm beacon dome atop MOXIE unit
    this.moxieBeaconMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#22D3EE',
        emissive: '#06B6D4',
        emissiveIntensity: 1.25,
        roughness: 0.18,
      })
    );
    const alarmBeacon = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.18, 12, 10)),
      this.moxieBeaconMat
    );
    alarmBeacon.position.set(-0.62, 2.34, 0.35);
    moxieGroup.add(alarmBeacon);

    const moxieLabel = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(1.3, 0.42)),
      this.track(
        new THREE.MeshBasicMaterial({
          map: this.track(createSignTexture('MOXIE O2 UNIT', '[E] REPAIR VALVE', '#22D3EE')),
        })
      )
    );
    moxieLabel.position.set(0, 2.65, 0.45);
    moxieGroup.add(moxieLabel);

    this.scene.add(moxieGroup);

    // ------------------------------------------------------------------
    // GLOWING CYAN WATER-WALL SHIELDING TANKS
    // ------------------------------------------------------------------
    const tankPositions: Array<[number, number]> = [
      [-18.5, -4.0],
      [-22.2, 2.3],
    ];
    tankPositions.forEach(([tx, tz], idx) => {
      const tankGroup = new THREE.Group();
      tankGroup.position.set(tx, 0, tz);

      const capGeo = this.track(new THREE.CylinderGeometry(0.68, 0.72, 0.25, 16));
      const baseCap = new THREE.Mesh(capGeo, this.darkTitanium);
      baseCap.position.y = 0.125;
      const topCap = new THREE.Mesh(capGeo, this.darkTitanium);
      topCap.position.y = 2.68;
      tankGroup.add(baseCap, topCap);

      const waterMat = this.track(
        new THREE.MeshStandardMaterial({
          color: '#0EA5E9',
          emissive: '#0369A1',
          emissiveIntensity: 0.35,
          transparent: true,
          opacity: 0.76,
          roughness: 0.16,
          metalness: 0.2,
        })
      );
      this.waterTankMats.push(waterMat);

      const col = new THREE.Mesh(
        this.track(new THREE.CylinderGeometry(0.58, 0.58, 2.35, 18)),
        waterMat
      );
      col.position.y = 1.4;
      tankGroup.add(col);

      const bMat = this.track(
        new THREE.MeshBasicMaterial({ color: '#E0F2FE', transparent: true, opacity: 0.85 })
      );
      for (let b = 0; b < 4; b++) {
        const bubble = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.08, 8, 8)), bMat);
        bubble.position.set(
          Math.cos(b * 1.7 + idx) * 0.24,
          0.45 + b * 0.52,
          Math.sin(b * 1.7 + idx) * 0.24
        );
        bubble.userData.baseY = 0.45;
        this.waterTankBubbles.push(bubble);
        tankGroup.add(bubble);
      }

      this.scene.add(tankGroup);
    });

    // ------------------------------------------------------------------
    // BATTERY STORAGE RACKS (-17.6, 0, 3.6)
    // ------------------------------------------------------------------
    const rackGroup = new THREE.Group();
    rackGroup.position.set(-17.6, 0, 3.6);
    rackGroup.rotation.y = -0.55;
    const cabinet = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.5, 2.15, 0.85)),
      this.darkTitanium
    );
    cabinet.position.y = 1.08;
    rackGroup.add(cabinet);

    for (let i = 0; i < 4; i++) {
      const ledMat = this.track(
        new THREE.MeshStandardMaterial({
          color: '#10B981',
          emissive: '#10B981',
          emissiveIntensity: 1.1,
        })
      );
      this.batteryLedMats.push(ledMat);
      const ledBar = new THREE.Mesh(
        this.track(new THREE.BoxGeometry(1.15, 0.14, 0.06)),
        ledMat
      );
      ledBar.position.set(0, 0.48 + i * 0.42, 0.43);
      rackGroup.add(ledBar);
    }
    this.scene.add(rackGroup);
  }

  private buildZoneCHydroponicsBiodome(): void {
    const cx = 20.0;

    // Grated floor + emerald perimeter LED trim
    const floor = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(6.0, 6.0, 0.2, 32)),
      this.floorMat
    );
    floor.position.set(cx, -0.1, 0);
    this.scene.add(floor);

    const floorLed = new THREE.Mesh(
      this.track(new THREE.RingGeometry(5.15, 5.25, 40)),
      this.emeraldLedMat
    );
    floorLed.rotation.x = -Math.PI / 2;
    floorLed.position.set(cx, 0.02, 0);
    this.scene.add(floorLed);

    // Pressurized hatch at East Corridor -> Bio-Dome entrance
    this.addPressurizedHatchPortal(15.1, 0, -Math.PI / 2, this.emeraldLedMat);

    // Lower acoustic padded knee wall around Bio-Dome (skip West corridor opening)
    const wallCount = 16;
    const wallGeo = this.track(new THREE.BoxGeometry(2.4, 1.35, 0.3));
    for (let i = 0; i < wallCount; i++) {
      const ang = (i / wallCount) * Math.PI * 2;
      const wx = cx + Math.cos(ang) * 5.85;
      const wz = Math.sin(ang) * 5.85;
      if (wx < cx - 4.4 && Math.abs(wz) < 2.05) continue;
      const wall = new THREE.Mesh(wallGeo, this.acousticWallMat);
      wall.position.set(wx, 0.68, wz);
      wall.rotation.y = -ang + Math.PI / 2;
      this.scene.add(wall);
    }

    // Ribbed Glass Greenhouse Dome Overhead
    const bioGlassMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#A7F3D0',
        transparent: true,
        opacity: 0.16,
        roughness: 0.14,
        metalness: 0.08,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    const domeGlass = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(5.95, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.48)),
      bioGlassMat
    );
    domeGlass.position.set(cx, 1.25, 0);
    this.scene.add(domeGlass);

    for (let i = 0; i < 6; i++) {
      const rib = new THREE.Mesh(
        this.track(new THREE.TorusGeometry(5.9, 0.085, 8, 28, Math.PI)),
        this.hullWhite
      );
      rib.position.set(cx, 1.25, 0);
      rib.rotation.y = (i / 6) * Math.PI;
      this.scene.add(rib);
    }

    // ------------------------------------------------------------------
    // GLOWING GREEN HYDROPONIC GROW-TOWERS IN LAB SECTION
    // ------------------------------------------------------------------
    const leafMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#15803D',
        emissive: '#059669',
        emissiveIntensity: 0.14,
        roughness: 0.48,
      })
    );
    const soilMat = this.track(
      new THREE.MeshStandardMaterial({ color: '#1F2937', roughness: 0.85 })
    );
    const nutrientTubeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#34D399',
        emissive: '#10B981',
        emissiveIntensity: 0.38,
        transparent: true,
        opacity: 0.65,
        roughness: 0.18,
      })
    );

    const towerConfigs: Array<{ x: number; z: number; rotY: number }> = [
      { x: 20.0, z: -2.6, rotY: 0 },
      { x: 22.8, z: 0.0, rotY: Math.PI / 2 },
      { x: 20.0, z: 2.6, rotY: 0 },
    ];

    towerConfigs.forEach((rc) => {
      const tower = new THREE.Group();
      tower.position.set(rc.x, 0, rc.z);
      tower.rotation.y = rc.rotY;

      // Central illuminated nutrient-supply core column + top reservoir ring
      const centerCol = new THREE.Mesh(
        this.track(new THREE.CylinderGeometry(0.18, 0.22, 2.75, 14)),
        nutrientTubeMat
      );
      centerCol.position.y = 1.42;
      tower.add(centerCol);

      const postGeo = this.track(new THREE.BoxGeometry(0.09, 2.75, 0.09));
      for (const px of [-1.02, 1.02]) {
        for (const pz of [-0.44, 0.44]) {
          const post = new THREE.Mesh(postGeo, this.darkTitanium);
          post.position.set(px, 1.38, pz);
          tower.add(post);
        }
      }

      // 3 stacked growing shelves with glowing green LED grow bars & lush crops
      for (let shelf = 0; shelf < 3; shelf++) {
        const sy = 0.42 + shelf * 0.84;
        const tray = new THREE.Mesh(
          this.track(new THREE.BoxGeometry(2.1, 0.11, 0.9)),
          soilMat
        );
        tray.position.y = sy;
        tower.add(tray);

        const ledBar = new THREE.Mesh(
          this.track(new THREE.BoxGeometry(1.9, 0.055, 0.14)),
          this.emeraldLedMat
        );
        ledBar.position.set(0, sy + 0.64, 0);
        tower.add(ledBar);

        const cropsRow = new THREE.Group();
        cropsRow.position.y = sy + 0.06;
        for (let c = 0; c < 5; c++) {
          const cxOffset = -0.76 + c * 0.38;
          const plantCluster = new THREE.Mesh(
            this.track(new THREE.DodecahedronGeometry(0.17, 1)),
            leafMat
          );
          plantCluster.position.set(cxOffset, 0.16, (c % 2 === 0 ? 1 : -1) * 0.14);
          plantCluster.scale.set(1.2, 0.95, 1.2);
          cropsRow.add(plantCluster);
        }
        this.biodomeCropClusters.push(cropsRow);
        tower.add(cropsRow);
      }

      this.scene.add(tower);
    });

    // Emerald mist particles inside Zone C Hydroponics Dome
    const mistSprite = this.track(createDustParticleSpriteTexture());
    const mistCount = 72;
    this.biodomeMistPositions = new Float32Array(mistCount * 3);
    for (let i = 0; i < mistCount; i++) {
      const ang = (i / mistCount) * Math.PI * 2;
      const rad = 0.8 + ((i * 1.7) % 3.8);
      this.biodomeMistPositions[i * 3] = cx + Math.cos(ang) * rad;
      this.biodomeMistPositions[i * 3 + 1] = 0.35 + ((i * 0.41) % 2.4);
      this.biodomeMistPositions[i * 3 + 2] = Math.sin(ang) * rad;
    }
    const mistGeo = this.track(new THREE.BufferGeometry());
    mistGeo.setAttribute('position', new THREE.BufferAttribute(this.biodomeMistPositions, 3));
    const mistMat = this.track(
      new THREE.PointsMaterial({
        map: mistSprite,
        color: '#A7F3D0',
        size: 0.42,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      })
    );
    this.biodomeMistPoints = new THREE.Points(mistGeo, mistMat);
    this.scene.add(this.biodomeMistPoints);
  }

  private buildInteriorLightBeamDustMotes(): void {
    const sprite = this.track(createDustParticleSpriteTexture());
    const moteCount = 96;
    this.dustMotePositions = new Float32Array(moteCount * 3);
    this.dustMoteSeeds = [];

    let seed = 409;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    for (let i = 0; i < moteCount; i++) {
      // Cluster motes cleanly inside the central Command Dome beam and console alcoves
      const ang = rand() * Math.PI * 2;
      const rad = 0.5 + rand() * 5.6;
      const bx = Math.cos(ang) * rad;
      const by = 0.8 + rand() * 4.4;
      const bz = Math.sin(ang) * rad;
      this.dustMotePositions[i * 3] = bx;
      this.dustMotePositions[i * 3 + 1] = by;
      this.dustMotePositions[i * 3 + 2] = bz;
      this.dustMoteSeeds.push({
        baseX: bx,
        baseY: by,
        baseZ: bz,
        speed: 0.25 + rand() * 0.35,
        phase: rand() * Math.PI * 2,
      });
    }

    const moteGeo = this.track(new THREE.BufferGeometry());
    moteGeo.setAttribute('position', new THREE.BufferAttribute(this.dustMotePositions, 3));
    const moteMat = this.track(
      new THREE.PointsMaterial({
        map: sprite,
        color: '#E0F2FE',
        size: 0.14,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.dustMotePoints = new THREE.Points(moteGeo, moteMat);
    this.scene.add(this.dustMotePoints);
  }

  private buildInteractableColliders(): void {
    const colliderMat = this.track(new THREE.MeshBasicMaterial({ visible: false }));
    for (const item of INTERIOR_INTERACTABLES) {
      const hit = new THREE.Mesh(
        this.track(new THREE.CylinderGeometry(1.35, 1.35, 2.6, 10)),
        colliderMat
      );
      hit.position.set(item.x, 1.3, item.z);
      hit.layers.set(1);
      hit.userData.interactableId = item.id;
      this.interactableColliders.push(hit);
      this.scene.add(hit);
    }

    this.promptHighlightMat = this.track(
      new THREE.MeshBasicMaterial({
        color: '#22D3EE',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      })
    );
    const ringGeo = this.track(new THREE.RingGeometry(1.1, 1.32, 28));
    ringGeo.rotateX(-Math.PI / 2);
    this.promptHighlightRing = new THREE.Mesh(ringGeo, this.promptHighlightMat);
    this.promptHighlightRing.visible = false;
    this.scene.add(this.promptHighlightRing);
  }

  public triggerStationFeedback(id: InteriorInteractableId): void {
    if (id === 'moxie_unit') {
      this.moxieValveSpinBoost = 2.4;
    } else if (id === 'crop_racks') {
      this.biodomePulseBoost = 2.4;
    }
  }

  public setHighlightedInteractable(id: InteriorInteractableId | null): void {
    if (!id) {
      this.promptHighlightRing.visible = false;
      return;
    }
    const target = INTERIOR_INTERACTABLES.find((x) => x.id === id);
    if (!target) {
      this.promptHighlightRing.visible = false;
      return;
    }
    this.promptHighlightRing.position.set(target.x, 0.04, target.z);
    this.promptHighlightRing.visible = true;
  }

  public update(dt: number, input: InteriorUpdateInput): void {
    this.totalTime += dt;

    // Sync exterior sky panorama visible through panoramic windows
    this.exteriorHorizonColor.copy(input.skyColor);
    this.exteriorZenithColor.copy(input.zenithColor);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(input.skyColor);
    }

    // Rotate central Holographic Mars Map
    if (this.holoSpinGroup) {
      this.holoSpinGroup.rotation.y += dt * 0.42;
      this.holoRingMesh.rotation.z += dt * 0.65;
    }

    // Animate Crewmates (subtle breathing, console typing, head scan)
    for (const c of this.crewmates) {
      const t = this.totalTime + c.phase;
      c.head.rotation.y = Math.sin(t * 0.9) * 0.24;
      c.head.rotation.x = Math.sin(t * 1.4) * 0.07;
      c.leftArm.rotation.x = -0.92 + Math.sin(t * 7.5) * 0.09;
      c.rightArm.rotation.x = -0.92 + Math.cos(t * 8.2) * 0.09;
    }

    // Update curved live waveform telemetry monitors (~8 Hz)
    this.telemetryRedrawTimer += dt;
    if (this.telemetryRedrawTimer >= 0.125) {
      this.telemetryRedrawTimer = 0;
      const stats = {
        powerKwh: input.resources.powerKwh,
        lifePct: input.resources.lifeSupportPct,
        healthPct: input.resources.crewHealthPct,
        waterWallCm: input.resources.waterWallCm,
        crisisActive: input.moxieCrisisActive || input.emergencyActive,
      };
      for (let i = 0; i < this.liveScreens.length; i++) {
        this.liveScreens[i].draw(this.totalTime, stats);
      }
    }

    // Zone B MOXIE Impeller, Manual Valve Spin, Water-Wall Tank Bubbles & Crisis Flash
    if (this.moxieImpeller) {
      this.moxieImpeller.rotation.y += dt * (input.moxieCrisisActive ? 1.4 : 4.8);
    }
    if (this.moxieValveSpinBoost > 0) {
      this.moxieValveSpinBoost = Math.max(0, this.moxieValveSpinBoost - dt);
      this.moxieValveWheel.rotation.z += dt * 9.5;
    }

    for (let i = 0; i < this.waterTankBubbles.length; i++) {
      const b = this.waterTankBubbles[i];
      b.position.y += dt * 0.55;
      if (b.position.y > 2.45) b.position.y = 0.42;
    }

    if (input.moxieCrisisActive || input.emergencyActive) {
      const flash = 0.5 + 0.5 * Math.sin(this.totalTime * 6.4);
      this.moxieCrisisLight.color.setHex(flash > 0.5 ? 0xff2a2a : 0xff8c00);
      this.moxieCrisisLight.intensity = 1.6 + flash * 4.4;
      this.moxieBeaconMat.color.setHex(0xff2a2a);
      this.moxieBeaconMat.emissive.setHex(0xff2a2a);
      this.moxieBeaconMat.emissiveIntensity = 1.0 + flash * 2.4;
    } else {
      this.moxieCrisisLight.intensity = THREE.MathUtils.lerp(
        this.moxieCrisisLight.intensity,
        0,
        Math.min(1, dt * 6)
      );
      this.moxieBeaconMat.color.setHex(0x22d3ee);
      this.moxieBeaconMat.emissive.setHex(0x06b6d4);
      this.moxieBeaconMat.emissiveIntensity = 1.25;
    }

    // Battery LED bars reflect current Power kWh
    const powerRatio = THREE.MathUtils.clamp(input.resources.powerKwh / 120, 0, 1);
    for (let i = 0; i < this.batteryLedMats.length; i++) {
      const lit = powerRatio >= (i + 0.5) / this.batteryLedMats.length;
      const mat = this.batteryLedMats[i];
      if (lit) {
        mat.color.setHex(powerRatio < 0.25 ? 0xf59e0b : 0x10b981);
        mat.emissive.setHex(powerRatio < 0.25 ? 0xd97706 : 0x10b981);
        mat.emissiveIntensity = 1.25;
      } else {
        mat.color.setHex(0x334155);
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0.05;
      }
    }

    // Zone C Bio-Dome crop growth scaling + Emerald grow light pulse + drifting mist
    if (this.biodomePulseBoost > 0) {
      this.biodomePulseBoost = Math.max(0, this.biodomePulseBoost - dt);
    }
    const cropScale = THREE.MathUtils.clamp(0.75 + (input.resources.cropGrowth - 1) * 0.14, 0.72, 1.45);
    for (let i = 0; i < this.biodomeCropClusters.length; i++) {
      this.biodomeCropClusters[i].scale.set(1, cropScale, 1);
    }
    this.biodomeEmeraldLight.intensity =
      1.95 + (this.biodomePulseBoost > 0 ? 1.1 : 0) + Math.sin(this.totalTime * 2.2) * 0.2;

    for (let i = 0; i < this.biodomeMistPositions.length; i += 3) {
      this.biodomeMistPositions[i + 1] += dt * (this.biodomePulseBoost > 0 ? 0.75 : 0.22);
      if (this.biodomeMistPositions[i + 1] > 2.75) {
        this.biodomeMistPositions[i + 1] = 0.3;
      }
    }
    this.biodomeMistPoints.geometry.attributes.position.needsUpdate = true;

    // Gentle floating dust motes inside Zone A overhead light beams
    for (let i = 0; i < this.dustMoteSeeds.length; i++) {
      const s = this.dustMoteSeeds[i];
      this.dustMotePositions[i * 3] = s.baseX + Math.sin(this.totalTime * s.speed + s.phase) * 0.28;
      this.dustMotePositions[i * 3 + 1] =
        s.baseY + Math.cos(this.totalTime * s.speed * 0.75 + s.phase) * 0.22;
      this.dustMotePositions[i * 3 + 2] =
        s.baseZ + Math.cos(this.totalTime * s.speed * 0.85 + s.phase * 1.3) * 0.28;
    }
    this.dustMotePoints.geometry.attributes.position.needsUpdate = true;

    if (this.promptHighlightRing.visible) {
      const p = 1 + Math.sin(this.totalTime * 5.2) * 0.07;
      this.promptHighlightRing.scale.set(p, 1, p);
    }

    void this.isSoftwareGl;
  }

  public dispose(): void {
    for (const item of this.disposables) {
      item.dispose();
    }
    this.disposables = [];
    this.liveScreens = [];
  }
}
