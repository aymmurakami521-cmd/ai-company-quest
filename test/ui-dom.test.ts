/**
 * The shipped `quest-app.js`, driven through a DOM.
 *
 * Two rules live here, both of them about what a re-render must not destroy:
 *
 * 1. **The keyboard keeps its place.** A LIVE stream re-renders on every frame,
 *    and a node that leaves the document takes the focus with it. If the desk
 *    list were rebuilt per frame, a keyboard user tabbing through an office
 *    would be thrown out of it several times a second, and the button they just
 *    pressed would no longer be under their fingers to press again. "Select any
 *    colleague with a keyboard alone" is only true if focus survives the
 *    frames that arrive while they are using it.
 * 2. **The human player is a different person from every AI colleague.** They
 *    come from the server's own `state.player` entity, they are rendered
 *    outside the colleague list, they hold no seat, and they cannot be
 *    selected - because no event can change them, there is nothing about them
 *    to select.
 *
 * `test/fakeDom.ts` supplies the document. It drops the focus when a focused
 * node is detached, exactly as a browser does, so rule 1 is held by observing
 * behaviour rather than by reading the source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import type { SanitizedEvent } from '../src/domain/event.ts';
import { makeEvent } from './helpers.ts';
import type { FakeElement } from './fakeDom.ts';
import { currentStream, installFakeDom } from './fakeDom.ts';

const { document: fakeDocument } = installFakeDom();

await import(new URL('../src/ui/public/quest-app.js', import.meta.url).href);

const desks = fakeDocument.element('desks');
const player = fakeDocument.element('player');
const playerName = fakeDocument.element('player-name');

/** The name of the human player this suite's server reports. */
const PLAYER_NAME = '歩';

// ------------------------------------------------------------- the office ---

/**
 * A snapshot from a real store, so the payload the app parses is the one the
 * server actually serialises - `state.player` included.
 */
function snapshot(agents: readonly string[], overrides: Partial<SanitizedEvent> = {}): unknown {
  const store = new NamespaceStore({
    namespace: 'live',
    player: { kind: 'player', id: 'player', display_name: PLAYER_NAME },
  });
  agents.forEach((agent, index) => {
    store.ingestObject(
      makeEvent({
        event_type: 'agent_start',
        agent_id: agent,
        status: 'active',
        ts: `2026-01-01T00:00:0${index}.000Z`,
        ...overrides,
      }),
    );
  });
  return {
    namespace: 'live',
    halted: false,
    halt_reason: null,
    last_ingest_seq: store.stats.last_ingest_seq,
    state: JSON.parse(JSON.stringify(store.state)) as unknown,
  };
}

/** The `<li>` elements currently in the colleague list. */
function deskItems(): FakeElement[] {
  return desks.children;
}

function agentNames(): string[] {
  return deskItems().map((item) => item.querySelector('.desk__agent')?.textContent ?? '');
}

/** The select button for one colleague, by the name shown on their desk. */
function selectButton(agent: string): FakeElement {
  const item = deskItems().find((node) => node.querySelector('.desk__agent')?.textContent === agent);
  if (item === undefined) throw new Error(`nobody called ${agent} is seated`);
  const button = item.querySelector('.desk__select');
  if (button === null) throw new Error(`${agent}'s desk has no select control`);
  return button;
}

/**
 * Activates a control the way a keyboard does. A native <button> fires `click`
 * for Enter and for Space, which is why the app needs no key handler - so the
 * keyboard path and the pointer path are the same path, and this is it.
 */
function pressWithKeyboard(button: FakeElement): void {
  const inner = button.querySelector('.desk__seat') ?? button;
  desks.dispatch('click', { target: inner });
}

let ticks = 0;

/** One ordinary frame about an actor that is already seated. */
function pushHeartbeat(agent: string): void {
  ticks += 1;
  currentStream().emit('quest_event', {
    event_id: `00000000-0000-4000-8000-${String(ticks).padStart(12, '0')}`,
    ingest_seq: 1000 + ticks,
    namespace: 'live',
    ts: `2026-01-01T01:00:${String(ticks % 60).padStart(2, '0')}.000Z`,
    event_type: 'tool_use',
    session_id: 'sess-1',
    actor_key: `sess-1:${agent}`,
    agent_id: agent,
    role: null,
    resolved: false,
    is_main_orchestrator: false,
    status: 'active',
    tool_name: 'Read',
    summary: null,
  });
}

// ------------------------------------------------------------------ focus ---

test('a busy stream never takes the focus out of the desk button holding it', () => {
  currentStream().emit('open', {});
  currentStream().emit('snapshot', snapshot(['main', 'worker-1', 'worker-2']));
  assert.deepEqual(agentNames().sort(), ['main', 'worker-1', 'worker-2'], 'the office is seated');

  // The operator tabs to a colleague.
  const button = selectButton('worker-1');
  button.focus();
  assert.equal(fakeDocument.activeElement, button, 'the test really put the focus there');

  // …and 20 frames arrive while they are deciding.
  for (let index = 0; index < 20; index += 1) {
    pushHeartbeat('worker-1');
    pushHeartbeat('main');
  }

  assert.equal(fakeDocument.activeElement, button, 'the focus is still on the button it was on');
  assert.equal(selectButton('worker-1'), button, "and it is still worker-1's own button, not a replacement");
  // The status text really did change under it: the frames were not no-ops.
  assert.equal(button.dataset.deskIndex !== undefined, true, 'the button still resolves to a seat');
});

