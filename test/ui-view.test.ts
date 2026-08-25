/**
 * The retro office view model.
 *
 * Nothing here touches the DOM, a socket or the clock: every case is a pure
 * function over data, so the suite is deterministic and cannot flake.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { seedDemoStore } from '../src/demo/fixtures.ts';
import type { QuestState } from '../src/domain/reducer.ts';
import type { WireEvent } from '../src/domain/wire.ts';
import { WIRE_EVENT_KEYS } from '../src/domain/wire.ts';
import { makeEvent } from './helpers.ts';

import type { ActorVisualState, ClientState } from '../src/ui/public/quest-view.js';
import {
  ACTOR_VISUAL_STATES,
  MAX_LOG_ENTRIES,
  UNATTRIBUTED_AGENT_LABEL,
  applyEvent,
  applyFrame,
  applySnapshot,
  classifyActor,
  classifyConnection,
  classifyStatus,
  createClientState,
  describeFreshness,
  gapLabel,
  haltLabel,
  normalizeGapReason,
  normalizeHaltReason,
  selectBanner,
  selectDesks,
  selectHeader,
  setConnectionPhase,
  visualForState,
} from '../src/ui/public/quest-view.js';

/** Collects the wire events a store emits, in order. */
function record(store: NamespaceStore): WireEvent[] {
  const seen: WireEvent[] = [];
  store.subscribe((wire) => {
    seen.push(wire);
  });
  return seen;
}

function snapshotOf(store: NamespaceStore): unknown {
  return {
    namespace: store.namespace,
    halted: store.stats.halted,
    halt_reason: store.stats.halt_reason,
    last_ingest_seq: store.stats.last_ingest_seq,
    // The server serialises the state to JSON; do the same so the test sees
    // exactly the object shape a browser would receive.
    state: JSON.parse(JSON.stringify(store.state)) as QuestState,
  };
}

function foldAll(namespace: string, wires: readonly WireEvent[]): ClientState {
  let state = createClientState(namespace);
  for (const wire of wires) state = applyEvent(state, wire);
  return state;
}

// --------------------------------------------------------------- mapping ---

type MappingCase = { name: string; status: string | null; active: boolean; expect: ActorVisualState };

const MAPPING_CASES: MappingCase[] = [
  { name: 'no status, never started', status: null, active: false, expect: 'idle' },
  { name: 'no status but active', status: null, active: true, expect: 'working' },
  { name: 'explicit idle', status: 'idle', active: true, expect: 'idle' },
  { name: 'waiting', status: 'waiting', active: true, expect: 'idle' },
  { name: 'queued', status: 'queued', active: true, expect: 'idle' },
  { name: 'active', status: 'active', active: true, expect: 'working' },
  { name: 'running', status: 'running', active: true, expect: 'working' },
  { name: 'thinking', status: 'thinking', active: true, expect: 'working' },
  { name: 'in progress, spaced', status: 'in progress', active: true, expect: 'working' },
  { name: 'mixed case', status: 'RUNNING', active: true, expect: 'working' },
  { name: 'approval waiting', status: 'awaiting_approval', active: true, expect: 'awaiting_approval' },
  { name: 'permission wording', status: 'needs permission', active: true, expect: 'awaiting_approval' },
  { name: 'hyphenated approval', status: 'tool-use-approval', active: true, expect: 'awaiting_approval' },
  { name: 'asking the operator', status: 'asking', active: true, expect: 'awaiting_approval' },
  { name: 'completed', status: 'completed', active: false, expect: 'ended' },
  { name: 'stopped', status: 'stopped', active: false, expect: 'ended' },
  { name: 'ended by session_end', status: 'ended', active: false, expect: 'ended' },
  { name: 'error', status: 'error', active: false, expect: 'error' },
  { name: 'failed', status: 'failed', active: true, expect: 'error' },
  { name: 'fail closed', status: 'fail_closed', active: false, expect: 'error' },
  { name: 'timeout', status: 'timeout', active: true, expect: 'error' },
  { name: 'denied', status: 'denied', active: false, expect: 'error' },
  { name: 'error outranks completion', status: 'completed_with_error', active: false, expect: 'error' },
  { name: 'approval outranks tool work', status: 'tool_use_approval', active: true, expect: 'awaiting_approval' },
  { name: 'unknown label, active', status: 'frobnicating', active: true, expect: 'working' },
  { name: 'unknown label, inactive', status: 'frobnicating', active: false, expect: 'idle' },
  { name: 'working label on a stopped actor', status: 'active', active: false, expect: 'ended' },
  { name: 'empty label', status: '', active: false, expect: 'idle' },
];

