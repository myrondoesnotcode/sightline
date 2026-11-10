/**
 * @module groundTiles
 *
 * Real ground heights from the free AWS "Terrain Tiles" (Terrarium PNGs,
 * mostly SRTM / Copernicus ~30 m data, CORS-open, keyless). Decoded into a
 * small grid in local metres, relative to the ground at the spot, so the
 * analysis can see hills and slopes. In dense cities this data reads a few
 * metres high over blocks, so the result is smoothed ground, not street level.
 */
const URL_T = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const Z = 14;
const tileCache = new Map();

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

async function loadTile(x, y) {
  const key = `${x}/${y}`;
  if (!tileCache.has(key)) {
    const p = (async () => {
      const res = await fetch(URL_T.replace('{z}', Z).replace('{x}', x).replace('{y}', y));
      if (!res.ok) throw new Error(`ground tile ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const { data, width } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const h = new Float32Array(width * width);
      for (let i = 0; i < h.length; i++) h[i] = Math.max(0, data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768); // sea floor → sea level
      return { h, size: width };
    })();
    p.catch(() => tileCache.delete(key));
    tileCache.set(key, p);
  }
  return tileCache.get(key);
}

/**
 * @returns {Promise<{data:Float32Array, n:number, cell:number, halfSize:number, spotElevation:number}|null>}
 *   heights relative to the ground at the spot (spot = 0), or null if the
 *   tiles could not be loaded (the analysis then assumes flat ground).
 */
export async function fetchGround(lat, lon, halfSize, proj, cell = 10) {
  try {
    const [nLat] = proj.toLatLon(0, halfSize);
    const [sLat] = proj.toLatLon(0, -halfSize);
    const [, wLon] = proj.toLatLon(-halfSize, 0);
    const [, eLon] = proj.toLatLon(halfSize, 0);
    const x0 = Math.floor(lon2x(wLon, Z)), x1 = Math.floor(lon2x(eLon, Z));
    const y0 = Math.floor(lat2y(nLat, Z)), y1 = Math.floor(lat2y(sLat, Z));
    const tiles = new Map();
    const jobs = [];
    for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
      jobs.push(loadTile(tx, ty).then((t) => tiles.set(`${tx}/${ty}`, t)));
    }
    await Promise.race([Promise.all(jobs), new Promise((_, rej) => setTimeout(() => rej(new Error('ground timeout')), 8000))]);

    const sample = (la, lo) => {
      // Bilinear inside the z14 pixel grid.
      const fx = lon2x(lo, Z), fy = lat2y(la, Z);
      const px = (t) => t.size;
      const at = (gx, gy) => {
        const tx = Math.floor(gx), ty = Math.floor(gy);
        const t = tiles.get(`${tx}/${ty}`);
        if (!t) return NaN;
        const s = px(t);
        const i = Math.min(s - 1, Math.floor((gx - tx) * s));
        const j = Math.min(s - 1, Math.floor((gy - ty) * s));
        return t.h[j * s + i];
      };
      const s = 256;
      const gx = fx * s - 0.5, gy = fy * s - 0.5;
      const ix = Math.floor(gx), iy = Math.floor(gy);
      const ax = gx - ix, ay = gy - iy;
      const v = (i, j) => at((i + 0.5) / s, (j + 0.5) / s);
      return (v(ix, iy) * (1 - ax) + v(ix + 1, iy) * ax) * (1 - ay) + (v(ix, iy + 1) * (1 - ax) + v(ix + 1, iy + 1) * ax) * ay;
    };

    const spotElevation = sample(lat, lon);
    if (!Number.isFinite(spotElevation)) return null;
    const n = Math.ceil((2 * halfSize) / cell) + 1;
    const data = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const [la, lo] = proj.toLatLon(-halfSize + i * cell, -halfSize + j * cell);
        const h = sample(la, lo);
        data[j * n + i] = Number.isFinite(h) ? h - spotElevation : 0;
      }
    }
    return { data, n, cell, halfSize, spotElevation };
  } catch (e) {
    console.warn('[ground]', e);
    return null;
  }
}

/**
 * Ground grid from surveyed spot heights (e.g. a city's ground level at each
 * building), same shape as fetchGround. Inverse-distance blend of the points
 * within 80 m of each cell; heights relative to the ground at the spot.
 * @param {number[][]} pts [x, y, elevation] in local metres
 */
export function groundFromPoints(pts, halfSize, cell = 10) {
  if (!pts || pts.length < 30) return null;
  const R = 80, B = 40;
  const bucketsOf = (list) => {
    const m = new Map();
    for (const p of list) {
      const k = `${Math.floor(p[0] / B)},${Math.floor(p[1] / B)}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return m;
  };
  // Drop odd points (a building on a podium or roof deck): more than 6 m off
  // the median of its neighbours within 60 m.
  const raw = bucketsOf(pts);
  const clean = pts.filter((p) => {
    const bx = Math.floor(p[0] / B), by = Math.floor(p[1] / B);
    const near = [];
    for (let i = bx - 2; i <= bx + 2; i++) for (let j = by - 2; j <= by + 2; j++) {
      for (const q of raw.get(`${i},${j}`) || []) if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < 3600) near.push(q[2]);
    }
    if (near.length < 4) return true;
    near.sort((x, y) => x - y);
    return Math.abs(p[2] - near[near.length >> 1]) <= 6;
  });
  const buckets = new Map();
  for (const p of clean) {
    const k = `${Math.floor(p[0] / B)},${Math.floor(p[1] / B)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  const at = (x, y) => {
    let w = 0, z = 0;
    const bx = Math.floor(x / B), by = Math.floor(y / B);
    for (let i = bx - 2; i <= bx + 2; i++) for (let j = by - 2; j <= by + 2; j++) {
      for (const p of buckets.get(`${i},${j}`) || []) {
        const d2 = (p[0] - x) ** 2 + (p[1] - y) ** 2;
        if (d2 > R * R) continue;
        const wt = 1 / (d2 + 100);
        w += wt; z += wt * p[2];
      }
    }
    return w ? z / w : NaN;
  };
  const spotElevation = at(0, 0);
  if (!Number.isFinite(spotElevation)) return null;
  const n = Math.ceil((2 * halfSize) / cell) + 1;
  const data = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h = at(-halfSize + i * cell, -halfSize + j * cell);
      data[j * n + i] = Number.isFinite(h) ? h - spotElevation : NaN;
    }
  }
  // Cells with no survey point nearby (sea, parks): nearest filled neighbour, else 0.
  for (let pass = 0; pass < 20; pass++) {
    let missing = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      if (!Number.isNaN(data[j * n + i])) continue;
      let s = 0, c = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const v = data[jj * n + ii];
        if (!Number.isNaN(v)) { s += v; c++; }
      }
      if (c) data[j * n + i] = s / c; else missing++;
    }
    if (!missing) break;
  }
  for (let k = 0; k < data.length; k++) if (Number.isNaN(data[k])) data[k] = 0;
  return { data, n, cell, halfSize, spotElevation, source: 'survey' };
}
