export type InteriorZoneId =
  | 'command_dome'
  | 'west_airlock'
  | 'moxie_bay'
  | 'east_airlock'
  | 'biodome';

export type InteriorInteractableId =
  | 'rover_terminal'
  | 'holo_map'
  | 'moxie_unit'
  | 'water_tanks'
  | 'crop_racks'
  | 'airlock_exit';

export interface InteriorZoneInfo {
  id: InteriorZoneId;
  code: string;
  name: string;
  subtitle: string;
}

export interface InteriorInteractable {
  id: InteriorInteractableId;
  x: number;
  y: number;
  z: number;
  zone: InteriorZoneId;
  maxDistance: number;
  promptLabel: string;
  shortTitle: string;
}

export interface InteriorCircleCollider {
  id: string;
  x: number;
  z: number;
  radius: number;
}

export const INTERIOR_EYE_HEIGHT = 1.66;
export const INTERIOR_PLAYER_RADIUS = 0.42;
export const INTERIOR_SPAWN = {
  x: 0,
  z: 5.2,
  yaw: 0, // Facing -Z toward central Holomap & Rover Terminal
};

// Walkable geometry bounds matching HabitatInteriorWorld.ts 1:1
export const ZONE_A_CENTER = { x: 0, z: 0, radius: 8.1 };
export const ZONE_B_CENTER = { x: -20.0, z: 0, radius: 5.0 };
export const ZONE_C_CENTER = { x: 20.0, z: 0, radius: 5.2 };

export const WEST_CORRIDOR_BOUNDS = {
  minX: -15.6,
  maxX: -7.2,
  minZ: -1.48,
  maxZ: 1.48,
};

export const EAST_CORRIDOR_BOUNDS = {
  minX: 7.2,
  maxX: 15.6,
  minZ: -1.48,
  maxZ: 1.48,
};

export const INTERIOR_OBSTACLES: InteriorCircleCollider[] = [
  // Zone A central Holographic Mars Map Table
  { id: 'holo_table', x: 0, z: 0, radius: 1.45 },
  // Zone A Rover Control Terminal desk
  { id: 'rover_terminal_desk', x: 0, z: -5.8, radius: 1.05 },
  // Zone A Crew mission consoles (Commander Maya & Flight Engineer)
  { id: 'crew_console_west', x: -4.4, z: -4.1, radius: 1.15 },
  { id: 'crew_console_east', x: 4.4, z: -4.1, radius: 1.15 },
  // Zone B MOXIE Oxygen Generator unit
  { id: 'moxie_generator', x: -21.6, z: -1.5, radius: 1.35 },
  // Zone B Water-Wall shielding tanks
  { id: 'water_tank_north', x: -18.5, z: -4.0, radius: 0.95 },
  { id: 'water_tank_south', x: -22.2, z: 2.3, radius: 0.95 },
  // Zone B Battery racks
  { id: 'battery_rack', x: -17.6, z: 3.6, radius: 0.95 },
  // Zone C Vertical Hydroponics plant racks
  { id: 'hydro_rack_north', x: 20.0, z: -2.6, radius: 1.18 },
  { id: 'hydro_rack_east', x: 22.8, z: 0.0, radius: 1.18 },
  { id: 'hydro_rack_south', x: 20.0, z: 2.6, radius: 1.18 },
];

export const INTERIOR_INTERACTABLES: InteriorInteractable[] = [
  {
    id: 'rover_terminal',
    x: 0,
    y: 1.25,
    z: -5.5,
    zone: 'command_dome',
    maxDistance: 3.0,
    promptLabel: 'Press [E] to Open Rover Feed',
    shortTitle: 'Rover Control Terminal',
  },
  {
    id: 'holo_map',
    x: 0,
    y: 1.25,
    z: 0,
    zone: 'command_dome',
    maxDistance: 3.0,
    promptLabel: 'Press [E] to Inspect Jezero Holomap',
    shortTitle: 'Holographic Mars Map',
  },
  {
    id: 'moxie_unit',
    x: -21.4,
    y: 1.25,
    z: -1.5,
    zone: 'moxie_bay',
    maxDistance: 3.0,
    promptLabel: 'Press [E] to Inspect & Repair MOXIE (+15% O2)',
    shortTitle: 'MOXIE Oxygen Generator',
  },
  {
    id: 'water_tanks',
    x: -18.5,
    y: 1.3,
    z: -3.8,
    zone: 'moxie_bay',
    maxDistance: 3.0,
    promptLabel: 'Press [E] to Reinforce Water-Wall (+6 cm)',
    shortTitle: 'Water-Wall Shield Tanks',
  },
  {
    id: 'crop_racks',
    x: 20.2,
    y: 1.25,
    z: -2.2,
    zone: 'biodome',
    maxDistance: 3.0,
    promptLabel: 'Press [E] to Water Crops & Harvest O2 (+10% O2, +5 Sci)',
    shortTitle: 'Hydroponics Plant Racks',
  },
  {
    id: 'airlock_exit',
    x: 0,
    y: 1.3,
    z: 7.85,
    zone: 'command_dome',
    maxDistance: 2.75,
    promptLabel: 'Press [E] to Step Outside (EVA Suit Walk)',
    shortTitle: 'Main Airlock Hatch',
  },
];