test('every actor status maps to exactly one visual state', () => {
  for (const item of MAPPING_CASES) {
    const visual = classifyActor({ status: item.status, active: item.active });
    assert.equal(visual.state, item.expect, `${item.name}: ${String(item.status)}`);
  }
});

test('each visual state carries a symbol and a readable label, not colour alone', () => {
  const symbols = new Set<string>();
  const labels = new Set<string>();
  for (const state of ACTOR_VISUAL_STATES) {
    const visual = visualForState(state);
    assert.equal(visual.state, state);
    assert.ok(visual.symbol.length > 0, `${state} has a symbol`);
    assert.ok(visual.label.length > 0, `${state} has a label`);
    assert.ok(visual.code.length > 0, `${state} has a code`);
    symbols.add(visual.symbol);
    labels.add(visual.label);
  }
  assert.equal(symbols.size, ACTOR_VISUAL_STATES.length, 'symbols are distinguishable');
  assert.equal(labels.size, ACTOR_VISUAL_STATES.length, 'labels are distinguishable');
});

test('an unknown status classifies as nothing rather than guessing', () => {
  assert.equal(classifyStatus('frobnicating'), null);
  assert.equal(classifyStatus(null), null);
  assert.equal(classifyStatus(''), null);
});

test('connection states are labelled, and fail-closed outranks the phase', () => {
  const cases: [string, boolean, string][] = [
    ['offline', false, 'OFFLINE'],
    ['connecting', false, 'CONNECTING'],
    ['open', false, 'CONNECTED'],
    ['reconnecting', false, 'RECONNECTING'],
    ['error', false, 'DISCONNECTED'],
    ['open', true, 'FAIL_CLOSED'],
    ['reconnecting', true, 'FAIL_CLOSED'],
  ];
  for (const [phase, halted, code] of cases) {
    const visual = classifyConnection({ phase: phase as never, halted });
    assert.equal(visual.code, code, `${phase} halted=${String(halted)}`);
    assert.ok(visual.label.length > 0);
    assert.ok(visual.symbol.length > 0);
  }
  // An unrecognised phase never invents a reassuring state.
  assert.equal(classifyConnection({ phase: 'teleporting' as never }).code, 'OFFLINE');
});

// ------------------------------------------------------- reducer parity ---

/** Only the fields the screen reads, so the comparison is about the fold. */
function projectActors(actors: Record<string, unknown>): unknown[] {
  return Object.keys(actors)
    .sort()
    .map((key) => {
      const actor = actors[key] as Record<string, unknown>;
      return {
        actor_key: actor['actor_key'],
        session_id: actor['session_id'],
        agent_id: actor['agent_id'],
        role: actor['role'],
        resolved: actor['resolved'],
        is_main_orchestrator: actor['is_main_orchestrator'],
        status: actor['status'],
        active: actor['active'],
        last_tool: actor['last_tool'],
        last_event_ts: actor['last_event_ts'],
        last_ingest_seq: actor['last_ingest_seq'],
        event_count: actor['event_count'],
      };
    });
}

function projectSessions(sessions: Record<string, unknown>): unknown[] {
  return Object.keys(sessions)
    .sort()
    .map((key) => {
      const session = sessions[key] as Record<string, unknown>;
      return {
        session_id: session['session_id'],
        started_at: session['started_at'],
        ended_at: session['ended_at'],
        event_count: session['event_count'],
        actor_keys: session['actor_keys'],
      };
    });
}

