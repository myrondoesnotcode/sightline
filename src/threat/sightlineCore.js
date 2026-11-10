/**
 * @module sightlineCore
 *
 * Pure math for the Sightline tool: "which windows and rooftops can see this
 * spot". No Cesium, no DOM, so it runs in a Web Worker and in node tests.
 *
 * Model (v0, stated plainly in the UI):
 *  - Ground is flat inside the search radius (no terrain yet).
 *  - Buildings come from OpenStreetMap footprints. Height = `height` tag, else
 *    levels x 3.2 m, else a default by building type (flagged "estimated").
 *  - Trees, walls, vehicles and glass are ignored, so results lean to
 *    "more exposed", which is the safe direction for a protection plan.
 *
 * Coordinates: local metres around the target, x = east, y = north, z = up
 * from ground.
 */

export const FLOOR_M = 3.2;
export const WINDOW_SPACING_M = 4;
export const ROOF_SPACING_M = 5;
export const ROOF_INSET_M = 1;
export const WINDOW_OFFSET_M = 0.6;
export const SHOOTER_EYE_M = 1.5; // window sill + standing/kneeling shooter
export const GROUND_SLACK_M = 2; // see buildHeightGrid
export const ROOF_EYE_M = 1.0; // prone/kneeling on a roof edge
export const CELL_M = 2;
export const SKIP_START_M = 2.5; // ignore the shooter's own wall/roof cell

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON_EQ = 111320;

