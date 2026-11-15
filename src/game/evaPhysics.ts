import * as THREE from 'three';

export type EvaInteractableId =
  | 'eva_solar'
  | 'eva_rover'
  | 'eva_moxie'
  | 'eva_airlock';

export interface EvaInteractable {
  id: EvaInteractableId;
  promptLabel: string;
  shortTitle: string;
  maxDistance: number;
}

export interface EvaCircleCollider {
  id: string;
  x: number;
  z: number;
  radius: number;
}

export interface EvaBoxCollider {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface EvaPhysicsState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  pitch: number;
  walkDistance: number;
  bobOffset: number;
  strafeTilt: number;
}

export interface EvaMoveInput {
  forward: number;
  right: number;
  turn: number;
}

export const EXTERIOR_BASE_SCALE = 3.5;
export const EVA_EYE_HEIGHT = 1.75;
export const EVA_PLAYER_RADIUS = 0.45;
export const EVA_MAX_RADIUS = 65;
export const EVA_FRICTION = 0.88; // Per 60Hz reference step damping
export const EVA_ACCEL = 32.0; // Weighted 0.38g Martian EVA suit acceleration
export const EVA_MAX_SPEED = 4.6;
export const EVA_INTERACT_RADIUS = 3.5;

// Default HUD spawn: open yard outside the scaled Habitat Dome facing the Cyan Airlock & Rover
export const EVA_HUD_SPAWN = {
  x: 2.1 * EXTERIOR_BASE_SCALE,
  z: 4.8 * EXTERIOR_BASE_SCALE,
  yaw: 0.22,
};

// Airlock exit spawn: right outside the scaled Main Habitat Airlock doorstep facing open Martian terrain & Rover
export const EVA_AIRLOCK_SPAWN = {
  x: 0.9 * EXTERIOR_BASE_SCALE,
  z: 4.45 * EXTERIOR_BASE_SCALE,
  yaw: -2.2,
};

function createCircleCompoundBoxes(cx: number, cz: number, radius: number): THREE.Box3[] {
  // Multi-slab AABB approximation of a circular dome wall so diagonal corners (like the rover at 12, 10) stay clear
  const slices = [0.32, 0.58, 0.78, 0.92];
  const boxes: THREE.Box3[] = [];
  for (const s of slices) {
    const c = Math.sqrt(Math.max(0.05, 1 - s * s));
    boxes.push(
      new THREE.Box3(
        new THREE.Vector3(cx - radius * s, -50, cz - radius * c),
        new THREE.Vector3(cx + radius * s, 50, cz + radius * c)
      ),
      new THREE.Box3(
        new THREE.Vector3(cx - radius * c, -50, cz - radius * s),
        new THREE.Vector3(cx + radius * c, 50, cz + radius * s)
      )
    );
  }
  return boxes;
}

