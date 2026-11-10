/**
 * @module pdfBrief
 *
 * The Sightline brief as a two-page A4 PDF, made in the browser.
 * Each page is drawn on a canvas (so Hebrew and other scripts lay out right
 * with the browser's own text engine), then wrapped in a small hand-written
 * PDF with one clickable link back to the live view. No library needed.
 */

const PT_W = 595.28; // A4 in PDF points
const PT_H = 841.89;
const SCALE = 2.5; // canvas px per point (~180 dpi)
const M = 40; // page margin, pt

const C = {
  ink: '#12151a',
  sub: '#5b6472',
  faint: '#8a919c',
  rule: '#dfe2e7',
  tile: '#f4f5f7',
  high: '#ff3b30',
  medium: '#ff8a00',
  low: '#ffd23f',
  blind: '#9aa3b2',
};
const F = {
  head: '"Inter Tight", "Inter", system-ui, sans-serif',
  body: '"Inter", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
};

function newPage() {
  const c = document.createElement('canvas');
  c.width = Math.round(PT_W * SCALE);
  c.height = Math.round(PT_H * SCALE);
  const g = c.getContext('2d');
  g.scale(SCALE, SCALE);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, PT_W, PT_H);
  g.textBaseline = 'alphabetic';
  return { c, g, links: [] };
}

function font(g, weight, size, family = F.body) {
  g.font = `${weight} ${size}px ${family}`;
}

function text(g, s, x, y, { color = C.ink, align = 'left', spacing = 0 } = {}) {
  g.fillStyle = color;
  g.textAlign = align;
  if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
  g.fillText(s, x, y);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
}

/** Wrap s into lines no wider than w; returns the y after the last line. */
function para(g, s, x, y, w, lh, opts) {
  const words = String(s).split(/\s+/);
  let line = '';
  for (const word of words) {
    const t = line ? `${line} ${word}` : word;
    if (g.measureText(t).width > w && line) {
      text(g, line, x, y, opts);
      y += lh;
      line = word;
    } else line = t;
  }
  if (line) { text(g, line, x, y, opts); y += lh; }
  return y;
}

function fit(g, s, w) {
  if (g.measureText(s).width <= w) return s;
  let t = s;
  while (t.length > 1 && g.measureText(`${t}…`).width > w) t = t.slice(0, -1);
  return `${t}…`;
}

