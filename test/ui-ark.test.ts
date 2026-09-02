/**
 * The Owner ARK management projection.
 *
 * Nothing here touches the DOM, a socket or the clock: every case is a pure
 * function over data, so the suite is deterministic and cannot flake.
 *
 * The rules being held, all of them about what the console must refuse to
 * claim:
 *
 * 1. **Need You outranks everything.** An explicit approval wait sorts above an
 *    advisory, and neither disappears because the stream went quiet.
 * 2. **Unknown is never work.** While nothing is confirming the office, Now
 *    reports 状態不明 for everybody rather than leaving rows that read as still
 *    executing - and it still says what was last observed, separately.
 * 3. **A gap in the contract is reported, not filled.** Next carries no invented
 *    plan and Outcome carries no invented artifact.
 * 4. **The command surface cannot send.** It builds a payload, says there is
 *    nowhere to send it, and has no way to send it anyway.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import type { SanitizedEvent } from '../src/domain/event.ts';
import type { WireEvent } from '../src/domain/wire.ts';
import { makeEvent } from './helpers.ts';

import type { ClientState } from '../src/ui/public/quest-view.js';
import {
  ACTOR_VISUAL_STATES,
  applyEvent,
  applyFrame,
  createClientState,
  setConnectionPhase,
} from '../src/ui/public/quest-view.js';
import type { ArkRuntimeCode } from '../src/ui/public/quest-ark.js';
import {
  ARK_ATTENTION_LEVELS,
  ARK_ATTENTION_REASONS,
  ARK_COMMAND_MAX,
  ARK_COMMAND_REJECTS,
  ARK_OUTCOME_RESULTS,
  ARK_RUNTIME_CODES,
  ARK_SUBMISSION,
  NOT_IN_CONTRACT,
  buildCommandDraft,
  outcomeLabel,
  runtimeLabel,
  selectArk,
  selectAttention,
  selectNext,
  selectNow,
  selectOutcome,
} from '../src/ui/public/quest-ark.js';

/**
 * A client state folded from wire events a real store produced, so the shapes
 * under test are the ones a browser would actually receive.
 */
function stateOf(events: readonly Partial<SanitizedEvent>[]): ClientState {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires: WireEvent[] = [];
  store.subscribe((wire) => wires.push(wire));
  events.forEach((overrides, index) => {
    store.ingestObject(makeEvent({ ts: `2026-01-01T00:00:0${index}.000Z`, ...overrides }));
  });
  let state = setConnectionPhase(createClientState('live'), 'open', 1000);
  for (const wire of wires) state = applyEvent(state, wire, 1000);
  return state;
}

/** The same office, with the stream no longer confirming anything. */
function disconnected(state: ClientState): ClientState {
  return setConnectionPhase(state, 'error', 2000);
}

/** One colleague per status label, all in one session. */
function office(statuses: Record<string, string>): ClientState {
  return stateOf(
    Object.entries(statuses).map(([agent, status]) => ({
      event_type: 'agent_start' as const,
      agent_id: agent,
      status,
    })),
  );
}

// ------------------------------------------------------------- Need You ---

test('Need You puts an explicit approval request above every advisory', () => {
  const state = office({ ann: 'awaiting_approval', bob: 'failed', cy: 'running' });
  const attention = selectAttention(state);

  assert.deepEqual(
    attention.items.map((item) => item.reason_code),
    ['AWAITING_APPROVAL', 'RUN_ERROR'],
    'the working colleague is not asking for anything, and is not listed',
  );
  assert.equal(attention.items[0]?.level, 'required');
  assert.equal(attention.items[1]?.level, 'advised');
  assert.equal(attention.count, 2);
  assert.equal(attention.required, true);
});

test('a quiet office asks for nobody', () => {
  const attention = selectAttention(office({ ann: 'running', bob: 'planning' }));
  assert.deepEqual(attention.items, []);
  assert.equal(attention.count, 0);
  assert.equal(attention.required, false);
});