// Static THREE.Box3 bounding boxes for the 3.5x scaled exterior habitat walls, equipment structures, and science boulders
export const EVA_STATIC_BOX3_COLLIDERS: THREE.Box3[] = [
  // 1. Scaled Main Habitat Dome walls (center: 0.9 * 3.5 = 3.15, 1.0 * 3.5 = 3.5, radius: 2.88 * 3.5 = 10.08)
  ...createCircleCompoundBoxes(0.9 * EXTERIOR_BASE_SCALE, 1.0 * EXTERIOR_BASE_SCALE, 2.88 * EXTERIOR_BASE_SCALE),
  // Scaled Main Habitat Airlock Vestibule protruding to the doorstep at z = 3.88 * 3.5 = 13.58
  new THREE.Box3(
    new THREE.Vector3((0.9 - 0.73) * EXTERIOR_BASE_SCALE, -50, 2.6 * EXTERIOR_BASE_SCALE),
    new THREE.Vector3((0.9 + 0.73) * EXTERIOR_BASE_SCALE, 50, 3.88 * EXTERIOR_BASE_SCALE)
  ),
  // 2. Scaled Hydroponic Bio-Dome (center: 6.8 * 3.5 = 23.8, 2.0 * 3.5 = 7.0, radius: 2.55 * 3.5 = 8.925)
  ...createCircleCompoundBoxes(6.8 * EXTERIOR_BASE_SCALE, 2.0 * EXTERIOR_BASE_SCALE, 2.55 * EXTERIOR_BASE_SCALE),
  // 3. Scaled Pressurized Connecting Tunnels
  new THREE.Box3(
    new THREE.Vector3(-1.3 * EXTERIOR_BASE_SCALE, -50, -1.5 * EXTERIOR_BASE_SCALE),
    new THREE.Vector3(0.1 * EXTERIOR_BASE_SCALE, 50, -0.1 * EXTERIOR_BASE_SCALE)
  ),
  new THREE.Box3(
    new THREE.Vector3(-2.8 * EXTERIOR_BASE_SCALE, -50, -3.3 * EXTERIOR_BASE_SCALE),
    new THREE.Vector3(-1.4 * EXTERIOR_BASE_SCALE, 50, -1.9 * EXTERIOR_BASE_SCALE)
  ),
  new THREE.Box3(
    new THREE.Vector3(2.5 * EXTERIOR_BASE_SCALE, -50, 0.8 * EXTERIOR_BASE_SCALE),
    new THREE.Vector3(5.2 * EXTERIOR_BASE_SCALE, 50, 2.2 * EXTERIOR_BASE_SCALE)
  ),
  // 4. Scaled MOXIE Core concrete pad & generator housing (-3.7 * 3.5, -4.4 * 3.5)
  new THREE.Box3(
    new THREE.Vector3(-5.6 * EXTERIOR_BASE_SCALE, -50, -5.8 * EXTERIOR_BASE_SCALE),
    new THREE.Vector3(-1.8 * EXTERIOR_BASE_SCALE, 50, -3.0 * EXTERIOR_BASE_SCALE)
  ),
  // 5. Scaled Solar Array Field front & rear panel rows (-6.8 * 3.5, 2.2 * 3.5) & junction box
  new THREE.Box3(
    new THREE.Vector3(-10.1 * EXTERIOR_BASE_SCALE, -50, 2.55 * EXTERIOR_BASE_SCALE),
    new THREE.Vector3(-3.5 * EXTERIOR_BASE_SCALE, 50, 3.95 * EXTERIOR_BASE_SCALE)
  ),
  new THREE.Box3(
    new THREE.Vector3(-10.1 * EXTERIOR_BASE_SCALE, -50, 0.35 * EXTERIOR_BASE_SCALE),
    new THREE.Vector3(-3.5 * EXTERIOR_BASE_SCALE, 50, 1.75 * EXTERIOR_BASE_SCALE)
  ),
  new THREE.Box3(
    new THREE.Vector3(-5.35 * EXTERIOR_BASE_SCALE, -50, 1.65 * EXTERIOR_BASE_SCALE),
    new THREE.Vector3(-3.85 * EXTERIOR_BASE_SCALE, 50, 2.85 * EXTERIOR_BASE_SCALE)
  ),
  // 6. Scaled Cryo Storage Tank Rack & Comms Dish
  new THREE.Box3(
    new THREE.Vector3((-3.55 - 1.1) * EXTERIOR_BASE_SCALE, -50, (4.35 - 0.8) * EXTERIOR_BASE_SCALE),
    new THREE.Vector3((-3.55 + 1.1) * EXTERIOR_BASE_SCALE, 50, (4.35 + 0.8) * EXTERIOR_BASE_SCALE)
  ),
  new THREE.Box3(
    new THREE.Vector3((5.05 - 1.05) * EXTERIOR_BASE_SCALE, -50, (-4.1 - 1.05) * EXTERIOR_BASE_SCALE),
    new THREE.Vector3((5.05 + 1.05) * EXTERIOR_BASE_SCALE, 50, (-4.1 + 1.05) * EXTERIOR_BASE_SCALE)
  ),
  // 7. Relocated Science Boulders
  new THREE.Box3(new THREE.Vector3(-14.5 - 1.05, -50, 9.5 - 1.05), new THREE.Vector3(-14.5 + 1.05, 50, 9.5 + 1.05)),
  new THREE.Box3(new THREE.Vector3(-7.8 - 1.05, -50, 14.2 - 1.05), new THREE.Vector3(-7.8 + 1.05, 50, 14.2 + 1.05)),
  new THREE.Box3(new THREE.Vector3(9.8 - 1.0, -50, 14.0 - 1.0), new THREE.Vector3(9.8 + 1.0, 50, 14.0 + 1.0)),
  new THREE.Box3(new THREE.Vector3(15.2 - 1.0, -50, 7.2 - 1.0), new THREE.Vector3(15.2 + 1.0, 50, 7.2 + 1.0)),
];