test('the client fold agrees with the shared reducer, event for event', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);

  const sequence = [
    makeEvent({ event_type: 'session_start', ts: '2026-02-01T00:00:00.000Z' }),
    makeEvent({ event_type: 'agent_start', status: 'active', ts: '2026-02-01T00:00:01.000Z' }),
    makeEvent({
      event_type: 'agent_start',
      agent_id: 'worker-1',
      agent_role: 'reviewer',
      status: 'active',
      ts: '2026-02-01T00:00:02.000Z',
    }),
    makeEvent({
      event_type: 'tool_use',
      agent_id: 'worker-1',
      tool_name: 'grep',
      status: 'awaiting_approval',
      ts: '2026-02-01T00:00:03.000Z',
    }),
    // Out of order for worker-1: must not overwrite the newer status.
    makeEvent({
      event_type: 'agent_status',
      agent_id: 'worker-1',
      status: 'idle',
      ts: '2026-02-01T00:00:01.500Z',
    }),
    // Unattributed actor.
    makeEvent({ event_type: 'heartbeat', agent_id: null, ts: '2026-02-01T00:00:04.000Z' }),
    // Well-formed but unknown event type: recorded, never interpreted.
    makeEvent({ event_type: 'weather_report', agent_id: 'worker-1', ts: '2026-02-01T00:00:05.000Z' }),
    makeEvent({
      event_type: 'agent_stop',
      agent_id: 'worker-2',
      status: 'error',
      ts: '2026-02-01T00:00:06.000Z',
    }),
    makeEvent({ event_type: 'session_end', ts: '2026-02-01T00:00:07.000Z' }),
    // A second session that stays open after the first one closed.
    makeEvent({
      event_type: 'agent_start',
      session_id: 'sess-2',
      status: 'running',
      ts: '2026-02-01T00:00:08.000Z',
    }),
  ];
  for (const event of sequence) assert.equal(store.ingestObject(event).status, 'accepted');

  const client = foldAll('live', wires);

  assert.deepEqual(projectActors(client.actors), projectActors(store.state.actors));
  assert.deepEqual(projectSessions(client.sessions), projectSessions(store.state.sessions));
  assert.equal(client.last_ingest_seq, store.state.last_ingest_seq);
  assert.equal(client.counters.applied, store.state.counters.applied);
  assert.equal(client.counters.ignored, store.state.counters.ignored);
  assert.equal(client.counters.out_of_order, store.state.counters.out_of_order);
  assert.ok(client.counters.out_of_order > 0, 'the out-of-order case was actually exercised');
});

test('a snapshot and a full replay of the same stream produce the same desks', () => {
  const store = new NamespaceStore({ namespace: 'demo' });
  const wires = record(store);
  seedDemoStore(store);

  const folded = foldAll('demo', wires);
  const restored = applySnapshot(createClientState('demo'), snapshotOf(store));

  assert.deepEqual(selectDesks(restored), selectDesks(folded));
  assert.equal(restored.last_ingest_seq, folded.last_ingest_seq);
});

// ------------------------------------------------------------- isolation ---

test('a foreign-namespace event is refused, never mixed in', () => {
  const store = new NamespaceStore({ namespace: 'demo' });
  const wires = record(store);
  seedDemoStore(store);

  let live = createClientState('live');
  for (const wire of wires) live = applyEvent(live, wire);

  assert.deepEqual(Object.keys(live.actors), []);
  assert.deepEqual(Object.keys(live.sessions), []);
  assert.equal(live.counters.applied, 0);
  assert.equal(live.counters.foreign, wires.length);
  assert.equal(live.log.length, 0);
});

test('a foreign-namespace snapshot is refused too', () => {
  const store = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(store);

  const live = applySnapshot(createClientState('live'), snapshotOf(store));
  assert.deepEqual(Object.keys(live.actors), []);
  assert.equal(live.counters.foreign, 1);
  assert.equal(live.counters.snapshots, 0);
});

test('switching modes starts from an empty state for the other namespace', () => {
  const store = new NamespaceStore({ namespace: 'demo' });
  const wires = record(store);
  seedDemoStore(store);

  const demo = foldAll('demo', wires);
  assert.ok(selectDesks(demo).length > 0);

  // A switch is modelled exactly as the app does it: a brand new client state.
  const live = createClientState('live');
  assert.deepEqual(selectDesks(live), []);
  assert.equal(selectHeader(live).mode, 'LIVE');
  assert.equal(selectHeader(live).empty, true);
  assert.equal(selectHeader(demo).mode, 'DEMO');
});

// ------------------------------------------------- frames and connection ---

