/**
 * One status change, one announcement.
 *
 * The banner is the screen's only live region, and a live region re-announces
 * itself whenever its descendants are rewritten - even when the new text is the
 * character-for-character same one it already held. Most frames say nothing new
 * about the connection (a heartbeat, a tool call on a seat that is already
 * taken), so rewriting the banner per frame would turn a busy stream into a
 * screen reader repeating "CONNECTED" forever.
 *
 * This suite runs the shipped `quest-app.js` against the smallest DOM it can
 * work with - one that counts every `textContent` assignment - and holds the
 * rule from both sides: an unchanged status writes nothing, and a changed one
 * writes exactly once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { SanitizedEvent } from '../src/domain/event.ts';
import { toWireEvent } from '../src/domain/wire.ts';
import type { WireEvent } from '../src/domain/wire.ts';
import { makeEvent, makeIngested } from './helpers.ts';

// ------------------------------------------------------------- fake DOM ---

/** A DOM node that remembers how often it was written to, unchanged text included. */
class FakeElement {
  className: string;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  hidden = false;
  children: FakeElement[] = [];
  writes = 0;
  #text = '';

  constructor(className = '', children: FakeElement[] = []) {
    this.className = className;
    this.children = children;
  }

  get textContent(): string {
    return this.#text;
  }