// Legacy metadata exports for compatibility
export const EVA_STATIC_CIRCLE_COLLIDERS: EvaCircleCollider[] = [
  { id: 'shelter_dome', x: 0.9 * EXTERIOR_BASE_SCALE, z: 1.0 * EXTERIOR_BASE_SCALE, radius: 2.88 * EXTERIOR_BASE_SCALE },
  { id: 'shelter_airlock', x: 0.9 * EXTERIOR_BASE_SCALE, z: 3.45 * EXTERIOR_BASE_SCALE, radius: 0.92 * EXTERIOR_BASE_SCALE },
  { id: 'biodome', x: 6.8 * EXTERIOR_BASE_SCALE, z: 2.0 * EXTERIOR_BASE_SCALE, radius: 2.55 * EXTERIOR_BASE_SCALE },
  { id: 'tank_rack', x: -3.55 * EXTERIOR_BASE_SCALE, z: 4.35 * EXTERIOR_BASE_SCALE, radius: 1.1 * EXTERIOR_BASE_SCALE },
  { id: 'comms_dish', x: 5.05 * EXTERIOR_BASE_SCALE, z: -4.1 * EXTERIOR_BASE_SCALE, radius: 1.05 * EXTERIOR_BASE_SCALE },
  { id: 'rock-delta', x: -14.5, z: 9.5, radius: 1.05 },
  { id: 'rock-olivine', x: -7.8, z: 14.2, radius: 1.05 },
  { id: 'rock-carbonate', x: 9.8, z: 14.0, radius: 1.0 },
  { id: 'rock-sulfate', x: 15.2, z: 7.2, radius: 1.0 },
];

export const EVA_STATIC_BOX_COLLIDERS: EvaBoxCollider[] = [
  {
    id: 'moxie_pad',
    minX: -5.6 * EXTERIOR_BASE_SCALE,
    maxX: -1.8 * EXTERIOR_BASE_SCALE,
    minZ: -5.8 * EXTERIOR_BASE_SCALE,
    maxZ: -3.0 * EXTERIOR_BASE_SCALE,
  },
  {
    id: 'solar_front_row',
    minX: -10.1 * EXTERIOR_BASE_SCALE,
    maxX: -3.5 * EXTERIOR_BASE_SCALE,
    minZ: 2.55 * EXTERIOR_BASE_SCALE,
    maxZ: 3.95 * EXTERIOR_BASE_SCALE,
  },
  {
    id: 'solar_rear_row',
    minX: -10.1 * EXTERIOR_BASE_SCALE,
    maxX: -3.5 * EXTERIOR_BASE_SCALE,
    minZ: 0.35 * EXTERIOR_BASE_SCALE,
    maxZ: 1.75 * EXTERIOR_BASE_SCALE,
  },
  {
    id: 'solar_junction',
    minX: -5.35 * EXTERIOR_BASE_SCALE,
    maxX: -3.85 * EXTERIOR_BASE_SCALE,
    minZ: 1.65 * EXTERIOR_BASE_SCALE,
    maxZ: 2.85 * EXTERIOR_BASE_SCALE,
  },
];

const EVA_INTERACTABLE_META: Record<EvaInteractableId, EvaInteractable> = {
  eva_solar: {
    id: 'eva_solar',
    promptLabel: '[E] Clean Solar Array',
    shortTitle: 'Solar Array Field',
    maxDistance: EVA_INTERACT_RADIUS,
  },
  eva_rover: {
    id: 'eva_rover',
    promptLabel: '[E] Inspect Rover / Open FHAZ Cam',
    shortTitle: 'Mars Utility Rover',
    maxDistance: EVA_INTERACT_RADIUS,
  },
  eva_moxie: {
    id: 'eva_moxie',
    promptLabel: '[E] Service Exterior Intake',
    shortTitle: 'Exterior MOXIE Unit',
    maxDistance: EVA_INTERACT_RADIUS,
  },
  eva_airlock: {
    id: 'eva_airlock',
    promptLabel: '[E] Enter Habitat Airlock',
    shortTitle: 'Main Habitat Airlock',
    maxDistance: 2.75 * EXTERIOR_BASE_SCALE,
  },
};

