import * as THREE from 'three';

function hash2D(ix: number, iy: number, seed = 1337): number {
  const n = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function valueNoise2D(x: number, y: number, period: number, seed = 1337): number {
  const ix0 = Math.floor(x);
  const iy0 = Math.floor(y);
  const fx = x - ix0;
  const fy = y - iy0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const wx0 = ((ix0 % period) + period) % period;
  const wy0 = ((iy0 % period) + period) % period;
  const wx1 = (wx0 + 1) % period;
  const wy1 = (wy0 + 1) % period;

  const a = hash2D(wx0, wy0, seed);
  const b = hash2D(wx1, wy0, seed);
  const c = hash2D(wx0, wy1, seed);
  const d = hash2D(wx1, wy1, seed);

  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function tileableFbm(u: number, v: number, baseFreq: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = baseFreq;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D(u * freq, v * freq, freq, seed + i * 31);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  return { canvas, ctx };
}

function configureDataTexture(
  tex: THREE.DataTexture | THREE.CanvasTexture,
  isColor: boolean,
  maxAnisotropy: number,
  repeatX = 1,
  repeatY = 1
): void {
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = maxAnisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
}

/**
 * In-code HTML5 Canvas procedural noise/grain PBR generator (bumpMap + roughnessMap).
 */
export function createProceduralNoisePbrMaps(
  maxAnisotropy: number,
  options: {
    size?: number;
    seed?: number;
    baseFreq?: number;
    octaves?: number;
    roughnessMin?: number;
    roughnessMax?: number;
    repeat?: number;
    streaks?: boolean;
  } = {}
): {
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = options.size ?? 256;
  const seed = options.seed ?? 503;
  const baseFreq = options.baseFreq ?? 10;
  const octaves = options.octaves ?? 4;
  const rMin = options.roughnessMin ?? 0.35;
  const rMax = options.roughnessMax ?? 0.9;
  const repeat = options.repeat ?? 2;

  const { canvas: bumpCanvas, ctx: bumpCtx } = makeCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(size);

  const bumpImg = bumpCtx.createImageData(size, size);
  const roughImg = roughCtx.createImageData(size, size);
  const bData = bumpImg.data;
  const rData = roughImg.data;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const n = tileableFbm(u, v, baseFreq, octaves, seed);
      const grain = hash2D(x, y, seed + 91);
      const streak = options.streaks ? tileableFbm(u * 0.35, v * 4.0, 12, 2, seed + 17) : 0.5;
      const h = Math.max(0, Math.min(1, n * 0.65 + grain * 0.2 + streak * 0.15));

      const bumpByte = Math.round(h * 255);
      const roughVal = rMin + (1 - h) * (rMax - rMin);
      const roughByte = Math.max(0, Math.min(255, Math.round(roughVal * 255)));

      const idx = (y * size + x) * 4;
      bData[idx] = bumpByte;
      bData[idx + 1] = bumpByte;
      bData[idx + 2] = bumpByte;
      bData[idx + 3] = 255;

      rData[idx] = roughByte;
      rData[idx + 1] = roughByte;
      rData[idx + 2] = roughByte;
      rData[idx + 3] = 255;
    }
  }

  bumpCtx.putImageData(bumpImg, 0, 0);
  roughCtx.putImageData(roughImg, 0, 0);

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  configureDataTexture(bumpMap, false, maxAnisotropy, repeat, repeat);

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  configureDataTexture(roughnessMap, false, maxAnisotropy, repeat, repeat);

  return { bumpMap, roughnessMap };
}

/**
 * High-resolution (512x512) tileable Martian Jezero Ochre-Sienna (#A65132) regolith
 * albedo + tangent normalMap + HTML5 Canvas wind-ripple bumpMap & roughnessMap.
 */