function clampToCircle(
  x: number,
  z: number,
  cx: number,
  cz: number,
  maxR: number
): { x: number; z: number; dist: number } {
  const dx = x - cx;
  const dz = z - cz;
  const dist = Math.hypot(dx, dz);
  if (dist <= maxR || dist === 0) {
    return { x, z, dist };
  }
  const scale = maxR / dist;
  return {
    x: cx + dx * scale,
    z: cz + dz * scale,
    dist: maxR,
  };
}

function clampToBox(
  x: number,
  z: number,
  box: { minX: number; maxX: number; minZ: number; maxZ: number }
): { x: number; z: number } {
  return {
    x: Math.max(box.minX, Math.min(box.maxX, x)),
    z: Math.max(box.minZ, Math.min(box.maxZ, z)),
  };
}

function isInsideWalkable(x: number, z: number, playerRadius: number): boolean {
  const rA = ZONE_A_CENTER.radius - playerRadius;
  if (Math.hypot(x - ZONE_A_CENTER.x, z - ZONE_A_CENTER.z) <= rA) return true;

  const rB = ZONE_B_CENTER.radius - playerRadius;
  if (Math.hypot(x - ZONE_B_CENTER.x, z - ZONE_B_CENTER.z) <= rB) return true;

  const rC = ZONE_C_CENTER.radius - playerRadius;
  if (Math.hypot(x - ZONE_C_CENTER.x, z - ZONE_C_CENTER.z) <= rC) return true;

  if (
    x >= WEST_CORRIDOR_BOUNDS.minX &&
    x <= WEST_CORRIDOR_BOUNDS.maxX &&
    z >= WEST_CORRIDOR_BOUNDS.minZ + playerRadius * 0.5 &&
    z <= WEST_CORRIDOR_BOUNDS.maxZ - playerRadius * 0.5
  ) {
    return true;
  }

  if (
    x >= EAST_CORRIDOR_BOUNDS.minX &&
    x <= EAST_CORRIDOR_BOUNDS.maxX &&
    z >= EAST_CORRIDOR_BOUNDS.minZ + playerRadius * 0.5 &&
    z <= EAST_CORRIDOR_BOUNDS.maxZ - playerRadius * 0.5
  ) {
    return true;
  }

  return false;
}

export function clampInteriorPlayerPosition(
  prevX: number,
  prevZ: number,
  nextX: number,
  nextZ: number,
  playerRadius = INTERIOR_PLAYER_RADIUS
): { x: number; z: number } {
  let x = nextX;
  let z = nextZ;

  // 1. Keep player inside the union of the 3 zones + 2 pressurized corridors
  if (!isInsideWalkable(x, z, playerRadius)) {
    const candidates: Array<{ x: number; z: number; err: number }> = [];

    const cA = clampToCircle(x, z, ZONE_A_CENTER.x, ZONE_A_CENTER.z, ZONE_A_CENTER.radius - playerRadius);
    candidates.push({ x: cA.x, z: cA.z, err: Math.hypot(cA.x - x, cA.z - z) });

    const cB = clampToCircle(x, z, ZONE_B_CENTER.x, ZONE_B_CENTER.z, ZONE_B_CENTER.radius - playerRadius);
    candidates.push({ x: cB.x, z: cB.z, err: Math.hypot(cB.x - x, cB.z - z) });

    const cC = clampToCircle(x, z, ZONE_C_CENTER.x, ZONE_C_CENTER.z, ZONE_C_CENTER.radius - playerRadius);
    candidates.push({ x: cC.x, z: cC.z, err: Math.hypot(cC.x - x, cC.z - z) });

    const bW = clampToBox(x, z, {
      minX: WEST_CORRIDOR_BOUNDS.minX,
      maxX: WEST_CORRIDOR_BOUNDS.maxX,
      minZ: WEST_CORRIDOR_BOUNDS.minZ + playerRadius * 0.5,
      maxZ: WEST_CORRIDOR_BOUNDS.maxZ - playerRadius * 0.5,
    });
    candidates.push({ x: bW.x, z: bW.z, err: Math.hypot(bW.x - x, bW.z - z) });

    const bE = clampToBox(x, z, {
      minX: EAST_CORRIDOR_BOUNDS.minX,
      maxX: EAST_CORRIDOR_BOUNDS.maxX,
      minZ: EAST_CORRIDOR_BOUNDS.minZ + playerRadius * 0.5,
      maxZ: EAST_CORRIDOR_BOUNDS.maxZ - playerRadius * 0.5,
    });
    candidates.push({ x: bE.x, z: bE.z, err: Math.hypot(bE.x - x, bE.z - z) });

    candidates.sort((a, b) => a.err - b.err);
    x = candidates[0].x;
    z = candidates[0].z;

    if (!isInsideWalkable(x, z, playerRadius)) {
      x = prevX;
      z = prevZ;
    }
  }

  // 2. Push out of interior solid machinery/furniture obstacles
  for (let i = 0; i < INTERIOR_OBSTACLES.length; i++) {
    const obs = INTERIOR_OBSTACLES[i];
    const minDist = obs.radius + playerRadius;
    const dx = x - obs.x;
    const dz = z - obs.z;
    const dist = Math.hypot(dx, dz);
    if (dist < minDist) {
      if (dist < 1e-4) {
        x = obs.x;
        z = obs.z + minDist;
      } else {
        const scale = minDist / dist;
        x = obs.x + dx * scale;
        z = obs.z + dz * scale;
      }
    }
  }

  return { x, z };
}

