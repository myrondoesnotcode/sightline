/**
 * @module buildingTiles
 *
 * Building footprints + heights from OpenFreeMap's free OpenStreetMap vector
 * tiles (OpenMapTiles schema, `building` layer with `render_height`). CDN
 * cached, keyless, CORS-open: far more reliable for a public site than the
 * shared Overpass servers.
 *
 * Ring vertices come out as [x, y, virtual] in local metres, where `virtual`
 * marks a vertex that lies on or past the tile edge. An edge between two
 * virtual vertices is a tile cut, not a real wall, so it gets no windows.
 */
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { pointInRing } from './sightlineCore.js';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const Z = 14;
let tileUrlPromise = null;
const tileCache = new Map();

function tileUrlTemplate() {
  if (!tileUrlPromise) {
    tileUrlPromise = fetch(TILEJSON)
      .then((r) => { if (!r.ok) throw new Error(`tile index ${r.status}`); return r.json(); })
      .then((j) => j.tiles[0])
      .catch((e) => { tileUrlPromise = null; throw e; });
  }
  return tileUrlPromise;
}

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

async function loadTile(x, y) {
  const key = `${x}/${y}`;
  if (!tileCache.has(key)) {
    const p = (async () => {
      const tpl = await tileUrlTemplate();
      const url = tpl.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
      const res = await fetch(url);
      if (res.status === 204 || res.status === 404) return null;
      if (!res.ok) throw new Error(`map tile ${res.status}`);
      return new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())));
    })();
    p.catch(() => tileCache.delete(key));
    tileCache.set(key, p);
  }
  return tileCache.get(key);
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * @returns {Promise<{id:string, ring:number[][], height:number, estimated:boolean, name:string|null}[]>}
 */
export async function fetchBuildingsFromTiles(lat, lon, radius, proj) {
  const pad = radius + 60;
  const [nLat] = proj.toLatLon(0, pad);
  const [sLat] = proj.toLatLon(0, -pad);
  const [, wLon] = proj.toLatLon(-pad, 0);
  const [, eLon] = proj.toLatLon(pad, 0);
  const x0 = Math.floor(lon2x(wLon, Z)), x1 = Math.floor(lon2x(eLon, Z));
  const y0 = Math.floor(lat2y(nLat, Z)), y1 = Math.floor(lat2y(sLat, Z));

  const jobs = [];
  for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) jobs.push([tx, ty]);
  const tiles = await Promise.all(jobs.map(([tx, ty]) => loadTile(tx, ty).then((t) => ({ t, tx, ty }))));

  const buildings = [];
  const labels = [];
  for (const { t, tx, ty } of tiles) {
    if (!t) continue;
    const toLocal = (px, py, extent) => {
      const la = y2lat(ty + py / extent, Z);
      const lo = x2lon(tx + px / extent, Z);
      return proj.toLocal(la, lo);
    };
    const layer = t.layers.building;
    if (layer) {
      const ext = layer.extent;
      const eps = 1;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        if (f.type !== 3) continue;
        const props = f.properties || {};
        if (props.hide_3d) continue;
        const height = Number(props.render_height) || 5;
        const minH = Number(props.render_min_height) || 0;
        if (minH > 3) continue; // bridges/skywalks/overhangs
        // Feature ids are shared by many merged footprints at z14, so every
        // outer ring gets its own id.
        const rings = f.loadGeometry();
        for (let ri = 0; ri < rings.length; ri++) {
          const r = rings[ri];
          if (r.length < 4 || ringArea(r) <= 0) continue; // outer rings only
          let outside = 0;
          const ring = r.map((p) => {
            const virt = p.x <= eps || p.y <= eps || p.x >= ext - eps || p.y >= ext - eps;
            const [x, y] = toLocal(p.x, p.y, ext);
            if (Math.hypot(x, y) > pad * 1.5) outside++;
            return [x, y, virt ? 1 : 0];
          });
          if (outside === ring.length) continue;
          buildings.push({
            id: `t${tx}_${ty}_${i}_${ri}`,
            ring,
            height,
            // OpenMapTiles falls back to ~5 m when OSM has no height/levels.
            estimated: !props.render_height || height === 5,
            name: null,
          });
        }
      }
    }
    for (const lname of ['poi', 'housenumber']) {
      const L = t.layers[lname];
      if (!L) continue;
      for (let i = 0; i < L.length; i++) {
        const f = L.feature(i);
        if (f.type !== 1) continue;
        const p = f.loadGeometry()[0]?.[0];
        if (!p) continue;
        const props = f.properties || {};
        const text = lname === 'poi' ? props['name:en'] || props.name : props.housenumber && `No. ${props.housenumber}`;
        if (!text) continue;
        const [x, y] = toLocal(p.x, p.y, L.extent);
        labels.push({ x, y, text, rank: lname === 'poi' ? 0 : 1 });
      }
    }
  }

  // Name each building after a POI inside it, else a house number.
  labels.sort((a, b) => a.rank - b.rank);
  for (const b of buildings) {
    for (const l of labels) {
      if (pointInRing(l.x, l.y, b.ring)) { b.name = l.text; break; }
    }
  }
  return buildings;
}