export function createMarsRegolithTextures(maxAnisotropy: number): {
  map: THREE.CanvasTexture;
  normalMap: THREE.DataTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 512;
  const count = size * size;
  const heightField = new Float32Array(count);

  const { canvas: colorCanvas, ctx: colorCtx } = makeCanvas(size);
  const { canvas: bumpCanvas, ctx: bumpCtx } = makeCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(size);

  const colorImg = colorCtx.createImageData(size, size);
  const bumpImg = bumpCtx.createImageData(size, size);
  const roughImg = roughCtx.createImageData(size, size);
  const cData = colorImg.data;
  const bData = bumpImg.data;
  const rData = roughImg.data;
  const normalData = new Uint8Array(count * 4);

  // 1. Multi-octave FBM + wind-blown sand ripples + gritty regolith grain
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const macro = tileableFbm(u, v, 6, 4, 101);
      const micro = tileableFbm(u, v, 24, 3, 409);
      const warp = macro * 0.45 + micro * 0.14;
      const ripplePhase = (u * 20.0 + v * 7.0 + warp * 2.4) * Math.PI * 2;
      const ripples = Math.sin(ripplePhase) * 0.5 + 0.5;
      const grit = hash2D(x, y, 777);

      const h = macro * 0.46 + micro * 0.24 + ripples * 0.22 + grit * 0.08;
      heightField[y * size + x] = h;

      // Rich Jezero Ochre-Sienna (#A65132 = 166, 81, 50) with muted sunlit crests & dark basalt troughs
      const crest = Math.min(1, Math.max(0, (h - 0.36) * 1.85));
      const basaltMask = Math.max(0, 1 - macro * 2.15);

      const r = 152 + crest * 34 - basaltMask * 54 + (grit - 0.5) * 14;
      const g = 76 + crest * 24 - basaltMask * 26 + (grit - 0.5) * 10;
      const b = 48 + crest * 16 - basaltMask * 14 + (grit - 0.5) * 8;

      const idx = (y * size + x) * 4;
      cData[idx] = Math.max(0, Math.min(255, Math.round(r)));
      cData[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      cData[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      cData[idx + 3] = 255;

      const bumpByte = Math.max(0, Math.min(255, Math.round(h * 255)));
      bData[idx] = bumpByte;
      bData[idx + 1] = bumpByte;
      bData[idx + 2] = bumpByte;
      bData[idx + 3] = 255;

      // Roughness variation: gritty troughs rougher (~0.98), wind-polished ripple crests slightly smoother (~0.84)
      const roughVal = 0.84 + (1 - h) * 0.14 + (grit - 0.5) * 0.05;
      const roughByte = Math.max(0, Math.min(255, Math.round(roughVal * 255)));
      rData[idx] = roughByte;
      rData[idx + 1] = roughByte;
      rData[idx + 2] = roughByte;
      rData[idx + 3] = 255;
    }
  }

  colorCtx.putImageData(colorImg, 0, 0);
  bumpCtx.putImageData(bumpImg, 0, 0);
  roughCtx.putImageData(roughImg, 0, 0);

  // 2. Compute tangent-space normal map via central differences
  const strength = 4.6;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;

      const hL = heightField[y * size + xm];
      const hR = heightField[y * size + xp];
      const hD = heightField[ym * size + x];
      const hU = heightField[yp * size + x];

      const dx = (hR - hL) * strength;
      const dy = (hU - hD) * strength;
      const nz = 1.0;
      const invLen = 1 / Math.hypot(dx, dy, nz);

      const nx = -dx * invLen;
      const ny = -dy * invLen;
      const nzz = nz * invLen;

      const idx = (y * size + x) * 4;
      normalData[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      normalData[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalData[idx + 2] = Math.round((nzz * 0.5 + 0.5) * 255);
      normalData[idx + 3] = 255;
    }
  }

  const map = new THREE.CanvasTexture(colorCanvas);
  configureDataTexture(map, true, maxAnisotropy, 16, 16);

  const normalMap = new THREE.DataTexture(normalData, size, size, THREE.RGBAFormat);
  configureDataTexture(normalMap, false, maxAnisotropy, 16, 16);

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  configureDataTexture(bumpMap, false, maxAnisotropy, 16, 16);

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  configureDataTexture(roughnessMap, false, maxAnisotropy, 16, 16);

  return { map, normalMap, bumpMap, roughnessMap };
}

/**
 * High-contrast pitted pores & rough fractured edges for Volcanic Basalt Rocks (bumpMap + roughnessMap).
 */
export function createBasaltRockPbrMaps(maxAnisotropy: number): {
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 256;
  const { canvas: bumpCanvas, ctx: bumpCtx } = makeCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(size);

  const bumpImg = bumpCtx.createImageData(size, size);
  const roughImg = roughCtx.createImageData(size, size);
  const bData = bumpImg.data;
  const rData = roughImg.data;

  // Deterministic vesicular basalt pore locations
  const pores: Array<{ x: number; y: number; r: number }> = [];
  let pSeed = 907;
  const pRand = () => {
    pSeed = (pSeed * 1664525 + 1013904223) % 4294967296;
    return pSeed / 4294967296;
  };
  for (let i = 0; i < 190; i++) {
    pores.push({
      x: pRand() * size,
      y: pRand() * size,
      r: 1.8 + pRand() * 5.8,
    });
  }

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const coarse = tileableFbm(u, v, 5, 4, 211);
      const fracture = Math.abs(tileableFbm(u, v, 9, 3, 613) - 0.5) * 2.0;
      const edgeSharp = Math.min(1, fracture * 1.65);
      const grit = hash2D(x, y, 881);

      let pitDepth = 0;
      for (let k = 0; k < pores.length; k++) {
        const p = pores[k];
        let dx = Math.abs(x - p.x);
        let dy = Math.abs(y - p.y);
        if (dx > size * 0.5) dx = size - dx;
        if (dy > size * 0.5) dy = size - dy;
        const d = Math.hypot(dx, dy);
        if (d < p.r) {
          const t = 1 - d / p.r;
          pitDepth = Math.max(pitDepth, t * t * 0.72);
        }
      }

      const h = Math.max(0, Math.min(1, coarse * 0.48 + edgeSharp * 0.42 + grit * 0.14 - pitDepth));
      const bumpByte = Math.round(h * 255);
      // Pitted pores are very matte/rough (0.98), sharp fractured basalt facets catch subtle grazing highlights (0.72)
      const roughVal = Math.max(0.68, Math.min(1.0, 0.74 + (1 - h) * 0.25 + pitDepth * 0.2));
      const roughByte = Math.round(roughVal * 255);

      const idx = (y * size + x) * 4;
      bData[idx] = bumpByte;
      bData[idx + 1] = bumpByte;
      bData[idx + 2] = bumpByte;
      bData[idx + 3] = 255;

      rData[idx] = roughByte;
      rData[idx + 1] = roughByte;
      rData[idx + 2] = roughByte;
      rData[idx + 3] = 255;
    }
  }

  bumpCtx.putImageData(bumpImg, 0, 0);
  roughCtx.putImageData(roughImg, 0, 0);

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  configureDataTexture(bumpMap, false, maxAnisotropy, 2, 2);

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  configureDataTexture(roughnessMap, false, maxAnisotropy, 2, 2);

  return { bumpMap, roughnessMap };
}