test('an empty office reports itself as empty', () => {
  const header = selectHeader(createClientState('live'));
  assert.equal(header.empty, true);
  assert.equal(header.desk_count, 0);
  assert.equal(header.session_count, 0);
  assert.equal(header.connection.code, 'OFFLINE');
});

test('the banner follows one connection through every situation it can reach', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(makeEvent({ event_type: 'agent_start', status: 'active' }));

  const codeOf = (state: ClientState): string => selectBanner(selectHeader(state)).code;

  // Before anything arrives, and while the socket is still opening.
  let state = createClientState('live');
  assert.equal(codeOf(state), 'LOADING');
  state = setConnectionPhase(state, 'connecting', 1_000);
  assert.equal(codeOf(state), 'LOADING');

  // Open but with no actor yet: still an explicit code, never a blank screen.
  state = setConnectionPhase(state, 'open', 2_000);
  assert.equal(codeOf(state), 'EMPTY');

  // The snapshot seats someone.
  state = applyFrame(state, { kind: 'snapshot', payload: snapshotOf(store), at_ms: 3_000 });
  assert.equal(codeOf(state), 'CONNECTED');

  // A replay is announced, and cleared when it ends.
  state = applyFrame(state, { kind: 'replay_start', payload: { count: wires.length }, at_ms: 4_000 });
  assert.equal(codeOf(state), 'REPLAYING');
  state = applyFrame(state, { kind: 'replay_end', payload: { count: wires.length }, at_ms: 5_000 });
  assert.equal(codeOf(state), 'CONNECTED');

  // A gap outranks a healthy connection until the snapshot that repairs it.
  state = applyFrame(state, { kind: 'stream_gap', payload: { reason: 'evicted' }, at_ms: 6_000 });
  assert.equal(codeOf(state), 'STREAM_GAP');
  state = applyFrame(state, { kind: 'snapshot', payload: snapshotOf(store), at_ms: 7_000 });
  assert.equal(codeOf(state), 'CONNECTED');

  // Losing the socket, and getting it back.
  state = setConnectionPhase(state, 'reconnecting', 8_000);
  assert.equal(codeOf(state), 'RECONNECTING');
  state = setConnectionPhase(state, 'error', 9_000);
  assert.equal(codeOf(state), 'DISCONNECTED');
  state = setConnectionPhase(state, 'open', 10_000);
  assert.equal(codeOf(state), 'CONNECTED');

  // A halt is sticky and outranks everything, including a healthy socket.
  state = applyFrame(state, {
    kind: 'fail_closed',
    payload: { namespace: 'live', halted: true, reason: 'unsupported_schema', detail: 'x' },
    at_ms: 11_000,
  });
  assert.equal(codeOf(state), 'FAIL_CLOSED');
  const halted = selectBanner(selectHeader(state));
  assert.ok(halted.message.includes('fail-closed'), 'the banner names the boundary');
  assert.ok(halted.message.includes('未対応のschema version'), 'and the known reason behind it');
  assert.equal(selectDesks(state).length, 1, 'and the frozen state is still on screen');
  state = setConnectionPhase(state, 'open', 12_000);
  assert.equal(codeOf(state), 'FAIL_CLOSED');
});

test('an unknown gap reason is reported as a gap, not echoed as text', () => {
  let state = setConnectionPhase(createClientState('live'), 'open', 1_000);
  state = applyFrame(state, { kind: 'stream_gap', payload: { reason: 'x'.repeat(200) }, at_ms: 2_000 });

  const banner = selectBanner(selectHeader(state));
  assert.equal(banner.code, 'STREAM_GAP');
  assert.equal(banner.message.includes('xxx'), false, 'the wire string never reaches the banner');
  assert.equal(normalizeGapReason('x'.repeat(200)), null);
  assert.equal(gapLabel('evicted'), 'replay bufferから溢れた分があります');
  assert.equal(gapLabel('nonsense'), null);
});