/** Build a lon/lat <-> local metre projection centred on (lat0, lon0). */
export function makeProjection(lat0, lon0) {
  const kx = M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  return {
    toLocal: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

const TYPE_DEFAULT_H = {
  house: 7, detached: 7, semidetached_house: 7, terrace: 8, bungalow: 4,
  garage: 3, garages: 3, shed: 3, hut: 3, roof: 4, carport: 3,
  apartments: 15, residential: 12, commercial: 14, office: 18, retail: 6,
  industrial: 9, warehouse: 9, hotel: 20, school: 10, university: 14,
  hospital: 18, church: 15, cathedral: 25, mosque: 15, synagogue: 12,
  train_station: 12, parking: 10, stadium: 20, public: 14, civic: 14,
  government: 15, yes: 10,
};

/** Parse an OSM length like "12", "12 m", "40'" into metres, or null. */
export function parseLength(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  const feet = s.match(/^([\d.]+)\s*(?:'|ft|feet)$/);
  if (feet) return Number(feet[1]) * 0.3048;
  const m = s.match(/^([\d.]+)\s*(?:m|meters|metres)?$/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 && v < 1000 ? v : null;
}

/** Height in metres for an OSM building, plus whether it was estimated. */
export function buildingHeight(tags = {}) {
  const h = parseLength(tags.height) ?? parseLength(tags['building:height']);
  if (h) return { height: h, estimated: false };
  const levels = Number(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0 && levels < 200) {
    const roofLevels = Number(tags['roof:levels']) || 0;
    return { height: (levels + roofLevels * 0.5) * FLOOR_M + 1, estimated: false };
  }
  const type = tags.building || 'yes';
  return { height: TYPE_DEFAULT_H[type] ?? 10, estimated: true };
}

/** Signed area (shoelace). > 0 means counter-clockwise. */
export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Drop the closing duplicate vertex and force counter-clockwise order. */
export function normalizeRing(ring) {
  let r = ring.slice();
  if (r.length > 1) {
    const [ax, ay] = r[0];
    const [bx, by] = r[r.length - 1];
    if (ax === bx && ay === by) r.pop();
  }
  if (signedArea(r) < 0) r.reverse();
  return r;
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Rasterise building footprints into a height grid (digital surface model).
 * @param {{ring:number[][], height:number}[]} buildings local-metre rings
 * @param {number} halfSize grid covers [-halfSize, halfSize] on both axes
 */
/** Bilinear ground height (relative to the spot) from a coarse ground grid. */
export function groundAt(ground, x, y) {
  if (!ground) return 0;
  const { data, n, cell, halfSize } = ground;
  const gx = Math.max(0, Math.min(n - 1.001, (x + halfSize) / cell));
  const gy = Math.max(0, Math.min(n - 1.001, (y + halfSize) / cell));
  const i = Math.floor(gx), j = Math.floor(gy), ax = gx - i, ay = gy - j;
  const v = (a, b) => data[b * n + a];
  return (v(i, j) * (1 - ax) + v(i + 1, j) * ax) * (1 - ay) + (v(i, j + 1) * (1 - ax) + v(i + 1, j + 1) * ax) * ay;
}

export function buildHeightGrid(buildings, halfSize, cell = CELL_M, ground = null) {
  const n = Math.ceil((2 * halfSize) / cell);
  const grid = new Float32Array(n * n);
  if (ground) {
    for (let j = 0; j < n; j++) {
      const cy = -halfSize + (j + 0.5) * cell;
      // ~30 m ground data is lumpy in cities: open ground only blocks once it
      // rises clearly above the line (a real hill or slope), not by a bump.
      for (let i = 0; i < n; i++) grid[j * n + i] = groundAt(ground, -halfSize + (i + 0.5) * cell, cy) - GROUND_SLACK_M;
    }
  }
  for (const b of buildings) {
    const top = (b.base || 0) + b.height;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of b.ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const i0 = Math.max(0, Math.floor((minX + halfSize) / cell));
    const i1 = Math.min(n - 1, Math.floor((maxX + halfSize) / cell));
    const j0 = Math.max(0, Math.floor((minY + halfSize) / cell));
    const j1 = Math.min(n - 1, Math.floor((maxY + halfSize) / cell));
    for (let j = j0; j <= j1; j++) {
      const cy = -halfSize + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const cx = -halfSize + (i + 0.5) * cell;
        if (pointInRing(cx, cy, b.ring)) {
          const k = j * n + i;
          if (top > grid[k]) grid[k] = top;
        }
      }
    }
  }
  return { grid, n, cell, halfSize };
}

export function gridHeightAt(g, x, y) {
  const i = Math.floor((x + g.halfSize) / g.cell);
  const j = Math.floor((y + g.halfSize) / g.cell);
  if (i < 0 || j < 0 || i >= g.n || j >= g.n) return -Infinity;
  return g.grid[j * g.n + i];
}

/** True when the straight line from shooter to target clears every roof. */
export function hasLineOfSight(g, sx, sy, sz, tx, ty, tz, step = g.cell / 2) {
  const dx = tx - sx, dy = ty - sy, dz = tz - sz;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return true;
  const end = dist - 1; // the target's own cell
  for (let d = SKIP_START_M; d < end; d += step) {
    const f = d / dist;
    const z = sz + dz * f;
    if (gridHeightAt(g, sx + dx * f, sy + dy * f) > z) return false;
  }
  return true;
}

/**
 * Candidate shooter spots for one building: windows on walls that face the
 * target (every floor above the ground floor) and roof-edge spots.
 */
export function candidatesForBuilding(b, tx, ty, maxDist) {
  const out = [];
  const ring = b.ring;
  const floors = Math.max(1, Math.floor((b.height - 1) / FLOOR_M));
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1, v1] = ring[i];
    const [x2, y2, v2] = ring[(i + 1) % ring.length];
    if (v1 && v2) continue; // tile cut, not a real wall
    const ex = x2 - x1, ey = y2 - y1;
    const len = Math.hypot(ex, ey);
    if (len < 0.5) continue;
    // CCW ring: outward normal is (ey, -ex).
    const nx = ey / len, ny = -ex / len;
    const steps = Math.max(1, Math.round(len / WINDOW_SPACING_M));
    for (let s = 0; s < steps; s++) {
      const f = (s + 0.5) / steps;
      const px = x1 + ex * f, py = y1 + ey * f;
      const toTx = tx - px, toTy = ty - py;
      const d = Math.hypot(toTx, toTy);
      if (d > maxDist || d < 3) continue;
      const facing = (nx * toTx + ny * toTy) / d;
      if (facing > 0.05) {
        for (let fl = 1; fl < floors; fl++) {
          out.push({
            x: px + nx * WINDOW_OFFSET_M, y: py + ny * WINDOW_OFFSET_M,
            z: fl * FLOOR_M + SHOOTER_EYE_M, kind: 'window', floor: fl, dist: d,
          });
        }
      }
    }
    const roofSteps = Math.max(1, Math.round(len / ROOF_SPACING_M));
    for (let s = 0; s < roofSteps; s++) {
      const f = (s + 0.5) / roofSteps;
      const px = x1 + ex * f - nx * ROOF_INSET_M;
      const py = y1 + ey * f - ny * ROOF_INSET_M;
      const d = Math.hypot(tx - px, ty - py);
      if (d > maxDist || d < 3) continue;
      out.push({ x: px, y: py, z: b.height + ROOF_EYE_M, kind: 'roof', floor: floors, dist: d });
    }
  }
  return out;
}

export function threatBand(dist) {
  if (dist <= 150) return 'high';
  if (dist <= 400) return 'medium';
  return 'low';
}

/**
 * Full analysis.
 * @param {object} input
 * @param {{id:string, ring:number[][], height:number, estimated:boolean, name?:string}[]} input.buildings local-metre buildings
 * @param {number} input.radius search radius in metres
 * @param {number} [input.targetHeight=1.7] height of the protected person's head
 */
export function analyzeSightlines({ buildings, radius, targetHeight = 1.7, ground = null }) {
  const t0 = Date.now();
  const halfSize = radius + 60;
  const norm = buildings
    .map((b) => ({ ...b, ring: normalizeRing(b.ring) }))
    .filter((b) => b.ring.length >= 3);
  // Each building stands on the ground under its middle (relative to the spot).
  for (const b of norm) {
    let cx = 0, cy = 0;
    for (const p of b.ring) { cx += p[0]; cy += p[1]; }
    b.base = groundAt(ground, cx / b.ring.length, cy / b.ring.length);
  }
  const g = buildHeightGrid(norm, halfSize, CELL_M, ground);

  // Standing inside a footprint (e.g. clicked a roof or courtyard)? Lift the
  // target onto that surface.
  const groundAtTarget = gridHeightAt(g, 0, 0);
  const tz = groundAtTarget + targetHeight;

  const exposed = [];
  const perBuilding = new Map();
  let checked = 0;
  for (const b of norm) {
    for (const c of candidatesForBuilding(b, 0, 0, radius)) {
      c.z += b.base;
      checked++;
      if (!hasLineOfSight(g, c.x, c.y, c.z, 0, 0, tz)) continue;
      const hit = { ...c, buildingId: b.id, band: threatBand(c.dist) };
      exposed.push(hit);
      let agg = perBuilding.get(b.id);
      if (!agg) {
        agg = {
          id: b.id, name: b.name || null, height: b.height, estimated: b.estimated, base: b.base, heightSource: b.heightSource || null,
          spots: 0, windows: 0, roofs: 0, nearest: Infinity, nearestSpot: null,
          floors: new Set(),
        };
        perBuilding.set(b.id, agg);
      }
      agg.spots++;
      if (c.kind === 'window') { agg.windows++; agg.floors.add(c.floor); } else agg.roofs++;
      if (c.dist < agg.nearest) { agg.nearest = c.dist; agg.nearestSpot = hit; }
    }
  }

  const buildingsOut = [...perBuilding.values()]
    .map((a) => ({
      ...a,
      floors: [...a.floors].sort((p, q) => p - q),
      band: threatBand(a.nearest),
      bearing: bearingDeg(a.nearestSpot.x, a.nearestSpot.y),
    }))
    .sort((p, q) => p.nearest - q.nearest);

  const counts = { high: 0, medium: 0, low: 0 };
  for (const e of exposed) counts[e.band]++;

  return {
    targetZ: tz,
    groundAtTarget,
    checked,
    exposed,
    buildings: buildingsOut,
    counts,
    buildingCount: norm.length,
    estimatedHeights: norm.filter((b) => b.estimated).length,
    measuredHeights: norm.filter((b) => b.heightSource).length,
    bases: Object.fromEntries(norm.map((b) => [b.id, b.base])),
    hasGround: Boolean(ground),
    ms: Date.now() - t0,
  };
}

/** Compass bearing from the target (origin) to a local point, 0 = north. */
export function bearingDeg(x, y) {
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

export function compass(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

/**
 * Turn an Overpass `out tags geom` response into local-metre buildings.
 * Ways become one ring; multipolygon relations contribute their outer ways.
 */
export function buildingsFromOverpass(json, proj) {
  const out = [];
  for (const el of json?.elements || []) {
    const tags = el.tags || {};
    const rings = [];
    if (el.type === 'way' && Array.isArray(el.geometry)) rings.push(el.geometry);
    else if (el.type === 'relation' && Array.isArray(el.members)) {
      for (const m of el.members) {
        if (m.type === 'way' && (m.role === 'outer' || m.role === '') && Array.isArray(m.geometry)) {
          rings.push(m.geometry);
        }
      }
    }
    const { height, estimated } = buildingHeight(tags);
    const name = tags.name
      || (tags['addr:housenumber'] && tags['addr:street']
        ? `${tags['addr:housenumber']} ${tags['addr:street']}`
        : tags['addr:street'] || null);
    rings.forEach((geom, idx) => {
      const ring = geom
        .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
        .map((p) => proj.toLocal(p.lat, p.lon));
      if (ring.length >= 3) {
        out.push({
          id: `${el.type}/${el.id}${rings.length > 1 ? `#${idx}` : ''}`,
          osmId: `${el.type}/${el.id}`,
          ring, height, estimated, name, tags,
        });
      }
    });
  }
  return out;
}