/**
 * High-res PBR solar cell array textures: Deep Cobalt Blue (#0D3B66) photovoltaic wafer cells,
 * fine photovoltaic grid weave, and paired bumpMap + roughnessMap.
 */
export function createSolarCellPbrMaps(maxAnisotropy: number): {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  const { canvas: bumpCanvas, ctx: bumpCtx } = makeCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(size);

  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#07223D');
  grad.addColorStop(0.5, '#0D3B66');
  grad.addColorStop(1, '#082849');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  bumpCtx.fillStyle = '#B8B8B8';
  bumpCtx.fillRect(0, 0, size, size);
  roughCtx.fillStyle = '#2E2E2E'; // glossy silicon wafers
  roughCtx.fillRect(0, 0, size, size);

  const cols = 8;
  const rows = 5;
  const cw = size / cols;
  const ch = size / rows;

  // Individual photovoltaic wafer cells with fine weave and silver collector fingers
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw + 3;
      const y = r * ch + 3;
      const w = cw - 6;
      const h = ch - 6;
      ctx.fillStyle = (r + c) % 2 === 0 ? '#0D3B66' : '#114678';
      ctx.fillRect(x, y, w, h);

      bumpCtx.fillStyle = '#C8C8C8';
      bumpCtx.fillRect(x, y, w, h);
      roughCtx.fillStyle = '#2A2A2A';
      roughCtx.fillRect(x, y, w, h);

      // Fine photovoltaic grid weave (horizontal + vertical micro-fingers)
      ctx.strokeStyle = 'rgba(147, 197, 253, 0.24)';
      ctx.lineWidth = 1;
      bumpCtx.strokeStyle = '#E0E0E0';
      bumpCtx.lineWidth = 1;
      roughCtx.strokeStyle = '#525252';
      roughCtx.lineWidth = 1;

      for (let fy = y + 6; fy < y + h - 3; fy += 6) {
        ctx.beginPath();
        ctx.moveTo(x + 2, fy);
        ctx.lineTo(x + w - 2, fy);
        ctx.stroke();

        bumpCtx.beginPath();
        bumpCtx.moveTo(x + 2, fy);
        bumpCtx.lineTo(x + w - 2, fy);
        bumpCtx.stroke();

        roughCtx.beginPath();
        roughCtx.moveTo(x + 2, fy);
        roughCtx.lineTo(x + w - 2, fy);
        roughCtx.stroke();
      }
      for (let fx = x + 10; fx < x + w - 3; fx += 10) {
        ctx.beginPath();
        ctx.moveTo(fx, y + 2);
        ctx.lineTo(fx, y + h - 2);
        ctx.stroke();
      }
    }
  }

  // Primary silver-cyan busbar grid seams (recessed slightly in bump, rougher matte silver)
  ctx.strokeStyle = '#38BDF8';
  ctx.lineWidth = 2.5;
  bumpCtx.strokeStyle = '#505050';
  bumpCtx.lineWidth = 3;
  roughCtx.strokeStyle = '#888888';
  roughCtx.lineWidth = 3;

  for (let c = 0; c <= cols; c++) {
    ctx.beginPath();
    ctx.moveTo(c * cw, 0);
    ctx.lineTo(c * cw, size);
    ctx.stroke();

    bumpCtx.beginPath();
    bumpCtx.moveTo(c * cw, 0);
    bumpCtx.lineTo(c * cw, size);
    bumpCtx.stroke();

    roughCtx.beginPath();
    roughCtx.moveTo(c * cw, 0);
    roughCtx.lineTo(c * cw, size);
    roughCtx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * ch);
    ctx.lineTo(size, r * ch);
    ctx.stroke();

    bumpCtx.beginPath();
    bumpCtx.moveTo(0, r * ch);
    bumpCtx.lineTo(size, r * ch);
    bumpCtx.stroke();

    roughCtx.beginPath();
    roughCtx.moveTo(0, r * ch);
    roughCtx.lineTo(size, r * ch);
    roughCtx.stroke();
  }

  ctx.strokeStyle = 'rgba(186, 230, 253, 0.45)';
  ctx.lineWidth = 1.5;
  for (let c = 0; c < cols; c++) {
    const bx = c * cw + cw * 0.5;
    ctx.beginPath();
    ctx.moveTo(bx, 0);
    ctx.lineTo(bx, size);
    ctx.stroke();
  }

  const map = new THREE.CanvasTexture(canvas);
  configureDataTexture(map, true, maxAnisotropy, 1, 1);

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  configureDataTexture(bumpMap, false, maxAnisotropy, 1, 1);

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  configureDataTexture(roughnessMap, false, maxAnisotropy, 1, 1);

  return { map, bumpMap, roughnessMap };
}

