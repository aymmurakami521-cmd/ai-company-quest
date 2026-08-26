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
 * work with - `test/fakeDom.ts`, which counts every `textContent` assignment -
 * and holds the rule from both sides: an unchanged status writes nothing, and a
 * changed one writes exactly once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { SanitizedEvent } from '../src/domain/event.ts';
import { toWireEvent } from '../src/domain/wire.ts';
import type { WireEvent } from '../src/domain/wire.ts';
import { makeEvent, makeIngested } from './helpers.ts';
import type { FakeElement } from './fakeDom.ts';
import { installFakeDom, onlyStream } from './fakeDom.ts';

const { document: fakeDocument } = installFakeDom();

// The app is a module with side effects: importing it is what renders the page
// and opens the stream, so it is imported once, here, for the whole file.
await import(new URL('../src/ui/public/quest-app.js', import.meta.url).href);

// ---------------------------------------------------------------- driving ---

const banner = fakeDocument.element('banner');

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
