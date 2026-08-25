/**
 * Deterministic DEMO fixtures.
 *
 * These events exist so the SSE contract and the retro office screen can be
 * exercised without a live Claude Code session. They are only ever fed into the
 * DEMO store; nothing in this file is reachable from the LIVE ingest path.
 *
 * The sequence is chosen so that folding all of it leaves one desk in each of
 * the five visual states the screen distinguishes - working, approval waiting,
 * idle, error and ended - in a single fixed frame. There are no timers and no
 * wall-clock dependency: the same fixtures always produce the same screen.
 */

import type { SanitizedEvent } from '../domain/event.ts';
import type { NamespaceStore } from '../collector/store.ts';

const BASE: Omit<SanitizedEvent, 'event_id' | 'ts' | 'event_type'> = {
  schema_version: 2,
  sanitizer_version: 3,
  session_id: 'demo-session-01',
  agent_id: 'main',
  agent_role: null,
  producer_seq: null,
  status: null,
  tool_name: null,
  duration_ms: null,
  token_count: null,
  summary: null,
};

/** The second demo session exists only to show a finished team. */
const CLOSED_SESSION = 'demo-session-02';

export const DEMO_EVENTS: readonly SanitizedEvent[] = [
  {
    ...BASE,
    event_id: '11111111-1111-4111-8111-111111111111',
    ts: '2026-01-01T00:00:00.000Z',
    event_type: 'session_start',
    summary: 'demo session started',
  },
  {
    ...BASE,
    event_id: '22222222-2222-4222-8222-222222222222',
    ts: '2026-01-01T00:00:01.000Z',
    event_type: 'agent_start',
    status: 'active',
    summary: 'main orchestrator online',
  },
  {
    ...BASE,
    event_id: '33333333-3333-4333-9333-333333333333',
    ts: '2026-01-01T00:00:02.000Z',
    event_type: 'agent_start',
    agent_id: 'worker-1',
    status: 'active',
    summary: 'worker online',
  },
  {
    ...BASE,
    event_id: '44444444-4444-4444-a444-444444444444',
    ts: '2026-01-01T00:00:03.000Z',
    event_type: 'tool_use',
    agent_id: 'worker-1',
    tool_name: 'read',
    status: 'running',
    duration_ms: 12,
    summary: 'read a repository file',
  },
  // Approval waiting: a tool call that stopped for the operator.
  {
    ...BASE,
    event_id: '55555555-5555-4555-b555-555555555555',
    ts: '2026-01-01T00:00:04.000Z',
    event_type: 'agent_start',
    agent_id: 'worker-2',
    status: 'active',
    summary: 'second worker online',
  },
  {
    ...BASE,
    event_id: '66666666-6666-4666-8666-666666666666',
    ts: '2026-01-01T00:00:05.000Z',
    event_type: 'tool_use',
    agent_id: 'worker-2',
    tool_name: 'shell',
    status: 'awaiting_approval',
    summary: 'waiting for the operator to approve a tool call',
  },
  // Idle: online, nothing to do.
  {
    ...BASE,
    event_id: '77777777-7777-4777-9777-777777777777',
    ts: '2026-01-01T00:00:06.000Z',
    event_type: 'agent_start',
    agent_id: 'worker-3',
    status: 'idle',
    summary: 'third worker online and idle',
  },
  // Error: started, then stopped with a failure status.
  {
    ...BASE,
    event_id: '88888888-8888-4888-a888-888888888888',
    ts: '2026-01-01T00:00:07.000Z',
    event_type: 'agent_start',
    agent_id: 'worker-4',
    status: 'active',
    summary: 'fourth worker online',
  },
  {
    ...BASE,
    event_id: '99999999-9999-4999-b999-999999999999',
    ts: '2026-01-01T00:00:08.000Z',
    event_type: 'agent_stop',
    agent_id: 'worker-4',
    status: 'error',
    summary: 'a tool call failed and the agent stopped',
  },
  // Working: the orchestrator keeps coordinating after the workers report in.
  {
    ...BASE,
    event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ts: '2026-01-01T00:00:09.000Z',
    event_type: 'agent_status',
    status: 'working',
    summary: 'coordinating the demo team',
  },
  // A second session that finishes, so the screen also shows a completed desk.
  {
    ...BASE,
    event_id: 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb',
    session_id: CLOSED_SESSION,
    ts: '2026-01-01T00:00:10.000Z',
    event_type: 'session_start',
    summary: 'earlier demo session started',
  },
  {
    ...BASE,
    event_id: 'cccccccc-cccc-4ccc-accc-cccccccccccc',
    session_id: CLOSED_SESSION,
    ts: '2026-01-01T00:00:11.000Z',
    event_type: 'agent_start',
    status: 'active',
    summary: 'earlier orchestrator online',
  },
  {
    ...BASE,
    event_id: 'dddddddd-dddd-4ddd-bddd-dddddddddddd',
    session_id: CLOSED_SESSION,
    ts: '2026-01-01T00:00:12.000Z',
    event_type: 'session_end',
    summary: 'earlier demo session finished',
  },
];

/** Feeds the fixtures into a DEMO store. Throws if handed a LIVE store. */
export function seedDemoStore(store: NamespaceStore): number {
  if (store.namespace !== 'demo') {
    throw new Error(`refusing to seed demo fixtures into namespace '${store.namespace}'`);
  }
  let accepted = 0;
  for (const event of DEMO_EVENTS) {
    const outcome = store.ingestObject(event);
    if (outcome.status === 'accepted') accepted += 1;
  }
  return accepted;
}