export function createSolarCellTexture(maxAnisotropy: number): THREE.CanvasTexture {
  return createSolarCellPbrMaps(maxAnisotropy).map;
}

/**
 * Crisp Titanium White (#EEF4F8) geodesic dome paneling with metallic micro-panel seams,
 * rivets, and paired bumpMap + roughnessMap.
 */
export function createHabitatHullPbrMaps(maxAnisotropy: number): {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  const { canvas: bumpCanvas, ctx: bumpCtx } = makeCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(size);

  // Crisp Titanium White (#EEF4F8) aerospace hull with subtle lower dust kiss
  const vGrad = ctx.createLinearGradient(0, 0, 0, size);
  vGrad.addColorStop(0.0, '#F5F9FC');
  vGrad.addColorStop(0.55, '#EEF4F8');
  vGrad.addColorStop(0.84, '#DDE6EE');
  vGrad.addColorStop(0.95, '#B68A74');
  vGrad.addColorStop(1.0, '#8E5840');
  ctx.fillStyle = vGrad;
  ctx.fillRect(0, 0, size, size);

  // Micro-brushed titanium base for bump & roughness
  bumpCtx.fillStyle = '#B8B8B8';
  bumpCtx.fillRect(0, 0, size, size);
  roughCtx.fillStyle = '#4A4A4A';
  roughCtx.fillRect(0, 0, size, size);

  let seed = 314;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  // Fine horizontal brushed titanium micro-grain
  for (let i = 0; i < 420; i++) {
    const y = rand() * size;
    const x = rand() * size;
    const w = 18 + rand() * 52;
    const shade = Math.round(165 + rand() * 36);
    bumpCtx.strokeStyle = `rgb(${shade},${shade},${shade})`;
    bumpCtx.lineWidth = 1;
    bumpCtx.beginPath();
    bumpCtx.moveTo(x, y);
    bumpCtx.lineTo(x + w, y);
    bumpCtx.stroke();

    const rShade = Math.round(58 + rand() * 42);
    roughCtx.strokeStyle = `rgb(${rShade},${rShade},${rShade})`;
    roughCtx.lineWidth = 1;
    roughCtx.beginPath();
    roughCtx.moveTo(x, y);
    roughCtx.lineTo(x + w, y);
    roughCtx.stroke();
  }

  // Metallic micro-panel seams (12x6 geodesic panel grid)
  ctx.strokeStyle = 'rgba(30, 41, 59, 0.34)';
  ctx.lineWidth = 2;
  bumpCtx.strokeStyle = '#424242';
  bumpCtx.lineWidth = 2.5;
  roughCtx.strokeStyle = '#9E9E9E';
  roughCtx.lineWidth = 2.5;

  for (let i = 1; i < 12; i++) {
    const x = (i / 12) * size;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();

    bumpCtx.beginPath();
    bumpCtx.moveTo(x, 0);
    bumpCtx.lineTo(x, size);
    bumpCtx.stroke();

    roughCtx.beginPath();
    roughCtx.moveTo(x, 0);
    roughCtx.lineTo(x, size);
    roughCtx.stroke();
  }
  for (let j = 1; j < 6; j++) {
    const y = (j / 6) * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();

    bumpCtx.beginPath();
    bumpCtx.moveTo(0, y);
    bumpCtx.lineTo(size, y);
    bumpCtx.stroke();

    roughCtx.beginPath();
    roughCtx.moveTo(0, y);
    roughCtx.lineTo(size, y);
    roughCtx.stroke();
  }

  // Subtle specular highlight strip & rivets along seams
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 12; i++) {
    const x = (i / 12) * size + 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }

  // Micro-rivets at panel corners
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 6; j++) {
      const px = (i / 12) * size + 7;
      const py = (j / 6) * size + 7;
      bumpCtx.fillStyle = '#ECECEC';
      bumpCtx.beginPath();
      bumpCtx.arc(px, py, 1.8, 0, Math.PI * 2);
      bumpCtx.fill();
    }
  }

  // Light lower-edge ochre-sienna dust grit speckles
  for (let i = 0; i < 240; i++) {
    const x = rand() * size;
    const y = size * (0.78 + rand() * 0.22);
    const r = 1.2 + rand() * 4.2;
    const a = (y / size - 0.75) * 1.1;
    ctx.fillStyle = `rgba(166, 81, 50, ${Math.min(0.32, a)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    roughCtx.fillStyle = 'rgba(235, 235, 235, 0.45)';
    roughCtx.beginPath();
    roughCtx.arc(x, y, r, 0, Math.PI * 2);
    roughCtx.fill();
  }

  const map = new THREE.CanvasTexture(canvas);
  configureDataTexture(map, true, maxAnisotropy, 1, 1);
  map.wrapT = THREE.ClampToEdgeWrapping;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  configureDataTexture(bumpMap, false, maxAnisotropy, 1, 1);
  bumpMap.wrapT = THREE.ClampToEdgeWrapping;

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  configureDataTexture(roughnessMap, false, maxAnisotropy, 1, 1);
  roughnessMap.wrapT = THREE.ClampToEdgeWrapping;

  return { map, bumpMap, roughnessMap };
}

export function createHabitatHullTexture(maxAnisotropy: number): THREE.CanvasTexture {
  return createHabitatHullPbrMaps(maxAnisotropy).map;
}

export function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(size / 2, size / 2, 6, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(10, 12, 18, 0.82)');
  grad.addColorStop(0.52, 'rgba(16, 16, 22, 0.40)');
  grad.addColorStop(1, 'rgba(16, 16, 22, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Dark landing scorch / thruster blast & disturbed dust halo decal.
 */
export function createScorchDecalTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const cx = size / 2;
  const cy = size / 2;

  const grad = ctx.createRadialGradient(cx, cy, 18, cx, cy, size * 0.49);
  grad.addColorStop(0.0, 'rgba(18, 20, 26, 0.90)');
  grad.addColorStop(0.55, 'rgba(34, 28, 28, 0.68)');
  grad.addColorStop(0.78, 'rgba(72, 42, 30, 0.38)');
  grad.addColorStop(1.0, 'rgba(166, 81, 50, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Radial blast streaks
  let seed = 919;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < 54; i++) {
    const a = (i / 54) * Math.PI * 2 + (rand() - 0.5) * 0.12;
    const inner = 36 + rand() * 16;
    const outer = 88 + rand() * 38;
    ctx.strokeStyle = rand() > 0.3 ? 'rgba(20, 18, 22, 0.50)' : 'rgba(166, 81, 50, 0.25)';
    ctx.lineWidth = 2.5 + rand() * 4.0;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Tileable dual rover tire tracks + subtle astronaut bootprint trail decal.
 */
export function createRoverTrackTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const width = 128;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, width, height);

  const drawTrackStrip = (xCenter: number) => {
    ctx.fillStyle = 'rgba(42, 22, 16, 0.58)';
    ctx.fillRect(xCenter - 12, 0, 24, height);
    ctx.fillStyle = 'rgba(196, 118, 84, 0.24)';
    ctx.fillRect(xCenter - 16, 0, 4, height);
    ctx.fillRect(xCenter + 12, 0, 4, height);

    ctx.strokeStyle = 'rgba(18, 12, 12, 0.72)';
    ctx.lineWidth = 2.5;
    for (let y = 8; y < height; y += 16) {
      ctx.beginPath();
      ctx.moveTo(xCenter - 10, y);
      ctx.lineTo(xCenter, y + 5);
      ctx.lineTo(xCenter + 10, y);
      ctx.stroke();
    }
  };

  drawTrackStrip(32);
  drawTrackStrip(96);

  ctx.fillStyle = 'rgba(28, 16, 14, 0.55)';
  for (let i = 0; i < 6; i++) {
    const by = 18 + i * 40;
    const bx = i % 2 === 0 ? 57 : 71;
    ctx.beginPath();
    ctx.ellipse(bx, by, 3.6, 6.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

/**
 * Soft radial dust mote sprite for subtle airborne Martian dust particles.
 */
export function createDustParticleSpriteTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, 'rgba(226, 186, 158, 0.85)');
  grad.addColorStop(0.45, 'rgba(186, 124, 96, 0.40)');
  grad.addColorStop(1.0, 'rgba(166, 81, 50, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Low-opacity wind-swept dust-mote sheet texture for animated ground-skimming atmospheric layers.
 */
export function createDustSheetTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);

  ctx.clearRect(0, 0, size, size);

  let seed = 419;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  // Soft wispy wind-blown sand plumes
  for (let i = 0; i < 42; i++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const rx = 28 + rand() * 58;
    const ry = 8 + rand() * 18;
    const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, rx);
    grad.addColorStop(0, 'rgba(224, 178, 148, 0.24)');
    grad.addColorStop(0.55, 'rgba(182, 118, 90, 0.10)');
    grad.addColorStop(1, 'rgba(166, 81, 50, 0)');
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    ctx.translate(-cx, -cy);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Fine wind-blown dust motes inside the sheet
  for (let i = 0; i < 160; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 0.8 + rand() * 1.8;
    ctx.fillStyle = `rgba(244, 214, 192, ${0.15 + rand() * 0.25})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Soft edge vignette so sheets never show hard borders
  const maskGrad = ctx.createRadialGradient(size / 2, size / 2, size * 0.14, size / 2, size / 2, size * 0.5);
  maskGrad.addColorStop(0, 'rgba(255,255,255,1)');
  maskGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = maskGrad;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  configureDataTexture(tex, true, maxAnisotropy, 1, 1);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function createDustOverlayTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, size, size);

  let seed = 808;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let i = 0; i < 480; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 2 + rand() * 11;
    const alpha = 0.08 + rand() * 0.22;
    ctx.fillStyle = rand() > 0.4 ? `rgba(166, 81, 50, ${alpha})` : `rgba(128, 56, 36, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(176, 92, 60, 0.2)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 24; i++) {
    const y = rand() * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.quadraticCurveTo(size * 0.5, y + (rand() - 0.5) * 14, size, y);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  configureDataTexture(tex, true, maxAnisotropy, 2, 2);
  return tex;
}

/**
 * Quilted Gold-Kapton or Silver-Mylar MLI thermal insulation blanket PBR maps
 * (diamond/grid quilted stitching + foil crinkle bumpMap + metallic roughnessMap).
 */
export function createMliBlanketPbrMaps(
  maxAnisotropy: number,
  variant: 'gold' | 'silver' = 'gold'
): {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  const { canvas: bumpCanvas, ctx: bumpCtx } = makeCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(size);

  const img = ctx.createImageData(size, size);
  const bImg = bumpCtx.createImageData(size, size);
  const rImg = roughCtx.createImageData(size, size);
  const d = img.data;
  const bd = bImg.data;
  const rd = rImg.data;

  const isGold = variant === 'gold';
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Crinkled Kapton/Mylar micro-facets + quilted pillow puffs
      const crinkle = tileableFbm(u, v, 14, 3, isGold ? 601 : 709);
      const fineCrinkle = Math.abs(tileableFbm(u * 1.4, v * 1.4, 20, 2, 811) - 0.5) * 2.0;

      // Diamond quilt pillow pattern (6x6 grid rotated 45 deg)
      const qx = ((u + v) * 5.0) % 1;
      const qy = ((u - v + 2.0) * 5.0) % 1;
      const seamDist = Math.min(qx, 1 - qx, qy, 1 - qy);
      const seamDip = seamDist < 0.065 ? (0.065 - seamDist) / 0.065 : 0;
      const pillow = Math.sin(Math.min(1, seamDist * 2.2) * Math.PI * 0.5);

      const h = Math.max(0, Math.min(1, pillow * 0.62 + crinkle * 0.28 + fineCrinkle * 0.14 - seamDip * 0.68));

      const baseR = isGold ? 216 : 206;
      const baseG = isGold ? 156 : 216;
      const baseB = isGold ? 42 : 228;
      const shade = 0.72 + h * 0.42 - seamDip * 0.25;

      const idx = (y * size + x) * 4;
      d[idx] = Math.max(0, Math.min(255, Math.round(baseR * shade)));
      d[idx + 1] = Math.max(0, Math.min(255, Math.round(baseG * shade)));
      d[idx + 2] = Math.max(0, Math.min(255, Math.round(baseB * shade)));
      d[idx + 3] = 255;

      const bByte = Math.round(h * 255);
      bd[idx] = bByte;
      bd[idx + 1] = bByte;
      bd[idx + 2] = bByte;
      bd[idx + 3] = 255;

      const roughVal = Math.max(0.14, Math.min(0.68, 0.18 + fineCrinkle * 0.18 + seamDip * 0.42));
      const rByte = Math.round(roughVal * 255);
      rd[idx] = rByte;
      rd[idx + 1] = rByte;
      rd[idx + 2] = rByte;
      rd[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  bumpCtx.putImageData(bImg, 0, 0);
  roughCtx.putImageData(rImg, 0, 0);

  const map = new THREE.CanvasTexture(canvas);
  configureDataTexture(map, true, maxAnisotropy, 3, 2);
  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  configureDataTexture(bumpMap, false, maxAnisotropy, 3, 2);
  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  configureDataTexture(roughnessMap, false, maxAnisotropy, 3, 2);

  return { map, bumpMap, roughnessMap };
}

/**
 * Grated metallic deck flooring PBR maps for the Habitat Interior (perforated industrial grating +
 * recessed sub-floor channels + diamond grip ridges + corner fasteners).
 */
export function createGratedDeckPbrMaps(maxAnisotropy: number): {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  const { canvas: bumpCanvas, ctx: bumpCtx } = makeCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(size);

  // Dark metallic sub-deck background
  ctx.fillStyle = '#141B26';
  ctx.fillRect(0, 0, size, size);
  bumpCtx.fillStyle = '#383838';
  bumpCtx.fillRect(0, 0, size, size);
  roughCtx.fillStyle = '#B8B8B8';
  roughCtx.fillRect(0, 0, size, size);

  const cells = 4;
  const cell = size / cells;

  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      const ox = col * cell;
      const oy = row * cell;

      // Brushed slate plate perimeter frame
      ctx.fillStyle = '#253142';
      ctx.fillRect(ox + 3, oy + 3, cell - 6, cell - 6);
      bumpCtx.fillStyle = '#C4C4C4';
      bumpCtx.fillRect(ox + 3, oy + 3, cell - 6, cell - 6);
      roughCtx.fillStyle = '#5C5C5C';
      roughCtx.fillRect(ox + 3, oy + 3, cell - 6, cell - 6);

      // Inner grated ventilation slots
      const pad = 16;
      const innerW = cell - pad * 2;
      ctx.fillStyle = '#0B1018';
      ctx.fillRect(ox + pad, oy + pad, innerW, innerW);
      bumpCtx.fillStyle = '#1E1E1E';
      bumpCtx.fillRect(ox + pad, oy + pad, innerW, innerW);
      roughCtx.fillStyle = '#D4D4D4';
      roughCtx.fillRect(ox + pad, oy + pad, innerW, innerW);

      // Raised steel grating bars inside slot
      const bars = 6;
      for (let b = 0; b < bars; b++) {
        const bx = ox + pad + (b + 0.5) * (innerW / bars) - 3;
        ctx.fillStyle = '#334155';
        ctx.fillRect(bx, oy + pad + 2, 6, innerW - 4);
        bumpCtx.fillStyle = '#E6E6E6';
        bumpCtx.fillRect(bx, oy + pad + 2, 6, innerW - 4);
        roughCtx.fillStyle = '#4A4A4A';
        roughCtx.fillRect(bx, oy + pad + 2, 6, innerW - 4);
      }
      for (let hb = 1; hb < 4; hb++) {
        const by = oy + pad + hb * (innerW / 4) - 2;
        ctx.fillStyle = '#475569';
        ctx.fillRect(ox + pad + 2, by, innerW - 4, 4);
        bumpCtx.fillStyle = '#EAEAEA';
        bumpCtx.fillRect(ox + pad + 2, by, innerW - 4, 4);
        roughCtx.fillStyle = '#424242';
        roughCtx.fillRect(ox + pad + 2, by, innerW - 4, 4);
      }

      // Corner hex bolts
      const bolts = [
        [ox + 9, oy + 9],
        [ox + cell - 9, oy + 9],
        [ox + 9, oy + cell - 9],
        [ox + cell - 9, oy + cell - 9],
      ];
      for (const [bx, by] of bolts) {
        ctx.fillStyle = '#64748B';
        ctx.beginPath();
        ctx.arc(bx, by, 2.8, 0, Math.PI * 2);
        ctx.fill();
        bumpCtx.fillStyle = '#FFFFFF';
        bumpCtx.beginPath();
        bumpCtx.arc(bx, by, 2.8, 0, Math.PI * 2);
        bumpCtx.fill();
      }
    }
  }

  const map = new THREE.CanvasTexture(canvas);
  configureDataTexture(map, true, maxAnisotropy, 7, 7);
  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  configureDataTexture(bumpMap, false, maxAnisotropy, 7, 7);
  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  configureDataTexture(roughnessMap, false, maxAnisotropy, 7, 7);

  return { map, bumpMap, roughnessMap };
}

/**
 * Padded white/slate NASA acoustic habitat wall panels with stitched cushion bevels,
 * micro-weave fabric grain, and equipment rail strips.
 */
export function createAcousticWallPbrMaps(maxAnisotropy: number): {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  const { canvas: bumpCanvas, ctx: bumpCtx } = makeCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(size);

  ctx.fillStyle = '#CBD5E1';
  ctx.fillRect(0, 0, size, size);
  bumpCtx.fillStyle = '#484848';
  bumpCtx.fillRect(0, 0, size, size);
  roughCtx.fillStyle = '#ADADAD';
  roughCtx.fillRect(0, 0, size, size);

  const cols = 2;
  const rows = 2;
  const pw = size / cols;
  const ph = size / rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * pw + 6;
      const y = r * ph + 6;
      const w = pw - 12;
      const h = ph - 12;

      const grad = ctx.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, r === 0 ? '#EEF4F8' : '#D6E0EB');
      grad.addColorStop(0.5, r === 0 ? '#E2E9F0' : '#B9C6D6');
      grad.addColorStop(1, r === 0 ? '#CED8E4' : '#94A3B8');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);

      ctx.strokeStyle = '#64748B';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      const bGrad = bumpCtx.createRadialGradient(x + w / 2, y + h / 2, 8, x + w / 2, y + h / 2, w * 0.72);
      bGrad.addColorStop(0, '#F0F0F0');
      bGrad.addColorStop(0.75, '#C8C8C8');
      bGrad.addColorStop(1, '#686868');
      bumpCtx.fillStyle = bGrad;
      bumpCtx.fillRect(x, y, w, h);

      roughCtx.fillStyle = r === 0 ? '#9E9E9E' : '#858585';
      roughCtx.fillRect(x, y, w, h);

      // Subtle horizontal acoustic stitch line + cargo tie-down grommets
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.35)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x + 8, y + h / 2);
      ctx.lineTo(x + w - 8, y + h / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#334155';
      ctx.fillRect(x + 8, y + 8, 6, 6);
      ctx.fillRect(x + w - 14, y + 8, 6, 6);
    }
  }

  const map = new THREE.CanvasTexture(canvas);
  configureDataTexture(map, true, maxAnisotropy, 2, 1);
  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  configureDataTexture(bumpMap, false, maxAnisotropy, 2, 1);
  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  configureDataTexture(roughnessMap, false, maxAnisotropy, 2, 1);

  return { map, bumpMap, roughnessMap };
}

export interface LiveTelemetryScreenHandle {
  texture: THREE.CanvasTexture;
  draw: (
    timeSec: number,
    metrics: {
      powerKwh: number;
      lifePct: number;
      healthPct: number;
      waterWallCm: number;
      crisisActive: boolean;
    }
  ) => void;
}

/**
 * Dynamic CanvasTexture updater for curved multi-monitor telemetry desks in Habitat Interior Mode.
 * Draws crisp real-time scrolling waveforms + live resource readouts.
 */
export function createLiveTelemetryScreen(
  title: string,
  subtitle: string,
  accentHex: string,
  mode: 'power' | 'life' | 'health' | 'water' | 'rover'
): LiveTelemetryScreenHandle {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;

  const draw = (
    timeSec: number,
    metrics: {
      powerKwh: number;
      lifePct: number;
      healthPct: number;
      waterWallCm: number;
      crisisActive: boolean;
    }
  ) => {
    const strokeCol = metrics.crisisActive ? '#F43F5E' : accentHex;
    ctx.fillStyle = '#050A14';
    ctx.fillRect(0, 0, 512, 256);

    // Subtle telemetry grid
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
    ctx.lineWidth = 1;
    for (let gx = 32; gx < 512; gx += 32) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, 256);
      ctx.stroke();
    }
    for (let gy = 32; gy < 256; gy += 32) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(512, gy);
      ctx.stroke();
    }

    // Outer bezel border
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, 500, 244);

    // Header
    ctx.fillStyle = strokeCol;
    ctx.font = 'bold 21px monospace';
    ctx.fillText(title, 20, 36);

    ctx.fillStyle = '#94A3B8';
    ctx.font = '14px monospace';
    ctx.fillText(subtitle, 20, 58);

    // Live numeric readout box on right
    const valStr =
      mode === 'power'
        ? `${metrics.powerKwh.toFixed(0)} kWh`
        : mode === 'life'
        ? `O2 ${metrics.lifePct.toFixed(0)}%`
        : mode === 'health'
        ? `CREW ${metrics.healthPct.toFixed(0)}%`
        : `SHLD ${metrics.waterWallCm}cm`;
    const subStr =
      mode === 'power'
        ? `CREW ${metrics.healthPct.toFixed(0)}%`
        : mode === 'life'
        ? `RAD ${metrics.crisisActive ? 'ALERT' : 'NOMINAL'}`
        : mode === 'health'
        ? `VITALS ${metrics.crisisActive ? 'STRESS' : 'NOMINAL'}`
        : mode === 'water'
        ? `H2O JACKET OK`
        : `FHAZ LINK OK`;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(340, 18, 152, 54);
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(340, 18, 152, 54);
    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(valStr, 352, 43);
    ctx.fillStyle = strokeCol;
    ctx.font = '12px monospace';
    ctx.fillText(subStr, 352, 62);

    // Live scrolling dual waveform traces
    const drawWave = (
      baseY: number,
      amp: number,
      freq: number,
      speed: number,
      col: string,
      phaseOffset: number
    ) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      for (let x = 20; x <= 492; x += 6) {
        const nx = (x - 20) / 472;
        const beat =
          Math.sin(nx * freq * Math.PI * 2 - timeSec * speed + phaseOffset) * 0.65 +
          Math.sin(nx * freq * 2.7 * Math.PI * 2 - timeSec * (speed * 1.4)) * 0.35;
        const py = baseY + beat * amp;
        if (x === 20) ctx.moveTo(x, py);
        else ctx.lineTo(x, py);
      }
      ctx.stroke();
    };

    const ampPower = Math.max(8, (metrics.powerKwh / 120) * 26);
    const ampLife = Math.max(8, (metrics.lifePct / 100) * 26);
    drawWave(124, ampPower, 2.5, 2.8, strokeCol, 0);
    drawWave(176, ampLife, 3.2, 2.1, '#10B981', 1.4);

    // Live bottom bar gauges
    const bars = [
      { label: 'PWR', ratio: Math.min(1, metrics.powerKwh / 120), col: '#F59E0B' },
      { label: 'O2', ratio: Math.min(1, metrics.lifePct / 100), col: '#00E5FF' },
      { label: 'HLTH', ratio: Math.min(1, metrics.healthPct / 100), col: '#10B981' },
    ];
    bars.forEach((b, idx) => {
      const bx = 20 + idx * 160;
      ctx.fillStyle = '#CBD5E1';
      ctx.font = '12px monospace';
      ctx.fillText(b.label, bx, 224);
      ctx.fillStyle = '#1E293B';
      ctx.fillRect(bx + 42, 213, 102, 12);
      ctx.fillStyle = b.col;
      ctx.fillRect(bx + 42, 213, Math.max(4, Math.round(102 * b.ratio)), 12);
    });

    texture.needsUpdate = true;
  };

  draw(0, { powerKwh: 88, lifePct: 80, healthPct: 88, waterWallCm: 16, crisisActive: false });
  return { texture, draw };
}

