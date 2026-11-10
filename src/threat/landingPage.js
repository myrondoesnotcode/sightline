/**
 * @module landingPage
 *
 * The first-open page: the hero (the Sightline panel, over the live orbiting
 * example) and, below it, sections that scroll up over the map. The panel is
 * moved into the page while it shows, then handed back to <body>.
 * Copy only claims what the tool does and which data it uses.
 */

const SECTIONS = `
  <nav class="slp-nav" aria-label="Page">
    <a href="#slp-how">How it works</a>
    <a href="#slp-data">The data</a>
    <a href="#slp-access">Early access</a>
    <button type="button" class="slp-open">Open the map</button>
  </nav>
  <div class="slp-hero"></div>
  <a class="slp-cue" href="#slp-how">How it works <span aria-hidden="true">↓</span></a>

  <section class="slp-sec" id="slp-how">
    <p class="slp-k">How it works</p>
    <h2>From an address to a plan in under a minute.</h2>
    <ol class="slp-steps">
      <li><b>01</b><h3>Pick the spot</h3><p>Search an address, use your location or tap the map. A stage, an entrance, a car drop-off.</p></li>
      <li><b>02</b><h3>Every line of sight</h3><p>Each floor of every building around it is checked for a clear view of the spot, plus the roof edges.</p>
        <ul class="slp-bands"><li><i class="high"></i>Under 150 m</li><li><i class="medium"></i>150 to 400 m</li><li><i class="low"></i>Over 400 m</li></ul></li>
      <li><b>03</b><h3>Stand in the window</h3><p>Tap a lit building to see the spot from its most exposed window or rooftop, then step to the next one.</p></li>
      <li><b>04</b><h3>Brief the team</h3><p>Send one link that opens straight to the result, or download a two-page PDF brief with maps, the building list and cordon rings.</p></li>
    </ol>
  </section>

  <section class="slp-sec" id="slp-who">
    <p class="slp-k">Who it's for</p>
    <h2>Anyone who has to plan around a crowd, a person or a door.</h2>
    <div class="slp-grid">
      <div><h3>Event and venue security</h3><p>Know which balconies and rooftops face the stage before the gates open.</p></div>
      <div><h3>Close protection</h3><p>Check the drop-off, the entrance and the route stops before the principal arrives.</p></div>
      <div><h3>Police and city planners</h3><p>Set cordons and posts from the buildings that actually see the spot, not a circle on a map.</p></div>
      <div><h3>Production and location teams</h3><p>See which windows overlook a set or a shoot, and who you may need to talk to.</p></div>
    </div>
  </section>

  <section class="slp-sec" id="slp-data">
    <p class="slp-k">The data</p>
    <h2>Open data, and honest about it.</h2>
    <div class="slp-data">
      <dl>
        <dt>Buildings</dt><dd>OpenStreetMap footprints and heights.</dd>
        <dt>Measured heights</dt><dd>Tel Aviv-Yafo: the city's own building survey. Elsewhere, heights from OpenStreetMap, marked <em>est.</em> where they are estimated.</dd>
        <dt>Ground</dt><dd>Tel Aviv-Yafo: city-surveyed ground levels. Elsewhere: open elevation tiles, so hills and slopes count.</dd>
        <dt>3D imagery</dt><dd>Google Photorealistic 3D Tiles, where Google has them.</dd>
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
    page.remove();
  };
}
