/**
 * @module landingPage
 *
 * The first-open page: the hero (the Sightline panel, over the live orbiting
 * example) and, below it, sections that scroll up over the map. The panel is
 * moved into the page while it shows, then handed back to <body>.
 * Copy only claims what the tool does and which data it uses.
 */

const WHO = [
  ['cp', 'Close protection', 'close protection teams.', [
    ['Who can see the principal', 'Rooftops and windows checked by eye from the street. The ones you miss stay missed.', 'Drop the spot. Every window and roof within 1 km with a clear view lights up, closest first.'],
    ['The advance', 'Half a day on foot, then an evening sorting photos and screenshots.', 'Stand in each exposed window in 3D and see the spot from there. Then step to the next one.'],
    ['The brief', 'Written late at night from screenshots.', 'A two-page PDF with maps, the building list and cordon rings. Or one link that opens the result.'],
  ]],
  ['events', 'Event security', 'event security teams.', [
    ['The stage', 'Which balconies face the stage is found out on the day.', 'Every building that can see the stage, by distance and floor, before the gates open.'],
    ['Posts and rooftops', 'Posts placed from a site plan and a guess.', 'Put people where the rooftops that see the stage are, not where the plan has space.'],
    ['The team', 'A slide deck that is out of date by the briefing.', 'Everyone opens the same link, on a laptop or a phone. No install, no sign-up.'],
  ]],
  ['police', 'Police and planners', 'police and city planners.', [
    ['Cordons', 'A circle on a paper map and a distance table.', 'Rings at 100, 300 and 600 m on the real streets, with the buildings that see the spot.'],
    ['What changed here', 'Old photos hunted down one at a time.', 'Satellite history of the spot: years of imagery, plus radar that sees through cloud and at night.'],
    ['Ground truth', 'Heights guessed from the street.', 'Tel Aviv-Yafo uses the city\'s own building survey. Every result says what is measured and what is estimated.'],
  ]],
  ['film', 'Production', 'production and location teams.', [
    ['Overlooking windows', 'Found out when someone leans out during the take.', 'Every window that overlooks the set, with its floor and distance.'],
    ['The view from there', 'A scout walks up the stairs to check.', 'See the set from any lit window or roof in 3D, with a zoom lens.'],
    ['Sharing it', 'Screenshots in a group chat.', 'One link that opens straight to the result, for the whole crew.'],
  ]],
];

