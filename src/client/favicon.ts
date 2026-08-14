/**
 * Tab icon that reflects whether a timer is running.
 *
 * Drawn to a canvas and set as a PNG data URL rather than swapping in an SVG
 * data URL: SVG favicon support is uneven across browsers, whereas a raster one
 * is understood everywhere. The geometry mirrors public/favicon.svg, which is
 * what shows before this runs.
 */

/** Fallbacks matching styles.css, used if the custom properties can't be read. */
const FALLBACK_IDLE = '#2563eb';
const FALLBACK_RUNNING = '#dc2626';

const SIZE = 64; // Drawn larger than 16px so downscaling stays crisp.

let lastColour: string | null = null;
let lastRunning = false;

function readColour(property: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(property).trim();
  return value || fallback;
}

function draw(colour: string): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const s = SIZE / 32; // The SVG is authored on a 32-unit grid.

  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(16 * s, 16 * s, 15 * s, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3 * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(16 * s, 8.5 * s);
  ctx.lineTo(16 * s, 16 * s);
  ctx.lineTo(21.5 * s, 16 * s);
  ctx.stroke();

  return canvas.toDataURL('image/png');
}

/**
 * Point the tab icon at the running or idle colour.
 *
 * Safe to call repeatedly; redrawing only happens when the colour actually
 * changes, so this can sit in an effect that runs on every render.
 */
export function applyTimerFavicon(running: boolean): void {
  lastRunning = running;
  const colour = running
    ? readColour('--danger', FALLBACK_RUNNING)
    : readColour('--accent', FALLBACK_IDLE);
  if (colour === lastColour) return;

  const href = draw(colour);
  if (!href) return;
  lastColour = colour;

  // Replace every icon link, including the static SVG, so no stale one wins.
  document.querySelectorAll('link[rel~="icon"]').forEach((el) => el.remove());
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  link.href = href;
  document.head.appendChild(link);
}

/** Redraw after a light/dark switch, since the palette changes with it. */
export function watchColourScheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    lastColour = null; // Force a redraw against the new palette.
    applyTimerFavicon(lastRunning);
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
