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
import { readFileSync } from 'node:fs';

import { UI_ASSET_PATHS, uiAsset } from '../src/ui/assets.ts';

import type { ActorDisplayState, ActorVisualState, Desk, Header } from '../src/ui/public/quest-view.js';
import {
  ACTOR_LEGEND_STATES,
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
  // The app only ever reaches a control through these selectors - directly, or
  // through `closest` when one listener serves a whole list.
  const bound = [...APP.matchAll(/(?:querySelectorAll|querySelector|closest)\('([^']+)'\)/g)]
    .map((match) => match[1] ?? '')
    .filter((selector) => selector.startsWith('[data-'));
  assert.deepEqual(bound.sort(), ['[data-action="reconnect"]', '[data-action="select-desk"]', '[data-mode]']);

  // …and in the page those are <button>s, which are focusable and fire on both
  // Enter and Space without any key handler of our own.
  for (const marker of ['data-mode="live"', 'data-mode="demo"', 'data-action="reconnect"', 'data-action="select-desk"']) {
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

test('every colleague can be selected with a keyboard alone', () => {
  // The control is a real <button> inside the desk heading, so Tab reaches one
  // per seat and Enter/Space activate it. Nothing custom, nothing pointer-only.
  const line = HTML.split('\n').find((row) => row.includes('class="desk__select"'));
  assert.ok(line !== undefined, 'the desk template has a select control');
  assert.ok(String(line).includes('<button'), 'and it is a <button>');
  assert.ok(String(line).includes('type="button"'), 'an explicit one');
  assert.ok(String(line).includes('aria-pressed'), 'that publishes its selected state');
  assert.equal(/class="desk__select"[^>]*tabindex=/.test(HTML), false, 'and does not reorder the tab stops');

  // Selection is state, not styling: the stylesheet reads it, and the app keeps
  // both the attribute and `aria-pressed` in step with the same projection.
  assert.match(CSS, /\.desk\[data-selected='true'\]/, 'the selected desk is styled from that state');
  assert.ok(APP.includes("select.setAttribute('aria-pressed', String(desk.selected))"));
  assert.ok(APP.includes("item.dataset.selected = String(desk.selected)"));

  // The list has one delegated `click` listener, which a <button> also fires for
  // Enter and Space - so there is still no key handler and no focus stealing.
  assert.match(APP, /dom\.desks\.addEventListener\('click'/, 'the list handles activation');
  assert.equal(/addEventListener\('key(down|up|press)'/.test(APP), false, 'no key handler of our own');
});

test('a re-render never takes the focus out of the desk button holding it', () => {
  // The behaviour is held end-to-end in `test/ui-dom.test.ts`, against a DOM
  // that drops the focus when a focused node is detached. What belongs here is
  // the *shape* that makes it possible, so a future edit cannot quietly go back
  // to rebuilding the list on every frame.
  assert.equal(/dom\.desks\.replaceChildren\(/.test(APP), false, 'the colleague list is never rebuilt wholesale');
  assert.ok(APP.includes('renderedNodes.get(desk.actor_key)'), 'each colleague keeps their own element');
  assert.ok(APP.includes('if (current !== node.item)'), 'and it is moved only when it is in the wrong place');

  // Focus is *kept*, never taken: the app still moves nobody's focus anywhere.
  assert.equal(APP.includes('.focus()'), false, 'the script never calls focus');
  assert.equal(/activeElement/.test(APP), false, 'and never reads who has it');

  // A colleague who left takes their element with them, so no stale node can
  // hold the focus or be pressed for somebody who is no longer seated.
  assert.ok(APP.includes('if (!next.has(key)) node.item.remove()'), 'departed colleagues are removed');
});

test('reusing a desk element still keeps wire identifiers out of the DOM', () => {
  // The element is looked up by `actor_key` through a Map held in the module -
  // the key itself never becomes an attribute a page inspector or a selector
  // could read it out of.
  assert.equal(/dataset\.\w+ = desk\.(actor_key|session_id|display_name)/.test(APP), false);
  assert.equal(/setAttribute\([^)]*desk\.(actor_key|session_id|display_name)/.test(APP), false);
  assert.ok(APP.includes('renderedDesks[Number(button.dataset.deskIndex)]'), 'selection still resolves by position');
});

test('the human player is shown, and is not something to operate', () => {
  const block = /<div class="player" id="player" hidden>[\s\S]*?<\/p>\s*<\/div>/.exec(HTML);
  assert.ok(block !== null, 'the page has a player region');
  const markup = String(block[0]);

  // Nothing to focus and nothing to press: the player is a fact, not a control.
  assert.equal(/<button|tabindex|data-action|aria-pressed/.test(markup), false, 'no control on the player');
  // …and they are outside the colleague list, so tabbing through seats never
  // lands on them and the list's accessible name stays honest.
  assert.ok(HTML.indexOf(markup) < HTML.indexOf('<ul class="desks"'), 'the player comes before the list');
  assert.equal(markup.includes('<ul'), false, 'and is not inside it');

  // Their name is written as text, like every other name on this screen.
  assert.ok(APP.includes('dom.playerName.textContent = player.display_name'));
  assert.equal(/playerName\.(innerHTML|outerHTML|insertAdjacentHTML)/.test(APP), false);
  // Hidden until the server names one, and the stylesheet honours that.
  assert.ok(APP.includes('dom.player.hidden = player === null'));
  assert.match(CSS, /\.player\[hidden\]\s*\{\s*display:\s*none/, 'the hidden attribute is not defeated by the layout');
  // The badge is decoration next to the name, so it is readable as text.
  assert.ok(markup.includes('class="player__badge"'));
});

test('the canvas is never the thing being operated', () => {
  // Condition: the DOM accessibility layer is the record of truth for input. The
  // canvas is `aria-hidden` decoration, so nothing may be bound to it and it may
  // not be hit-tested - either would put a fact behind a surface a screen reader
  // and a keyboard cannot reach.
  for (const target of ['dom.canvas', 'dom.canvasFrame']) {
    assert.equal(APP.includes(`${target}.addEventListener`), false, `${target} has no listener`);
  }
  assert.equal(
    /getBoundingClientRect|\.(clientX|clientY|offsetX|offsetY|pageX|pageY)\b/.test(APP),
    false,
    'nothing translates a pointer position into a seat',
  );
  // The selected seat is resolved from the rendered projection, never from a
  // coordinate and never from a wire string smuggled into an attribute.
  assert.ok(APP.includes('renderedDesks[Number(button.dataset.deskIndex)]'), 'selection resolves via the projection');
  assert.equal(/dataset\.\w+ = desk\.(actor_key|session_id|display_name)/.test(APP), false, 'no wire string in an attribute');
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
    selected: false,
    visual: visualForState('idle'),
    stale: false,
    last_known_visual: visualForState('idle'),
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
  assert.ok(APP.includes('desks.forEach((desk, index)'), 'and the app renders all of them, uncapped');
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

test('every displayable state has its own colour rule, in the CSS that ships', () => {
  // The desk and legend fall back to the idle colour for a state with no rule of
  // its own. That fallback is silent, so a state added to the vocabulary without
  // a matching rule would render as a plausible wrong colour rather than fail.
  for (const state of ACTOR_LEGEND_STATES) {
    assert.ok(
      CSS.includes(`--state-${state}:`),
      `quest.css defines a --state-${state} token`,
    );
    assert.ok(
      CSS.includes(`.desk[data-state='${state}']`),
      `quest.css binds the desk colour for ${state}`,
    );
    assert.ok(
      CSS.includes(`.legend__row[data-state='${state}']`),
      `quest.css binds the legend swatch for ${state}`,
    );
  }
});

test('every desk slot the app fills exists in the shipped template and in the fake DOM', () => {
  // Three copies of the same list have to agree: the <template> the browser
  // clones, the selectors `quest-app.js` fills, and the slots `test/fakeDom.ts`
  // provides. A slot missing from the page makes `querySelector` return null and
  // the desk list stop rendering; one missing from the fake DOM makes the
  // focus-retention suite blind. Both have happened, so both are pinned here.
  const fake = readFileSync(new URL('./fakeDom.ts', import.meta.url), 'utf8');
  const filled = new Set(
    [...APP.matchAll(/'(\.desk__[a-z-]+)'/g)].map((match) => (match[1] as string).slice(1)),
  );
  assert.ok(filled.size >= 8, 'the selectors were actually found in the app');
  for (const slot of filled) {
    assert.ok(HTML.includes(`class="${slot}"`), `index.html has a .${slot} element`);
    assert.ok(fake.includes(`'${slot}'`), `test/fakeDom.ts provides a .${slot} slot`);
  }
});

test('a frozen desk keeps what was last observed, in text', () => {
  // The freeze must be readable without the palette: the state itself says
  // 状態不明 and this line names what it was, so nothing is silently dropped.
  assert.ok(HTML.includes('class="desk__frozen"'), 'the template carries the frozen line');
  assert.ok(HTML.includes('凍結'), 'and labels it in text, not by colour');
  assert.ok(APP.includes('停止時点'), 'the app names the last observed state');
  assert.ok(APP.includes('frozen.hidden = !desk.stale'), 'and shows it only while stale');
});

test('the detail panel is named, referenced, and not a second live region', () => {
  assert.ok(HTML.includes('id="detail-panel"'), 'the panel exists');
  assert.ok(HTML.includes('id="detail-heading"'), 'and has a heading');
  assert.ok(
    HTML.includes('aria-labelledby="detail-heading"'),
    'the region is named by that heading',
  );
  assert.ok(
    HTML.includes('aria-controls="detail-panel"'),
    'the desk select button says what it controls',
  );

  // Selecting a colleague must not interrupt a screen reader mid-sentence, so
  // the banner stays the only live region on the page.
  const liveRegions = HTML.match(/aria-live=/g) ?? [];
  assert.equal(liveRegions.length, 1, 'exactly one live region on the page');
  const statuses = HTML.match(/role="status"/g) ?? [];
  assert.equal(statuses.length, 1, 'and exactly one role="status"');
});

test('the detail panel opens no request and injects no markup', () => {
  // Selection stays a screen-local fact: it must not become a fetch, and stream
  // text must not become HTML.
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(APP), false, 'nothing becomes markup');
  assert.equal(/fetch\(|XMLHttpRequest|\.src\s*=/.test(APP), false, 'the app opens no new request');
});

test('the detail panel says what the contract cannot supply', () => {
  // A blank row reads as "there was none of that". These rows say something
  // different and more accurate: this stream does not carry it.
  assert.ok(APP.includes('NOT_REPORTED'), 'unreported facts are labelled');
  assert.ok(APP.includes('NO_EVIDENCE_IN_CONTRACT'), 'and missing evidence is explained');
  assert.ok(HTML.includes('担当タスク'), 'the task row exists');
  assert.ok(HTML.includes('最新の概要'), 'and is a different row from the event summary');
});