// Small isometric line drawings for the tool cards (ink on paper, one red accent).
const iso = (inner) => `<svg viewBox="0 -44 240 190" aria-hidden="true">${inner}</svg>`;
const block = (x, y, w, d, h, fill = '#fff') => {
  // isometric box: footprint w (to the right-down) × d (to the left-down), height h
  const a = [x, y], b = [x + w * 0.87, y + w * 0.5], c = [x + w * 0.87 - d * 0.87, y + w * 0.5 + d * 0.5], e = [x - d * 0.87, y + d * 0.5];
  const up = ([px, py]) => `${px},${py - h}`;
  const pt = ([px, py]) => `${px},${py}`;
  return `<g stroke="#111" stroke-width="1" stroke-linejoin="round">
    <polygon points="${up(a)} ${up(b)} ${up(c)} ${up(e)}" fill="${fill}"/>
    <polygon points="${up(e)} ${up(c)} ${pt(c)} ${pt(e)}" fill="${fill === '#fff' ? '#e9e9e6' : fill}" opacity="${fill === '#fff' ? 1 : 0.85}"/>
    <polygon points="${up(c)} ${up(b)} ${pt(b)} ${pt(c)}" fill="${fill === '#fff' ? '#d6d6d2' : fill}" opacity="${fill === '#fff' ? 1 : 0.7}"/>
  </g>`;
};
const ART = {
  sight: iso(`${block(150, 30, 34, 30, 70, '#ff3b30')}${block(70, 70, 30, 26, 30)}${block(190, 92, 26, 22, 22)}
    <line x1="152" y1="20" x2="96" y2="122" stroke="#ff3b30" stroke-width="1.5"/>
    <circle cx="96" cy="124" r="4" fill="#fff" stroke="#111"/><rect x="104" y="14" width="56" height="14" fill="#fff" stroke="#111"/>
    <text x="108" y="24" font-size="8" font-family="JetBrains Mono, monospace">FLOOR 14</text>`),
  pov: iso(`${block(40, 40, 40, 34, 60)}${block(150, 60, 40, 34, 40)}
    <rect x="96" y="22" width="70" height="52" fill="none" stroke="#111" stroke-width="1.5"/>
    <line x1="131" y1="40" x2="131" y2="56" stroke="#ff3b30"/><line x1="123" y1="48" x2="139" y2="48" stroke="#ff3b30"/>
    <circle cx="131" cy="48" r="3" fill="none" stroke="#ff3b30"/>`),
  rings: iso(`<ellipse cx="120" cy="84" rx="100" ry="54" fill="none" stroke="#111" stroke-dasharray="3 4" opacity=".5"/>
    <ellipse cx="120" cy="84" rx="62" ry="34" fill="none" stroke="#111" stroke-dasharray="3 4" opacity=".7"/>
    <ellipse cx="120" cy="84" rx="26" ry="14" fill="rgba(255,59,48,.12)" stroke="#ff3b30"/>
    ${block(64, 52, 18, 16, 18)}${block(170, 60, 20, 16, 26, '#ff8a00')}${block(130, 104, 18, 14, 12)}
    <circle cx="120" cy="84" r="3.5" fill="#fff" stroke="#111"/>
    <rect x="196" y="40" width="34" height="13" fill="#fff" stroke="#111"/><text x="200" y="49" font-size="8" font-family="JetBrains Mono, monospace">600 m</text>`),
  brief: iso(`<g stroke="#111" fill="#fff"><rect x="58" y="18" width="78" height="104"/><rect x="104" y="28" width="78" height="104"/></g>
    <rect x="112" y="38" width="62" height="34" fill="#eee" stroke="#111"/><circle cx="143" cy="55" r="3" fill="#ff3b30"/>
    <g stroke="#111" opacity=".55"><line x1="112" y1="82" x2="172" y2="82"/><line x1="112" y1="90" x2="166" y2="90"/><line x1="112" y1="98" x2="170" y2="98"/><line x1="112" y1="106" x2="150" y2="106"/></g>
    <rect x="112" y="114" width="26" height="9" fill="#ff3b30"/>`),
  link: iso(`<rect x="34" y="52" width="172" height="34" fill="#fff" stroke="#111"/>
    <text x="46" y="73" font-size="10" font-family="JetBrains Mono, monospace">sightline/?at=32.08,34.78</text>
    <rect x="160" y="96" width="46" height="20" fill="#111"/><text x="170" y="109" font-size="9" fill="#fff" font-family="JetBrains Mono, monospace">COPY</text>`),
  history: iso(`<g stroke="#111"><rect x="40" y="34" width="70" height="70" fill="#e4e4e0"/><rect x="70" y="44" width="70" height="70" fill="#d8d8d3"/><rect x="100" y="54" width="70" height="70" fill="#fff"/></g>
    <circle cx="135" cy="89" r="10" fill="none" stroke="#ff3b30" stroke-width="1.5"/>
    <g font-size="8" font-family="JetBrains Mono, monospace"><text x="40" y="28">2016</text><text x="178" y="62">2026</text></g>
    <line x1="176" y1="66" x2="176" y2="124" stroke="#111" stroke-dasharray="2 3"/>`),
};
const TOOLS = [
  ['sight', 'Sight', 'Analysis', 'Sightlines', 'Every window and roof that can see the spot, on every floor.'],
  ['pov', 'View from here', 'Analysis', 'Stand in the window', 'The spot as seen from its most exposed window or rooftop.'],
  ['rings', 'Cordons', 'Plan', 'Cordon rings', 'Rings at 100, 300 and 600 m and the buildings inside each.'],
  ['brief', 'The brief', 'Print', 'PDF brief', 'Two pages: maps, the building list and the rings.'],
  ['link', 'Share', 'Plan', 'One link', 'Opens straight to the result. Laptop or phone.'],
  ['history', 'History', 'Imagery', 'Satellite history', 'Years of imagery of the spot, and radar that sees at night.'],
];

