/**
 * @module liveHero
 *
 * The interactive top of the landing page. Your spot follows the mouse (or a
 * tap on phones) over the real 3D city: every building that can see you turns
 * red / orange / yellow, the street area you can be seen from lights up, the
 * two closest clear shots are labelled, and the count updates as you move.
 * Uses the same line-of-sight maths as the full analysis, on a smaller radius.
 */
import {
  normalizeRing, groundAt, buildHeightGrid, gridHeightAt, hasLineOfSight,
  candidatesForBuilding, threatBand, CELL_M,
} from './sightlineCore.js';

export const LIVE_RADIUS = 300;
const LIGHT_RAYS = 240;
const HEX = { high: '#ff3b30', medium: '#ff8a00', low: '#ffd23f' };

/**
 * @param {object} o
 * @param {boolean} [o.paper]  light "paper" look: white blocks, ink lines, hatched light
 * @param {any} o.Cesium
 * @param {any} o.viewer
 * @param {{toLatLon:Function,toLocal:Function}} o.proj  local metres ↔ lat/lon
 * @param {any[]} o.buildings  local-metre buildings from the demo area
 * @param {any} o.ground  ground grid (or null)
 * @param {number} o.h0  ground height at the demo centre
 * @param {number} o.halfSize  area covered by the buildings (m)
 * @param {HTMLElement} o.host  element that receives the pointer
 * @param {(c:object)=>void} o.onUpdate  live counts
 * @param {(spot:{lat:number,lon:number})=>void} o.onOpen  "full analysis here"
 */
