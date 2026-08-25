/**
 * The accessibility and layout contract of the retro office screen.
 *
 * The screen is browser-native HTML/CSS, so these tests read the shipped assets
 * and hold the rules that a DOM-less suite can actually hold:
 *
 * - the DOM is the record of truth and the canvas stays decorative;
 * - every control is reachable and operable with a keyboard alone;
 * - every focusable thing has a visible focus indicator and an accessible name;
 * - status is always readable as text and a symbol, never as colour alone;
 * - the status vocabulary is closed, and one code of it is always showing;
 * - ARIA is not piled on: one live region, no role that repeats a native one;
 * - the layout reflows down to a 320px-wide viewport (a 640px screen at 200%
 *   zoom, or a 960px screen at 200% zoom, is just a narrower viewport).
 *
 * Pixel rendering, real focus order and a real screen reader are out of scope
 * here - see the README's known limitations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { UI_ASSET_PATHS, uiAsset } from '../src/ui/assets.ts';

import type { ActorVisualState, Desk, Header } from '../src/ui/public/quest-view.js';
import {
  ACTOR_VISUAL_STATES,
  BANNER_CODES,
  applyFrame,
  createClientState,
  selectBanner,
  selectDesks,
  selectHeader,
  setConnectionPhase,
  visualForState,
} from '../src/ui/public/quest-view.js';
import { MAX_COLUMNS, MAX_ROWS, buildWorld } from '../src/ui/public/quest-world.js';

function assetText(pathname: string): string {
  const asset = uiAsset(pathname);
  assert.ok(asset !== null, `${pathname} is served`);
  return asset.body.toString('utf8');
}

const HTML = assetText('/');
const CSS = assetText('/ui/quest.css');
const APP = assetText('/ui/quest-app.js');

/** All attribute occurrences of one name in the page, e.g. every `tabindex="…"`. */
function attributes(name: string): string[] {
  return [...HTML.matchAll(new RegExp(`\\b${name}="([^"]*)"`, 'g'))].map((match) => match[1] ?? '');
}

// ------------------------------------------------------------- keyboard ---

test('every control on the page is a native, keyboard-operable element', () => {
  // The app only ever binds clicks to elements it found by these selectors.
  const bound = [...APP.matchAll(/querySelectorAll\('([^']+)'\)|querySelector\('([^']+)'\)/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((selector) => selector.startsWith('[data-'));
  assert.deepEqual(bound.sort(), ['[data-action="reconnect"]', '[data-mode]']);

  // …and in the page those are <button>s, which are focusable and fire on both
  // Enter and Space without any key handler of our own.
  for (const marker of ['data-mode="live"', 'data-mode="demo"', 'data-action="reconnect"']) {
    const line = HTML.split('\n').find((row) => row.includes(marker));
    assert.ok(line !== undefined, `page has ${marker}`);
    assert.ok(String(line).includes('<button'), `${marker} is a <button>`);
    assert.ok(String(line).includes('type="button"'), `${marker} is an explicit button`);
  }

  // No custom widget that would need its own key handling, and no click-only
  // element pretending to be a control.
  assert.equal(/role="(button|tab|checkbox|switch|menuitem|link)"/.test(HTML), false, 'no hand-rolled widget');
  assert.equal(/\son[a-z]+=/.test(HTML), false, 'no inline handler');
  assert.equal(/addEventListener\('(mousedown|mouseup|mousemove|dblclick|contextmenu)'/.test(APP), false);
});

test('the tab order is the reading order: no positive or removed tabindex', () => {
  for (const value of attributes('tabindex')) {
    assert.equal(value, '0', `tabindex="${value}" reorders or removes a stop`);
  }
  assert.equal(APP.includes('tabIndex'), false, 'the script never rewrites the tab order');
  assert.equal(APP.includes('.focus()'), false, 'the script never steals focus');
});

test('a scrollable region can be reached and scrolled with a keyboard', () => {
  // The activity log is the one part of the page with its own scrollbar, so it
  // is the one part that needs to be a focus stop of its own.
  assert.match(CSS, /\.log__scroll\s*\{[^}]*overflow-y:\s*auto/, 'the log scrolls in its own container');
  const line = HTML.split('\n').find((row) => row.includes('class="log__scroll"'));
  assert.ok(line !== undefined, 'the page has the log scroll container');
  assert.ok(String(line).includes('tabindex="0"'), 'the log scroll container is a focus stop');
  assert.ok(String(line).includes('aria-labelledby="log-heading"'), 'and it is named by its heading');
  assert.ok(HTML.includes('id="log-heading"'), 'the heading it points at exists');

  // The list itself keeps its list semantics inside the scrolling box.
  assert.match(CSS, /\.log \{[^}]*\}/, 'the list is still styled as a list');
  assert.equal(/<ol class="log" id="log"[^>]*role=/.test(HTML), false, 'no role overrides the list');
});

test('the skip link goes to a target that exists', () => {
  const target = /<a class="skip-link" href="#([^"]+)"/.exec(HTML);
  assert.ok(target !== null, 'the page opens with a skip link');
  assert.ok(HTML.includes(`id="${String(target[1])}"`), 'the skip link target exists');
});