const MARQUEE = ['OpenStreetMap', 'Tel Aviv-Yafo building survey', 'City-surveyed ground levels', 'Open elevation tiles', 'Google Photorealistic 3D Tiles', 'Esri World Imagery Wayback', 'Sentinel-1 radar', 'Sentinel-2'];

const SECTIONS = `
  <nav class="slp-nav" aria-label="Page">
    <a class="slp-brand" href="#slp-top"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="2.4" fill="#ff3b30"/><path d="M10 0v5M10 15v5M0 10h5M15 10h5" stroke="currentColor" stroke-width="1.6"/></svg>SIGHTLINE</a>
    <span class="slp-nav-links">
      <a href="#slp-who">Who it's for</a>
      <a href="#slp-tools">Tools</a>
      <a href="#slp-data">The data</a>
    </span>
    <button type="button" class="slp-open">Open the map</button>
  </nav>
  <div class="slp-hero" id="slp-top"></div>
  <a class="slp-cue" href="#slp-who">Scroll <span aria-hidden="true">↓</span></a>

  <div class="slp-marquee" aria-label="Data sources">
    <div class="slp-marquee-track">
      ${[0, 1].map(() => MARQUEE.map((m) => `<span><i></i>${m}</span>`).join('')).join('')}
    </div>
  </div>

  <section class="slp-sec slp-who" id="slp-who">
    <div class="slp-who-head">
      <p class="slp-k">Who it's for</p>
      <span class="slp-count"><b>01</b> / 0${WHO.length}</span>
    </div>
    <h2 class="slp-who-h">Sightline helps<br /><em>${WHO[0][2]}</em></h2>
    <div class="slp-tabs" role="tablist">
      ${WHO.map(([id, name], i) => `<button type="button" role="tab" data-i="${i}" aria-selected="${i === 0}">${name}</button>`).join('')}
    </div>
    <div class="slp-cmp" role="tabpanel">
      <div class="slp-cmp-head"><span></span><span>— Today</span><span><i></i>Sightline</span></div>
      <div class="slp-rows"></div>
    </div>
  </section>

  <section class="slp-sec slp-white" id="slp-tools">
    <p class="slp-k">The tools</p>
    <h2>Six tools.<br />One live 3D city.</h2>
    <p class="slp-lead">Everything runs on the same model of the real streets, in the browser, from one address.</p>
    <div class="slp-tools">
      ${TOOLS.map(([art, k, kind, h, p]) => `
        <article><header><span>${k}</span><span>${kind}</span></header>
          <div class="slp-art">${ART[art]}</div>
          <h3>${h}</h3><p>${p}</p></article>`).join('')}
    </div>
  </section>

  <section class="slp-sec" id="slp-how">
    <p class="slp-k">How it works</p>
    <h2>From an address to a plan in under a minute.</h2>
    <ol class="slp-steps">
      <li><b>01</b><h3>Pick the spot</h3><p>Search an address, use your location or tap the map. A stage, an entrance, a car drop-off.</p></li>
      <li><b>02</b><h3>Every line of sight</h3><p>Each floor of every building around it is checked for a clear view of the spot, plus the roof edges.</p>
        <ul class="slp-bands"><li><i class="high"></i>Under 150 m</li><li><i class="medium"></i>150 to 400 m</li><li><i class="low"></i>Over 400 m</li></ul></li>
      <li><b>03</b><h3>Stand in the window</h3><p>Tap a lit building to see the spot from its most exposed window or rooftop, then step to the next one.</p></li>
      <li><b>04</b><h3>Brief the team</h3><p>Send one link that opens straight to the result, or download a two-page PDF brief.</p></li>
    </ol>
  </section>

  <section class="slp-sec slp-white" id="slp-data">
    <p class="slp-k">The data</p>
    <h2>Open data, and honest about it.</h2>
    <div class="slp-data">
      <dl>
        <dt>Buildings</dt><dd>OpenStreetMap footprints and heights.</dd>
        <dt>Measured heights</dt><dd>Tel Aviv-Yafo: the city's own building survey. Elsewhere, heights from OpenStreetMap, marked <em>est.</em> where they are estimated.</dd>
        <dt>Ground</dt><dd>Tel Aviv-Yafo: city-surveyed ground levels. Elsewhere: open elevation tiles, so hills and slopes count.</dd>
        <dt>3D imagery</dt><dd>Google Photorealistic 3D Tiles, where Google has them.</dd>
        <dt>History</dt><dd>Esri World Imagery Wayback, and Sentinel-1 and Sentinel-2 from ESA.</dd>
      </dl>
      <div class="slp-limits">
        <h3>What it doesn't model yet</h3>
        <ul><li>Trees</li><li>Glass, balconies and signs</li><li>Stages, cranes and anything temporary</li></ul>
        <p>Every result says how much of it is measured and how much is estimated. It is a planning aid: walk the site too.</p>
      </div>
    </div>
  </section>

  <section class="slp-sec slp-end" id="slp-access">
    <p class="slp-k">Early access</p>
    <h2>Free to use while we build it.</h2>
    <p class="slp-lead">No install, no sign-up. Open it in a browser, on a laptop or a phone.</p>
    <div class="slp-ctas">
      <button type="button" class="slp-search">Search an address</button>
      <button type="button" class="slp-open slp-ghost">Open the map</button>
    </div>
  </section>

  <footer class="slp-foot">
    <span>SIGHTLINE</span>
    <span>Planning aid only. Check every result on the ground.</span>
    <span>Map data © OpenStreetMap contributors</span>
  </footer>`;