  set textContent(value: string) {
    this.#text = String(value);
    this.writes += 1;
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelector(selector: string): FakeElement | null {
    const wanted = selector.replace(/^\./, '');
    return this.descendants().find((node) => node.className === wanted) ?? null;
  }

  replaceChildren(): void {
    this.children = [];
  }

  append(node: FakeElement): void {
    this.children.push(node);
  }

  addEventListener(): void {
    // The suite drives the app through the stream, never through a click.
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

/** A <template>: every clone is a fresh flat fragment with the slots the app fills. */
class FakeTemplate {
  classes: readonly string[];

  constructor(classes: readonly string[]) {
    this.classes = classes;
  }

  get content(): { cloneNode: () => FakeElement } {
    return {
      cloneNode: () => new FakeElement('fragment', this.classes.map((name) => new FakeElement(name))),
    };
  }
}

const banner = new FakeElement('banner', [
  new FakeElement('banner__symbol'),
  new FakeElement('banner__code'),
  new FakeElement('banner__message'),
]);

const elements = new Map<string, FakeElement | FakeTemplate>([
  ['banner', banner],
  [
    'desk-template',
    new FakeTemplate(['desk', 'desk__select', 'desk__badge', 'desk__seat', 'desk__agent', 'desk__symbol']),
  ],
  ['log-template', new FakeTemplate(['log__row', 'log__symbol', 'log__seq', 'log__ts', 'log__actor'])],
  ['legend-template', new FakeTemplate(['legend__row', 'legend__symbol', 'legend__label', 'legend__code'])],
]);

/** Anything else the app looks up is an ordinary element it may write to. */
function elementById(id: string): FakeElement | FakeTemplate {
  const known = elements.get(id);
  if (known !== undefined) return known;
  const made = new FakeElement(id);
  elements.set(id, made);
  return made;
}

const modeButtons = [new FakeElement('mode-button'), new FakeElement('mode-button')];
modeButtons[0]!.dataset.mode = 'live';
modeButtons[1]!.dataset.mode = 'demo';

const fakeDocument = {
  getElementById: elementById,
  querySelector: () => new FakeElement('reconnect'),
  querySelectorAll: (selector: string) => (selector === '[data-mode]' ? modeButtons : []),
};

/** The stream the app opens, held so the suite can push frames into it. */
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = FakeEventSource.OPEN;
  listeners = new Map<string, ((event: { data: string }) => void)[]>();

  constructor(_url: string) {
    opened.push(this);
  }

  addEventListener(name: string, listener: (event: { data: string }) => void): void {
    const existing = this.listeners.get(name) ?? [];
    existing.push(listener);
    this.listeners.set(name, existing);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(name: string, payload: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(payload) });
  }
}

const opened: FakeEventSource[] = [];

const fakeWindow = {
  location: { hash: '' },
  innerHeight: 800,
  devicePixelRatio: 1,
  addEventListener: () => {},
  // Nothing in this suite depends on the clock, and a live timer would keep the
  // test process alive.
  setInterval: () => 0,
};

const globals = globalThis as unknown as Record<string, unknown>;
globals.document = fakeDocument;
globals.window = fakeWindow;
globals.EventSource = FakeEventSource;

// The app is a module with side effects: importing it is what renders the page
// and opens the stream, so it is imported once, here, for the whole file.
await import(new URL('../src/ui/public/quest-app.js', import.meta.url).href);

// ---------------------------------------------------------------- driving ---

/** One of the three text slots inside the live region. */
function slot(selector: string): FakeElement {
  const found = banner.querySelector(selector);
  if (found === null) throw new Error(`the banner has no ${selector}`);
  return found;
}

const symbolSlot = slot('.banner__symbol');
const codeSlot = slot('.banner__code');
const messageSlot = slot('.banner__message');

/** The one stream importing the app opened. */
function onlyStream(): FakeEventSource {
  const [first] = opened;
  if (first === undefined || opened.length !== 1) throw new Error(`the app opened ${opened.length} streams`);
  return first;
}

const stream = onlyStream();

/** Total assignments into the live region, unchanged text included. */
function announcements(): number {
  return symbolSlot.writes + codeSlot.writes + messageSlot.writes;
}

let seq = 0;

/** One sanitized event on the wire, projected exactly as the server sends it. */
function wire(overrides: Partial<SanitizedEvent> = {}): WireEvent {
  seq += 1;
  return toWireEvent(makeIngested(makeEvent({ ts: `2026-01-01T00:00:0${seq % 10}.000Z`, ...overrides }), seq));
}

function pushEvent(overrides: Partial<SanitizedEvent> = {}): void {
  stream.emit('quest_event', wire(overrides));
}

// ----------------------------------------------------------------- rules ---

test('a stream that says nothing new about the status never rewrites the live region', () => {
  stream.emit('open', {});
  // An open stream with no seat taken yet: EMPTY.
  const afterOpen = announcements();
  assert.equal(codeSlot.textContent, 'EMPTY', 'the banner reports the empty office');

  // First actor: the office is no longer empty, so this one is a real change.
  pushEvent({ event_type: 'agent_start', agent_id: 'main', status: 'active' });
  assert.equal(codeSlot.textContent, 'CONNECTED');
  const afterFirstDesk = announcements();
  assert.ok(afterFirstDesk > afterOpen, 'a status change is written');

  // …and now the frames that change nothing: the same actor, still connected,
  // still one seat. Before the guard, each of these rewrote all three slots.
  for (let index = 0; index < 5; index += 1) {
    pushEvent({ event_type: 'heartbeat' });
    pushEvent({ event_type: 'tool_use', tool_name: 'Read', status: 'active' });
  }
  assert.equal(announcements(), afterFirstDesk, '10 frames with an unchanged status announced nothing');
  assert.equal(codeSlot.textContent, 'CONNECTED', 'and the banner still says what it should');
});

test('every real status change is still written, exactly once', () => {
  const before = announcements();

  stream.emit('stream_gap', { reason: 'evicted' });
  assert.equal(codeSlot.textContent, 'STREAM_GAP', 'the gap is reported');
  const afterGap = announcements();
  assert.equal(afterGap, before + 3, 'the three slots are written once each');

  // A frame arriving while the gap is still standing is not a second gap.
  pushEvent({ event_type: 'heartbeat' });
  assert.equal(announcements(), afterGap, 'the same gap is not re-announced');

  stream.emit('fail_closed', { namespace: 'live', reason: 'state_limit' });
  assert.equal(codeSlot.textContent, 'FAIL_CLOSED', 'the halt takes over');
  const afterHalt = announcements();
  assert.equal(afterHalt, afterGap + 3, 'and is written once');

  // The halt is sticky: later frames must not repeat it.
  pushEvent({ event_type: 'heartbeat' });
  stream.emit('fail_closed', { namespace: 'live', reason: 'state_limit' });
  assert.equal(announcements(), afterHalt, 'a repeated halt announces nothing');
});

test('skipping a write never leaves the banner stale', () => {
  // Whatever the guard skipped, what is on screen is the current status: text,
  // symbol, code and the tone attribute all agree with the last real change.
  assert.equal(codeSlot.textContent, 'FAIL_CLOSED');
  assert.equal(banner.dataset.code, 'FAIL_CLOSED', 'the attribute the stylesheet reads agrees');
  assert.equal(banner.dataset.tone, 'error');
  assert.equal(symbolSlot.textContent.length > 0, true, 'the symbol is text, not a colour');
  assert.ok(messageSlot.textContent.includes('fail-closed'), 'the message explains the halt');
});