// ---------------------------------------------------------------- focus ---

test('every focusable element has a visible focus indicator', () => {
  assert.match(CSS, /(^|\})\s*:focus-visible\s*\{[^}]*outline:/m, 'a global focus ring is declared');
  // The button rule may override the colour, but never remove the ring.
  for (const block of CSS.match(/:focus[^{]*\{[^}]*\}/g) ?? []) {
    assert.equal(/outline:\s*(none|0)/.test(block), false, `a focus rule removes the outline: ${block}`);
  }
  assert.equal(/outline:\s*(none|0)/.test(CSS), false, 'nothing removes an outline anywhere');
});

// ------------------------------------------------------ accessible names ---

test('the lists and regions the screen fills carry an accessible name', () => {
  assert.match(HTML, /<ul class="desks" id="desks" aria-label="[^"]+"/, 'the desk list is named');
  assert.match(HTML, /role="group" aria-label="[^"]+"/, 'the mode group is named');
  assert.match(HTML, /class="log__scroll" tabindex="0" role="group" aria-labelledby=/, 'the log region is named');

  // Every heading the page relies on for structure is present and in order.
  const headings = [...HTML.matchAll(/<h([1-3])[^>]*>/g)].map((match) => Number(match[1]));
  assert.equal(headings[0], 1, 'the page starts at h1');
  assert.equal(headings.filter((level) => level === 1).length, 1, 'exactly one h1');
  for (let index = 1; index < headings.length; index += 1) {
    const previous = headings[index - 1] ?? 1;
    const current = headings[index] ?? 1;
    assert.ok(current <= previous + 1, `heading level jumps from h${previous} to h${current}`);
  }
});

test('the current mode is exposed as state, not only as a colour', () => {
  assert.ok(HTML.includes('aria-pressed="false"'), 'the mode buttons start with a pressed state');
  assert.ok(APP.includes("setAttribute('aria-pressed'"), 'the app keeps it in sync');
  assert.match(CSS, /\.mode-button\[aria-pressed='true'\]/, 'the pressed button is styled from that state');
  // The buttons' own text is the name; nothing relabels them.
  assert.equal(/<button[^>]*data-mode[^>]*aria-label=/.test(HTML), false, 'no aria-label hides the visible text');
});

// ------------------------------------------------------------- no excess ---

test('the page has exactly one live region and no redundant ARIA', () => {
  const live = attributes('aria-live');
  assert.deepEqual(live, ['polite'], 'exactly one polite live region, so no double announcement');
  assert.equal((HTML.match(/role="status"/g) ?? []).length, 1, 'and exactly one status role');
  assert.ok(/id="banner"[^>]*role="status"[^>]*aria-live="polite"/.test(HTML), 'the banner is that region');

  // The header stats repeat the same facts, so they must stay non-live.
  assert.equal(/id="stat-[a-z]+"[^>]*aria-live/.test(HTML), false, 'the stats do not announce as well');

  // No role that only repeats what the element already is.
  for (const [element, role] of [
    ['ul', 'list'],
    ['ol', 'list'],
    ['li', 'listitem'],
    ['main', 'main'],
    ['header', 'banner'],
    ['footer', 'contentinfo'],
    ['button', 'button'],
    ['h2', 'heading'],
  ] as const) {
    assert.equal(
      new RegExp(`<${element}[^>]*role="${role}"`).test(HTML),
      false,
      `<${element}> does not restate role="${role}"`,
    );
  }
});

test('the canvas is decorative and everything it paints is in the DOM too', () => {
  assert.match(HTML, /<canvas[^>]*aria-hidden="true"/, 'the canvas is hidden from assistive tech');
  assert.equal(/<canvas[^>]*(aria-label|role=)/.test(HTML), false, 'and is not given a role or a name');
  // Every decorative flourish is hidden the same way.
  assert.match(HTML, /class="office__wall" aria-hidden="true"/);
  assert.match(HTML, /class="desk__sprite" aria-hidden="true"/);
  // Symbols are decoration next to a text label, never the label itself.
  for (const symbol of ['desk__symbol', 'log__symbol', 'legend__symbol', 'banner__symbol', 'hud__logo']) {
    const line = HTML.split('\n').find((row) => row.includes(symbol));
    assert.ok(line !== undefined, `page has .${symbol}`);
    assert.ok(String(line).includes('aria-hidden="true"'), `.${symbol} is decorative`);
  }
});

