/**
 * Wire projection for SSE.
 *
 * Everything leaving the process goes through this whitelist. The projection is
 * built field by field (never spread from the producer object) so that a future
 * schema addition cannot silently start streaming unmodelled data.
 */

import type { Namespace } from './event.ts';
import type { IngestedEvent } from './reducer.ts';

export type WireEvent = {
  event_id: string;
  ingest_seq: number;
  namespace: Namespace;
  ts: string;
  event_type: string;
  session_id: string;
  actor_key: string;
  agent_id: string | null;
  role: string | null;
  resolved: boolean;
  is_main_orchestrator: boolean;
  status: string | null;
  tool_name: string | null;
  duration_ms: number | null;
  token_count: number | null;
  summary: string | null;
  schema_version: number;
  sanitizer_version: number;
};

/** The exact set of keys that may appear on the wire. */
export const WIRE_EVENT_KEYS: readonly string[] = [
  'event_id',
  'ingest_seq',
  'namespace',
  'ts',
  'event_type',
  'session_id',
  'actor_key',
  'agent_id',
  'role',
  'resolved',
  'is_main_orchestrator',
  'status',
  'tool_name',
  'duration_ms',
  'token_count',
  'summary',
  'schema_version',
  'sanitizer_version',
];

export function toWireEvent(ingested: IngestedEvent): WireEvent {
  const event = ingested.event;
  const actor = ingested.actor;
  return {
    event_id: event.event_id,
    ingest_seq: ingested.ingest_seq,
    namespace: ingested.namespace,
    ts: event.ts,
    event_type: event.event_type,
    session_id: event.session_id,
    actor_key: actor.actor_key,
    agent_id: actor.agent_id,
    role: actor.role,
    resolved: actor.resolved,
    is_main_orchestrator: actor.is_main_orchestrator,
    status: event.status,
    tool_name: event.tool_name,
    duration_ms: event.duration_ms,
    token_count: event.token_count,
    summary: event.summary,
    schema_version: event.schema_version,
    sanitizer_version: event.sanitizer_version,
  };
}
