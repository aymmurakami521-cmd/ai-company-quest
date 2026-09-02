/**
 * The shipped `quest-ark-app.js`, driven through a DOM.
 *
 * Four rules live here, all of them things an owner would be misled by if they
 * broke:
 *
 * 1. **Need You is on the screen and is loud.** It renders first, it carries a
 *    word for its level, and the count is repeated in the top bar.
 * 2. **A disconnection empties 実行中.** No row may keep reading as work while
 *    nothing is confirming it, and the last observation is shown as such. A
 *    socket that merely reopens is not yet something confirming it: the freeze
 *    stands until a recovery frame re-states the office.
 * 3. **The console stays compact.** Only the first `ARK_SUMMARY_ROWS` rows are in
 *    a panel's main list; the rest is behind a drawer, so a large office does
 *    not turn the screen back into a long diagnostic page.
 * 4. **The command surface cannot send.** It builds a payload, the button stays
 *    disabled, and the app opens no request other than the one documented SSE
 *    stream.
 *
 * `test/fakeArkDom.ts` supplies the document.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NamespaceStore } from '../src/collector/store.ts';
import type { SanitizedEvent } from '../src/domain/event.ts';
import { UI_ASSET_PATHS, uiAsset } from '../src/ui/assets.ts';
import { toWireEvent } from '../src/domain/wire.ts';
import { makeEvent, makeIngested } from './helpers.ts';
import type { FakeElement } from './fakeDom.ts';
import { FakeEventSource, currentStream, installFakeArkDom } from './fakeArkDom.ts';
import { ARK_SUMMARY_ROWS } from '../src/ui/public/quest-ark.js';

const { document: fakeDocument } = installFakeArkDom();

await import(new URL('../src/ui/public/quest-ark-app.js', import.meta.url).href);

function assetText(pathname: string): string {
  const asset = uiAsset(pathname);
  assert.ok(asset !== null, `${pathname} is served`);
  return asset.body.toString('utf8');
}

const HTML = assetText('/ark');
const APP = assetText('/ui/quest-ark-app.js');
const CSS = assetText('/ui/quest-ark.css');

/** A snapshot from a real store, so the payload the app parses is the real one. */
function snapshot(events: readonly Partial<SanitizedEvent>[]): unknown {
  const store = new NamespaceStore({ namespace: 'live' });
  events.forEach((overrides, index) => {
    store.ingestObject(
      makeEvent({
        ts: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        ...overrides,
      } satisfies Partial<SanitizedEvent>),
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

/** Opens a fresh stream and puts the office these events describe on the screen. */
function showEvents(events: readonly Partial<SanitizedEvent>[]): void {
  fakeDocument.control('[data-action="reconnect"]').dispatch('click', {});
  const stream = currentStream();
  stream.emit('open', {});
  stream.emit('snapshot', snapshot(events));
}

/** The common case: one colleague per status label, all of them started. */
function show(statuses: Record<string, string>): void {
  showEvents(
    Object.entries(statuses).map(([agent, status]) => ({
      event_type: 'agent_start' as const,
      agent_id: agent,
      status,
    })),
  );
}

/** Stops the stream from confirming anything, without changing what it said. */
function disconnect(): void {
  currentStream().emit('error', {});
}

/**
 * The reconnect `EventSource` performs on its own, in the order a browser
 * delivers it: the socket drops while still retrying, and then reports `open` -
 * before any of the replay, gap or snapshot frames the server queues behind it.
 */
function reconnect(): void {
  const stream = currentStream();
  stream.readyState = FakeEventSource.CONNECTING;
  stream.emit('error', {});
  stream.readyState = FakeEventSource.OPEN;
  stream.emit('open', {});
}

let pushed = 0;

/**
 * One ordinary frame on the live stream, about a colleague already seated.
 *
 * The server can only have written this *after* the synchronous block that
 * carries a replay and any halt queued behind it, so on the wire it is proof
 * that no halt was queued - which is the only thing that may lift a recovery a
 * `replay_end` could not settle.
 */
function pushEvent(overrides: Partial<SanitizedEvent> = {}): void {
  pushed += 1;
  currentStream().emit(
    'quest_event',
    toWireEvent(
      makeIngested(
        makeEvent({ ts: `2026-01-01T01:00:${String(pushed % 60).padStart(2, '0')}.000Z`, ...overrides }),
        10_000 + pushed,
      ),
    ),
  );
}

/**
 * Yields to the macrotask queue, so a test can show that nothing the console
 * does on a timer hands the office back. Nothing here is waiting *for* the
 * console: `quest-ark-app.js` has no clock that decides anything, and these
 * assertions are what holds it to that.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function rowsIn(id: string): FakeElement[] {
  return fakeDocument.element(id).children;
}

function textIn(node: FakeElement, selector: string): string {
  return node.querySelector(selector)?.textContent ?? '';
}

function tags(id: string): string[] {
  return rowsIn(id).map((row) => row.dataset.tag ?? '');
}

function countFor(id: string, code: string): string {
  const row = fakeDocument.element(id).children.find((node) => node.dataset.code === code);
  return row === undefined ? '' : textIn(row, '.ark-count__value');
}

// ------------------------------------------------------------- Need You ---

test('Need You renders every packet, loudest first, in words', () => {
  show({ ann: 'awaiting_approval', bob: 'failed', cy: 'running' });

  const items = rowsIn('ark-need-list');
  assert.equal(items.length, 2, 'the working colleague asks for nothing');
  assert.deepEqual(
    items.map((item) => item.dataset.reason),
    ['AWAITING_APPROVAL', 'RUN_ERROR'],
  );
  // The level is a word, the state is a word, the symbol is a character. None
  // of the three is a colour.
  assert.equal(textIn(items[0] as FakeElement, '.ark-need-item__level'), '要対応');
  assert.equal(textIn(items[1] as FakeElement, '.ark-need-item__level'), '要確認');
  assert.ok(textIn(items[0] as FakeElement, '.ark-need-item__symbol').length > 0);
  assert.ok(textIn(items[0] as FakeElement, '.ark-need-item__state').includes('承認待ち'));

  // The decision itself, not just a request to approve.
  assert.ok(textIn(items[0] as FakeElement, '.ark-need-item__recommended').length > 0);
  assert.ok(textIn(items[0] as FakeElement, '.ark-need-item__options').includes('/'));
  assert.ok(textIn(items[0] as FakeElement, '.ark-need-item__inaction').length > 0);

  assert.equal(fakeDocument.element('ark-need-empty').hidden, true);
  assert.equal(fakeDocument.element('ark-need-count').textContent, '2');
  assert.equal(fakeDocument.element('ark-need-count').dataset.required, 'true');
  // Repeated in the top bar, so it is readable before the panel is looked at.
  assert.equal(fakeDocument.element('ark-attention-count').textContent, '2');
});

test('an office with nothing to decide says so instead of showing an empty list', () => {
  show({ ann: 'running' });
  assert.deepEqual(rowsIn('ark-need-list'), []);
  assert.equal(fakeDocument.element('ark-need-empty').hidden, false);
  assert.equal(fakeDocument.element('ark-need-count').textContent, '0');
  assert.equal(fakeDocument.element('ark-need-count').dataset.required, 'false');
});

// -------------------------------------------------------- unknown state ---

test('a disconnection empties 実行中 and never leaves a row reading as work', () => {
  show({ ann: 'running', bob: 'running', cy: 'failed' });
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '2', 'while the stream was confirming');

  disconnect();

  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0');
  assert.equal(countFor('ark-now-counts', 'UNKNOWN'), '3');
  assert.deepEqual(tags('ark-now-list'), ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  for (const row of rowsIn('ark-now-list')) {
    assert.equal(row.dataset.confirmed, 'false');
    // The freeze is readable without the palette, and it names what was last
    // observed rather than dropping it.
    const frozen = row.querySelector('.ark-row__frozen');
    assert.equal(frozen?.hidden, false);
    assert.ok((frozen?.textContent ?? '').includes('停止時点'));
  }
  const unconfirmed = fakeDocument.element('ark-now-unconfirmed');
  assert.equal(unconfirmed.hidden, false);
  assert.ok(unconfirmed.textContent.includes('状態不明'));
});

test('a stream gap empties 実行中 too, while the screen reports the recovery', () => {
  show({ ann: 'running', bob: 'running' });
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '2');

  // The socket stays open through this: the office's own `stale` rule does not
  // fire, so without the console's own check these rows would keep reading as
  // 実行中・確認済み underneath a banner that says frames are missing.
  currentStream().emit('stream_gap', { reason: 'evicted' });

  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'STREAM_GAP');
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0');
  assert.equal(countFor('ark-now-counts', 'UNKNOWN'), '2');
  assert.deepEqual(tags('ark-now-list'), ['UNKNOWN', 'UNKNOWN']);
  for (const row of rowsIn('ark-now-list')) assert.equal(row.dataset.confirmed, 'false');
  assert.equal(fakeDocument.element('ark-now-unconfirmed').hidden, false);
  // And Need You says why, so the frozen rows are not left unexplained.
  assert.ok(
    rowsIn('ark-need-list').some((item) => item.dataset.reason === 'STREAM_UNCONFIRMED'),
  );

  // The recovery snapshot is what hands the office back.
  currentStream().emit('snapshot', snapshot([
    { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
    { event_type: 'agent_start', agent_id: 'bob', status: 'running' },
  ]));
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '2', 'and only then');
});

test('a replay in progress is not rendered as a confirmed office either', () => {
  show({ ann: 'running' });
  currentStream().emit('replay_start', {});

  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'REPLAYING');
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0');
  assert.deepEqual(tags('ark-now-list'), ['UNKNOWN']);
});

test('a reconnected socket is not a live office until a recovery frame says so', () => {
  show({ ann: 'running', bob: 'running' });
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '2');

  // The browser's own reconnect, in the order it actually happens: `open` is
  // delivered before the queued replay/gap/snapshot. Without the console's own
  // gate, this one line handed both desks back as confirmed 実行中 - on nothing
  // more than the transport being up.
  reconnect();

  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'RECONNECTING');
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0');
  assert.equal(countFor('ark-now-counts', 'UNKNOWN'), '2');
  assert.deepEqual(tags('ark-now-list'), ['UNKNOWN', 'UNKNOWN']);
  for (const row of rowsIn('ark-now-list')) assert.equal(row.dataset.confirmed, 'false');
  // Nothing follows the open - the stalled case, which is the one a freeze that
  // lifts on `open` alone would leave reading as work indefinitely.
  assert.equal(fakeDocument.element('ark-now-unconfirmed').hidden, false);
  assert.ok(rowsIn('ark-need-list').some((item) => item.dataset.reason === 'STREAM_UNCONFIRMED'));

  // The snapshot re-states the office, and that is what hands it back.
  currentStream().emit('snapshot', snapshot([
    { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
    { event_type: 'agent_start', agent_id: 'bob', status: 'running' },
  ]));
  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'CONNECTED');
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '2', 'and only then');
  for (const row of rowsIn('ark-now-list')) assert.equal(row.dataset.confirmed, 'true');
});

test('a replay served over a reconnect is confirmed by the stream, not by its end', async () => {
  show({ ann: 'running' });
  reconnect();
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0');

  currentStream().emit('replay_start', { count: 0 });
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0', 'a replay beginning establishes nothing');
  assert.deepEqual(tags('ark-now-list'), ['UNKNOWN']);

  // Nor does its end: the server can still have a `fail_closed` queued behind it,
  // in the same write, and the browser has not delivered it yet.
  currentStream().emit('replay_end', { count: 0 });
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0', 'not while the burst may continue');
  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'RECONNECTING');

  // Time is not what settles it, and this is the assertion that says so: the
  // console used to lift the freeze on a zero-delay timer, which is a guess that
  // the halt is already in the browser's queue rather than in a later read.
  await tick();
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0', 'and waiting proves nothing');
  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'RECONNECTING');

  // A frame the server could only have written after that block is what proves
  // no halt was queued - and it is the office being confirmed, not the clock.
  pushEvent({ event_type: 'tool_use', agent_id: 'ann', status: 'running', tool_name: 'Read' });
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '1', 'the live stream is the recovery');
  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'CONNECTED');
  for (const row of rowsIn('ark-now-list')) assert.equal(row.dataset.confirmed, 'true');
});

test('a replay that is followed by nothing is not an office anybody is confirming', async () => {
  // The halted namespace and the quiet one are the same silence, and no amount
  // of waiting tells them apart. So the console holds 状態不明 and says why,
  // rather than reading the retained desks back as work on the strength of a
  // timer having fired.
  show({ ann: 'running', bob: 'running' });
  reconnect();

  const stream = currentStream();
  stream.emit('replay_start', { count: 0 });
  stream.emit('replay_end', { count: 0 });

  for (let turn = 0; turn < 3; turn += 1) await tick();

  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'RECONNECTING');
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0');
  assert.equal(countFor('ark-now-counts', 'UNKNOWN'), '2');
  for (const row of rowsIn('ark-now-list')) assert.equal(row.dataset.confirmed, 'false');
  // And it is explained rather than left as a silent freeze: the item names the
  // state and offers 再接続, which rebuilds from a snapshot and settles it.
  assert.ok(rowsIn('ark-need-list').some((item) => item.dataset.reason === 'STREAM_UNCONFIRMED'));
  assert.equal(fakeDocument.element('ark-now-unconfirmed').hidden, false);
});

test('a halt queued behind a replay is never one frame of confirmed work', async () => {
  show({ ann: 'running', bob: 'running' });
  reconnect();

  // Exactly what `server.ts:326-337` writes when a valid `Last-Event-ID` replay
  // meets a namespace that halted while this client was away: `replay_start`,
  // the replayed events, `replay_end`, and only then the halt notice - the whole
  // burst in one write, delivered to the page as separate events.
  const stream = currentStream();
  stream.emit('replay_start', { count: 0 });
  stream.emit('replay_end', { count: 0 });
  // The frame the console used to render as 実行中・確認済み, on a namespace that
  // had already stopped ingesting.
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0');
  assert.equal(countFor('ark-now-counts', 'UNKNOWN'), '2');
  for (const row of rowsIn('ark-now-list')) assert.equal(row.dataset.confirmed, 'false');

  // The halt in a later network read, which is the case a zero-delay timer got
  // wrong: the timer would already have run, and the console would already have
  // claimed the office was being confirmed.
  await tick();
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0', 'still nothing confirmed');

  stream.emit('fail_closed', {
    namespace: 'live',
    halted: true,
    reason: 'collector_stopped',
    detail: null,
  });
  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'FAIL_CLOSED');
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0');

  // A halt is sticky and outranks every phase, so nothing after it hands the
  // office back either.
  await tick();
  pushEvent({ event_type: 'tool_use', agent_id: 'ann', status: 'running', tool_name: 'Read' });
  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'FAIL_CLOSED');
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0');
  assert.deepEqual(tags('ark-now-list'), ['UNKNOWN', 'UNKNOWN']);
  assert.ok(rowsIn('ark-need-list').some((item) => item.dataset.reason === 'INGEST_HALTED'));
});

test('a replay left unsettled by one socket does not confirm the burst of the next', async () => {
  // The bookkeeping holds a reconnect open across exactly one burst, so it may
  // not be left standing into another: the first frame of the *next* reconnect
  // is a `replay_start`, and a stale hold would have read that as the proof it
  // was waiting for and handed the office back mid-recovery.
  show({ ann: 'running', bob: 'running' });
  reconnect();
  currentStream().emit('replay_start', { count: 0 });
  currentStream().emit('replay_end', { count: 0 });
  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'RECONNECTING');

  // The socket drops again before anything else arrived, and comes back.
  reconnect();
  currentStream().emit('replay_start', { count: 0 });
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0', 'a replay beginning is not an answer');
  // Still the reconnect the console is holding, which outranks the replay it is
  // being served; either way the code is one nothing may be confirmed under.
  assert.equal(fakeDocument.element('ark-banner').dataset.code, 'RECONNECTING');
  for (const row of rowsIn('ark-now-list')) assert.equal(row.dataset.confirmed, 'false');

  currentStream().emit('replay_end', { count: 0 });
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '0');
  pushEvent({ event_type: 'tool_use', agent_id: 'ann', status: 'running', tool_name: 'Read' });
  assert.equal(countFor('ark-now-counts', 'EXECUTING'), '2', 'and only the stream itself is');
});

test('a disconnection is one Need You item, and does not hide the approval wait', () => {
  show({ ann: 'awaiting_approval', bob: 'running' });
  disconnect();

  const items = rowsIn('ark-need-list');
  assert.deepEqual(
    items.map((item) => item.dataset.reason),
    ['AWAITING_APPROVAL', 'STREAM_UNCONFIRMED'],
  );
  const approval = items[0] as FakeElement;
  assert.equal(approval.dataset.confirmed, 'false');
  const unconfirmed = approval.querySelector('.ark-need-item__unconfirmed');
  assert.equal(unconfirmed?.hidden, false);
  assert.ok((unconfirmed?.textContent ?? '').includes('停止時点'));
});

// -------------------------------------------------------- compact layout ---

test('a large office stays compact: the overflow goes into a drawer', () => {
  const statuses: Record<string, string> = {};
  for (let i = 0; i < ARK_SUMMARY_ROWS + 3; i += 1) statuses[`agent-${i}`] = 'running';
  show(statuses);

  assert.equal(rowsIn('ark-now-list').length, ARK_SUMMARY_ROWS, 'the panel shows a fixed few');
  assert.equal(rowsIn('ark-now-more').length, 3, 'and the rest is still reachable');
  assert.equal(fakeDocument.element('ark-now-drawer').hidden, false);

  // A small office has no drawer at all: an empty control is noise.
  show({ ann: 'running' });
  assert.equal(rowsIn('ark-now-list').length, 1);
  assert.equal(rowsIn('ark-now-more').length, 0);
  assert.equal(fakeDocument.element('ark-now-drawer').hidden, true);
});

test('the deep detail is in drawers, not stacked down the page', () => {
  // Every per-colleague and per-outcome detail surface is a <details>, so the
  // default screen is the summary and the diagnostics are one click away.
  assert.ok(HTML.includes('<details class="ark-drawer" id="ark-now-drawer"'), 'Now overflow');
  assert.ok(HTML.includes('id="ark-outcome-drawer"'), 'Outcome overflow');
  assert.ok(HTML.includes('class="ark-drawer ark-drawer--inline ark-row__evidence"'), 'row evidence');
  assert.ok(HTML.includes('id="ark-next-fields"'), 'the contract fields');

  // Need You is first in the document and first in the layout at both widths.
  assert.ok(HTML.indexOf('id="ark-need"') < HTML.indexOf('id="ark-now"'));
  assert.ok(HTML.indexOf('id="ark-now"') < HTML.indexOf('id="ark-command"'));
  const areas = [...CSS.matchAll(/grid-template-areas:\s*([^;]+);/g)].map((match) => match[1] ?? '');
  assert.ok(areas.length >= 2, 'a wide layout and a narrow one');
  for (const area of areas) {
    assert.ok(area.trimStart().startsWith("'need"), `Need You is the first row: ${area.trim()}`);
  }
  // The console owns the viewport at laptop width; the panels scroll inside it.
  assert.ok(CSS.includes('height: 100vh'), 'the page itself does not grow');
  assert.ok(CSS.includes('@media (max-width: 900px)'), 'and collapses to one column');
});

// ------------------------------------------------------------- evidence ---

test('an outcome carries evidence that can actually be reached', () => {
  showEvents([
    { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
    // Its own stop report, which is what 完了 takes.
    { event_type: 'agent_stop', agent_id: 'ann', status: 'completed' },
    { event_type: 'agent_start', agent_id: 'bob', status: 'failed' },
  ]);

  const rows = rowsIn('ark-outcome-list');
  assert.deepEqual(tags('ark-outcome-list'), ['FAILED', 'COMPLETED']);
  const failed = rows[0] as FakeElement;
  assert.equal(textIn(failed, '.ark-row__tag'), '失敗', 'the result is a word');
  assert.ok(textIn(failed, '.ark-row__note').includes('未解決'), 'and names what is still open');

  const drawer = failed.querySelector('.ark-row__evidence');
  assert.equal(drawer?.hidden, false, 'the evidence drawer is present');
  const trace = failed.querySelector('.ark-evidence');
  assert.ok((trace?.children.length ?? 0) >= 4, 'with rows off the stream');
  assert.ok(
    trace?.children.some((row) => row.querySelector('.ark-evidence__label')?.textContent === 'session'),
    'including the run itself',
  );
  // And the kind of evidence the contract has none of is stated, not left blank.
  assert.ok(textIn(failed, '.ark-row__artifacts').length > 0);
  assert.ok(fakeDocument.element('ark-outcome-artifacts').textContent.length > 0);
});

test('Next shows no plan it was never told, and says why', () => {
  show({ ann: 'planning', bob: 'running' });

  const rows = rowsIn('ark-next-list');
  assert.equal(rows.length, 1);
  assert.equal(textIn(rows[0] as FakeElement, '.ark-row__tag'), '計画中');
  assert.ok(textIn(rows[0] as FakeElement, '.ark-row__note').includes('報告されていません'));
  assert.ok(fakeDocument.element('ark-next-note').textContent.includes('Delegation Contract'));
  const fields = fakeDocument.element('ark-next-fields').children;
  assert.ok(fields.length >= 5, 'the shape of what is missing is visible');
  for (const field of fields) {
    assert.ok(textIn(field, '.ark-field__value').includes('ありません'));
  }
});

// ------------------------------------------------------ command surface ---

test('the command field builds a payload and states that nothing sent it', () => {
  show({ ann: 'running' });
  const input = fakeDocument.element('ark-command-input') as unknown as { value: string };
  input.value = 'ARKのNeed You画面をスマホで見やすくして';
  fakeDocument.element('ark-command-input').dispatch('input', {});

  const preview = fakeDocument.element('ark-command-preview').textContent;
  const payload = JSON.parse(preview) as Record<string, unknown>;
  assert.equal(payload.kind, 'owner_task_delegation');
  assert.equal(payload.namespace, 'live');
  assert.equal(payload.intent, 'ARKのNeed You画面をスマホで見やすくして');
  // The payload says it itself, so it cannot be mistaken for a dispatched task
  // if it is ever copied out of this screen.
  assert.equal(payload.dispatch, 'none');

  const notice = fakeDocument.element('ark-command-submission');
  assert.ok(notice.textContent.startsWith('NOT_CONNECTED'));
  assert.equal(notice.dataset.available, 'false');
  const submit = fakeDocument.element('ark-command-submit') as unknown as { disabled: boolean };
  assert.equal(submit.disabled, true, 'the send control never becomes available');
  assert.equal(
    fakeDocument.element('ark-command-submit').getAttribute('aria-disabled'),
    'true',
  );
});

test('a refused draft says so and builds nothing', () => {
  const input = fakeDocument.element('ark-command-input') as unknown as { value: string };
  input.value = '   ';
  fakeDocument.element('ark-command-input').dispatch('input', {});
  assert.equal(fakeDocument.element('ark-command-status').dataset.status, 'empty');
  assert.equal(fakeDocument.element('ark-command-preview').textContent.includes('{'), false);

  input.value = 'あ'.repeat(500);
  fakeDocument.control('[data-action="build-command"]').dispatch('click', {});
  assert.equal(fakeDocument.element('ark-command-status').dataset.status, 'rejected');
  assert.equal(fakeDocument.element('ark-command-preview').textContent.includes('{'), false);
});

test('pressing 組み立てる opens no stream and no other request', () => {
  const before = currentStream();
  fakeDocument.control('[data-action="build-command"]').dispatch('click', {});
  assert.equal(currentStream(), before, 'building a draft is a screen-local act');

  // The whole file, held to the same rule the office screen is held to.
  assert.equal(/fetch\(|XMLHttpRequest|sendBeacon|\.src\s*=/.test(APP), false, 'no request');
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(APP), false, 'nothing becomes markup');
  assert.equal(/new EventSource\(/.test(APP), true, 'the one stream it does open');
  assert.equal((APP.match(/new EventSource\(/g) ?? []).length, 1, 'and only one place opens it');
});

// --------------------------------------------------------------- assets ---

test('the console requests nothing the asset table does not serve', () => {
  assert.ok(HTML.includes('rel="icon"'));
  const refs = [...HTML.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1] as string);
  for (const ref of refs) {
    if (ref.startsWith('data:') || ref.startsWith('#')) continue;
    assert.ok(UI_ASSET_PATHS.includes(ref), `${ref} is served by the asset table`);
  }
});

test('the console has exactly one live region, as the office screen does', () => {
  // Need You changes on a busy stream. If the panel were a live region too, a
  // screen reader would be interrupted mid-sentence by every frame.
  assert.equal((HTML.match(/aria-live=/g) ?? []).length, 1);
  assert.equal((HTML.match(/role="status"/g) ?? []).length, 1);
  assert.ok(HTML.includes('id="ark-banner"'), 'and it is the banner');
});

test('every slot the console fills exists in the page and in the fake DOM', () => {
  // Three copies of the same list have to agree: the <template> the browser
  // clones, the selectors `quest-ark-app.js` fills, and the slots
  // `test/fakeArkDom.ts` provides. A slot missing from the page makes
  // `querySelector` return null and the panel stop rendering; one missing from
  // the fake makes this suite blind.
  const fake = readFileSync(new URL('./fakeArkDom.ts', import.meta.url), 'utf8');
  const filled = new Set(
    [...APP.matchAll(/'\.(ark-(?:row|need-item|evidence|count|field)__[a-z-]+)'/g)].map(
      (match) => match[1] as string,
    ),
  );
  assert.ok(filled.size >= 10, 'the selectors were actually found in the app');
  for (const slot of filled) {
    // A slot may share its element with layout classes, so the class list is
    // matched rather than the whole attribute.
    const inPage = new RegExp(`class="[^"]*\\b${slot}\\b[^"]*"`);
    assert.ok(inPage.test(HTML), `ark.html has a .${slot} element`);
    assert.ok(fake.includes(`'${slot}'`), `test/fakeArkDom.ts provides a .${slot} slot`);
  }
});