test('a stream gap is shown until the snapshot that follows it clears it', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(makeEvent({ event_type: 'agent_start', status: 'active' }));

  let state = setConnectionPhase(createClientState('live'), 'open', 1_000);
  state = applyFrame(state, { kind: 'stream_gap', payload: { reason: 'evicted' }, at_ms: 2_000 });

  assert.deepEqual(state.connection.gap, { reason: 'evicted' });
  assert.equal(selectHeader(state).gap?.reason, 'evicted');
  assert.equal(state.counters.gaps, 1);

  state = applyFrame(state, { kind: 'snapshot', payload: snapshotOf(store), at_ms: 3_000 });
  assert.equal(state.connection.gap, null);
  assert.equal(selectDesks(state).length, 1);
  assert.equal(state.counters.snapshots, 1);
  assert.equal(state.connection.last_frame_at_ms, 3_000);
  assert.equal(wires.length, 1);
});

test('replay_start and replay_end bracket a replay without losing events', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(makeEvent({ event_type: 'agent_start', status: 'active' }));
  store.ingestObject(makeEvent({ event_type: 'tool_use', tool_name: 'read', status: 'running' }));

  let state = setConnectionPhase(createClientState('live'), 'reconnecting');
  state = applyFrame(state, { kind: 'replay_start', payload: { count: wires.length } });
  assert.equal(selectHeader(state).replaying, true);

  for (const wire of wires) state = applyFrame(state, { kind: 'event', payload: wire });
  state = applyFrame(state, { kind: 'replay_end', payload: { count: wires.length } });

  assert.equal(selectHeader(state).replaying, false);
  assert.equal(state.counters.applied, 2);
  assert.equal(selectDesks(state)[0]?.last_tool, 'read');
});

test('a reconnect that replays does not double-apply what is already known', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(makeEvent({ event_type: 'agent_start', status: 'active' }));
  store.ingestObject(makeEvent({ event_type: 'tool_use', tool_name: 'read', status: 'running' }));

  // First connection sees both events, then drops.
  let state = foldAll('live', wires);
  state = setConnectionPhase(state, 'reconnecting');

  // The reconnect replays only what came after the last id the client holds -
  // which, having seen everything, is nothing.
  const lookup = store.replayFrom(state.connection.last_event_id ?? '');
  assert.equal(lookup.status, 'replay');
  assert.deepEqual(lookup.status === 'replay' ? lookup.events : null, []);

  state = applyFrame(state, { kind: 'replay_start', payload: { count: 0 } });
  state = applyFrame(state, { kind: 'replay_end', payload: { count: 0 } });
  state = setConnectionPhase(state, 'open');

  assert.equal(state.counters.applied, 2);
  assert.equal(selectHeader(state).connection.code, 'CONNECTED');
  assert.equal(selectDesks(state).length, 1);
});

test('a halted namespace is reported as fail-closed', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  store.ingestObject(makeEvent({ event_type: 'agent_start', status: 'active' }));
  store.ingestObject(makeEvent({ schema_version: 7 }));
  assert.equal(store.stats.halted, true);

  const state = applySnapshot(setConnectionPhase(createClientState('live'), 'open'), snapshotOf(store));
  const header = selectHeader(state);
  assert.equal(header.halted, true);
  assert.equal(header.connection.code, 'FAIL_CLOSED');
  assert.ok(header.connection.label.length > 0);
  assert.equal(header.halt_reason, 'unsupported_schema');
  // The state the client already has is kept: fail closed freezes, not erases.
  assert.equal(header.desk_count, 1);
});

test('a halt that happens mid-connection is applied from the fail_closed frame', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(makeEvent({ event_type: 'agent_start', status: 'active' }));

  // The client is connected and healthy: the office is shown, nothing is halted.
  let state = setConnectionPhase(foldAll('live', wires), 'open', 1_000);
  assert.equal(selectHeader(state).connection.code, 'CONNECTED');

  // The halt itself carries no wire event, so the frame is the only signal.
  state = applyFrame(state, {
    kind: 'fail_closed',
    payload: { namespace: 'live', halted: true, reason: 'state_limit', detail: 'actors:4096' },
    at_ms: 2_000,
  });

  const header = selectHeader(state);
  assert.equal(header.halted, true);
  assert.equal(header.connection.code, 'FAIL_CLOSED');
  assert.equal(header.halt_reason, 'state_limit');
  assert.equal(state.counters.halts, 1);
  // Frozen, not erased: the desk that was on screen is still on screen.
  assert.equal(header.desk_count, 1);
  assert.equal(header.last_frame_at_ms, 2_000);
});