test('every Need You item is a decision packet, not a request to approve', () => {
  const attention = selectAttention(office({ ann: 'awaiting_approval' }));
  const item = attention.items[0];
  assert.ok(item !== undefined);
  // Why a person is needed, what the choice is, and what happens if nobody
  // makes it. A bare 「承認してください」 is exactly what this must not be.
  assert.ok(item.reason.length > 0, 'why a person is needed');
  assert.ok(item.recommended.length > 0, 'what is recommended');
  assert.ok(item.options.length >= 2, 'what the choices are');
  assert.ok(item.inaction.length > 0, 'what doing nothing costs');
  assert.equal(item.last_update, '2026-01-01T00:00:00.000Z', 'and when it was last true');
  assert.ok(ARK_ATTENTION_REASONS.includes(item.reason_code), 'from a closed vocabulary');
});

test('a lost stream raises one item, not one per colleague', () => {
  const state = disconnected(office({ ann: 'awaiting_approval', bob: 'running', cy: 'running' }));
  const items = selectAttention(state).items;

  const connection = items.filter((item) => item.kind === 'connection');
  assert.equal(connection.length, 1, 'the disconnection is one fact about one stream');
  assert.equal(connection[0]?.reason_code, 'STREAM_UNCONFIRMED');
  // The two working colleagues become 状態不明 while stale. That is not three
  // more things to decide, so they raise nothing.
  assert.deepEqual(
    items.map((item) => item.reason_code),
    ['AWAITING_APPROVAL', 'STREAM_UNCONFIRMED'],
  );
});

test('an approval wait survives the disconnection that hid it, marked unconfirmed', () => {
  const live = selectAttention(office({ ann: 'awaiting_approval' })).items[0];
  const frozen = selectAttention(disconnected(office({ ann: 'awaiting_approval' }))).items.find(
    (item) => item.kind === 'actor',
  );

  assert.equal(live?.confirmed, true);
  assert.equal(frozen?.reason_code, 'AWAITING_APPROVAL', 'still the reason it was raised for');
  assert.equal(frozen?.confirmed, false, 'but not presented as a live observation');
  assert.equal(frozen?.visual?.state, 'unknown', 'what may be claimed now');
  assert.equal(frozen?.last_known_visual?.state, 'awaiting_approval', 'what was last observed');
});

test('a fail-closed namespace is an explicit request for a person', () => {
  let state = office({ ann: 'running' });
  state = applyFrame(state, {
    kind: 'fail_closed',
    payload: { namespace: 'live', halted: true, reason: 'state_limit', detail: '' },
    at_ms: 2000,
  });
  const items = selectAttention(state).items;
  assert.equal(items[0]?.reason_code, 'INGEST_HALTED');
  assert.equal(items[0]?.level, 'required');
  assert.equal(items[0]?.confirmed, false);
});

test('nothing in Need You is carried by colour alone', () => {
  const state = disconnected(office({ ann: 'awaiting_approval', bob: 'failed' }));
  for (const item of selectAttention(state).items) {
    assert.ok(ARK_ATTENTION_LEVELS.includes(item.level), 'the level is a word');
    assert.ok(item.title.length > 0, 'the item is named');
    if (item.visual !== null) {
      assert.ok(item.visual.symbol.length > 0, 'the state has a symbol');
      assert.ok(item.visual.label.length > 0, 'and a readable label');
    }
  }
});

// ------------------------------------------------------------------ Now ---

test('Now separates the runtime classes it can actually classify', () => {
  const now = selectNow(office({ ann: 'running', bob: 'awaiting_approval', cy: 'failed', di: 'idle' }));
  const byName = new Map(now.rows.map((row) => [row.display_name, row.runtime]));
  assert.equal(byName.get('ann'), 'EXECUTING');
  assert.equal(byName.get('bob'), 'HUMAN_WAIT');
  assert.equal(byName.get('cy'), 'BLOCKED');
  assert.equal(byName.get('di'), 'IDLE');
  assert.equal(now.confirmed, true);
  // Worst first, so the failure is not below the fold on a busy screen.
  assert.deepEqual(now.rows.map((row) => row.display_name), ['cy', 'bob', 'ann', 'di']);
});

test('Now never reports work while nothing is confirming it', () => {
  const state = disconnected(office({ ann: 'running', bob: 'running', cy: 'failed' }));
  const now = selectNow(state);

  assert.equal(now.confirmed, false);
  assert.equal(now.counts.EXECUTING, 0, 'a disconnection empties 実行中');
  assert.equal(now.counts.UNKNOWN, 3, 'and moves everybody to 状態不明');
  for (const row of now.rows) {
    assert.equal(row.runtime, 'UNKNOWN');
    assert.equal(row.confirmed, false);
  }
  // The observation itself is kept, separately and labelled as the last one.
  assert.deepEqual(
    now.rows.map((row) => row.last_known_runtime).sort(),
    ['BLOCKED', 'EXECUTING', 'EXECUTING'],
  );
});

