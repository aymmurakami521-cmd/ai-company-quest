/**
 * Deterministic DEMO fixtures.
 *
 * These events exist so the SSE contract can be exercised without a live Claude
 * Code session. They are only ever fed into the DEMO store; nothing in this file
 * is reachable from the LIVE ingest path.
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
    duration_ms: 12,
    summary: 'read a repository file',
  },
  {
    ...BASE,
    event_id: '55555555-5555-4555-b555-555555555555',
    ts: '2026-01-01T00:00:04.000Z',
    event_type: 'session_end',
    summary: 'demo session finished',
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