export function createLiveHero({ paper = false, Cesium, viewer, proj, buildings, ground, h0, halfSize, host, onUpdate, onOpen }) {
  const scene = viewer.scene;
  const norm = buildings
    .map((b) => ({ ...b, ring: normalizeRing(b.ring) }))
    .filter((b) => b.ring.length >= 3);
  for (const b of norm) {
    let cx = 0, cy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of b.ring) { cx += x; cy += y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    b.base = groundAt(ground, cx / b.ring.length, cy / b.ring.length);
    b.bb = [x0, y0, x1, y1];
  }
  const g = buildHeightGrid(norm, halfSize, CELL_M, ground);
  const reach = halfSize - LIVE_RADIUS - 10; // how far from the centre the spot may go
  // Street, square or yard: somewhere a person can stand (not inside a building).
  const isOpen = (x, y) => Math.hypot(x, y) <= reach && gridHeightAt(g, x, y) < groundAt(ground, x, y) + 0.5;

  // ── 3D buildings: one primitive, recoloured per building as you move ──
  const DARK = Cesium.Color.fromCssColorString(paper ? '#f7f7f5' : '#1d222b');
  // Paper: lighter tints so the blocks read as marked, not painted over.
  const tint = (hex) => { const c = Cesium.Color.fromCssColorString(hex); return paper ? Cesium.Color.lerp(c, Cesium.Color.WHITE, 0.3, new Cesium.Color()) : c; };
  const BAND = { high: tint(HEX.high), medium: tint(HEX.medium), low: tint(HEX.low) };
  const pos = (x, y, z) => {
    const [lat, lon] = proj.toLatLon(x, y);
    return Cesium.Cartesian3.fromDegrees(lon, lat, h0 + z);
  };
  const instances = [];
  for (const b of norm) {
    try {
      instances.push(new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(b.ring.map(([x, y]) => pos(x, y, 0))),
          height: h0 + Math.min(0, b.base),
          extrudedHeight: h0 + b.base + b.height,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        id: `lh-${b.id}`,
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(DARK) },
      }));
    } catch { /* malformed footprint */ }
  }
  const prim = scene.primitives.add(new Cesium.Primitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
    asynchronous: true,
  }));
  const painted = new Map(); // building id → band now shown

  // ── 2D overlay: ground light, the closest shots, you ──
  const cv = document.createElement('canvas');
  cv.className = 'lh-canvas';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'lh-chip';
  chip.hidden = true;
  chip.textContent = 'Full analysis here →';
  host.appendChild(chip);

  const INK = '#111';
  let hatchPat = null;
  let dpr = 1;
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    hatchPat = null;
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
  };
  resize();
  addEventListener('resize', resize);

  let you = { x: 0, y: 0 };      // shown position (eased)
  let goal = { x: 0, y: 0 };     // where it's heading
  let res = null;                // last analysis
  let resAt = null;
  let pinned = false;
  let lastPointer = 0;
  let raf = 0;
  let dead = false;

  function analyse(tx, ty) {
    const tz = gridHeightAt(g, tx, ty) + 1.7;
    const R = LIVE_RADIUS;
    const exposedBy = new Map();
    let windows = 0, roofs = 0;
    for (const b of norm) {
      const [x0, y0, x1, y1] = b.bb;
      if (x1 < tx - R || x0 > tx + R || y1 < ty - R || y0 > ty + R) continue;
      for (const c of candidatesForBuilding(b, tx, ty, R)) {
        const cz = c.z + b.base;
        if (!hasLineOfSight(g, c.x, c.y, cz, tx, ty, tz, CELL_M)) continue;
        if (c.kind === 'window') windows++; else roofs++;
        const a = exposedBy.get(b.id);
        if (!a || c.dist < a.dist) exposedBy.set(b.id, { x: c.x, y: c.y, z: cz, dist: c.dist, kind: c.kind, floor: c.floor, name: b.name });
      }
    }
    // Ground light: how far along each ray a person at street level stays in view.
    const light = new Float32Array(LIGHT_RAYS);
    const ground0 = gridHeightAt(g, tx, ty);
    for (let i = 0; i < LIGHT_RAYS; i++) {
      const a = (i / LIGHT_RAYS) * Math.PI * 2, dx = Math.sin(a), dy = Math.cos(a);
      let d = 3;
      for (; d < R; d += CELL_M) {
        if (gridHeightAt(g, tx + dx * d, ty + dy * d) > ground0 + 2.5) break;
      }
      light[i] = d;
    }
    const near = [...exposedBy.entries()].map(([id, s]) => ({ id, ...s, band: threatBand(s.dist) })).sort((p, q) => p.dist - q.dist);
    return { tx, ty, tz, windows, roofs, near, light, ground0 };
  }

  function paint() {
    if (!prim.ready || !res) return;
    const now = new Map(res.near.map((s) => [s.id, s.band]));
    for (const [id] of painted) if (!now.has(id)) setColor(id, DARK);
    for (const [id, band] of now) if (painted.get(id) !== band) setColor(id, BAND[band]);
    painted.clear();
    for (const [id, band] of now) painted.set(id, band);
  }
  function setColor(id, color) {
    const a = prim.getGeometryInstanceAttributes(`lh-${id}`);
    if (a) a.color = Cesium.ColorGeometryInstanceAttribute.toValue(color, a.color);
  }

  function hatch() {
    if (hatchPat) return hatchPat;
    const t = document.createElement('canvas');
    const n = Math.round(7 * dpr);
    t.width = t.height = n;
    const c = t.getContext('2d');
    c.strokeStyle = 'rgba(255,59,48,0.45)';
    c.lineWidth = 1 * dpr;
    c.beginPath(); c.moveTo(0, n); c.lineTo(n, 0); c.moveTo(-n / 2, n / 2); c.lineTo(n / 2, -n / 2); c.moveTo(n / 2, n * 1.5); c.lineTo(n * 1.5, n / 2); c.stroke();
    hatchPat = ctx.createPattern(t, 'repeat');
    return hatchPat;
  }
  // Paper: dashed range rings around you, labelled like a survey drawing.
  function rings(c0) {
    ctx.save();
    ctx.font = `500 ${10 * dpr}px "JetBrains Mono", monospace`;
    ctx.textBaseline = 'middle';
    for (const m of [100, 200, 300]) {
      const pts = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        const p = toScreen(you.x + Math.sin(a) * m, you.y + Math.cos(a) * m, res.ground0 + 0.2);
        if (p) pts.push(p);
      }
      if (pts.length < 10) continue;
      ctx.strokeStyle = 'rgba(17,17,17,0.35)';
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
      const lp = toScreen(you.x + m * 0.6, you.y - m * 0.8, res.ground0 + 0.2);
      if (!lp) continue;
      const text = `${m} m`;
      const w = ctx.measureText(text).width + 10 * dpr, h = 16 * dpr;
      ctx.fillStyle = '#fff';
      ctx.fillRect(lp[0] - w / 2, lp[1] - h / 2, w, h);
      ctx.strokeStyle = 'rgba(17,17,17,0.5)';
      ctx.strokeRect(lp[0] - w / 2 + 0.5, lp[1] - h / 2 + 0.5, w - 1, h - 1);
      ctx.fillStyle = INK;
      ctx.fillText(text, lp[0] - w / 2 + 5 * dpr, lp[1] + 0.5);
    }
    ctx.restore();
  }

  const toScreen = (x, y, z) => {
    const p = Cesium.SceneTransforms.worldToWindowCoordinates(scene, pos(x, y, z));
    return p ? [p.x * dpr, p.y * dpr] : null;
  };

  function draw(t) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!res) return;
    const { tx, ty, ground0 } = res;
    const c0 = toScreen(you.x, you.y, ground0 + 0.2);
    if (!c0) return;
    // Light on the street: a polygon of the ray ends, soft from the middle out.
    const pts = [];
    for (let i = 0; i < LIGHT_RAYS; i++) {
      const a = (i / LIGHT_RAYS) * Math.PI * 2;
      const p = toScreen(tx + Math.sin(a) * res.light[i], ty + Math.cos(a) * res.light[i], ground0 + 0.2);
      if (p) pts.push(p);
    }
    const edge = toScreen(tx + LIVE_RADIUS, ty, ground0);
    const rPx = edge ? Math.hypot(edge[0] - c0[0], edge[1] - c0[1]) : 300 * dpr;
    ctx.save();
    if (paper) {
      // Paper: the street area you can be seen from, tinted and hatched in red.
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      const tint = ctx.createRadialGradient(c0[0], c0[1], 0, c0[0], c0[1], rPx);
      tint.addColorStop(0, 'rgba(255,59,48,0.30)');
      tint.addColorStop(1, 'rgba(255,59,48,0.08)');
      ctx.fillStyle = tint;
      ctx.fill();
      ctx.fillStyle = hatch();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,59,48,0.55)';
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
      ctx.restore();
      ctx.save();
    }
    ctx.globalCompositeOperation = paper ? 'source-over' : 'lighter';
    const grad = ctx.createRadialGradient(c0[0], c0[1], 0, c0[0], c0[1], rPx);
    grad.addColorStop(0, 'rgba(255,245,235,0.8)');
    grad.addColorStop(0.2, 'rgba(255,130,95,0.42)');
    grad.addColorStop(0.7, 'rgba(255,70,45,0.14)');
    grad.addColorStop(1, 'rgba(255,60,40,0.04)');
    if (!paper) {
      ctx.fillStyle = grad;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
    }
    // Every building that sees you: a glowing point at its closest spot.
    for (const s of res.near) {
      const p = toScreen(s.x, s.y, s.z);
      if (!p) continue;
      ctx.fillStyle = HEX[s.band];
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(p[0], p[1], 2.6 * dpr, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    if (paper) rings(c0);

    // The two closest clear shots: a line to you and a tag.
    ctx.save();
    ctx.font = `600 ${11 * dpr}px "JetBrains Mono", monospace`;
    ctx.textBaseline = 'middle';
    const boxes = [];
    for (const s of res.near.slice(0, 2)) {
      const p = toScreen(s.x, s.y, s.z);
      if (!p) continue;
      ctx.strokeStyle = paper ? INK : HEX[s.band];
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash(paper ? [] : [5 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(c0[0], c0[1]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = HEX[s.band];
      ctx.beginPath(); ctx.arc(p[0], p[1], 5 * dpr, 0, Math.PI * 2); ctx.fill();
      const where = s.kind === 'roof' ? 'roof' : `floor ${s.floor}`;
      const text = `CLEAR SHOT · ${where} · ${Math.round(s.dist)} m`;
      const w = ctx.measureText(text).width + 14 * dpr, h = 22 * dpr;
      const pr = innerWidth >= 600 ? host.querySelector('.threat-panel')?.getBoundingClientRect() : null;
      let left = p[0] < c0[0];
      if (left && pr && p[0] - w - 10 * dpr < pr.right * dpr) left = false;
      if (!left && p[0] + w + 18 * dpr > cv.width) left = true;
      const bx = Math.max(8 * dpr, Math.min(cv.width - w - 8 * dpr, left ? p[0] - w - 10 * dpr : p[0] + 10 * dpr));
      let by = p[1] - h / 2;
      // Keep the two tags from sitting on top of each other.
      for (const o of boxes) if (bx < o[0] + o[2] && o[0] < bx + w && Math.abs(by - o[1]) < h + 6 * dpr) by = o[1] + (by >= o[1] ? 1 : -1) * (h + 6 * dpr);
      boxes.push([bx, by, w]);
      ctx.fillStyle = paper ? '#fff' : 'rgba(8,10,14,0.92)';
      ctx.fillRect(bx, by, w, h);
      if (paper) { ctx.strokeStyle = INK; ctx.lineWidth = 1 * dpr; ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1); }
      ctx.fillStyle = HEX[s.band];
      ctx.fillRect(left ? bx + w - 3 * dpr : bx, by, 3 * dpr, h);
      ctx.fillStyle = paper ? INK : '#fff';
      ctx.fillText(text, bx + 8 * dpr, by + h / 2 + 0.5);
    }
    ctx.restore();

    // You: a white dot with a breathing ring.
    const pulse = (t / 1400) % 1;
    ctx.save();
    ctx.strokeStyle = paper ? `rgba(17,17,17,${0.6 * (1 - pulse)})` : `rgba(255,255,255,${0.7 * (1 - pulse)})`;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.arc(c0[0], c0[1], (10 + pulse * 22) * dpr, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.shadowColor = paper ? 'rgba(0,0,0,0.25)' : 'rgba(255,90,60,0.9)'; ctx.shadowBlur = (paper ? 6 : 14) * dpr;
    ctx.beginPath(); ctx.arc(c0[0], c0[1], 6 * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = pinned ? '#ff3b30' : paper ? INK : '#0b0e13';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
    ctx.restore();

    if (pinned && !chip.hidden) {
      const below = c0[1] / dpr < innerHeight - 150;
      chip.style.transform = `translate(${c0[0] / dpr}px, ${c0[1] / dpr + (below ? 26 : -62)}px) translateX(-50%)`;
    }
  }

  function tick(t) {
    if (dead) return;
    raf = requestAnimationFrame(tick);
    // With no hand on it, the spot strolls slowly around the square.
    if (!pinned && t - lastPointer > 3500) {
      const k = t / 9000;
      const w = { x: Math.sin(k) * 70, y: Math.sin(k * 1.7) * 45 };
      if (isOpen(w.x, w.y)) goal = w;
    }
    you.x += (goal.x - you.x) * 0.18;
    you.y += (goal.y - you.y) * 0.18;
    const moved = (!resAt || Math.hypot(you.x - resAt.x, you.y - resAt.y) > 1.5) && (isOpen(you.x, you.y) || !res);
    if (moved) {
      res = analyse(you.x, you.y);
      resAt = { x: you.x, y: you.y };
      paint();
      const [lat, lon] = proj.toLatLon(you.x, you.y);
      onUpdate({
        total: res.windows + res.roofs, windows: res.windows, roofs: res.roofs,
        buildings: res.near.length, nearest: res.near[0]?.dist ?? null, lat, lon,
      });
      scene.requestRender();
    } else if (!prim.ready || painted.size === 0) paint();
    draw(t);
  }
  raf = requestAnimationFrame(tick);

  // ── Pointer ──
  const level = new Cesium.Ellipsoid(6378137 + h0, 6378137 + h0, 6356752.3142451793 + h0);
  function toLocal(e) {
    // Not under the headline/panel on desktop: tags there would cover the text.
    const pr = host.querySelector('.threat-panel')?.getBoundingClientRect();
    if (pr && innerWidth >= 600 && e.clientX < pr.right + 24) return null;
    if (e.clientY > innerHeight - 90) return null; // credit + place tag strip
    if (pr && innerWidth < 600 && e.clientY < pr.bottom + 12) return null;
    const c = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(e.clientX, e.clientY), level);
    if (!c) return null;
    const cg = Cesium.Cartographic.fromCartesian(c, level);
    const [x, y] = proj.toLocal(Cesium.Math.toDegrees(cg.latitude), Cesium.Math.toDegrees(cg.longitude));
    return isOpen(x, y) ? { x, y } : null;
  }
  const onMap = (e) => e.target === host || e.target.classList?.contains('lh-host');
  const move = (e) => {
    if (e.pointerType === 'touch' || pinned || !onMap(e)) return;
    const p = toLocal(e);
    if (!p) return;
    lastPointer = performance.now();
    goal = p;
    host.classList.add('lh-following');
  };
  const leave = () => host.classList.remove('lh-following');
  const click = (e) => {
    if (!onMap(e)) return;
    const p = toLocal(e);
    if (!p) return;
    lastPointer = performance.now();
    goal = p;
    pinned = true;
    chip.hidden = false;
  };
  const key = (e) => { if (e.key === 'Escape' && pinned) unpin(); };
  function unpin() { pinned = false; chip.hidden = true; lastPointer = performance.now(); }
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    const [lat, lon] = proj.toLatLon(goal.x, goal.y);
    onOpen({ lat, lon });
  });
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerleave', leave);
  host.addEventListener('click', click);
  host.addEventListener('dblclick', unpin);
  addEventListener('keydown', key);

  return {
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      removeEventListener('resize', resize);
      removeEventListener('keydown', key);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
      host.removeEventListener('click', click);
      host.removeEventListener('dblclick', unpin);
      cv.remove();
      chip.remove();
      scene.primitives.remove(prim);
      scene.requestRender();
    },
  };
}