function rule(g, y, x0 = M, x1 = PT_W - M, color = C.rule) {
  g.strokeStyle = color;
  g.lineWidth = 0.6;
  g.beginPath();
  g.moveTo(x0, y);
  g.lineTo(x1, y);
  g.stroke();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Draw an image (canvas) to cover the box, rounded corners. */
function picture(g, img, x, y, w, h, credit) {
  g.save();
  roundRect(g, x, y, w, h, 4);
  g.clip();
  g.fillStyle = '#1b1f26';
  g.fillRect(x, y, w, h);
  if (img) {
    const s = Math.max(w / img.width, h / img.height);
    const iw = img.width * s, ih = img.height * s;
    g.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
    if (credit) {
      font(g, 500, 5.6, F.body);
      const cw = g.measureText(credit).width + 8;
      g.fillStyle = 'rgba(10,12,16,0.6)';
      g.fillRect(x + w - cw, y + h - 10, cw, 10);
      text(g, credit, x + w - 4, y + h - 3, { color: '#fff', align: 'right' });
    }
  }
  g.restore();
}

function header(g, d, pageNo, pages) {
  font(g, 800, 12, F.head);
  text(g, 'SIGHTLINE', M, M + 6, { spacing: 2.2 });
  font(g, 500, 7.5, F.mono);
  text(g, `EXPOSURE BRIEF · ${d.when}`, PT_W - M, M + 6, { color: C.sub, align: 'right', spacing: 0.6 });
  rule(g, M + 16, M, PT_W - M, C.ink);
  // Footer
  rule(g, PT_H - 34);
  font(g, 400, 7, F.mono);
  text(g, 'Planning aid only. Built from open map data; walk the site before you rely on it.', M, PT_H - 22, { color: C.faint });
  text(g, `${pageNo} / ${pages}`, PT_W - M, PT_H - 22, { color: C.faint, align: 'right' });
}

function caption(g, s, x, y) {
  font(g, 600, 6.8, F.mono);
  text(g, s.toUpperCase(), x, y, { color: C.sub, spacing: 0.8 });
}

function keyRow(g, x, y) {
  const items = [['high', 'under 150 m'], ['medium', '150–400 m'], ['low', 'over 400 m'], ['blind', "can't see the spot"]];
  font(g, 500, 7.5, F.body);
  let cx = x;
  caption(g, 'Can see your spot', cx, y + 6.5);
  cx += 88;
  for (const [k, label] of items) {
    g.fillStyle = C[k];
    roundRect(g, cx, y, 9, 9, 2);
    g.fill();
    font(g, 500, 7.5, F.body);
    text(g, label, cx + 13, y + 7.5, { color: C.ink });
    cx += 13 + g.measureText(label).width + 16;
  }
}

/** North arrow + scale bar drawn over the plan image. */
function planMarks(g, x, y, w, h, metresAcross) {
  // Scale bar: a round length ~1/4 of the width.
  const mPerPt = metresAcross / w;
  const nice = [50, 100, 200, 250, 500, 1000].find((v) => v / mPerPt >= w * 0.18) || 1000;
  const len = nice / mPerPt;
  const bx = x + 12, by = y + h - 14;
  g.fillStyle = 'rgba(10,12,16,0.72)';
  roundRect(g, bx - 6, by - 15, len + 44, 22, 3);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(bx, by - 3); g.lineTo(bx, by); g.lineTo(bx + len, by); g.lineTo(bx + len, by - 3);
  g.stroke();
  font(g, 600, 7, F.mono);
  text(g, nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, bx + len + 6, by + 1, { color: '#fff' });
  // North arrow
  const nx = x + w - 22, ny = y + 22;
  g.fillStyle = 'rgba(10,12,16,0.72)';
  g.beginPath(); g.arc(nx, ny, 13, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(nx, ny - 9); g.lineTo(nx + 5, ny + 4); g.lineTo(nx, ny + 1); g.lineTo(nx - 5, ny + 4); g.closePath(); g.fill();
  font(g, 700, 6.5, F.mono);
  text(g, 'N', nx, ny + 11.5, { color: '#fff', align: 'center' });
}

function page1(d) {
  const p = newPage();
  const { g } = p;
  header(g, d, 1, 2);
  let y = M + 50;
  font(g, 700, 22, F.head);
  text(g, fit(g, d.place, PT_W - 2 * M), M, y);
  y += 16;
  font(g, 400, 8, F.mono);
  text(g, d.where, M, y, { color: C.sub });

  // Headline
  y += 38;
  font(g, 800, 28, F.head);
  text(g, d.headline, M, y);
  y += 20;
  font(g, 400, 11, F.body);
  y = para(g, d.sub, M, y, PT_W - 2 * M, 15, { color: C.ink });

  // Stat tiles
  y += 8;
  const tiles = [...d.bands.map((b) => ({ ...b, unit: b.count === 1 ? 'building' : 'buildings' })), d.closestTile];
  const gap = 8;
  const tw = (PT_W - 2 * M - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach((t, i) => {
    const x = M + i * (tw + gap);
    g.fillStyle = C.tile;
    roundRect(g, x, y, tw, 58, 4);
    g.fill();
    if (t.key) {
      g.fillStyle = C[t.key];
      g.fillRect(x, y + 4, 3, 50);
    }
    font(g, 600, 6.8, F.mono);
    text(g, t.label.toUpperCase(), x + 11, y + 15, { color: C.sub, spacing: 0.6 });
    font(g, 800, 21, F.head);
    text(g, String(t.value ?? t.count), x + 11, y + 40);
    font(g, 400, 7.5, F.body);
    text(g, fit(g, t.unit || '', tw - 16), x + 11, y + 51, { color: C.sub });
  });
  y += 58 + 20;

  // Plan view
  caption(g, `Plan view · north up · rings at ${d.ringList}`, M, y);
  y += 6;
  const planH = 300;
  picture(g, d.images.plan, M, y, PT_W - 2 * M, planH, d.images.credit);
  if (d.images.plan) planMarks(g, M, y, PT_W - 2 * M, planH, d.planMetresAcross);
  y += planH + 10;
  keyRow(g, M, y);
  y += 26;

  // Two smaller views
  const hw = (PT_W - 2 * M - 12) / 2;
  const sh = PT_H - 46 - y - 14;
  caption(g, 'Overview in 3D', M, y);
  caption(g, d.images.povCaption || 'From the closest building', M + hw + 12, y);
  y += 6;
  picture(g, d.images.oblique, M, y, hw, sh, d.images.credit);
  picture(g, d.images.pov, M + hw + 12, y, hw, sh, d.images.credit);
  if (d.images.pov) {
    // A target marker in the middle of the window view, where the spot is.
    const cx = M + hw + 12 + hw / 2, cy = y + sh / 2;
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    g.moveTo(cx - 15, cy); g.lineTo(cx - 5, cy); g.moveTo(cx + 5, cy); g.lineTo(cx + 15, cy);
    g.moveTo(cx, cy - 15); g.lineTo(cx, cy - 5); g.moveTo(cx, cy + 5); g.lineTo(cx, cy + 15);
    g.stroke();
  }
  return p;
}

function page2(d) {
  const p = newPage();
  const { g } = p;
  header(g, d, 2, 2);
  let y = M + 46;
  font(g, 700, 15, F.head);
  text(g, 'Buildings that can see the spot', M, y);
  y += 14;
  font(g, 400, 8.5, F.body);
  text(g, d.rows.length < d.totalBuildings
    ? `Nearest ${d.rows.length} of ${d.totalBuildings}, closest first.`
    : `All ${d.totalBuildings}, closest first.`, M, y, { color: C.sub });
  y += 18;

  // Table
  const cols = [
    { k: 'n', label: '#', w: 26 },
    { k: 'name', label: 'Building', w: 142 },
    { k: 'dist', label: 'Distance', w: 52, align: 'right' },
    { k: 'dir', label: 'Dir.', w: 34, align: 'right' },
    { k: 'height', label: 'Height', w: 62, align: 'right' },
    { k: 'floors', label: 'Floors in view', w: 74, align: 'right' },
    { k: 'windows', label: 'Windows', w: 52, align: 'right' },
    { k: 'roofs', label: 'Roof spots', w: 0, align: 'right' },
  ];
  const tableW = PT_W - 2 * M;
  cols[cols.length - 1].w = tableW - cols.slice(0, -1).reduce((s, c) => s + c.w, 0);
  const drawRow = (vals, yy, head, band) => {
    let x = M;
    for (const c of cols) {
      const v = vals[c.k] ?? '';
      if (head) font(g, 600, 6.8, F.mono);
      else if (c.k === 'name') font(g, 500, 8.5, F.body);
      else font(g, 400, 8, F.mono);
      const pad = 6;
      if (!head && c.k === 'n' && band) {
        g.fillStyle = C[band];
        roundRect(g, x, yy - 8, 3, 11, 1);
        g.fill();
      }
      const s = fit(g, String(v), c.w - pad * 2);
      const tx = c.align === 'right' ? x + c.w - pad : x + (c.k === 'n' ? 8 : pad);
      text(g, head ? s.toUpperCase() : s, tx, yy, {
        color: head ? C.sub : (c.k === 'height' && vals.heightEst ? C.sub : C.ink),
        align: c.align === 'right' ? 'right' : 'left',
        spacing: head ? 0.5 : 0,
      });
      x += c.w;
    }
  };
  drawRow(Object.fromEntries(cols.map((c) => [c.k, c.label])), y, true);
  y += 7;
  rule(g, y, M, PT_W - M, C.ink);
  y += 14;
  for (const r of d.rows) {
    drawRow(r, y, false, r.band);
    y += 6;
    rule(g, y);
    y += 13;
  }
  y += 4;
  font(g, 400, 7.5, F.body);
  text(g, 'Heights marked "est." (in grey) are estimated from the building type; the rest are measured or mapped.', M, y, { color: C.sub });
  y += 30;

  // Cordon
  font(g, 700, 12, F.head);
  text(g, 'Cordon', M, y);
  y += 16;
  const cw = (PT_W - 2 * M - 16) / 3;
  d.rings.forEach((r, i) => {
    const x = M + i * (cw + 8);
    g.fillStyle = C.tile;
    roundRect(g, x, y, cw, 44, 4);
    g.fill();
    font(g, 600, 6.8, F.mono);
    text(g, `WITHIN ${r.label}`.toUpperCase(), x + 10, y + 14, { color: C.sub, spacing: 0.6 });
    font(g, 800, 16, F.head);
    text(g, String(r.count), x + 10, y + 34);
    const nw = g.measureText(String(r.count)).width;
    font(g, 400, 7.5, F.body);
    text(g, `building${r.count === 1 ? '' : 's'} with a line of sight`, x + 10 + nw + 5, y + 34, { color: C.sub });
  });
  y += 44 + 30;

  // Data and limits
  font(g, 700, 12, F.head);
  text(g, 'How good is this data', M, y);
  y += 16;
  font(g, 400, 8.5, F.body);
  for (const s of d.dataLines) {
    g.fillStyle = C.ink;
    g.fillRect(M, y - 3.5, 2.5, 2.5);
    y = para(g, s, M + 10, y, PT_W - 2 * M - 10, 12.5, { color: C.ink });
    y += 3;
  }
  y += 14;

  // Link back
  font(g, 700, 12, F.head);
  text(g, 'Open the live view', M, y);
  y += 15;
  font(g, 400, 8, F.mono);
  const url = d.shareUrl;
  const shown = fit(g, url, PT_W - 2 * M);
  text(g, shown, M, y, { color: '#1a5fd0' });
  p.links.push({ x: M, y: y - 9, w: Math.min(g.measureText(shown).width, PT_W - 2 * M), h: 12, url });
  y += 13;
  font(g, 400, 7.5, F.body);
  text(g, 'Opens this spot in Sightline: turn the 3D view, step through each building, see the spot from its windows.', M, y, { color: C.sub });
  return p;
}

// ── Minimal PDF writer: one JPEG per page + link annotations ─────────────
function pdfEscape(s) {
  return String(s).replace(/[\\()]/g, (m) => `\\${m}`).replace(/[^\x20-\x7e]/g, (ch) => encodeURIComponent(ch));
}

async function jpegBytes(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}

async function writePdf(pages, title) {
  const enc = new TextEncoder();
  const parts = [];
  let length = 0;
  const offsets = [];
  const push = (chunk) => {
    const b = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(b);
    length += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    for (const b of [].concat(body)) push(b);
    push('\nendobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  // 1 catalog, 2 pages, 3 info, then per page: page, content, image, annots…
  const pageIds = [];
  let next = 4;
  const plan = pages.map((p) => {
    const ids = { page: next++, content: next++, image: next++, annots: p.links.map(() => next++) };
    pageIds.push(ids.page);
    return ids;
  });
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  obj(3, `<< /Title (${pdfEscape(title)}) /Producer (Sightline) /Creator (Sightline) >>`);
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const ids = plan[i];
    const jpg = await jpegBytes(p.c);
    const annots = ids.annots.length ? ` /Annots [${ids.annots.map((a) => `${a} 0 R`).join(' ')}]` : '';
    obj(ids.page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PT_W} ${PT_H}] /Resources << /XObject << /Im0 ${ids.image} 0 R >> >> /Contents ${ids.content} 0 R${annots} >>`);
    const stream = `q ${PT_W} 0 0 ${PT_H} 0 0 cm /Im0 Do Q`;
    obj(ids.content, [`<< /Length ${stream.length} >>\nstream\n`, stream, '\nendstream']);
    obj(ids.image, [`<< /Type /XObject /Subtype /Image /Width ${p.c.width} /Height ${p.c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, '\nendstream']);
    p.links.forEach((l, k) => {
      const rect = [l.x, PT_H - l.y - l.h, l.x + l.w, PT_H - l.y].map((v) => v.toFixed(2)).join(' ');
      obj(ids.annots[k], `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /A << /S /URI /URI (${pdfEscape(l.url)}) >> >>`);
    });
  }
  const xref = length;
  push(`xref\n0 ${next}\n0000000000 65535 f \n`);
  for (let n = 1; n < next; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${next} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/**
 * @param {object} d brief data (see threatTool.js `pdfData`)
 * @returns {Promise<Blob>}
 */
export async function buildBriefPdf(d) {
  await Promise.all([
    document.fonts.load(`800 20px "Inter Tight"`),
    document.fonts.load(`700 20px "Inter Tight"`),
    document.fonts.load(`400 12px "Inter"`),
    document.fonts.load(`600 12px "Inter"`),
    document.fonts.load(`400 12px "JetBrains Mono"`),
    document.fonts.load(`600 12px "JetBrains Mono"`),
  ]).catch(() => {});
  const pages = [page1(d), page2(d)];
  return writePdf(pages, `Sightline brief: ${d.place}`);
}