test('Now reports the bucket the contract cannot fill instead of guessing it', () => {
  const now = selectNow(office({ ann: 'running' }));
  assert.equal(now.external_wait.available, false);
  assert.ok(now.external_wait.note.length > 0, 'and says why in words');
  assert.equal(
    ARK_RUNTIME_CODES.includes('EXTERNAL_WAIT' as ArkRuntimeCode),
    false,
    'so no row can ever land in a class nothing can classify',
  );
});

test('every runtime code has a readable label', () => {
  for (const code of ARK_RUNTIME_CODES) {
    assert.ok(runtimeLabel(code).length > 0, `${code} is a word, not just a colour`);
  }
});

// ----------------------------------------------------------------- Next ---

test('Next reports that the plan is not in the contract, and invents none', () => {
  const next = selectNext(office({ ann: 'planning', bob: 'running' }));

  assert.equal(next.contract_available, false);
  assert.ok(next.note.length > 0);
  assert.deepEqual(next.rows.map((row) => row.display_name), ['ann'], 'only what reported planning');
  assert.equal(next.rows[0]?.next_action, null, 'and no step it did not report');
  for (const field of next.fields) {
    assert.equal(field.value, NOT_IN_CONTRACT, `${field.key} is reported absent, not blank`);
  }
});

// -------------------------------------------------------------- Outcome ---

test('Outcome puts a failure above a success, and leaves the unfinished out', () => {
  const outcome = selectOutcome(office({ ann: 'completed', bob: 'failed', cy: 'running' }));

  assert.deepEqual(
    outcome.rows.map((row) => [row.display_name, row.result]),
    [
      ['bob', 'FAILED'],
      ['ann', 'COMPLETED'],
    ],
    'cy is still working, so it has no outcome yet',
  );
  assert.equal(outcome.counts.FAILED, 1);
  assert.equal(outcome.counts.COMPLETED, 1);
  assert.equal(outcome.counts.STOPPED, 0);
});

test('a session that ended on somebody still waiting is 中断, never 完了', () => {
  const state = stateOf([
    { event_type: 'agent_start', agent_id: 'di', status: 'running' },
    // Stopped while it was still waiting for a person, so the reducer leaves
    // this status alone: `session_end` only rewrites actors that are still
    // active.
    { event_type: 'agent_stop', agent_id: 'di', status: 'approval' },
    { event_type: 'session_end', agent_id: 'zz', status: 'running' },
  ]);
  const rows = selectOutcome(state).rows;

  assert.deepEqual(
    rows.map((row) => [row.display_name, row.result]),
    [
      ['di', 'STOPPED'],
      ['zz', 'COMPLETED'],
    ],
    'the run is over; di never got the approval it was waiting for',
  );
  assert.ok((rows[0]?.follow_up ?? '').length > 0, 'and the loop it left open is named');
  assert.equal(rows[1]?.follow_up, null, 'a completed one leaves nothing hanging');
});

test('Outcome evidence is reachable, and says what it does not have', () => {
  const state = office({ ann: 'completed' });
  const row = selectOutcome(state).rows[0];
  assert.ok(row !== undefined);

  const labels = row.evidence.trace.map((entry) => entry.label);
  assert.ok(labels.includes('session'), 'the run is reachable');
  assert.ok(labels.includes('actor_key'), 'and so is the identity behind the name');
  assert.ok(labels.includes('最終更新'));
  for (const entry of row.evidence.trace) {
    assert.ok(entry.value.length > 0, `${entry.label} is never a blank cell`);
  }
  // Tests, CI, PR and commit refs are not on the wire. Saying so is not the
  // same claim as leaving the row empty.
  assert.equal(row.evidence.artifacts.available, false);
  assert.ok(row.evidence.artifacts.note.length > 0);
  assert.equal(selectOutcome(state).artifacts.available, false);
});

test('every outcome result has a readable label', () => {
  for (const result of ARK_OUTCOME_RESULTS) {
    assert.ok(outcomeLabel(result).length > 0);
  }
});

