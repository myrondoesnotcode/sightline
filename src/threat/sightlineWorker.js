// Runs the sightline analysis off the main thread so the globe keeps moving.
import { analyzeSightlines } from './sightlineCore.js';

self.onmessage = (ev) => {
  const { id, buildings, radius, targetHeight, ground } = ev.data || {};
  try {
    const result = analyzeSightlines({ buildings, radius, targetHeight, ground });
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