export function getInteriorZoneAt(x: number, z: number): InteriorZoneInfo {
  if (x <= -14.8) {
    return {
      id: 'moxie_bay',
      code: 'ZONE B',
      name: 'MOXIE & Life Support Bay',
      subtitle: 'West Wing · CO2 Electrolysis & Water-Wall Shielding',
    };
  }
  if (x < -7.5 && Math.abs(z) <= 2.2) {
    return {
      id: 'west_airlock',
      code: 'AIRLOCK W',
      name: 'West Bulkhead Corridor',
      subtitle: 'Pressurized Transfer to MOXIE Bay',
    };
  }
  if (x >= 14.8) {
    return {
      id: 'biodome',
      code: 'ZONE C',
      name: 'Hydroponics Bio-Dome',
      subtitle: 'East Wing · UV Plant Racks & Oxygen Regeneration',
    };
  }
  if (x > 7.5 && Math.abs(z) <= 2.2) {
    return {
      id: 'east_airlock',
      code: 'AIRLOCK E',
      name: 'East Bulkhead Corridor',
      subtitle: 'Pressurized Transfer to Hydroponics Bio-Dome',
    };
  }
  return {
    id: 'command_dome',
    code: 'ZONE A',
    name: 'Central Command Dome',
    subtitle: 'Main Hub · Holomap, Crew Consoles & Rover Terminal',
  };
}

export function findNearestInteractable(
  playerX: number,
  playerZ: number,
  lookDirX: number,
  lookDirZ: number
): { interactable: InteriorInteractable; distance: number } | null {
  const lookLen = Math.hypot(lookDirX, lookDirZ);
  const lx = lookLen > 1e-4 ? lookDirX / lookLen : 0;
  const lz = lookLen > 1e-4 ? lookDirZ / lookLen : -1;

  // Check nearby crop racks cluster in Zone C as well so walking near any rack triggers crop_racks
  const cropClusterOffsets: Array<{ x: number; z: number }> = [
    { x: 20.0, z: -2.6 },
    { x: 22.8, z: 0.0 },
    { x: 20.0, z: 2.6 },
  ];

  let best: { interactable: InteriorInteractable; distance: number; score: number } | null = null;

  for (const item of INTERIOR_INTERACTABLES) {
    let dist = Math.hypot(item.x - playerX, item.z - playerZ);
    let targetX = item.x;
    let targetZ = item.z;

    if (item.id === 'crop_racks') {
      for (const rack of cropClusterOffsets) {
        const d = Math.hypot(rack.x - playerX, rack.z - playerZ);
        if (d < dist) {
          dist = d;
          targetX = rack.x;
          targetZ = rack.z;
        }
      }
    }

    if (dist > item.maxDistance) continue;

    const toItemX = targetX - playerX;
    const toItemZ = targetZ - playerZ;
    const toLen = Math.hypot(toItemX, toItemZ);
    const dot =
      toLen > 1e-4 ? (toItemX / toLen) * lx + (toItemZ / toLen) * lz : 1;

    // Require player to be roughly facing toward the station (dot >= 0.15) or very close (< 1.8m)
    if (dot < 0.15 && dist > 1.8) continue;

    // Higher score = better match (facing directly & closer)
    const score = dot * 2.2 - dist * 0.45;
    if (!best || score > best.score) {
      best = { interactable: item, distance: dist, score };
    }
  }

  return best ? { interactable: best.interactable, distance: best.distance } : null;
}