function clampVal(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function distanceToBox2D(
  px: number,
  pz: number,
  box: { minX: number; maxX: number; minZ: number; maxZ: number }
): { dist: number; cx: number; cz: number } {
  const cx = clampVal(px, box.minX, box.maxX);
  const cz = clampVal(pz, box.minZ, box.maxZ);
  return { dist: Math.hypot(px - cx, pz - cz), cx, cz };
}

const playerTestBoxScratch = new THREE.Box3();

export function doesPlayerIntersectBox3List(
  x: number,
  z: number,
  boxes: THREE.Box3[],
  playerRadius = EVA_PLAYER_RADIUS
): boolean {
  playerTestBoxScratch.min.set(x - playerRadius, -10, z - playerRadius);
  playerTestBoxScratch.max.set(x + playerRadius, 10, z + playerRadius);
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].intersectsBox(playerTestBoxScratch)) {
      return true;
    }
  }
  return false;
}

export function clampEvaPlayerPosition(
  prevX: number,
  prevZ: number,
  nextX: number,
  nextZ: number,
  extraCircleObstacles: EvaCircleCollider[] = [],
  roverPos?: { x: number; z: number },
  playerRadius = EVA_PLAYER_RADIUS,
  maxRadius = EVA_MAX_RADIUS,
  extraBox3Obstacles: THREE.Box3[] = []
): { x: number; z: number } {
  if (!Number.isFinite(nextX) || !Number.isFinite(nextZ)) {
    return { x: prevX, z: prevZ };
  }

  // Build full list of THREE.Box3 solid colliders (static scaled structures + dynamic rocks + rover)
  const allBoxes: THREE.Box3[] = [...EVA_STATIC_BOX3_COLLIDERS, ...extraBox3Obstacles];

  for (let i = 0; i < extraCircleObstacles.length; i++) {
    const obs = extraCircleObstacles[i];
    allBoxes.push(
      new THREE.Box3(
        new THREE.Vector3(obs.x - obs.radius, -50, obs.z - obs.radius),
        new THREE.Vector3(obs.x + obs.radius, 50, obs.z + obs.radius)
      )
    );
  }

  if (roverPos) {
    const roverHalf = 1.05;
    allBoxes.push(
      new THREE.Box3(
        new THREE.Vector3(roverPos.x - roverHalf, -50, roverPos.z - roverHalf),
        new THREE.Vector3(roverPos.x + roverHalf, 50, roverPos.z + roverHalf)
      )
    );
  }

  let x = nextX;
  let z = nextZ;

  // Check proposed next position against THREE.Box3 bounding boxes and block position updates upon intersection
  if (doesPlayerIntersectBox3List(x, z, allBoxes, playerRadius)) {
    const canMoveX = !doesPlayerIntersectBox3List(nextX, prevZ, allBoxes, playerRadius);
    const canMoveZ = !doesPlayerIntersectBox3List(prevX, nextZ, allBoxes, playerRadius);
    if (canMoveX && !canMoveZ) {
      x = nextX;
      z = prevZ;
    } else if (!canMoveX && canMoveZ) {
      x = prevX;
      z = nextZ;
    } else {
      x = prevX;
      z = prevZ;
    }
  }

  // Enforce 65-unit perimeter boundary around the outpost
  const r = Math.hypot(x, z);
  const allowedR = Math.max(1, maxRadius - playerRadius);
  if (r > allowedR) {
    const scale = allowedR / r;
    x *= scale;
    z *= scale;
  }

  return { x, z };
}

export function createInitialEvaState(
  groundHeightFn: (x: number, z: number) => number,
  spawn: { x: number; z: number; yaw: number } = EVA_HUD_SPAWN
): EvaPhysicsState {
  const y = groundHeightFn(spawn.x, spawn.z) + EVA_EYE_HEIGHT;
  return {
    x: spawn.x,
    y,
    z: spawn.z,
    vx: 0,
    vz: 0,
    yaw: spawn.yaw,
    pitch: 0,
    walkDistance: 0,
    bobOffset: 0,
    strafeTilt: 0,
  };
}