test('a reconnect that replays into a halt ends fail-closed, not connected', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(makeEvent({ event_type: 'agent_start', status: 'active' }));

  // The client saw this event, dropped its connection, and reconnected with the
  // event's id. The server replays (nothing new) and then reports the halt that
  // happened while the client was offline.
  let state = setConnectionPhase(foldAll('live', wires), 'open', 1_000);
  state = applyFrame(state, { kind: 'replay_start', payload: { count: 0 }, at_ms: 2_000 });
  state = applyFrame(state, { kind: 'replay_end', payload: { count: 0 }, at_ms: 2_000 });
  assert.equal(selectHeader(state).connection.code, 'CONNECTED', 'replay alone says nothing about a halt');

  state = applyFrame(state, {
    kind: 'fail_closed',
    payload: { namespace: 'live', halted: true, reason: 'unsupported_schema', detail: 'schema_version:7' },
    at_ms: 2_000,
  });

  const header = selectHeader(state);
  assert.equal(header.connection.code, 'FAIL_CLOSED');
  assert.equal(header.halt_reason, 'unsupported_schema');
  assert.equal(header.replaying, false);
  assert.equal(header.gap, null, 'a replayed reconnect is not a gap');
  assert.equal(header.desk_count, 1, 'the replayed state is kept, frozen');
});

test('the halt frame respects namespace isolation and never echoes an unknown reason', () => {
  const base = setConnectionPhase(createClientState('live'), 'open');

  // A DEMO halt must not freeze the LIVE screen.
  const foreign = applyFrame(base, {
    kind: 'fail_closed',
    payload: { namespace: 'demo', halted: true, reason: 'state_limit', detail: 'actors:1' },
  });
  assert.equal(selectHeader(foreign).halted, false);
  assert.equal(foreign.counters.foreign, 1);
  assert.equal(foreign.counters.halts, 0);

  // An unrecognised reason still halts, but the screen invents no label for it.
  const unknown = applyFrame(base, {
    kind: 'fail_closed',
    payload: { namespace: 'live', halted: true, reason: '<img src=x>', detail: 'whatever' },
  });
  const header = selectHeader(unknown);
  assert.equal(header.halted, true);
  assert.equal(header.halt_reason, null);
  assert.equal(haltLabel(header.halt_reason), null);
  assert.equal(haltLabel('state_limit:actors:4096'), haltLabel('state_limit'));
  assert.equal(normalizeHaltReason('unsupported_schema:schema_version:7'), 'unsupported_schema');
  assert.equal(normalizeHaltReason(null), null);
});

test('a disconnect is visible and does not erase what was already shown', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(makeEvent({ event_type: 'agent_start', status: 'active' }));

  let state = foldAll('live', wires);
  state = setConnectionPhase(state, 'error', 5_000);
  const header = selectHeader(state);

  assert.equal(header.connection.code, 'DISCONNECTED');
  assert.equal(header.desk_count, 1);
  assert.equal(describeFreshness(state, 5_000), 'たった今');
  assert.equal(describeFreshness(state, 12_000), '7秒前');
  assert.equal(describeFreshness(state, 245_000), '4分前');
  assert.equal(describeFreshness(createClientState('live'), 1_000), '未受信');
});

test('an unparseable or unknown frame is counted, never guessed at', () => {
  const before = createClientState('live');
  const after = applyFrame(before, { kind: 'unparseable' });
  assert.equal(after.counters.ignored, 1);
  assert.deepEqual(selectDesks(after), []);
});

// ------------------------------------------------------------- rendering ---

test('the DEMO fixtures show every visual state at once', () => {
  const store = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(store);
  const state = applySnapshot(createClientState('demo'), snapshotOf(store));
  const header = selectHeader(state);

  for (const name of ACTOR_VISUAL_STATES) {
    assert.ok(header.by_state[name] > 0, `DEMO shows at least one ${name} desk`);
  }
  assert.equal(header.mode, 'DEMO');
  assert.equal(header.empty, false);
});

test('seating is deterministic and puts the main orchestrator first', () => {
  const store = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(store);
  const state = applySnapshot(createClientState('demo'), snapshotOf(store));

  const first = selectDesks(state);
  const second = selectDesks(state);
  assert.deepEqual(first, second, 'the same state always seats the same way');
  assert.deepEqual(
    first.map((desk) => desk.seat),
    first.map((_, index) => index + 1),
  );
  assert.equal(first[0]?.is_main_orchestrator, true);
  assert.equal(first[0]?.session_id, 'demo-session-01');
});