/**
 * @param {HTMLElement} panel the Sightline panel (hero lives inside it)
 * @param {{ onOpenMap: () => void, onSearch: () => void }} hooks
 * @returns {() => void} unmount: puts the panel back on <body>
 */
export function mountLanding(panel, { onOpenMap, onSearch }) {
  const page = document.createElement('div');
  page.className = 'sl-page';
  page.innerHTML = SECTIONS;
  document.body.appendChild(page);
  page.querySelector('.slp-hero').appendChild(panel);
  // Map credits ("Data attribution") live in the footer, not over the hero.
  const credits = document.getElementById('cesium-credits');
  if (credits) page.querySelector('.slp-foot').appendChild(credits);

  // "Who it's for": tabs swap the headline and the Today / Sightline rows.
  const rows = page.querySelector('.slp-rows');
  const tabs = [...page.querySelectorAll('.slp-tabs button')];
  const showWho = (i) => {
    const [, , line, list] = WHO[i];
    page.querySelector('.slp-who-h em').textContent = line;
    page.querySelector('.slp-count b').textContent = String(i + 1).padStart(2, '0');
    tabs.forEach((t, j) => t.setAttribute('aria-selected', String(i === j)));
    rows.innerHTML = list.map(([k, today, ours]) => `<div class="slp-row"><h4>${k}</h4><p class="slp-today">${today}</p><p>${ours}</p></div>`).join('');
  };
  tabs.forEach((t, i) => t.addEventListener('click', () => showWho(i)));
  showWho(0);

  page.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#slp-"]');
    if (a) {
      e.preventDefault();
      page.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (e.target.closest('.slp-open')) onOpenMap();
    else if (e.target.closest('.slp-search')) {
      page.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(onSearch, 350);
    }
  });
  // Fade the cue and dim the hero once you scroll into the sections.
  const onScroll = () => page.classList.toggle('scrolled', page.scrollTop > 40);
  page.addEventListener('scroll', onScroll, { passive: true });

  return function unmount() {
    document.body.appendChild(panel);
    if (credits) document.body.appendChild(credits);
    page.remove();
  };
}