export function stepEvaPhysics(
  state: EvaPhysicsState,
  input: EvaMoveInput,
  dt: number,
  groundHeightFn: (x: number, z: number) => number,
  extraCircleObstacles: EvaCircleCollider[] = [],
  roverPos?: { x: number; z: number },
  extraBox3Obstacles: THREE.Box3[] = []
): EvaPhysicsState {
  const safeDt = clampVal(dt, 0.0001, 0.05);
  let yaw = state.yaw;
  if (input.turn !== 0) {
    yaw -= input.turn * safeDt * 2.1;
  }

  const rawFwd = clampVal(input.forward, -1, 1);
  const rawRight = clampVal(input.right, -1, 1);
  const inputLen = Math.hypot(rawFwd, rawRight);
  const nf = inputLen > 1 ? rawFwd / inputLen : rawFwd;
  const nr = inputLen > 1 ? rawRight / inputLen : rawRight;

  const fwdX = -Math.sin(yaw);
  const fwdZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);

  const wishX = fwdX * nf + rightX * nr;
  const wishZ = fwdZ * nf + rightZ * nr;

  let vx = state.vx + wishX * EVA_ACCEL * safeDt;
  let vz = state.vz + wishZ * EVA_ACCEL * safeDt;

  // Frame-rate-independent 0.88 per-tick friction damping (at 60Hz reference)
  const damping = Math.pow(EVA_FRICTION, safeDt * 60);
  vx *= damping;
  vz *= damping;

  const speed = Math.hypot(vx, vz);
  if (speed > EVA_MAX_SPEED) {
    const scale = EVA_MAX_SPEED / speed;
    vx *= scale;
    vz *= scale;
  } else if (speed < 0.015 && inputLen < 0.01) {
    vx = 0;
    vz = 0;
  }

  const prevX = state.x;
  const prevZ = state.z;
  const nextX = prevX + vx * safeDt;
  const nextZ = prevZ + vz * safeDt;

  const clamped = clampEvaPlayerPosition(
    prevX,
    prevZ,
    nextX,
    nextZ,
    extraCircleObstacles,
    roverPos,
    EVA_PLAYER_RADIUS,
    EVA_MAX_RADIUS,
    extraBox3Obstacles
  );

  // Stop velocity along any axis blocked by a THREE.Box3 intersection
  const movedX = clamped.x - prevX;
  const movedZ = clamped.z - prevZ;
  const stepDist = Math.hypot(movedX, movedZ);
  if (Math.abs(nextX - clamped.x) > 1e-4) {
    vx = 0;
  }
  if (Math.abs(nextZ - clamped.z) > 1e-4) {
    vz = 0;
  }

  const effectiveSpeed = Math.hypot(vx, vz);
  const speedFactor = clampVal(effectiveSpeed / EVA_MAX_SPEED, 0, 1);
  const walkDistance = state.walkDistance + stepDist;

  // Weighted Martian stride head-bob & subtle lateral strafe roll tilt
  let bobOffset = state.bobOffset;
  if (stepDist > 0.0004 && speedFactor > 0.04) {
    const targetBob = Math.sin(walkDistance * 2.15) * 0.048 * speedFactor;
    bobOffset = bobOffset + (targetBob - bobOffset) * Math.min(1, safeDt * 14);
  } else {
    bobOffset = bobOffset + (0 - bobOffset) * Math.min(1, safeDt * 10);
  }

  const targetTilt = -nr * 0.024 * (0.35 + 0.65 * speedFactor);
  const strafeTilt = state.strafeTilt + (targetTilt - state.strafeTilt) * Math.min(1, safeDt * 9);

  const terrainY = groundHeightFn(clamped.x, clamped.z);

  return {
    x: clamped.x,
    y: terrainY + EVA_EYE_HEIGHT + bobOffset,
    z: clamped.z,
    vx,
    vz,
    yaw,
    pitch: state.pitch,
    walkDistance,
    bobOffset,
    strafeTilt,
  };
}

