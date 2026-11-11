/**
 * @module threatTool
 *
 * The Sightline panel: search, use your location or tap the map to set a spot, find every window and rooftop
 * that has a clear line to it, draw them, add cordon rings, and write a brief.
 */
import * as Cesium from 'cesium';
import { makeProjection, compass, threatBand } from './sightlineCore.js';
import { fetchBuildingsFromTiles } from './buildingTiles.js';
import { fetchGround, groundFromPoints } from './groundTiles.js';
import { applyCityHeights } from './cityHeights.js';
import { buildBriefPdf } from './pdfBrief.js';
import { mountLanding } from './landingPage.js';
import { createLiveHero, LIVE_RADIUS } from './liveHero.js';
import { governorRequestRender } from '../renderGovernor.js';
import './threat.css';

const BAND_COLOR = {
  high: Cesium.Color.fromCssColorString('#ff3b30'),
  medium: Cesium.Color.fromCssColorString('#ff8a00'),
  low: Cesium.Color.fromCssColorString('#ffd23f'),
};
const BAND_LABEL = { high: 'Under 150 m', medium: '150–400 m', low: 'Over 400 m' };
const BAND_MIN = { high: 0, medium: 150, low: 400 };
const RINGS_M = [100, 300, 600];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const DIR_WORD = { N: 'north', NE: 'northeast', E: 'east', SE: 'southeast', S: 'south', SW: 'southwest', W: 'west', NW: 'northwest' };
const compassWord = (deg) => DIR_WORD[compass(deg)] || compass(deg);

