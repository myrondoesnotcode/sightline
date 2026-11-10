// src/threat/sightlineCore.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSightlines, buildingHeight, parseLength, normalizeRing, signedArea,
  buildHeightGrid, hasLineOfSight, makeProjection, buildingsFromOverpass, bearingDeg,
} from './sightlineCore.js';

const box = (cx, cy, w, d) => [
  [cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2],
];

test('parseLength handles units', () => {
  assert.equal(parseLength('12'), 12);
  assert.equal(parseLength('12 m'), 12);
  assert.ok(Math.abs(parseLength("40'") - 12.192) < 1e-6);
  assert.equal(parseLength('tall'), null);
});

test('buildingHeight prefers height, then levels, then type default', () => {
  assert.deepEqual(buildingHeight({ height: '30' }), { height: 30, estimated: false });
  assert.equal(buildingHeight({ 'building:levels': '5' }).height, 5 * 3.2 + 1);
  assert.equal(buildingHeight({ building: 'house' }).estimated, true);
});

test('normalizeRing makes rings counter-clockwise and drops the closing vertex', () => {
  const cw = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
  const r = normalizeRing(cw);
  assert.equal(r.length, 4);
  assert.ok(signedArea(r) > 0);
});

test('a tall wall between shooter and target blocks the line', () => {
  const g = buildHeightGrid([{ ring: box(0, 20, 40, 4), height: 30 }], 100);
  assert.equal(hasLineOfSight(g, 0, 50, 10, 0, 0, 1.7), false);
  // At y=20 the ray from z=100 is still at ~41 m, above the 30 m wall.
  assert.equal(hasLineOfSight(g, 0, 50, 100, 0, 0, 1.7), true);
  assert.equal(hasLineOfSight(g, 60, 0, 10, 0, 0, 1.7), true);
});

test('a building facing an open square is exposed; the one hidden behind it is not', () => {
  const front = { id: 'front', ring: box(0, 40, 30, 10), height: 20, estimated: false };
  const back = { id: 'back', ring: box(0, 70, 30, 10), height: 12, estimated: false };
  const r = analyzeSightlines({ buildings: [front, back], radius: 200 });
  const ids = r.buildings.map((b) => b.id);
  assert.ok(ids.includes('front'));
  assert.ok(!ids.includes('back'));
  const f = r.buildings.find((b) => b.id === 'front');
  assert.ok(f.windows > 0);
  assert.ok(f.nearest < 40);
  assert.equal(f.band, 'high');
  // Only the wall facing the target exposes windows: every window is south of the block.
  for (const e of r.exposed.filter((x) => x.kind === 'window')) assert.ok(e.y < 36);
});

test('bearing is a compass bearing', () => {
  assert.equal(Math.round(bearingDeg(0, 10)), 0);
  assert.equal(Math.round(bearingDeg(10, 0)), 90);
  assert.equal(Math.round(bearingDeg(-10, 0)), 270);
});

test('buildingsFromOverpass reads ways and relation outers', () => {
  const proj = makeProjection(32.08, 34.78);
  const sq = (lat, lon) => [
    { lat, lon }, { lat: lat + 0.0002, lon }, { lat: lat + 0.0002, lon: lon + 0.0002 }, { lat, lon: lon + 0.0002 }, { lat, lon },
  ];
  const json = {
    elements: [
      { type: 'way', id: 1, tags: { building: 'yes', 'building:levels': '4' }, geometry: sq(32.08, 34.78) },
      { type: 'relation', id: 2, tags: { building: 'yes', name: 'Tower' }, members: [
        { type: 'way', role: 'outer', geometry: sq(32.081, 34.781) },
        { type: 'way', role: 'inner', geometry: sq(32.081, 34.781) },
      ] },
    ],
  };
  const bs = buildingsFromOverpass(json, proj);
  assert.equal(bs.length, 2);
  assert.equal(bs[1].name, 'Tower');
  assert.ok(Math.abs(bs[0].ring[1][1] - 22.1) < 0.5);
});

test('a hill between spot and building blocks the view; flat ground does not', async () => {
  const { analyzeSightlines: run } = await import('./sightlineCore.js');
  const sq = (cx, cy, s) => [[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s]];
  const buildings = [{ id: 'b', ring: sq(0, 150, 8), height: 7, estimated: false }];
  const flat = run({ buildings, radius: 200 });
  assert.ok(flat.buildings.length === 1, 'visible on flat ground');
  // Ground grid: a 15 m ridge across y = 60..90, flat elsewhere.
  const halfSize = 260, cell = 10, n = Math.ceil((2 * halfSize) / cell) + 1;
  const data = new Float32Array(n * n);
  for (let j = 0; j < n; j++) { const y = -halfSize + j * cell; if (y >= 60 && y <= 90) for (let i = 0; i < n; i++) data[j * n + i] = 15; }
  const hill = run({ buildings, radius: 200, ground: { data, n, cell, halfSize } });
  assert.equal(hill.buildings.length, 0, 'ridge hides it');
});
