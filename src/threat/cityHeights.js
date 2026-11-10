/**
 * @module cityHeights
 *
 * Measured building heights from city open GIS, where a city publishes them.
 * These replace OpenStreetMap's estimated heights building by building.
 *
 * Tel Aviv-Yafo: municipal GIS layer "מבנים" (IView2 MapServer, layer 513),
 * ~45,800 buildings with `gova_simplex_2019` (building height from the 2019
 * survey, m), `ms_komot` (floors), `year`. CORS-open for the browser.
 * Licence: check the municipality's open-data terms before paid use.
 */
import { pointInRing } from './sightlineCore.js';

const CITIES = [
  {
    id: 'tlv',
    label: 'Tel Aviv-Yafo city survey, 2019',
    bbox: [32.02, 34.73, 32.15, 34.86], // S, W, N, E
    url: 'https://gisn.tel-aviv.gov.il/arcgis/rest/services/IView2/MapServer/513/query',
    fields: 'gova_simplex_2019,ms_komot,year,min_height',
    ground: (a) => (a.min_height > -5 && a.min_height < 200 ? a.min_height : null), // ground elevation at the building, m
    height: (a) => (a.gova_simplex_2019 > 1 ? a.gova_simplex_2019 : a.ms_komot > 0 ? a.ms_komot * 3.2 + 1 : null),
  },
];

const cache = new Map();

export function cityFor(lat, lon) {
  return CITIES.find((c) => lat >= c.bbox[0] && lat <= c.bbox[2] && lon >= c.bbox[1] && lon <= c.bbox[3]) || null;
}

async function queryCity(c, s, w, n, e) {
  const key = `${c.id}:${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
  if (cache.has(key)) return cache.get(key);
  const out = [];
  for (let offset = 0; offset < 20000; offset += 2000) {
    const q = new URLSearchParams({
      geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: c.fields, returnGeometry: 'true',
      geometryPrecision: '6', resultOffset: String(offset), resultRecordCount: '2000', f: 'json',
    });
    const res = await fetch(`${c.url}?${q}`);
    if (!res.ok) throw new Error(`city GIS ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`city GIS ${j.error.message || 'error'}`);
    for (const f of j.features || []) out.push(f);
    if (!j.exceededTransferLimit || !(j.features || []).length) break;
  }
  cache.set(key, out);
  return out;
}

/**
 * Give OSM buildings measured heights where the city has them (in place).
 * @returns {Promise<{source:string, matched:number, groundPts:number[][]}|null>}
 *   groundPts: [x, y, ground elevation] per city building, where the city has it.
 */
export async function applyCityHeights(buildings, lat, lon, radius, proj) {
  const c = cityFor(lat, lon);
  if (!c) return null;
  try {
    const pad = radius + 60;
    const [n] = proj.toLatLon(0, pad), [s] = proj.toLatLon(0, -pad);
    const [, w] = proj.toLatLon(-pad, 0), [, e] = proj.toLatLon(pad, 0);
    const feats = await Promise.race([
      queryCity(c, s, w, n, e),
      new Promise((_, rej) => setTimeout(() => rej(new Error('city GIS timeout')), 10000)),
    ]);
    // City footprints in local metres, with a quick bbox for lookup.
    const city = [];
    const groundPts = [];
    for (const f of feats) {
      const h = c.height(f.attributes || {});
      const r = f.geometry?.rings?.[0];
      const gz = c.ground?.(f.attributes || {});
      if (gz != null && r?.length >= 3) {
        let gx = 0, gy = 0;
        for (const [lo, la] of r) { const [x, y] = proj.toLocal(la, lo); gx += x; gy += y; }
        groundPts.push([gx / r.length, gy / r.length, gz]);
      }
      if (!h || !r || r.length < 3) continue;
      const ring = r.map(([lo, la]) => proj.toLocal(la, lo));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      city.push({ ring, h, floors: f.attributes.ms_komot || null, year: f.attributes.year || null, x0, y0, x1, y1 });
    }
    let matched = 0;
    for (const b of buildings) {
      // A point inside the OSM footprint: centroid, else the first vertex nudged in.
      let cx = 0, cy = 0;
      for (const p of b.ring) { cx += p[0]; cy += p[1]; }
      cx /= b.ring.length; cy /= b.ring.length;
      if (!pointInRing(cx, cy, b.ring)) { cx = (b.ring[0][0] * 3 + cx) / 4; cy = (b.ring[0][1] * 3 + cy) / 4; }
      const hit = city.find((m) => cx >= m.x0 && cx <= m.x1 && cy >= m.y0 && cy <= m.y1 && pointInRing(cx, cy, m.ring));
      if (!hit) continue;
      b.height = hit.h;
      b.estimated = false;
      b.heightSource = c.id;
      if (hit.floors) b.floorsKnown = hit.floors;
      if (hit.year) b.year = hit.year;
      matched++;
    }
    return { source: c.label, matched, groundPts };
  } catch (e) {
    console.warn('[city heights]', e);
    return null;
  }
}