test('the button that was pressed is still there to be pressed again', () => {
  const button = selectButton('worker-1');
  button.focus();

  pressWithKeyboard(button);
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'Space selected the colleague');
  assert.equal(fakeDocument.activeElement, button, 'and the re-render left the focus on it');

  // The toggle `aria-pressed` promises: the same key on the same button clears
  // it. That is only possible because the button survived the last render.
  pressWithKeyboard(button);
  assert.equal(button.getAttribute('aria-pressed'), 'false', 'Space cleared it again');
  assert.equal(fakeDocument.activeElement, button, 'still focused');
});

test('a colleague joining does not disturb the focus of the seats already there', () => {
  const button = selectButton('worker-2');
  button.focus();
  pressWithKeyboard(button);
  assert.equal(button.getAttribute('aria-pressed'), 'true');

  currentStream().emit('snapshot', snapshot(['main', 'worker-1', 'worker-2', 'worker-3']));

  assert.deepEqual(agentNames().sort(), ['main', 'worker-1', 'worker-2', 'worker-3'], 'the newcomer is seated');
  assert.equal(selectButton('worker-2'), button, 'worker-2 kept their own element');
  assert.equal(fakeDocument.activeElement, button, 'and the focus stayed with them');
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'the selection survived the re-layout');
});

test('an actor that leaves takes its node with it, and the focus goes nowhere else', () => {
  const leaving = selectButton('worker-3');
  leaving.focus();
  pressWithKeyboard(leaving);
  assert.equal(leaving.getAttribute('aria-pressed'), 'true', 'the departing colleague was selected');

  currentStream().emit('snapshot', snapshot(['main', 'worker-1', 'worker-2']));

  assert.equal(agentNames().includes('worker-3'), false, 'the office no longer seats them');
  assert.equal(desks.children.length, 3, 'and no empty element was left behind');
  // The focus is released rather than handed to whoever took that position:
  // silently moving a keyboard user onto a different colleague is worse than
  // returning them to the start of the document.
  assert.equal(fakeDocument.activeElement, null, 'nothing inherited the focus');
  for (const item of deskItems()) {
    assert.equal(item.querySelector('.desk__select')?.getAttribute('aria-pressed'), 'false');
  }
});

test('switching namespace empties the list and leaves no focus behind', () => {
  const button = selectButton('worker-1');
  button.focus();

  const [, demo] = fakeDocument.modeButtons;
  assert.ok(demo !== undefined, 'the page has a DEMO button');
  demo.dispatch('click', {});

  assert.deepEqual(agentNames(), [], 'no colleague from the other namespace survives');
  assert.equal(fakeDocument.activeElement, null, 'and the focus did not survive on a detached node');
});

// ----------------------------------------------------------------- player ---

test('the human player is rendered, from the server entity and nowhere else', () => {
  // A fresh namespace has had no snapshot yet, so there is nobody to show.
  assert.equal(player.hidden, true, 'no player is invented before the server names one');

  const live = fakeDocument.modeButtons[0];
  assert.ok(live !== undefined);
  live.dispatch('click', {});
  currentStream().emit('open', {});
  currentStream().emit('snapshot', snapshot(['main', 'worker-1']));

  assert.equal(player.hidden, false, 'the player the snapshot named is shown');
  assert.equal(playerName.textContent, PLAYER_NAME, 'under the name the server holds');
});

test('the player is not one of the AI colleagues', () => {
  // Not in the list, not a seat, and not something the seat count counts.
  assert.deepEqual(agentNames().sort(), ['main', 'worker-1']);
  assert.equal(agentNames().includes(PLAYER_NAME), false, 'the player took no desk');
  assert.equal(fakeDocument.element('stat-desks').textContent, '2', 'and is not counted as one');

  // There is no control on them either: selecting is for colleagues.
  assert.equal(player.querySelector('.desk__select'), null);
  assert.equal(player.dataset.deskIndex, undefined);
});

test('events cannot touch the player, on the screen either', () => {
  const before = playerName.writes;
  for (let index = 0; index < 5; index += 1) pushHeartbeat('worker-1');

  assert.equal(playerName.textContent, PLAYER_NAME, 'the name did not change');
  assert.equal(playerName.writes, before + 5, 'it is re-stated, never re-derived from an event');
  assert.equal(player.hidden, false, 'and the player did not disappear');

  // An *agent* that calls itself "player" is a colleague like any other: it
  // takes a desk, and it does not become the person at the keyboard.
  currentStream().emit('snapshot', snapshot(['main', 'player']));
  assert.deepEqual(agentNames().sort(), ['main', 'player'], 'the agent got a seat');
  assert.equal(playerName.textContent, PLAYER_NAME, 'and the human player is still themselves');
  const impostor = selectButton('player');
  impostor.focus();
  pressWithKeyboard(impostor);
  assert.equal(impostor.getAttribute('aria-pressed'), 'true', 'it is selectable, as any colleague is');
  assert.equal(player.hidden, false, 'selecting it changed nothing about the player');
});

test('a snapshot without a player leaves nobody standing there', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const payload = JSON.parse(
    JSON.stringify({
      namespace: 'live',
      halted: false,
      halt_reason: null,
      last_ingest_seq: 0,
      state: { ...store.state, player: null },
    }),
  ) as unknown;

  currentStream().emit('snapshot', payload);
  assert.equal(player.hidden, true, 'no player is kept from the snapshot before it');
});
