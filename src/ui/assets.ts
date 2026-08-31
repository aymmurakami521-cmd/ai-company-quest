/**
 * Static assets for the retro office screen.
 *
 * Security posture: the request URL never contributes to a filesystem path.
 * Routes are a fixed table of literal filenames, every file is read once at
 * module load, and a request only ever performs a lookup in that table - so
 * there is no path traversal surface and no per-request disk access at all. A
 * missing asset fails at startup rather than at request time.
 *
 * The screen is read-only: it opens the two documented SSE endpoints, reads the
 * value read model from `/value/summary`, and does nothing else. All three are
 * same-origin GETs. The CSP below states that in a form the browser enforces -
 * `default-src 'none'` plus `connect-src 'self'` leaves no way for the page to
 * reach any other origin, and no inline script or style may run.
 */

import { readFileSync } from 'node:fs';

export type UiAsset = {
  readonly pathname: string;
  readonly body: Buffer;
  readonly contentType: string;
};

/**
 * Everything the page may load, keyed by exact request path. Filenames are
 * literals in this file; nothing here is ever built from user input.
 */
const ASSET_TABLE: readonly { pathname: string; file: string; contentType: string }[] = [
  { pathname: '/', file: 'index.html', contentType: 'text/html; charset=utf-8' },
  { pathname: '/ui/quest.css', file: 'quest.css', contentType: 'text/css; charset=utf-8' },
  { pathname: '/ui/quest-app.js', file: 'quest-app.js', contentType: 'text/javascript; charset=utf-8' },
  { pathname: '/ui/quest-view.js', file: 'quest-view.js', contentType: 'text/javascript; charset=utf-8' },
  { pathname: '/ui/quest-world.js', file: 'quest-world.js', contentType: 'text/javascript; charset=utf-8' },
  { pathname: '/ui/quest-canvas.js', file: 'quest-canvas.js', contentType: 'text/javascript; charset=utf-8' },
  { pathname: '/ui/quest-value.js', file: 'quest-value.js', contentType: 'text/javascript; charset=utf-8' },
];

/** Same-origin only, no inline code, no way to reach an external service. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const ASSETS = new Map<string, UiAsset>(
  ASSET_TABLE.map((entry) => [
    entry.pathname,
    {
      pathname: entry.pathname,
      // Resolved from this module's own location, never from a request.
      body: readFileSync(new URL(`./public/${entry.file}`, import.meta.url)),
      contentType: entry.contentType,
    },
  ]),
);

/** Every path the UI serves. Exported so the tests can assert the whole set. */
export const UI_ASSET_PATHS: readonly string[] = ASSET_TABLE.map((entry) => entry.pathname);

/** Returns the asset for an exact path, or null. A `Map` lookup, not a file read. */
export function uiAsset(pathname: string): UiAsset | null {
  return ASSETS.get(pathname) ?? null;
}