// ------------------------------------------------------ status vocabulary ---

/** A header in one situation, without touching a socket or the clock. */
function headerWith(patch: Partial<Header>): Header {
  return { ...selectHeader(createClientState('live')), ...patch };
}

test('the status vocabulary is closed and one code is always showing', () => {
  const phases = ['offline', 'connecting', 'open', 'reconnecting', 'error'];
  const seen = new Set<string>();

  for (const phase of phases) {
    for (const halted of [false, true]) {
      for (const gap of [null, { reason: 'evicted' }, { reason: 'not-a-real-reason' }]) {
        for (const replaying of [false, true]) {
          for (const empty of [false, true]) {
            const header = headerWith({
              connection: { state: phase, code: phase, label: phase, symbol: '?' } as Header['connection'],
              halted,
              gap,
              replaying,
              empty,
            });
            const banner = selectBanner(header);
            assert.ok(BANNER_CODES.includes(banner.code), `${banner.code} is in the vocabulary`);
            assert.ok(banner.message.length > 0, `${banner.code} says something`);
            assert.ok(banner.symbol.length > 0, `${banner.code} has a symbol`);
            assert.ok(['error', 'warn', 'info', 'ok'].includes(banner.tone), `${banner.code} has a known tone`);
            seen.add(banner.code);
          }
        }
      }
    }
  }

  // Nothing in the vocabulary is unreachable, and nothing reachable is missing.
  assert.deepEqual([...seen].sort(), [...BANNER_CODES].sort());
});

test('the banner never echoes a free-form reason off the wire', () => {
  const header = headerWith({ gap: { reason: '<script>alert(1)</script>' } });
  const banner = selectBanner(header);
  assert.equal(banner.code, 'STREAM_GAP');
  assert.equal(banner.message.includes('script'), false, 'an unknown reason is reported as an unlabelled gap');

  const known = selectBanner(headerWith({ gap: { reason: 'unknown_event_id' } }));
  assert.ok(known.message.includes('replay buffer'), 'a known reason gets its own sentence');
});

test('every status is readable without colour: symbol plus code plus message', () => {
  // Banner: the tone is a colour, but the code and symbol are text next to it.
  assert.ok(APP.includes("querySelector('.banner__code')"), 'the code is written as text');
  assert.ok(APP.includes("querySelector('.banner__symbol')"), 'the symbol is written as text');
  assert.ok(HTML.includes('class="banner__code"'), 'the page has a slot for it');
  for (const tone of ['error', 'info', 'ok']) {
    assert.ok(CSS.includes(`.banner[data-tone='${tone}']`), `tone ${tone} has a rule`);
  }

  // Desks and log rows: symbol and label for every state in the closed set.
  for (const state of ACTOR_VISUAL_STATES) {
    const visual = visualForState(state as ActorVisualState);
    assert.ok(visual.symbol.length > 0, `${state} has a symbol`);
    assert.ok(visual.label.length > 0, `${state} has a label`);
    assert.ok(visual.code.length > 0, `${state} has a code`);
  }
  assert.ok(APP.includes('desk__state-label'), 'the desk prints the label, not only the colour');
});

test('no motion and no transition is declared outside the reduced-motion guard', () => {
  const guard = CSS.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(guard > 0, 'the guard exists');
  const outside = CSS.slice(0, guard);
  assert.equal(/animation:/.test(outside), false, 'no animation outside the guard');
  assert.equal(/transition:/.test(outside), false, 'no transition outside the guard');
  // The canvas layer has no motion at all: no timer, no animation frame.
  assert.equal(/requestAnimationFrame/.test(APP), false, 'the canvas never animates');
});

// ---------------------------------------------------------------- layout ---