export function findNearestEvaInteractable(
  playerX: number,
  playerZ: number,
  lookDirX: number,
  lookDirZ: number,
  roverPos: { x: number; z: number } = { x: 12.0, z: 10.0 }
): { interactable: EvaInteractable; distance: number } | null {
  const lookLen = Math.hypot(lookDirX, lookDirZ);
  const lx = lookLen > 1e-4 ? lookDirX / lookLen : 0;
  const lz = lookLen > 1e-4 ? lookDirZ / lookLen : -1;

  const candidates: Array<{
    id: EvaInteractableId;
    dist: number;
    tx: number;
    tz: number;
  }> = [];

  // 1. Solar Array Field footprint (scaled by EXTERIOR_BASE_SCALE)
  const solarScaled = distanceToBox2D(playerX, playerZ, {
    minX: -10.1 * EXTERIOR_BASE_SCALE,
    maxX: -3.5 * EXTERIOR_BASE_SCALE,
    minZ: 0.35 * EXTERIOR_BASE_SCALE,
    maxZ: 3.95 * EXTERIOR_BASE_SCALE,
  });
  const solarUnscaled = distanceToBox2D(playerX, playerZ, {
    minX: -10.1,
    maxX: -3.5,
    minZ: 0.35,
    maxZ: 3.95,
  });
  const solarMeasure = solarScaled.dist <= solarUnscaled.dist ? solarScaled : solarUnscaled;
  candidates.push({
    id: 'eva_solar',
    dist: solarMeasure.dist,
    tx: solarMeasure.cx,
    tz: solarMeasure.cz,
  });

  // 2. Live Mars Utility Rover position
  const roverDist = Math.hypot(roverPos.x - playerX, roverPos.z - playerZ);
  candidates.push({
    id: 'eva_rover',
    dist: roverDist,
    tx: roverPos.x,
    tz: roverPos.z,
  });

  // 3. Exterior MOXIE Intake footprint (scaled by EXTERIOR_BASE_SCALE)
  const moxieScaled = distanceToBox2D(playerX, playerZ, {
    minX: -5.6 * EXTERIOR_BASE_SCALE,
    maxX: -1.8 * EXTERIOR_BASE_SCALE,
    minZ: -5.8 * EXTERIOR_BASE_SCALE,
    maxZ: -3.0 * EXTERIOR_BASE_SCALE,
  });
  const moxieUnscaled = distanceToBox2D(playerX, playerZ, {
    minX: -5.6,
    maxX: -1.8,
    minZ: -5.8,
    maxZ: -3.0,
  });
  const moxieMeasure = moxieScaled.dist <= moxieUnscaled.dist ? moxieScaled : moxieUnscaled;
  candidates.push({
    id: 'eva_moxie',
    dist: moxieMeasure.dist,
    tx: moxieMeasure.cx,
    tz: moxieMeasure.cz,
  });

  // 4. Main Habitat Airlock Hatch position and distance threshold scaled by EXTERIOR_BASE_SCALE (3.5)
  const airlockX = 0.9 * EXTERIOR_BASE_SCALE;
  const airlockZ = 3.88 * EXTERIOR_BASE_SCALE;
  const airlockDist = Math.hypot(airlockX - playerX, airlockZ - playerZ);
  candidates.push({
    id: 'eva_airlock',
    dist: airlockDist,
    tx: airlockX,
    tz: airlockZ,
  });

  let best: { interactable: EvaInteractable; distance: number; score: number } | null = null;

  for (const c of candidates) {
    const meta = EVA_INTERACTABLE_META[c.id];
    if (c.dist > meta.maxDistance) continue;

    const toX = c.tx - playerX;
    const toZ = c.tz - playerZ;
    const toLen = Math.hypot(toX, toZ);
    const dot = toLen > 1e-4 ? (toX / toLen) * lx + (toZ / toLen) * lz : 1;

    // Allow interaction when facing roughly toward the object or standing right beside the doorstep
    const closeStandThreshold = c.id === 'eva_airlock' ? 2.1 * EXTERIOR_BASE_SCALE : 2.1;
    if (dot < -0.1 && c.dist > closeStandThreshold) continue;

    const score = dot * 1.8 - c.dist * 0.6;
    if (!best || score > best.score) {
      best = { interactable: meta, distance: c.dist, score };
    }
  }

  return best ? { interactable: best.interactable, distance: best.distance } : null;
}