// ------------------------------------------------------ command surface ---

test('the command surface builds a payload and refuses to claim it was sent', () => {
  const draft = buildCommandDraft('ARKのNeed You画面をスマホで見やすくして', {
    namespace: 'live',
    target_actor_key: null,
    at: '2026-09-02T00:00:00.000Z',
  });

  assert.equal(draft.status, 'ready');
  assert.equal(draft.reject, null);
  assert.deepEqual(draft.payload, {
    schema_version: 1,
    kind: 'owner_task_delegation',
    origin: 'owner_ark_console',
    namespace: 'live',
    intent: 'ARKのNeed You画面をスマホで見やすくして',
    target_actor_key: null,
    drafted_at: '2026-09-02T00:00:00.000Z',
    dispatch: 'none',
  });
  // Not "sending failed" and not "sent": there is nowhere to send it, and the
  // screen says which of those it is.
  assert.equal(draft.submission.available, false);
  assert.equal(draft.submission.code, 'NOT_CONNECTED');
  assert.equal(draft.submission, ARK_SUBMISSION, 'the same constant in every state');
});

test('the command surface refuses what a boundary would refuse, without echoing it', () => {
  const empty = buildCommandDraft('   ', { namespace: 'live' });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.reject, 'empty');
  assert.equal(empty.payload, null);

  const long = buildCommandDraft('あ'.repeat(ARK_COMMAND_MAX + 1), { namespace: 'live' });
  assert.equal(long.reject, 'too_long');
  assert.equal(long.payload, null);
  assert.equal(long.message?.includes('あ'), false, 'the refusal never quotes the input back');

  const control = buildCommandDraft(`ok${String.fromCharCode(7)}`, { namespace: 'live' });
  assert.equal(control.reject, 'control_chars');
  assert.equal(control.payload, null);

  for (const rule of [empty, long, control]) {
    assert.ok(rule.reject !== null && ARK_COMMAND_REJECTS.includes(rule.reject));
    assert.equal(rule.submission.available, false);
  }
});

test('the command surface is a pure builder: no clock, no request, no state', () => {
  const before = buildCommandDraft('同じ依頼', { namespace: 'live', at: null });
  const after = buildCommandDraft('同じ依頼', { namespace: 'live', at: null });
  assert.deepEqual(before, after, 'the same input builds the same draft, always');
  // Counted in code points, so a surrogate pair is one character and not two.
  assert.equal(buildCommandDraft('🙂', {}).length, 1);
  assert.equal(buildCommandDraft(undefined, {}).status, 'empty', 'a missing field is not a crash');
});

// ------------------------------------------------------------ the whole ---

test('the console reads one state, and no second state machine', () => {
  const state = office({ ann: 'awaiting_approval', bob: 'failed', cy: 'planning' });
  const ark = selectArk(state);

  assert.deepEqual(ark.attention, selectAttention(state));
  assert.deepEqual(ark.now, selectNow(state));
  assert.deepEqual(ark.next, selectNext(state));
  assert.deepEqual(ark.outcome, selectOutcome(state));
  assert.equal(ark.banner.code, 'CONNECTED');
});

test('the console ranks attention by the office’s own ordering, not a new one', () => {
  // If these two ever disagree, the same failure is "worse" on one screen and
  // "better" on the other. The rank here is `ACTOR_VISUAL_STATES` itself.
  assert.deepEqual(
    [...ACTOR_VISUAL_STATES],
    ['error', 'awaiting_approval', 'planning', 'working', 'ended', 'idle'],
  );
  const rows = selectNow(office({ ann: 'idle', bob: 'failed', cy: 'planning' })).rows;
  assert.deepEqual(rows.map((row) => row.display_name), ['bob', 'cy', 'ann']);
});

test('every vocabulary the console exposes is closed and frozen', () => {
  for (const vocabulary of [
    ARK_ATTENTION_LEVELS,
    ARK_ATTENTION_REASONS,
    ARK_RUNTIME_CODES,
    ARK_OUTCOME_RESULTS,
    ARK_COMMAND_REJECTS,
  ]) {
    assert.equal(Object.isFrozen(vocabulary), true);
    assert.equal(new Set(vocabulary).size, vocabulary.length, 'no duplicate token');
  }
});