function fmtM(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

export function initThreatTool({ viewer, tileset, mapStackController }) {
  const scene = viewer.scene;
  const state = {
    picking: false,
    radius: 600,
    target: null, // { lat, lon, h0 }
    result: null,
    buildings: null,
    showRings: true,
    showLines: true,
    busy: false,
    dark: true,
  };

  // ── Scene objects ────────────────────────────────────────────────────────
  const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const lines = scene.primitives.add(new Cesium.PolylineCollection());
  const rings = scene.primitives.add(new Cesium.PolylineCollection());
  const labels = scene.primitives.add(new Cesium.LabelCollection());
  let buildingPrim = null;
  let glowEnt = null;
  let glowCanvas = null;
  function makeGlow() {
    if (glowCanvas) return glowCanvas;
    glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 256;
    const g = glowCanvas.getContext('2d');
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(255,255,255,0.55)');
    grd.addColorStop(0.35, 'rgba(255,235,225,0.22)');
    grd.addColorStop(1, 'rgba(255,220,210,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    return glowCanvas;
  }

  // Dark map (the Vilya-like look): the same OSM tiles, greyed and dimmed.
  // No extra tile provider, key or licence; works for whatever base layer
  // the map stack swaps in.
  function styleBase() {
    const L = viewer.imageryLayers;
    for (let i = 0; i < L.length; i++) {
      const l = L.get(i);
      if (l.imageryProvider === satProvider) continue;
      // Landing: the light "paper" map (pale grey streets, white blocks).
      if (document.body.classList.contains('landing')) { l.saturation = 0; l.brightness = 1.22; l.contrast = 0.42; l.gamma = 0.9; }
      else if (state.dark) { l.saturation = 0; l.brightness = 0.3; l.contrast = 1.8; l.gamma = 1.15; }
      else { l.saturation = 1; l.brightness = 1; l.contrast = 1; l.gamma = 1; }
    }
  }
  viewer.imageryLayers.layerAdded.addEventListener(styleBase);
  function setDark(on) {
    state.dark = on;
    styleBase();
    document.body.classList.toggle('sl-dark', on);
    if (state.result) drawResult();
    render();
  }

  // Flat ground. The analysis already treats the ground as flat around the
  // spot, and the keyless Re:Earth terrain drew Tel Aviv at heights that
  // jumped by tens of metres between zoom levels (-8 / 22 / 44 m), so our
  // buildings sank into it and low window views started underground.
  // Google 3D hides the globe anyway, so nothing is lost there.
  if (mapStackController) mapStackController._reearthTerrainProvider = new Cesium.EllipsoidTerrainProvider();
  viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  const photoreal = () => Boolean(tileset && tileset.show);
  // Real ground photo where Google has no 3D city (all of Israel): Google's
  // 2D satellite tiles, same key and API, under Sightline's solid buildings.
  let satProvider = null;
  let satLayer = null;
  const satOn = () => Boolean(satLayer?.show);
  async function setSat(on) {
    if (on && !satLayer) {
      const key = import.meta.env.GOOGLE_MAPS_API_KEY;
      if (!key) return;
      try {
        satProvider = await Cesium.Google2DImageryProvider.fromUrl({ key, mapType: 'satellite' });
        satLayer = viewer.imageryLayers.addImageryProvider(satProvider);
      } catch (e) { console.warn('[threat] satellite', e); return; }
    }
    if (!satLayer || satLayer.show === on) return;
    satLayer.show = on;
    viewer.imageryLayers.raiseToTop(satLayer);
    document.body.classList.toggle('sl-sat', on);
    if (state.result) drawResult();
    render();
  }
  const render = () => governorRequestRender('threat-tool');

  function clearScene() {
    points.removeAll();
    lines.removeAll();
    rings.removeAll();
    labels.removeAll();
    if (glowEnt) { viewer.entities.remove(glowEnt); glowEnt = null; }
    if (buildingPrim) {
      scene.primitives.remove(buildingPrim);
      buildingPrim = null;
    }
    render();
  }

  // ── Worker ───────────────────────────────────────────────────────────────
  let worker = null;
  let jobId = 0;
  const pending = new Map();
  // One plain line on how good the data under this result is.
  function dataQuality(r) {
    const n = Math.max(1, r.buildingCount);
    const est = Math.round((100 * r.estimatedHeights) / n);
    const parts = [];
    if (r.city?.matched) parts.push(`${100 - est}% of heights measured (${r.city.source}), ${est}% estimated`);
    else parts.push(`${est}% of heights estimated from building type`);
    parts.push(r.hasGround ? `real ground (${r.groundSource || '30 m elevation data'}${r.relief >= 3 ? `, ${r.relief} m rise across the area` : ''})` : 'flat ground');
    parts.push('no trees');
    return parts.join('; ');
  }

  function runAnalysis(payload) {
    if (!worker) {
      worker = new Worker(new URL('./sightlineWorker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (ev) => {
        const p = pending.get(ev.data.id);
        if (!p) return;
        pending.delete(ev.data.id);
        if (ev.data.ok) p.resolve(ev.data.result);
        else p.reject(new Error(ev.data.error));
      };
    }
    const id = ++jobId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...payload });
    });
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  function drawResult() {
    clearScene();
    const { target, result, buildings, proj } = state;
    if (!target || !result) return;
    const pos = (x, y, z) => {
      const [lat, lon] = proj.toLatLon(x, y);
      return Cesium.Cartesian3.fromDegrees(lon, lat, target.h0 + z);
    };
    const depthOff = photoreal() ? Number.POSITIVE_INFINITY : 0;

    // A soft light on the ground around the spot, like a spotlight.
    if (state.dark && !photoreal() && !satOn() && !pov) {
      const R = Math.min(state.radius, 600) * 0.5;
      glowEnt = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(target.lon, target.lat, target.h0),
        ellipse: {
          semiMajorAxis: R, semiMinorAxis: R, height: target.h0 + 0.2,
          material: new Cesium.ImageMaterialProperty({ image: makeGlow(), transparent: true }),
        },
      });
    }

    // Without the photoreal city, extrude the OSM buildings so there is a 3D
    // scene to read. Buildings that can see the spot are solid, coloured by
    // their nearest band; the rest are faded so the danger stands out. In
    // "View from here" everything goes pale and see-through, so the view
    // isn't a wall of colour.
    const inPov = Boolean(pov);
    if (!photoreal() && buildings?.length) {
      const exposedBand = new Map(result.buildings.map((b) => [b.id, b.band]));
      const solid = [];
      const faded = [];
      const blindColor = satOn()
        ? Cesium.Color.fromCssColorString('#f1eee8').withAlpha(0.5)
        : state.dark
          ? Cesium.Color.fromCssColorString('#2a3039').withAlpha(0.55)
          : Cesium.Color.fromCssColorString('#8a94a6').withAlpha(0.3);
      for (const b of buildings) {
        const band = exposedBand.get(b.id);
        const base = result.bases?.[b.id] || 0;
        let color;
        let list;
        if (inPov) {
          color = band ? BAND_COLOR[band].withAlpha(0.28) : blindColor.withAlpha(0.22);
          list = faded;
        } else if (band) {
          color = BAND_COLOR[band];
          list = solid;
        } else {
          color = blindColor;
          list = faded;
        }
        const positions = b.ring.map(([x, y]) => {
          const [lat, lon] = proj.toLatLon(x, y);
          return Cesium.Cartesian3.fromDegrees(lon, lat, target.h0);
        });
        try {
          list.push(new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(positions),
              height: target.h0 + Math.min(0, base),
              extrudedHeight: target.h0 + base + b.height,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            id: band ? { buildingId: b.id } : undefined,
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
          }));
        } catch { /* skip malformed footprint */ }
      }
      const prims = [];
      if (solid.length) {
        prims.push(new Cesium.Primitive({
          geometryInstances: solid,
          appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
          asynchronous: true,
        }));
      }
      if (faded.length) {
        prims.push(new Cesium.Primitive({
          geometryInstances: faded,
          appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }),
          asynchronous: true,
        }));
      }
      if (prims.length) {
        buildingPrim = new Cesium.PrimitiveCollection();
        prims.forEach((p) => buildingPrim.add(p));
        scene.primitives.add(buildingPrim);
      }
    }

    // Window dots: none on the overview (the building colour says it), one
    // per building on Google 3D (we don't draw buildings there), and every
    // window of the building you're looking from in View from here.
    const dotSpots = inPov
      ? []
      : photoreal()
        ? result.buildings.map((b) => b.nearestSpot)
        : [];
    for (const e of dotSpots) {
      points.add({
        position: pos(e.x, e.y, e.z),
        color: BAND_COLOR[e.band],
        pixelSize: 9,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 1.5,
        disableDepthTestDistance: depthOff,
        id: { spot: e },
      });
    }

    const targetPos = pos(0, 0, result.targetZ);
    if (inPov && state.povSpot) {
      // Just the one line: from this window to the spot.
      const s = state.povSpot;
      lines.add({
        positions: [pos(s.x, s.y, s.z), targetPos],
        width: 2,
        material: Cesium.Material.fromType('PolylineDash', { color: Cesium.Color.WHITE.withAlpha(0.7), dashLength: 12 }),
      });
    } else if (state.showLines) {
      // The 5 closest buildings, each line labelled with its distance.
      for (const bl of result.buildings.slice(0, 5)) {
        const s = bl.nearestSpot;
        lines.add({
          positions: [pos(s.x, s.y, s.z), targetPos],
          width: 2.5,
          material: Cesium.Material.fromType('PolylineOutline', {
            color: BAND_COLOR[bl.band],
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 1,
          }),
        });
        labels.add({
          position: pos(s.x, s.y, s.z),
          pixelOffset: new Cesium.Cartesian2(0, -14),
          text: fmtM(bl.nearest),
          font: '700 12px "IBM Plex Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: BAND_COLOR[bl.band].withAlpha(0.95),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
    }
    // A person-sized post at the spot, so you can judge scale up close.
    if (inPov) {
      const [lat, lon] = [target.lat, target.lon];
      glowEnt = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, target.h0 + 0.85),
        cylinder: {
          length: 1.7, topRadius: 0.25, bottomRadius: 0.25,
          material: Cesium.Color.WHITE.withAlpha(0.95),
          outline: true, outlineColor: Cesium.Color.fromCssColorString('#ff3b30'),
        },
      });
    }

    points.add({
      position: targetPos,
      color: Cesium.Color.WHITE,
      pixelSize: 12,
      outlineColor: Cesium.Color.fromCssColorString('#ff3b30'),
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    labels.add({
      position: targetPos,
      text: 'YOUR SPOT',
      font: '600 12px "IBM Plex Mono", monospace',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -18),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });

    if (state.showRings && !inPov) {
      for (const r of RINGS_M) {
        if (r > state.radius + 1) continue;
        const ringPts = [];
        for (let a = 0; a <= 72; a++) {
          const t = (a / 72) * Math.PI * 2;
          ringPts.push(pos(Math.sin(t) * r, Math.cos(t) * r, 1));
        }
        rings.add({
          positions: ringPts,
          width: 2,
          material: Cesium.Material.fromType('PolylineDash', {
            color: Cesium.Color.WHITE.withAlpha(0.85),
            dashLength: 16,
          }),
        });
        labels.add({
          position: pos(0, -r, 2),
          text: `${r} m`,
          font: '600 11px "IBM Plex Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
    }
    render();
  }

  const narrow = () => window.innerWidth < 600;

  function flyToTarget() {
    const { target, proj } = state;
    if (!target) return;
    // On phones the panel covers the top of the screen, so aim the camera a
    // little past the spot: the spot then lands in the visible lower half.
    const heading = 20;
    let { lat, lon } = target;
    if (narrow() && proj) {
      const d = state.radius * 0.7;
      const h = Cesium.Math.toRadians(heading);
      [lat, lon] = proj.toLatLon(Math.sin(h) * d, Math.cos(h) * d);
    }
    const center = Cesium.Cartesian3.fromDegrees(lon, lat, target.h0);
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, state.radius * 0.6), {
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading), Cesium.Math.toRadians(-38), state.radius * (narrow() ? 2.6 : 2.1)),
      duration: 1.6,
    });
  }

  function flyToBuilding(b) {
    const { target, proj } = state;
    const s = b.nearestSpot;
    const [lat, lon] = proj.toLatLon(s.x, s.y);
    const center = Cesium.Cartesian3.fromDegrees(lon, lat, target.h0 + s.z);
    // Look from the target's side so the exposed wall faces the camera.
    const heading = Cesium.Math.toRadians((b.bearing + 180) % 360);
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, 20), {
      offset: new Cesium.HeadingPitchRange(heading + Math.PI, Cesium.Math.toRadians(-15), Math.max(80, b.nearest * 0.9)),
      duration: 1.2,
    });
  }

  // ── Map key: what the colours mean, on the map itself ───────────────────
  const keyEl = el('div', 'threat-key');
  keyEl.hidden = true;
  keyEl.setAttribute('aria-label', 'Map key');
  document.body.appendChild(keyEl);
  function showKey() {
    const r = state.result;
    if (!r || document.body.classList.contains('landing')) { keyEl.hidden = true; return; }
    keyEl.innerHTML = `<span class="threat-key-title">Can see your spot</span>
      <span class="threat-key-item"><i class="high"></i>under 150 m</span>
      <span class="threat-key-item"><i class="medium"></i>150–400 m</span>
      <span class="threat-key-item"><i class="low"></i>over 400 m</span>
      <span class="threat-key-item"><i class="blind"></i>can't see it</span>`;
    keyEl.hidden = false;
  }

  // ── View from here: stand at a window or roof that can see the spot ─────
  let pov = null; // camera to return to + POV index
  let instantPov = false; // PDF snapshots jump straight there
  const povBar = el('div', 'threat-pov');
  povBar.hidden = true;
  povBar.innerHTML = `
    <button type="button" class="threat-pov-back" title="Back to the map (Esc)">← Back</button>
    <div class="threat-pov-text"><span class="threat-pov-kicker">VIEW FROM HERE</span><b class="threat-pov-where"></b><span class="threat-pov-meta"></span></div>
    <div class="threat-pov-step">
      <button type="button" class="threat-pov-prev" title="Previous building" aria-label="Previous building">‹</button>
      <button type="button" class="threat-pov-next" title="Next building" aria-label="Next building">›</button>
    </div>
    <div class="threat-pov-zoom">
      <button type="button" class="threat-pov-out" title="Zoom out" aria-label="Zoom out">−</button>
      <button type="button" class="threat-pov-in" title="Zoom in (like binoculars)" aria-label="Zoom in">+</button>
    </div>`;
  document.body.appendChild(povBar);
  const FOV0 = viewer.camera.frustum.fov;
  const setFov = (deg) => {
    viewer.camera.frustum.fov = Cesium.Math.toRadians(Math.min(70, Math.max(6, deg)));
    render();
  };
  const fovDeg = () => Cesium.Math.toDegrees(viewer.camera.frustum.fov);
  const onPovWheel = (ev) => {
    if (!pov) return;
    ev.preventDefault();
    ev.stopPropagation();
    setFov(fovDeg() * (ev.deltaY > 0 ? 1.12 : 1 / 1.12));
  };
  const onPovKey = (ev) => { if (pov && ev.key === 'Escape') exitPov(); };

  function buildingOf(s) {
    const list = state.result?.buildings || [];
    const i = list.findIndex((b) => b.id === s.buildingId);
    return { b: list[i], i };
  }
  function viewFrom(s) {
    const { target, proj, result } = state;
    if (!target || !result || !s) return;
    exitLanding();
    stopOrbit();
    const cam = viewer.camera;
    if (!pov) {
      pov = {
        position: cam.position.clone(),
        heading: cam.heading, pitch: cam.pitch, roll: cam.roll,
        saved: {
          enableTranslate: cc.enableTranslate, enableZoom: cc.enableZoom,
          enableTilt: cc.enableTilt, enableRotate: cc.enableRotate,
          lookEventTypes: cc.lookEventTypes, collision: cc.enableCollisionDetection,
        },
      };
      viewer.canvas.addEventListener('wheel', onPovWheel, { passive: false, capture: true });
      window.addEventListener('keydown', onPovKey);
    }
    const { b, i } = buildingOf(s);
    pov.index = i;
    state.povSpot = s;
    drawResult();
    const at = (x, y, z) => {
      const [lat, lon] = proj.toLatLon(x, y);
      return Cesium.Cartesian3.fromDegrees(lon, lat, target.h0 + z);
    };
    // Stand 1.5 m out from the wall, toward the spot.
    const d = Math.hypot(s.x, s.y) || 1;
    const k = Math.max(0, 1 - 1.5 / d);
    let eye = at(s.x * k, s.y * k, s.z);
    const aim = at(0, 0, result.targetZ);
    // Google's real buildings (and trees) don't line up exactly with the
    // OpenStreetMap outlines the windows come from, so the eye can land inside
    // Google's mesh and the view turns into a smear. Trace from the spot back
    // toward the window and stand just in front of the first real surface.
    let blockedAt = 0;
    if (photoreal() && tileset) {
      const span = Cesium.Cartesian3.distance(aim, eye);
      const back = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(eye, aim, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      // Our own lines and dots would fill the hit list first: hide everything
      // but Google's tiles for the instant of the trace.
      const prims = viewer.scene.primitives;
      const hidden = [];
      for (let pi = 0; pi < prims.length; pi++) {
        const p = prims.get(pi);
        if (p && p !== tileset && p.show) { p.show = false; hidden.push(p); }
      }
      let hits = [];
      try { hits = viewer.scene.drillPickFromRay(new Cesium.Ray(aim, back), 4) || []; } catch { hits = []; }
      for (const p of hidden) p.show = true;
      for (const h of hits) {
        if (!h?.position || h.object?.primitive !== tileset) continue;
        const dist = Cesium.Cartesian3.distance(aim, h.position);
        if (dist < 2 || dist > span + 0.5) continue; // the spot's own ground / past the window
        const stand = Math.max(1, dist - 1);
        eye = Cesium.Cartesian3.add(aim, Cesium.Cartesian3.multiplyByScalar(back, stand, new Cesium.Cartesian3()), new Cesium.Cartesian3());
        blockedAt = span - stand;
        break;
      }
    }
    // Keep a low window eye at standing height above the ground.
    if (!photoreal()) {
      const c = Cesium.Cartographic.fromCartesian(eye);
      const g = state.target.h0;
      if (c.height < g + 1.6) eye = Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, g + 1.6);
    }
    const dir = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(aim, eye, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(eye, new Cesium.Cartesian3());
    const right = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(dir, normal, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const up = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(right, dir, new Cesium.Cartesian3()), new Cesium.Cartesian3());

    // Drag looks around from where you stand; the wheel is the zoom lens.
    cc.enableTranslate = false;
    cc.enableZoom = false;
    cc.enableTilt = false;
    cc.enableRotate = false;
    cc.enableCollisionDetection = false;
    cc.lookEventTypes = [Cesium.CameraEventType.LEFT_DRAG, Cesium.CameraEventType.RIGHT_DRAG];
    // Default to a lens that shows a person at the spot at a readable size.
    setFov(Math.min(60, Math.max(14, 2600 / Math.max(40, d))));

    const name = b?.name || (i >= 0 ? `Building ${i + 1}` : 'A building');
    const where = s.kind === 'roof' ? 'roof' : `floor ${s.floor}`;
    povBar.querySelector('.threat-pov-where').textContent = `${name}, ${where}`;
    povBar.querySelector('.threat-pov-meta').textContent = blockedAt > 15
      ? `${fmtM(d)} from your spot · Google 3D shows something in the way (a tree or newer building), so this is from just in front of it`
      : `${fmtM(d)} from your spot · clear line of sight`;
    const n = result.buildings.length;
    povBar.querySelector('.threat-pov-step').hidden = n < 2;
    povBar.hidden = false;
    document.body.classList.add('sl-pov');
    if (document.hidden || instantPov) cam.setView({ destination: eye, orientation: { direction: dir, up } });
    else cam.flyTo({ destination: eye, orientation: { direction: dir, up }, duration: 1.4 });
    render();
  }
  function stepPov(delta) {
    const list = state.result?.buildings || [];
    if (!list.length || !pov) return;
    const i = ((pov.index ?? -1) + delta + list.length) % list.length;
    viewFrom(list[i].nearestSpot);
  }
  function exitPov({ fly = true } = {}) {
    if (!pov) return;
    const p = pov;
    pov = null;
    Object.assign(cc, {
      enableTranslate: p.saved.enableTranslate, enableZoom: p.saved.enableZoom,
      enableTilt: p.saved.enableTilt, enableRotate: p.saved.enableRotate,
      lookEventTypes: p.saved.lookEventTypes, enableCollisionDetection: p.saved.collision,
    });
    viewer.canvas.removeEventListener('wheel', onPovWheel, { capture: true });
    window.removeEventListener('keydown', onPovKey);
    viewer.camera.frustum.fov = FOV0;
    povBar.hidden = true;
    document.body.classList.remove('sl-pov');
    state.povSpot = null;
    drawResult();
    if (fly) {
      viewer.camera.flyTo({
        destination: p.position,
        orientation: { heading: p.heading, pitch: p.pitch, roll: p.roll },
        duration: 1.2,
      });
    }
    render();
  }

  // ── Brief ────────────────────────────────────────────────────────────────
  function briefText() {
    const { target, result } = state;
    if (!target || !result) return '';
    const L = [];
    L.push('SIGHTLINE BRIEF');
    L.push(`Location: ${target.label || `${target.lat.toFixed(5)}, ${target.lon.toFixed(5)}`}`);
    L.push(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`);
    L.push(`Search radius: ${state.radius} m`);
    L.push('');
    L.push('EXPOSURE');
    L.push(`${result.exposed.length} window/roof positions in ${result.buildings.length} buildings have a clear line of sight to the target.`);
    L.push(`Under 150 m: ${result.counts.high} · 150–400 m: ${result.counts.medium} · Over 400 m: ${result.counts.low}`);
    L.push('');
    L.push('PRIORITY BUILDINGS (nearest first)');
    result.buildings.slice(0, 10).forEach((b, i) => {
      const floors = b.floors.length ? `floors ${b.floors[0]}–${b.floors[b.floors.length - 1]}` : '';
      const what = [b.windows ? `${b.windows} windows` : '', b.roofs ? `${b.roofs} roof spots` : '', floors].filter(Boolean).join(', ');
      L.push(`${i + 1}. ${b.name || 'Unnamed building'} · ${fmtM(b.nearest)} ${compass(b.bearing)} · ${what}${b.estimated ? ' · height estimated' : ''}`);
    });
    L.push('');
    L.push('CORDON');
    L.push(`Rings drawn at ${RINGS_M.filter((r) => r <= state.radius).join(' / ')} m.`);
    L.push('');
    L.push('SATELLITE HISTORY');
    L.push(timelineUrl(false));
    L.push('');
    L.push('LIMITS');
    L.push(`Buildings from OpenStreetMap via OpenFreeMap (${result.buildingCount} footprint parts); ${dataQuality(result)}. Trees, walls and vehicles not modelled, so real exposure may be lower. Planning aid only: walk the site.`);
    return L.join('\n');
  }

  // ── Places (Photon: free OSM geocoder built for type-ahead) ──────────────
  const PHOTON = 'https://photon.komoot.io';
  // Myron 2026-11-10: places the geocoder files under "Palestinian
  // Territories" are shown as Israel, everywhere a name appears.
  const PS_NAMES = /^(palestinian territor(y|ies)|state of palestine|palestine)$/i;
  function fixPlace(p) {
    const q = { ...p };
    if (PS_NAMES.test(q.country || '') || q.countrycode === 'PS') {
      q.country = 'Israel';
      q.countrycode = 'IL';
      if (/^area [abc]$/i.test(q.county || '')) q.county = q.state || null;
    }
    for (const k of ['name', 'city', 'district', 'county', 'state']) {
      if (PS_NAMES.test(q[k] || '')) q[k] = 'Israel';
    }
    return q;
  }
  function placeLabel(raw) {
    const p = fixPlace(raw);
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const title = p.name || street || p.city || p.county || 'Unnamed place';
    const sub = [p.name && street ? street : null, p.city || p.district || p.county, p.country]
      .filter((s) => s && s !== title);
    return { title, sub: [...new Set(sub)].join(', ') };
  }
  function cameraBias() {
    const c = viewer.camera.positionCartographic;
    return `&lat=${Cesium.Math.toDegrees(c.latitude).toFixed(4)}&lon=${Cesium.Math.toDegrees(c.longitude).toFixed(4)}`;
  }
  async function searchPlaces(q, signal) {
    const res = await fetch(`${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&lang=en${cameraBias()}`, { signal });
    if (!res.ok) throw new Error(`search ${res.status}`);
    const { features = [] } = await res.json();
    const seen = new Set();
    const places = features.filter((f) => {
      const k = `${f.properties.osm_type}${f.properties.osm_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map((f) => ({
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      score: addressScore(q, f.properties),
      ...placeLabel(f.properties),
    }));
    // A query with a house number ("Trumpledor 17") should put the house
    // first, even when the street name is misspelled and Photon ranks a
    // park or cemetery of the same name above it.
    if (/\d/.test(q)) places.sort((a, b) => b.score - a.score);
    const labels = new Set();
    return places.filter((p) => {
      const k = `${p.title}|${p.sub}`;
      if (labels.has(k)) return false;
      labels.add(k);
      return true;
    }).slice(0, 5).map(({ score, ...p }) => p);
  }
  const tokens = (s) => (s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  }
  // 0–4: 2 for the right house number, up to 2 for how much of the street
  // (or name) matches the typed words, allowing a typo or two.
  function addressScore(q, p) {
    const qt = tokens(q);
    const nums = qt.filter((t) => /^\d+[a-z]?$/.test(t));
    const words = qt.filter((t) => !/^\d/.test(t));
    const near = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && editDistance(a, b) <= 2);
    const st = tokens(p.street || p.name).filter((t) => !/^\d/.test(t));
    const hit = st.length ? st.filter((t) => words.some((w) => near(w, t))).length / st.length : 0;
    const hn = p.housenumber && nums.includes(String(p.housenumber).toLowerCase()) ? 2 : 0;
    return hn + 2 * hit;
  }
  async function placeNameAt(lat, lon) {
    try {
      const res = await fetch(`${PHOTON}/reverse?lat=${lat}&lon=${lon}&lang=en&limit=8&radius=0.15`);
      const feats = (await res.json()).features || [];
      // Prefer a street address or a named place over the whole city.
      const AREA = new Set(['city', 'county', 'state', 'country', 'district', 'locality']);
      const f = feats.find((x) => x.properties.street || x.properties.housenumber)
        || feats.find((x) => !AREA.has(x.properties.type))
        || feats[0];
      if (!f) return null;
      const { title, sub } = placeLabel(f.properties);
      return sub ? `${title}, ${sub.split(', ')[0]}` : title;
    } catch {
      return null;
    }
  }
  const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

  // ── Panel ────────────────────────────────────────────────────────────────
  const panel = el('section', 'threat-panel');
  panel.setAttribute('aria-label', 'Sightline');
  panel.innerHTML = `
    <header class="threat-head">
      <span class="threat-title">SIGHTLINE</span>
      <button class="threat-collapse" type="button" aria-label="Collapse panel">–</button>
    </header>
    <div class="threat-body">
      <div class="sl-hero-head">
        <h1 class="sl-h1">See who can<br />see you.</h1>
        <p class="sl-lede">Type any address. Every window and rooftop with a clear line of sight lights up in 3D. Plan the day, brief the team, send one link.</p>
      </div>
      <div class="threat-intro">
        <h2 class="threat-q">What are you protecting?</h2>
        <p class="threat-hint">See every window and rooftop with a clear view of a spot: a stage, an entrance, a car drop-off.</p>
      </div>
      <div class="threat-search">
        <span class="threat-search-icon" aria-hidden="true">⌕</span>
        <input type="text" placeholder="Search an address or place" aria-label="Search an address or place"
          autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"
          role="combobox" aria-expanded="false" aria-controls="threat-suggest" aria-autocomplete="list" />
        <button type="button" class="threat-search-clear" aria-label="Clear search" hidden>×</button>
        <ul id="threat-suggest" class="threat-suggest" role="listbox" hidden></ul>
      </div>
      <div class="threat-alt">
        <button type="button" class="threat-locate"><span class="threat-locate-dot" aria-hidden="true"></span>Use my location</button>
        <span class="threat-or">or tap the map</span>
        <button type="button" class="sl-explore">Explore this example →</button>
      </div>
      <div class="threat-status" role="status" aria-live="polite"></div>
      <div class="threat-results" hidden>
        <div class="threat-place">
          <span class="threat-place-kicker">Your spot</span>
          <span class="threat-place-name"></span>
        </div>
        <p class="threat-summary"></p>
        <div class="threat-bands"></div>
        <ol class="threat-list"></ol>
        <div class="threat-settings">
          <span class="threat-set-label">Check within</span>
          <div class="threat-seg" role="radiogroup" aria-label="Distance to check">
            <button type="button" role="radio" data-r="300">300 m</button>
            <button type="button" role="radio" data-r="600">600 m</button>
            <button type="button" role="radio" data-r="1000">1 km</button>
          </div>
          <label class="threat-toggle"><input type="checkbox" class="threat-rings" checked /> Rings</label>
          <label class="threat-toggle"><input type="checkbox" class="threat-lines" checked /> Lines</label>
        </div>
        <div class="threat-actions">
          <button type="button" class="threat-pdf">PDF brief</button>
          <button type="button" class="threat-history" title="Satellite images of this spot over the years">Satellite history ↗</button>
          <button type="button" class="threat-share">Share link</button>
          <button type="button" class="threat-copy">Copy brief</button>
          <button type="button" class="threat-clear" aria-label="Start over">Start over</button>
        </div>
        <p class="threat-note"></p>
      </div>
    </div>`;
  document.body.appendChild(panel);

  const $ = (s) => panel.querySelector(s);
  const statusEl = $('.threat-status');
  const input = $('.threat-search input');
  const suggestEl = $('.threat-suggest');
  const clearSearchBtn = $('.threat-search-clear');
  const locateBtn = $('.threat-locate');
  const setStatus = (t, kind = '') => {
    statusEl.textContent = t;
    statusEl.dataset.kind = kind;
    statusEl.hidden = !t;
  };
  setStatus('');

  $('.threat-collapse').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    $('.threat-collapse').textContent = panel.classList.contains('collapsed') ? '+' : '–';
  });

  // Search box with suggestions as you type.
  let suggestions = [];
  let active = -1;
  let searchTimer = 0;
  let searchAbort = null;
  function renderSuggestions() {
    suggestEl.innerHTML = '';
    suggestions.forEach((s, i) => {
      const li = el('li', 'threat-sugg');
      li.id = `threat-sugg-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.append(el('span', 'threat-sugg-title', s.title));
      if (s.sub) li.append(el('span', 'threat-sugg-sub', s.sub));
      // pointerdown, not click, so the input's blur doesn't close the list first.
      li.addEventListener('pointerdown', (ev) => { ev.preventDefault(); choosePlace(s); });
      suggestEl.appendChild(li);
    });
    const open = suggestions.length > 0;
    suggestEl.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0) input.setAttribute('aria-activedescendant', `threat-sugg-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }
  function closeSuggestions() {
    suggestions = [];
    active = -1;
    renderSuggestions();
  }
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearSearchBtn.hidden = !input.value;
    clearTimeout(searchTimer);
    searchAbort?.abort();
    if (q.length < 3 || COORDS.test(q)) { closeSuggestions(); return; }
    searchTimer = setTimeout(async () => {
      searchAbort = new AbortController();
      try {
        suggestions = await searchPlaces(q, searchAbort.signal);
        active = suggestions.length ? 0 : -1;
        renderSuggestions();
        if (!suggestions.length) setStatus(`No places match "${q}".`, 'warn');
        else if (statusEl.dataset.kind === 'warn') setStatus('');
      } catch (err) {
        if (err.name !== 'AbortError') setStatus('Search is not responding. Try again, or tap the map.', 'warn');
      }
    }, 220);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' && suggestions.length) {
      ev.preventDefault();
      active = (active + 1) % suggestions.length;
      renderSuggestions();
    } else if (ev.key === 'ArrowUp' && suggestions.length) {
      ev.preventDefault();
      active = (active - 1 + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const m = input.value.match(COORDS);
      if (m) {
        const lat = Number(m[1]), lon = Number(m[2]);
        closeSuggestions();
        input.blur();
        analyzeAt({ lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
      } else if (suggestions[active]) {
        choosePlace(suggestions[active]);
      }
    } else if (ev.key === 'Escape') {
      closeSuggestions();
    }
  });
  input.addEventListener('blur', () => setTimeout(closeSuggestions, 120));
  input.addEventListener('focus', () => input.select());
  clearSearchBtn.addEventListener('click', () => {
    input.value = '';
    clearSearchBtn.hidden = true;
    closeSuggestions();
    input.focus();
  });

  function choosePlace(s) {
    input.value = s.title;
    clearSearchBtn.hidden = false;
    closeSuggestions();
    input.blur();
    analyzeAt({ lat: s.lat, lon: s.lon, label: s.sub ? `${s.title}, ${s.sub.split(', ')[0]}` : s.title });
  }

  // Use my location.
  locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      setStatus('This browser cannot share your location. Search or tap the map.', 'warn');
      return;
    }
    locateBtn.disabled = true;
    locateBtn.classList.add('busy');
    setStatus('Finding you…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        locateBtn.disabled = false;
        locateBtn.classList.remove('busy');
        const { latitude: lat, longitude: lon, accuracy } = pos.coords;
        const name = await placeNameAt(lat, lon);
        input.value = name || 'My location';
        clearSearchBtn.hidden = false;
        analyzeAt({ lat, lon, label: name ? `${name} (my location)` : 'My location', accuracy });
      },
      (err) => {
        locateBtn.disabled = false;
        locateBtn.classList.remove('busy');
        const why = err.code === 1
          ? 'Location is blocked. Allow it in your browser settings, or search instead.'
          : 'Could not get your location. Search or tap the map instead.';
        setStatus(why, 'warn');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });

  // Settings.
  const segBtns = [...panel.querySelectorAll('.threat-seg button')];
  const syncSeg = () => segBtns.forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.r) === state.radius)));
  syncSeg();
  segBtns.forEach((b) => b.addEventListener('click', () => {
    const r = Number(b.dataset.r);
    if (r === state.radius) return;
    state.radius = r;
    syncSeg();
    if (state.target) analyzeAt({ ...state.target, fly: false });
  }));
  $('.threat-rings').addEventListener('change', (ev) => { state.showRings = ev.target.checked; drawResult(); });
  $('.threat-lines').addEventListener('change', (ev) => { state.showLines = ev.target.checked; drawResult(); });

  function flash(btn, text) {
    const old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1600);
  }
  function shareUrl() {
    const { target } = state;
    const u = new URL(window.location.href);
    u.hash = '';
    u.search = '';
    u.searchParams.set('at', `${target.lat.toFixed(5)},${target.lon.toFixed(5)}`);
    u.searchParams.set('r', String(state.radius));
    const name = (target.label || '').replace(/ \(my location\)$/, '');
    if (name && name !== 'My location') u.searchParams.set('name', name);
    return u.toString();
  }
  // Spot Timeline (public/timeline/): every satellite date for this spot, before/after, evidence report.
  // Source of truth: Computer Work/spot-timeline/index.html, copied here by its sync.sh.
  function timelineUrl(withBack = true) {
    const { target } = state;
    const u = new URL('timeline/index.html', new URL(import.meta.env.BASE_URL || '/', window.location.origin));
    u.searchParams.set('at', `${target.lat.toFixed(5)},${target.lon.toFixed(5)}`);
    u.searchParams.set('z', '17');
    const name = (target.label || '').replace(/ \(my location\)$/, '');
    if (name && name !== 'My location') u.searchParams.set('name', name);
    if (withBack) u.searchParams.set('back', shareUrl());
    return u.toString();
  }
  $('.threat-history').addEventListener('click', () => {
    if (!state.target) return;
    window.open(timelineUrl(), '_blank', 'noopener');
  });
  $('.threat-share').addEventListener('click', async () => {
    if (!state.target) return;
    const url = shareUrl();
    try {
      if (navigator.share && narrow()) {
        await navigator.share({ title: 'Sightline', text: `Sightlines for ${state.target.label || 'this spot'}`, url });
      } else {
        await navigator.clipboard.writeText(url);
        flash($('.threat-share'), 'Link copied');
      }
    } catch (err) {
      if (err?.name !== 'AbortError') setStatus('Could not copy. The link is in the address bar.', 'warn');
    }
  });
  $('.threat-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(briefText());
      flash($('.threat-copy'), 'Copied');
    } catch {
      setStatus('Clipboard blocked by the browser.', 'warn');
    }
  });
  // ── PDF brief: three snapshots of the map + the findings, on two A4 pages ──
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function settle(maxMs = 9000) {
    const t0 = performance.now();
    await sleep(150);
    while (performance.now() - t0 < maxMs) {
      viewer.render();
      if (scene.globe.tilesLoaded && (!photoreal() || tileset.tilesLoaded)) break;
      await sleep(150);
    }
    await sleep(250);
    viewer.render();
  }
  function grab(aspect) {
    viewer.render();
    const src = viewer.canvas;
    let w = src.width, h = src.height;
    if (w / h > aspect) w = h * aspect; else h = w / aspect;
    const out = document.createElement('canvas');
    out.width = Math.round(w);
    out.height = Math.round(h);
    out.getContext('2d').drawImage(src, (src.width - w) / 2, (src.height - h) / 2, w, h, 0, 0, out.width, out.height);
    return out;
  }
  async function captureViews() {
    const { target, result } = state;
    const cam = viewer.camera;
    const saved = { destination: cam.position.clone(), orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll } };
    const fov0 = cam.frustum.fov;
    const out = {};
    stopOrbit();
    if (pov) exitPov({ fly: false });
    try {
      const center = Cesium.Cartesian3.fromDegrees(target.lon, target.lat, target.h0);
      // Plan view, north up, the whole check area top to bottom.
      const PLAN_ASPECT = (595.28 - 80) / 300;
      const cw = viewer.canvas.width, ch = viewer.canvas.height;
      const ca = cw / ch;
      const fovy = ca > 1 ? 2 * Math.atan(Math.tan(cam.frustum.fov / 2) / ca) : cam.frustum.fov;
      const cropFrac = ca > PLAN_ASPECT ? 1 : ca / PLAN_ASPECT; // share of the height kept
      const span = 2 * state.radius * 1.08;
      const alt = (span / cropFrac / 2) / Math.tan(fovy / 2);
      cam.setView({
        destination: Cesium.Cartesian3.fromDegrees(target.lon, target.lat, target.h0 + alt),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });
      await settle();
      out.plan = grab(PLAN_ASPECT);
      out.planMetresAcross = span * PLAN_ASPECT;
      // 3D overview from the south-southwest.
      cam.flyToBoundingSphere(new Cesium.BoundingSphere(center, state.radius), {
        offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(20), Cesium.Math.toRadians(-35), state.radius * 1.7),
        duration: 0,
      });
      cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
      await settle();
      out.oblique = grab(257.6 / 200);
      // The view from the closest building that can see the spot.
      // The building with the most windows and roof spots on the spot (closest
      // breaks ties), from its highest one: looking down at the street reads
      // far better than a ground-floor view next door.
      const first = result.buildings.reduce((a, b) => (!a || b.spots > a.spots ? b : a), null);
      const top = first && result.exposed
        .filter((e) => e.buildingId === first.id)
        .reduce((a, e) => (!a || e.z > a.z ? e : a), null);
      const s = top || first?.nearestSpot;
      if (s) {
        instantPov = true;
        viewFrom(s);
        instantPov = false;
        await settle();
        out.pov = grab(257.6 / 200);
        out.povCaption = `Most windows on the spot: ${first.name || `building ${result.buildings.indexOf(first) + 1}`}, ${s.kind === 'roof' ? 'roof' : `floor ${s.floor}`} · ${fmtM(Math.hypot(s.x, s.y))} away`;
        exitPov({ fly: false });
      }
    } finally {
      instantPov = false;
      cam.frustum.fov = fov0;
      cam.setView(saved);
      render();
    }
    out.credit = photoreal() || satOn() ? 'Imagery ©Google · map data ©OpenStreetMap contributors' : '©OpenStreetMap contributors';
    return out;
  }
  function pdfData(images) {
    const { target, result: r } = state;
    const windows = r.exposed.filter((e) => e.kind !== 'roof').length;
    const roofs = r.exposed.length - windows;
    const n = r.buildings.length;
    const nearest = r.buildings[0];
    const place = (target.label || `${target.lat.toFixed(5)}, ${target.lon.toFixed(5)}`).replace(/ \(my location\)$/, '');
    const est = Math.round((100 * r.estimatedHeights) / Math.max(1, r.buildingCount));
    const pics = photoreal() ? 'Google Photorealistic 3D Tiles' : satOn() ? 'Google satellite imagery' : 'OpenStreetMap';
    const floorsTxt = (f) => (!f.length ? '—' : f[0] === f[f.length - 1] ? `${f[0]}` : `${f[0]}–${f[f.length - 1]}`);
    return {
      place,
      where: `${Math.abs(target.lat).toFixed(5)}° ${target.lat >= 0 ? 'N' : 'S'}, ${Math.abs(target.lon).toFixed(5)}° ${target.lon >= 0 ? 'E' : 'W'} · checked within ${fmtM(state.radius)} · a person 1.7 m tall at the spot`,
      when: new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      headline: n ? `${n} building${n === 1 ? '' : 's'} can see this spot.` : 'No building can see this spot.',
      sub: n
        ? `The closest is ${fmtM(nearest.nearest)} ${compassWord(nearest.bearing)}${nearest.name ? ` (${nearest.name})` : ''}. In all, ${windows.toLocaleString()} windows and ${roofs.toLocaleString()} rooftop spots have a clear line of sight to a person standing here.`
        : `No window or rooftop within ${fmtM(state.radius)} has a clear view of this spot.`,
      bands: ['high', 'medium', 'low'].filter((k) => BAND_MIN[k] < state.radius)
        .map((k) => ({ key: k, label: BAND_LABEL[k], count: r.buildings.filter((b) => b.band === k).length })),
      closestTile: { label: 'Closest', value: nearest ? fmtM(nearest.nearest) : '—', unit: nearest ? `${compassWord(nearest.bearing)}${nearest.name ? ` · ${nearest.name}` : ''}` : '' },
      images,
      planMetresAcross: images.planMetresAcross,
      ringList: `${RINGS_M.filter((x) => x <= state.radius).join(' / ')} m`,
      totalBuildings: n,
      rows: r.buildings.slice(0, 16).map((b, i) => ({
        n: i + 1,
        name: b.name || `Building ${i + 1}`,
        dist: fmtM(b.nearest),
        dir: compass(b.bearing),
        height: `${Math.round(b.height)} m${b.estimated ? ' est.' : ''}`,
        heightEst: b.estimated,
        floors: floorsTxt(b.floors || []),
        windows: b.windows || '—',
        roofs: b.roofs || '—',
        band: b.band,
      })),
      rings: RINGS_M.filter((x) => x <= state.radius).map((x) => ({ label: fmtM(x), count: r.buildings.filter((b) => b.nearest <= x).length })),
      dataLines: [
        `Buildings: ${r.buildingCount.toLocaleString()} building outlines from OpenStreetMap (via OpenFreeMap).${r.city?.matched ? ` ${r.city.matched.toLocaleString()} of them use measured heights from the ${r.city.source}.` : ''}`,
        `Heights: ${100 - est}% measured or mapped, ${est}% estimated from building type.`,
        r.hasGround
          ? `Ground: real ground heights from ${r.groundSource || '30 m elevation data'}${r.relief >= 3 ? `; the ground rises about ${r.relief} m across the area` : ''}.`
          : 'Ground: treated as flat.',
        `Method: a line is traced from the head of a person 1.7 m tall at the spot to a window on every floor of each wall that faces it, and to the edges of every roof, within ${fmtM(state.radius)}.`,
        'Not modelled: trees, walls, fences, vehicles and street furniture, so the real exposure may be lower. Windows and balconies are not told apart.',
        `Pictures: ${pics}, with Sightline's buildings and lines on top.`,
      ],
      shareUrl: shareUrl(),
    };
  }
  async function makePdf({ download = true } = {}) {
    if (!state.target || !state.result || state.busy) return null;
    const btn = $('.threat-pdf');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Making PDF…';
    state.busy = true;
    try {
      const images = await captureViews();
      const blob = await buildBriefPdf(pdfData(images));
      if (download) {
        const day = new Date().toISOString().slice(0, 10);
        const place = (state.target.label || 'spot').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Sightline brief - ${place} - ${day}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      }
      return blob;
    } catch (err) {
      console.warn('[threat] pdf', err);
      setStatus(`Couldn't make the PDF: ${err.message}`, 'warn');
      return null;
    } finally {
      state.busy = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  }
  $('.threat-pdf').addEventListener('click', () => makePdf());

  $('.threat-clear').addEventListener('click', () => {
    state.target = null;
    state.result = null;
    clearScene();
    panel.classList.remove('has-result');
    $('.threat-results').hidden = true;
    input.value = '';
    clearSearchBtn.hidden = true;
    history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    setStatus('');
    input.focus();
  });

  // Tap anywhere on the map to set (or move) the spot. Cesium only fires
  // LEFT_CLICK when the pointer barely moved, so dragging the map is safe.
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction(async (click) => {
    if (state.busy || pov) return;
    if (state.result) {
      let picked;
      try { picked = scene.pick(click.position, 9, 9); } catch { picked = null; }
      const id = picked?.id;
      if (id?.spot) { viewFrom(id.spot); return; }
      if (id?.buildingId) {
        const b = state.result.buildings.find((x) => x.id === id.buildingId);
        if (b) { viewFrom(b.nearestSpot); return; }
      }
    }
    let cart = null;
    if (photoreal() && scene.pickPositionSupported) {
      try { cart = scene.pickPosition(click.position); } catch { cart = null; }
    }
    if (!cart) {
      const ray = viewer.camera.getPickRay(click.position);
      cart = ray && scene.globe.pick(ray, scene);
    }
    if (!cart) cart = viewer.camera.pickEllipsoid(click.position, scene.globe.ellipsoid);
    if (!cart) return;
    const c = Cesium.Cartographic.fromCartesian(cart);
    const lat = Cesium.Math.toDegrees(c.latitude);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const run = analyzeAt({ lat, lon, pickHeight: photoreal() ? c.height : undefined, label: null, fly: false });
    const name = await placeNameAt(lat, lon);
    if (name) {
      input.value = name;
      clearSearchBtn.hidden = false;
      await run;
      if (state.target && state.target.lat === lat) {
        state.target.label = name;
        $('.threat-place-name').textContent = name;
        updateUrl();
      }
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  function updateUrl() {
    if (!state.target) return;
    const u = new URL(shareUrl());
    history.replaceState(null, '', `${u.pathname}${u.search}${window.location.hash}`);
  }

  async function groundHeight(lat, lon) {
    const c = Cesium.Cartographic.fromDegrees(lon, lat);
    try {
      const tp = viewer.terrainProvider;
      if (tp && !(tp instanceof Cesium.EllipsoidTerrainProvider)) {
        const [r] = await Cesium.sampleTerrainMostDetailed(tp, [c]);
        if (Number.isFinite(r?.height)) return r.height;
      }
    } catch { /* fall through */ }
    // Flat ground (see the terrain note at the top): the ellipsoid is 0.
    // globe.getHeight can still return stale tiles here (-28 km seen).
    return 0;
  }
  // Areas (~5 km cells) where Google's 3D city turned out to be flat photos.
  const flatAreas = new Set();
  const areaKey = (lat, lon) => `${Math.round(lat * 20)}:${Math.round(lon * 20)}`;
  async function googleIsFlat(t, buildings, proj) {
    const tall = buildings
      .filter((b) => !b.estimated && b.height >= 15)
      .sort((a, b) => b.height - a.height)
      .slice(0, 6);
    if (tall.length < 2) return false; // nothing tall to test against
    const pts = [Cesium.Cartographic.fromDegrees(t.lon, t.lat)];
    for (const b of tall) {
      let x = 0, y = 0;
      for (const p of b.ring) { x += p[0]; y += p[1]; }
      const [la, lo] = proj.toLatLon(x / b.ring.length, y / b.ring.length);
      pts.push(Cesium.Cartographic.fromDegrees(lo, la));
    }
    // If Google is too slow to answer, say "flat": satellite + our own
    // buildings works everywhere, a flat Google photo doesn't (2026-11-11).
    let got;
    try {
      got = await Promise.race([
        scene.sampleHeightMostDetailed(pts),
        new Promise((r) => setTimeout(() => r(null), 12000)),
      ]);
    } catch { return 'unsure'; }
    if (!got) return 'unsure';
    const base = got[0]?.height;
    if (!Number.isFinite(base)) return false;
    const ratios = tall
      .map((b, i) => (Number.isFinite(got[i + 1]?.height) ? (got[i + 1].height - base) / b.height : null))
      .filter((r) => r != null)
      .sort((a, b) => a - b);
    if (!ratios.length) return false;
    const median = ratios[Math.floor(ratios.length / 2)];
    return median < 0.35;
  }

  async function analyzeAt(t) {
    if (state.busy) return;
    if (!t.demo) exitLanding();
    exitPov({ fly: false });
    state.busy = true;
    panel.classList.add('busy');
    locateBtn.disabled = true;
    const radius = state.radius;
    try {
      setStatus('Loading buildings around the spot…');
      const proj = makeProjection(t.lat, t.lon);
      const buildings = await fetchBuildingsFromTiles(t.lat, t.lon, radius, proj);
      // Better data where we have it: measured city heights, real ground.
      setStatus('Loading measured heights and ground…');
      let [city, ground] = await Promise.all([
        buildings.length ? applyCityHeights(buildings, t.lat, t.lon, radius, proj) : null,
        fetchGround(t.lat, t.lon, radius + 60, proj),
      ]);
      if (!buildings.length) {
        setStatus('No building data here. Try a spot in a town or city.', 'warn');
        return;
      }
      // Real 3D city on for a picked spot; it sits at true elevation, so
      // sample the surface height under the spot when the tap didn't give one.
      let flatHere = flatAreas.has(areaKey(t.lat, t.lon));
      state.flat = flatHere;
      if (!t.demo && wantReal && !flatHere && tileset && !photoreal()) await setReal(true);
      // Google only has real 3D buildings in cities it has scanned (none in
      // Israel, for one). Elsewhere its "3D" is a flat photo, which hides our
      // buildings and puts the window view on the ground. Check the tallest
      // buildings: if Google shows nothing standing there, use our own city.
      if (photoreal() && !t.demo) {
        setStatus('Checking Google 3D here…');
        const verdict = await googleIsFlat(t, buildings, proj);
        if (verdict) {
          flatHere = true;
          if (verdict === true) flatAreas.add(areaKey(t.lat, t.lon));
          t = { ...t, pickHeight: undefined };
          await setReal(false);
        }
      }
      state.flat = flatHere;
      await setSat(!t.demo && wantReal && flatHere && !photoreal());
      if (photoreal() && t.pickHeight == null) {
        try {
          const [c] = await scene.sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(t.lon, t.lat)]);
          if (Number.isFinite(c?.height)) t = { ...t, pickHeight: c.height };
        } catch { /* keep 0 */ }
      }
      setStatus(`Checking sightlines from ${buildings.length.toLocaleString()} buildings…`);
      // Where the city surveyed ground level at each building, trust that over
      // the 30 m elevation data (which reads rooftops in dense blocks).
      const surveyed = groundFromPoints(city?.groundPts, radius + 60);
      if (surveyed) ground = surveyed;
      if (city) delete city.groundPts;
      const result = await runAnalysis({ buildings, radius, targetHeight: 1.7, ground });
      result.groundSource = ground?.source === 'survey' ? 'city survey' : ground ? '30 m elevation data' : null;
      result.city = city;
      result.relief = ground ? (() => { const v = Float32Array.from(ground.data).sort(); return Math.round(v[Math.floor(v.length * 0.98)] - v[Math.floor(v.length * 0.02)]); })() : null;
      // Photoreal pick height is the surface you clicked; if that was a roof,
      // move ground back down by the modelled roof height.
      // Without the photoreal city the globe still has real terrain, so sit
      // the buildings on the ground height under the spot (not sea level).
      let h0;
      if (t.pickHeight != null && photoreal()) h0 = t.pickHeight - result.groundAtTarget;
      else h0 = await groundHeight(t.lat, t.lon);
      const { fly, demo, ...rest } = t;
      state.target = { ...rest, h0 };
      state.result = result;
      state.buildings = buildings;
      state.proj = proj;
      state.ground = ground;
      drawResult();
      showResults();
      realBtn.classList.toggle('on', photoreal() || satOn());
      if (t.fly !== false) flyToTarget();
      if (t.demo) startLive(); else updateUrl();
      setStatus(flatHere && tileset && !t.demo && satOn() ? "Google has no 3D buildings here, so you're seeing a satellite photo with Sightline's own buildings." : '');
    } catch (err) {
      console.warn('[threat]', err);
      setStatus(`Couldn't run the check: ${err.message}`, 'warn');
    } finally {
      state.busy = false;
      panel.classList.remove('busy');
      locateBtn.disabled = false;
    }
  }

  function showResults() {
    const r = state.result;
    const t = state.target;
    panel.classList.add('has-result');
    $('.threat-results').hidden = false;
    $('.threat-place-name').textContent = t.label || `${t.lat.toFixed(5)}, ${t.lon.toFixed(5)}`;
    const windows = r.exposed.filter((e) => e.kind !== 'roof').length;
    const roofs = r.exposed.length - windows;
    const summary = $('.threat-summary');
    if (!r.exposed.length) {
      summary.textContent = `No window or rooftop within ${fmtM(state.radius)} has a clear view of this spot.`;
    } else {
      const nearest = r.buildings[0];
      const n = r.buildings.length;
      summary.innerHTML = '';
      summary.append(
        el('b', 'threat-headline', `${n} building${n === 1 ? '' : 's'} can see you.`),
        ' The closest is ',
        el('b', null, `${fmtM(nearest.nearest)} ${compassWord(nearest.bearing)}`),
        nearest.name ? ` (${nearest.name}).` : '.',
        el('span', 'threat-summary-sub', `${windows.toLocaleString()} windows and ${roofs.toLocaleString()} rooftop spots in all.`),
      );
    }
    const bands = $('.threat-bands');
    bands.innerHTML = '';
    for (const k of ['high', 'medium', 'low']) {
      const nb = r.buildings.filter((b) => b.band === k).length;
      if (!nb && BAND_MIN[k] >= state.radius) continue;
      const chip = el('span', `threat-chip ${k}`);
      chip.innerHTML = `<b>${nb}</b> ${BAND_LABEL[k]}`;
      chip.title = `${nb} building${nb === 1 ? '' : 's'} ${BAND_LABEL[k].toLowerCase()} away can see your spot`;
      bands.appendChild(chip);
    }
    showKey();
    const list = $('.threat-list');
    list.innerHTML = '';
    r.buildings.slice(0, 8).forEach((b, i) => {
      const li = el('li', `threat-item ${b.band}`);
      const name = el('span', 'threat-item-name', b.name || `Building ${i + 1}`);
      const parts = [
        `${fmtM(b.nearest)} ${compass(b.bearing)}`,
        b.windows ? `${b.windows} windows` : '',
        b.roofs ? `${b.roofs} roof` : '',
        b.estimated ? 'height est.' : b.heightSource ? `${Math.round(b.height)} m measured` : '',
      ].filter(Boolean);
      li.append(name, el('span', 'threat-item-meta', parts.join(' · ')));
      li.tabIndex = 0;
      li.title = 'See your spot from this building';
      li.addEventListener('click', () => viewFrom(b.nearestSpot));
      li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') viewFrom(b.nearestSpot); });
      list.appendChild(li);
    });
    list.hidden = !r.buildings.length;
    $('.threat-note').textContent = `Tap a lit building to see your spot from its window. Tap anywhere else to move your spot. Built from OpenStreetMap; ${dataQuality(r)}. A planning aid: walk the site.`;
  }

  // ── Camera: map-style controls + on-screen buttons ──────────────────────
  const cc = scene.screenSpaceCameraController;
  const CE = Cesium.CameraEventType;
  const KM = Cesium.KeyboardEventModifier;
  // Left-drag moves the map (Cesium's default). Right-drag / Ctrl-drag tilts
  // and turns, like Google Maps; the wheel and pinch zoom toward the pointer.
  cc.zoomEventTypes = [CE.WHEEL, CE.PINCH];
  cc.tiltEventTypes = [CE.RIGHT_DRAG, CE.MIDDLE_DRAG, CE.PINCH, { eventType: CE.LEFT_DRAG, modifier: KM.CTRL }];
  cc.lookEventTypes = [{ eventType: CE.LEFT_DRAG, modifier: KM.SHIFT }];
  cc.minimumZoomDistance = 15;
  cc.maximumZoomDistance = 40000;
  cc.enableCollisionDetection = true;

  const camGroundPoint = () => {
    const c = viewer.canvas;
    const mid = new Cesium.Cartesian2(c.clientWidth / 2, c.clientHeight / 2);
    return viewer.camera.pickEllipsoid(mid, scene.globe.ellipsoid);
  };
  function zoomBy(f) {
    const cam = viewer.camera;
    const h = cam.positionCartographic.height;
    const amt = Math.max(10, h * 0.45);
    if (f > 0) cam.zoomIn(amt); else cam.zoomOut(amt);
    render();
  }
  function orbit(headingDeg, pitchDeg, duration = 0.8, done) {
    // Turn around the point in the middle of the screen, keeping the distance.
    const target = camGroundPoint();
    const cam = viewer.camera;
    if (!target) {
      cam.flyTo({ destination: cam.position, orientation: { heading: Cesium.Math.toRadians(headingDeg), pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 }, duration, complete: done, cancel: done });
      return;
    }
    const range = Cesium.Cartesian3.distance(cam.position, target);
    cam.flyToBoundingSphere(new Cesium.BoundingSphere(target, 1), {
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(headingDeg), Cesium.Math.toRadians(pitchDeg), range),
      duration, complete: done, cancel: done,
    });
  }
  const camBar = el('div', 'threat-cam');
  camBar.innerHTML = `
    <button type="button" class="threat-cam-spot" title="Back to my spot" aria-label="Back to my spot" hidden>◎</button>
    <div class="threat-cam-turn">
      <button type="button" class="threat-cam-left" title="Turn left (←). Or right-drag / Ctrl-drag the map" aria-label="Turn the view left">↺</button>
      <button type="button" class="threat-cam-right" title="Turn right (→). Or right-drag / Ctrl-drag the map" aria-label="Turn the view right">↻</button>
    </div>
    <button type="button" class="threat-cam-north" title="Face north" aria-label="Face north"><span>N</span></button>
    <button type="button" class="threat-cam-tilt" title="Top-down view" aria-label="Switch between 3D and top-down">2D</button>
    <button type="button" class="threat-cam-map" title="Street map" aria-label="Switch between dark and street map">◐</button>
    <button type="button" class="threat-cam-real" title="Real 3D city (Google)" aria-label="Switch the real 3D city on or off" hidden>3D</button>
    <div class="threat-cam-zoom">
      <button type="button" class="threat-cam-in" title="Zoom in" aria-label="Zoom in">+</button>
      <button type="button" class="threat-cam-out" title="Zoom out" aria-label="Zoom out">−</button>
    </div>`;
  document.body.appendChild(camBar);
  const northBtn = camBar.querySelector('.threat-cam-north');
  const tiltBtn = camBar.querySelector('.threat-cam-tilt');
  const spotBtn = camBar.querySelector('.threat-cam-spot');
  camBar.querySelector('.threat-cam-in').addEventListener('click', () => zoomBy(1));
  camBar.querySelector('.threat-cam-out').addEventListener('click', () => zoomBy(-1));
  northBtn.addEventListener('click', () => orbit(0, Cesium.Math.toDegrees(viewer.camera.pitch)));
  // Turn around the middle of the screen, 45° a press, so you can see the
  // other side of the buildings without knowing the drag gestures.
  // Quick repeated presses add up instead of restarting from mid-turn.
  let turnGoal = 0, turnAt = 0;
  const turn = (deg) => {
    const busy = performance.now() - turnAt < 650;
    turnGoal = (busy ? turnGoal : Cesium.Math.toDegrees(viewer.camera.heading)) + deg;
    turnAt = performance.now();
    orbit(turnGoal, Math.min(-10, Cesium.Math.toDegrees(viewer.camera.pitch)), 0.6);
  };
  camBar.querySelector('.threat-cam-left').addEventListener('click', () => turn(-45));
  camBar.querySelector('.threat-cam-right').addEventListener('click', () => turn(45));
  window.addEventListener('keydown', (ev) => {
    if (pov || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ev.key === 'ArrowLeft' || ev.key === 'q' || ev.key === 'Q') { turn(-45); ev.preventDefault(); }
    else if (ev.key === 'ArrowRight' || ev.key === 'e' || ev.key === 'E') { turn(45); ev.preventDefault(); }
  });
  tiltBtn.addEventListener('click', () => {
    const topDown = viewer.camera.pitch < Cesium.Math.toRadians(-75);
    orbit(Cesium.Math.toDegrees(viewer.camera.heading), topDown ? -38 : -89.5);
  });
  spotBtn.addEventListener('click', () => flyToTarget());
  povBar.querySelector('.threat-pov-back').addEventListener('click', () => exitPov());
  povBar.querySelector('.threat-pov-prev').addEventListener('click', () => stepPov(-1));
  povBar.querySelector('.threat-pov-next').addEventListener('click', () => stepPov(1));
  povBar.querySelector('.threat-pov-in').addEventListener('click', () => setFov(fovDeg() / 1.4));
  povBar.querySelector('.threat-pov-out').addEventListener('click', () => setFov(fovDeg() * 1.4));
  // Google photoreal city: only when a Maps key loaded the tileset. The dark
  // map stays for the landing; the real city comes on once you pick a spot.
  const realBtn = camBar.querySelector('.threat-cam-real');
  realBtn.hidden = !(tileset && mapStackController);
  let wantReal = true;
  async function setReal(on) {
    if (!tileset || !mapStackController) return;
    // Where Google has no 3D city, "real view" means the satellite photo.
    const flat = Boolean(state.flat);
    const wantPhoto = on && !flat;
    if (!on || wantPhoto) await setSat(false);
    if (wantPhoto !== photoreal()) {
      try { await mapStackController.setStack(wantPhoto ? 'photoreal' : 'osm', { silent: true }); } catch (e) { console.warn('[threat] map stack', e); }
    }
    if (on && flat) await setSat(true);
    realBtn.classList.toggle('on', photoreal() || satOn());
    if (state.result) drawResult();
    render();
  }
  realBtn.addEventListener('click', () => { wantReal = !(photoreal() || satOn()); setReal(wantReal); });
  const mapBtn = camBar.querySelector('.threat-cam-map');
  mapBtn.addEventListener('click', () => {
    setDark(!state.dark);
    mapBtn.title = state.dark ? 'Street map' : 'Dark map';
  });
  const syncCam = () => {
    const cam = viewer.camera;
    northBtn.querySelector('span').style.transform = `rotate(${-Cesium.Math.toDegrees(cam.heading)}deg)`;
    const topDown = cam.pitch < Cesium.Math.toRadians(-75);
    tiltBtn.textContent = topDown ? '3D' : '2D';
    tiltBtn.title = topDown ? 'Tilted 3D view' : 'Top-down view';
    spotBtn.hidden = !state.target;
  };
  viewer.camera.changed.addEventListener(syncCam);
  viewer.camera.percentageChanged = 0.01;
  syncCam();

  // One-time hint on how to move around.
  const touch = window.matchMedia('(pointer: coarse)').matches;
  function showHint() {
  let hintSeen = false;
  try { hintSeen = localStorage.getItem('sightline.hint') === '1'; } catch { /* private mode */ }
  if (!hintSeen && !document.querySelector('.threat-hint-chip')) {
    const hint = el('div', 'threat-hint-chip');
    hint.innerHTML = touch
      ? '<b>Drag</b> move · <b>Pinch</b> zoom · <b>Two fingers</b> tilt and turn'
      : '<b>Drag</b> move · <b>Scroll</b> zoom · <b>Right-drag</b> turn';
    const x = el('button', null, '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    hint.appendChild(x);
    document.body.appendChild(hint);
    const dismiss = () => {
      hint.remove();
      try { localStorage.setItem('sightline.hint', '1'); } catch { /* ignore */ }
    };
    x.addEventListener('click', dismiss);
    // Hide once they've actually moved the map (or after a minute).
    // Only the person's own drag/scroll counts, not our camera flights.
    const cv = viewer.scene.canvas;
    let down = null;
    const used = () => {
      setTimeout(dismiss, 2500);
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onPMove);
      cv.removeEventListener('wheel', used);
    };
    const onDown = (e) => { down = [e.clientX, e.clientY]; };
    const onPMove = (e) => {
      if (down && e.buttons && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 12) used();
    };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onPMove);
    cv.addEventListener('wheel', used, { passive: true });
    setTimeout(dismiss, 90000);
  }
  }

  // ── Landing: a live example behind a big headline ─────────────────────
  const DEMO = { lat: 32.08093, lon: 34.78079, label: 'Rabin Square, Tel Aviv' };
  const stat = el('div', 'sl-stat');
  const tag = el('div', 'sl-tag');
  let orbitRaf = 0;
  let unmountLanding = null;
  let live = null;
  // The interactive top: your spot follows the mouse and the city re-checks
  // who can see it as you move. Falls back to the slow orbit if it can't start.
  function startLive() {
    const t = state.target;
    const host = document.querySelector('.slp-hero');
    if (!t || !host || !document.body.classList.contains('landing')) return;
    fillHero();
    try {
      heroCamera();
      clearScene();
      live = createLiveHero({
        paper: true, Cesium, viewer, proj: state.proj, buildings: state.buildings, ground: state.ground,
        h0: t.h0, halfSize: state.radius + 60, host,
        onUpdate: fillLive,
        onOpen: ({ lat, lon }) => { stopLive(); exitLanding(); input.value = ''; analyzeAt({ lat, lon, label: null }); },
      });
    } catch (err) {
      console.warn('[threat] live hero', err);
      live = null;
      drawResult();
      startOrbit();
    }
  }
  function stopLive() {
    if (!live) return;
    live.destroy();
    live = null;
    if (state.result) drawResult();
  }
  // Fixed, steep view over the square, spot pushed clear of the headline.
  function heroCamera() {
    const t = state.target;
    const center = Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.h0);
    const range = narrow() ? 1250 : 900;
    viewer.camera.lookAt(center, new Cesium.HeadingPitchRange(Cesium.Math.toRadians(15), Cesium.Math.toRadians(-68), range));
    if (narrow()) viewer.camera.moveUp(range * 0.36);
    else viewer.camera.moveLeft(range * 0.32);
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    render();
  }
  function fillLive(c) {
    stat.innerHTML = `
      <div class="sl-num">${c.total.toLocaleString()}</div>
      <div class="sl-cap">spots can see you <span>within ${LIVE_RADIUS} m</span></div>
      <ul>
        <li><i class="high"></i><b>${c.windows.toLocaleString()}</b> windows</li>
        <li><i class="medium"></i><b>${c.roofs.toLocaleString()}</b> rooftop spots</li>
        <li><i class="low"></i><b>${c.buildings}</b> buildings${c.nearest != null ? `, closest ${Math.round(c.nearest)} m` : ''}</li>
      </ul>
      <p class="sl-live-hint">${narrow() ? 'Tap the map to move' : 'Move your mouse over the map'}</p>`;
    const ns = c.lat >= 0 ? 'N' : 'S', ew = c.lon >= 0 ? 'E' : 'W';
    tag.innerHTML = `
      <span class="sl-tag-k">Live · move to test</span>
      <b>${(state.target?.label || '').toUpperCase().replace(', ', ' · ')}</b>
      <span>${Math.abs(c.lat).toFixed(5)}° ${ns}&nbsp;&nbsp;${Math.abs(c.lon).toFixed(5)}° ${ew}</span>`;
  }
  function fillHero() {
    const r = state.result;
    const t = state.target;
    if (!r || !t) return;
    const windows = r.exposed.filter((e) => e.kind !== 'roof').length;
    const roofs = r.exposed.length - windows;
    const nearest = r.buildings[0];
    stat.innerHTML = `
      <div class="sl-num">${r.exposed.length.toLocaleString()}</div>
      <div class="sl-cap">can see this spot <span>within ${fmtM(state.radius)}</span></div>
      <ul>
        <li><i class="high"></i><b>${windows.toLocaleString()}</b> windows</li>
        <li><i class="medium"></i><b>${roofs.toLocaleString()}</b> rooftop spots</li>
        <li><i class="low"></i><b>${r.buildings.length}</b> buildings${nearest ? `, closest ${fmtM(nearest.nearest)}` : ''}</li>
      </ul>`;
    const ns = t.lat >= 0 ? 'N' : 'S';
    const ew = t.lon >= 0 ? 'E' : 'W';
    tag.innerHTML = `
      <span class="sl-tag-k">Live example</span>
      <b>${(t.label || '').toUpperCase().replace(', ', ' · ')}</b>
      <span>${Math.abs(t.lat).toFixed(4)}° ${ns}&nbsp;&nbsp;${Math.abs(t.lon).toFixed(4)}° ${ew}</span>`;
  }
  function startOrbit() {
    const t = state.target;
    if (!t || !document.body.classList.contains('landing')) return;
    cancelAnimationFrame(orbitRaf);
    const center = Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.h0);
    let h = Cesium.Math.toRadians(20);
    const step = () => {
      const range = state.radius * (narrow() ? 2.9 : 1.8);
      h += 0.0011;
      viewer.camera.lookAt(center, new Cesium.HeadingPitchRange(h, Cesium.Math.toRadians(-50), range));
      // Push the spot out from under the headline: right on desktop, down on phones.
      if (narrow()) viewer.camera.moveUp(range * 0.22);
      else viewer.camera.moveLeft(range * 0.3);
      render();
      orbitRaf = requestAnimationFrame(step);
    };
    step();
  }
  function stopOrbit() {
    if (!orbitRaf) return;
    cancelAnimationFrame(orbitRaf);
    orbitRaf = 0;
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
  function exitLanding() {
    if (!document.body.classList.contains('landing')) return;
    stopOrbit();
    stopLive();
    document.body.classList.remove('landing');
    unmountLanding?.();
    unmountLanding = null;
    stat.remove();
    tag.remove();
    styleBase();
    render();
    showHint();
    showKey();
  }
  function openExample() {
    exitLanding();
    if (state.target) { input.value = state.target.label || ''; clearSearchBtn.hidden = !input.value; flyToTarget(); updateUrl(); }
  }
  $('.sl-explore').addEventListener('click', openExample);
  // Grabbing the map during the intro stops the spin so you can look around.
  viewer.scene.canvas.addEventListener('pointerdown', () => {
    if (document.body.classList.contains('landing')) stopOrbit();
  });

  setDark(true);
  const q0 = new URLSearchParams(window.location.search);
  if (!q0.get('at') && !q0.has('app')) {
    document.body.classList.add('landing');
    styleBase();
    if (photoreal()) setReal(false);
    $('.threat-body').appendChild(stat);
    document.body.appendChild(tag);
    unmountLanding = mountLanding(panel, { onOpenMap: openExample, onSearch: () => input.focus() });
    setTimeout(() => analyzeAt({ ...DEMO, demo: true, fly: false }), 300);
  } else {
    showHint();
  }

  // Open a shared link: ?at=lat,lon&r=600&name=…
  {
    const q = new URLSearchParams(window.location.search);
    const m = (q.get('at') || '').match(COORDS);
    if (m) {
      const r = Number(q.get('r'));
      if ([300, 600, 1000].includes(r)) { state.radius = r; syncSeg(); }
      const label = q.get('name') || null;
      if (label) { input.value = label; clearSearchBtn.hidden = false; }
      setTimeout(() => analyzeAt({ lat: Number(m[1]), lon: Number(m[2]), label }), 400);
    }
  }

  return {
    analyzeAt,
    getState: () => state,
    briefText,
    makePdf,
    destroy() {
      exitPov({ fly: false });
      povBar.remove();
      handler.destroy();
      camBar.remove();
      stopOrbit();
      live?.destroy();
      stat.remove();
      tag.remove();
      viewer.imageryLayers.layerAdded.removeEventListener(styleBase);
      clearScene();
      panel.remove();
      worker?.terminate();
    },
  };
}

export { threatBand };