test('the layout reflows down to a 320px viewport', () => {
  for (const breakpoint of ['1024px', '720px', '480px']) {
    assert.ok(CSS.includes(`@media (max-width: ${breakpoint})`), `there is a ${breakpoint} step`);
  }
  // Nothing holds the page open wider than the narrowest supported viewport.
  for (const value of CSS.match(/min-width:\s*(\d+)px/g) ?? []) {
    const px = Number(/(\d+)/.exec(value)?.[1] ?? 0);
    assert.ok(px <= 320, `min-width: ${px}px would block reflow at 320px`);
  }
  // A breakpoint (`max-width`) is fine; a fixed layout width is not.
  assert.equal(/(?<![a-z-])width:\s*\d{3,}px/.test(CSS), false, 'no three-digit fixed width');
  // The canvas scales with its box instead of forcing a width.
  assert.match(CSS, /\.office__canvas-surface\s*\{[^}]*width:\s*100%/, 'the canvas is fluid');
  assert.match(CSS, /\.office__canvas-surface\s*\{[^}]*height:\s*auto/, 'and keeps its own ratio');
  // The desk grid collapses rather than overflowing.
  assert.match(CSS, /@media \(max-width: 720px\)[\s\S]*?\.desks \{\s*grid-template-columns: 1fr;/);
});

test('the page never asks the viewport to zoom-lock', () => {
  const viewport = /<meta name="viewport" content="([^"]+)"/.exec(HTML);
  assert.ok(viewport !== null, 'the page declares a viewport');
  const content = String(viewport[1]);
  assert.equal(content.includes('user-scalable=no'), false, 'pinch zoom stays available');
  assert.equal(/maximum-scale=(1|1\.0)\b/.test(content), false, 'zoom is not capped');
});

// -------------------------------------------------- canvas overflow ↔ DOM ---

test('an office larger than the canvas still lists every actor in the DOM', () => {
  const total = MAX_COLUMNS * MAX_ROWS + 7;
  const desks: Desk[] = Array.from({ length: total }, (_unused, index) => ({
    seat: index + 1,
    actor_key: `sess-1:agent-${index}`,
    session_id: 'sess-1',
    display_name: `agent-${index}`,
    is_main_orchestrator: false,
    role: null,
    resolved: false,
    status_label: null,
    last_tool: null,
    last_event_ts: null,
    event_count: 1,
    visual: visualForState('idle'),
  }));

  const world = buildWorld({
    desks,
    header: headerWith({ desk_count: total, empty: false }),
    viewport: { width: 960, height: 560, dpr: 1 },
  });

  // The canvas leaves seats out - and says so rather than dropping them quietly.
  assert.ok(world.overflow.hidden > 0, 'the canvas cannot draw them all');
  assert.equal(world.overflow.drawn + world.overflow.hidden, total, 'the count adds up');
  assert.ok(world.overflow_label.text.length > 0, 'the canvas states what it left out');

  // The DOM list is built from `desks` itself, so it is unaffected by that cap.
  assert.equal(desks.length, total, 'every actor is still in the projection the DOM renders');
  assert.ok(APP.includes('for (const desk of desks)'), 'and the app renders all of them, uncapped');
  assert.equal(/desks\.slice\(|desks\.filter\(/.test(APP), false, 'the DOM list is never truncated or filtered');
});

// --------------------------------------------------- switching namespaces ---

test('switching mode closes the stream and resets connection, state and banner', () => {
  // The glue: one closed stream, one brand new client state, per switch.
  assert.match(APP, /function connect\(namespace\) \{\s*closeStream\(\);/, 'connecting closes the old stream first');
  assert.match(APP, /setConnectionPhase\(createClientState\(namespace\), 'connecting'/, 'and starts from scratch');
  assert.ok(APP.includes('if (source !== stream) return;'), 'late frames from the old stream are dropped');

  // The state: nothing of the old namespace survives, banner included.
  let live = setConnectionPhase(createClientState('live'), 'open', 1000);
  live = applyFrame(live, { kind: 'stream_gap', payload: { reason: 'evicted' }, at_ms: 1000 });
  live = applyFrame(live, { kind: 'fail_closed', payload: { namespace: 'live', reason: 'state_limit' }, at_ms: 1000 });
  assert.equal(selectBanner(selectHeader(live)).code, 'FAIL_CLOSED');

  const demo = setConnectionPhase(createClientState('demo'), 'connecting', 2000);
  const header = selectHeader(demo);
  assert.equal(header.mode, 'DEMO');
  assert.equal(header.halted, false, 'the halt did not follow the switch');
  assert.equal(header.gap, null, 'and neither did the gap');
  assert.deepEqual(selectDesks(demo), [], 'no desk from the other namespace survives');
  assert.equal(demo.log.length, 0, 'and no log row either');
  assert.equal(selectBanner(header).code, 'LOADING', 'the banner resets to the fresh connection');
});

// --------------------------------------------------------------- assets ---

test('the accessibility layer needs no new asset, dependency or request', () => {
  assert.deepEqual(
    [...UI_ASSET_PATHS].sort(),
    ['/', '/ui/quest-app.js', '/ui/quest-canvas.js', '/ui/quest-view.js', '/ui/quest-world.js', '/ui/quest.css'].sort(),
  );
  for (const pathname of UI_ASSET_PATHS) {
    const text = assetText(pathname);
    assert.equal(/https?:\/\//.test(text), false, `${pathname}: external URL`);
    assert.equal(/@import|url\(/.test(text), false, `${pathname}: external asset`);
  }
});