test('a role is shown only once the collector resolved one', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(makeEvent({ event_type: 'agent_start', agent_id: 'worker-1', status: 'active' }));
  store.ingestObject(makeEvent({ event_type: 'agent_start', agent_id: 'worker-2', agent_role: 'reviewer' }));

  const desks = selectDesks(foldAll('live', wires));
  const unresolved = desks.find((desk) => desk.display_name === 'worker-1');
  const resolved = desks.find((desk) => desk.display_name === 'worker-2');

  assert.equal(unresolved?.resolved, false);
  assert.equal(unresolved?.role, null, 'no role is ever inferred');
  assert.equal(resolved?.resolved, true);
  assert.equal(resolved?.role, 'reviewer');
});

test('an unattributed actor gets a safe display name instead of a blank desk', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(makeEvent({ event_type: 'agent_start', agent_id: null, status: 'active' }));

  const desks = selectDesks(foldAll('live', wires));
  assert.equal(desks.length, 1);
  assert.equal(desks[0]?.display_name, UNATTRIBUTED_AGENT_LABEL);
  assert.equal(desks[0]?.visual.state, 'working');
});

test('the activity log is bounded', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  for (let index = 0; index < MAX_LOG_ENTRIES + 25; index += 1) {
    store.ingestObject(makeEvent({ event_type: 'heartbeat', ts: '2026-03-01T00:00:00.000Z' }));
  }

  const state = foldAll('live', wires);
  assert.equal(state.log.length, MAX_LOG_ENTRIES);
  // Newest first, so the oldest entries are the ones dropped.
  assert.equal(state.log[0]?.ingest_seq, MAX_LOG_ENTRIES + 25);
});

test('the projections expose only whitelisted wire fields', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(
    makeEvent({ event_type: 'tool_use', tool_name: 'read', status: 'running', summary: 'read a file' }),
  );
  const state = foldAll('live', wires);

  // Whatever a desk or a log row carries must be traceable to the wire
  // contract, so nothing new can start being rendered without a schema change.
  const deskFields = new Set([
    'seat',
    'actor_key',
    'session_id',
    'display_name',
    'is_main_orchestrator',
    'role',
    'resolved',
    'status_label',
    'last_tool',
    'last_event_ts',
    'event_count',
    'visual',
  ]);
  for (const desk of selectDesks(state)) {
    for (const key of Object.keys(desk)) assert.ok(deskFields.has(key), `unexpected desk field ${key}`);
  }

  const logFields = new Set([
    'event_id',
    'ingest_seq',
    'ts',
    'event_type',
    'actor',
    'session_id',
    'status',
    'tool_name',
    'summary',
    'state',
  ]);
  for (const entry of state.log) {
    for (const key of Object.keys(entry)) assert.ok(logFields.has(key), `unexpected log field ${key}`);
  }

  // Every value that came from the stream is a field the collector already
  // publishes; the screen adds no new source of data.
  const streamed = new Set(WIRE_EVENT_KEYS);
  for (const key of ['session_id', 'tool_name', 'status', 'summary', 'event_type', 'ts', 'event_id']) {
    assert.ok(streamed.has(key), `${key} is part of the wire whitelist`);
  }
});

test('a prototype-shaped session or agent id stays an ordinary key', () => {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires = record(store);
  store.ingestObject(
    makeEvent({ event_type: 'agent_start', session_id: '__proto__', agent_id: 'constructor', status: 'active' }),
  );

  const state = foldAll('live', wires);
  const desks = selectDesks(state);
  assert.equal(desks.length, 1);
  assert.equal(desks[0]?.display_name, 'constructor');
  assert.equal(desks[0]?.session_id, '__proto__');
  assert.equal(selectHeader(state).session_count, 1);
  // The client keeps the collector's prototype-less maps, so `__proto__` is a
  // key and not a way to reach `Object.prototype`.
  assert.equal(Object.getPrototypeOf(state.actors), null);
  assert.equal(Object.getPrototypeOf(state.sessions), null);
});
