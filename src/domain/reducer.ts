/**
 * The single shared reducer.
 *
 * This module is pure: no I/O, no timers, no globals. The collector, the future
 * UI, replay tooling and the tests all fold events through this exact function,
 * so a replayed stream and a live stream can never diverge.
 *
 * Invariants enforced here:
 * - `reduce` never mutates its input state.
 * - The human `player` entity is not an input to, nor an output of, event
 *   handling. Events cannot change it, ever.
 * - A state belongs to exactly one namespace; folding a foreign-namespace event
 *   throws instead of silently mixing LIVE and DEMO.
 */

import type { Namespace, SanitizedEvent } from './event.ts';
import type { ResolvedActor } from './actor.ts';

/** An accepted, de-duplicated event with its collector-assigned sequence. */
export type IngestedEvent = {
  namespace: Namespace;
  /** Deterministic, monotonically increasing, assigned by the collector only. */
  ingest_seq: number;
  event: SanitizedEvent;
  actor: ResolvedActor;
};

/**
 * The human operator. Owned by the UI layer, never by the event stream.
 */
export type PlayerEntity = {
  readonly kind: 'player';
  readonly id: string;
  readonly display_name: string;
};

export type ActorState = {
  actor_key: string;
  session_id: string;
  agent_id: string | null;
  role: string | null;
  resolved: boolean;
  role_source: ResolvedActor['role_source'];
  is_main_orchestrator: boolean;
  status: string | null;
  active: boolean;
  last_tool: string | null;
  last_event_ts: string | null;
  last_ingest_seq: number;
  event_count: number;
};

export type SessionState = {
  session_id: string;
  started_at: string | null;
  ended_at: string | null;
  event_count: number;
  actor_keys: string[];
};

export type StateCounters = {
  applied: number;
  ignored: number;
  out_of_order: number;
  by_type: Record<string, number>;
};

export type QuestState = {
  namespace: Namespace;
  player: PlayerEntity;
  sessions: Record<string, SessionState>;
  actors: Record<string, ActorState>;
  last_ingest_seq: number;
  counters: StateCounters;
};

export const DEFAULT_PLAYER: PlayerEntity = {
  kind: 'player',
  id: 'player',
  display_name: 'Player',
};

export function createInitialState(namespace: Namespace, player: PlayerEntity = DEFAULT_PLAYER): QuestState {
  return {
    namespace,
    player,
    sessions: {},
    actors: {},
    last_ingest_seq: 0,
    counters: { applied: 0, ignored: 0, out_of_order: 0, by_type: {} },
  };
}

function emptyActor(ingested: IngestedEvent): ActorState {
  const actor = ingested.actor;
  return {
    actor_key: actor.actor_key,
    session_id: actor.session_id,
    agent_id: actor.agent_id,
    role: null,
    resolved: false,
    role_source: 'none',
    is_main_orchestrator: actor.is_main_orchestrator,
    status: null,
    active: false,
    last_tool: null,
    last_event_ts: null,
    last_ingest_seq: 0,
    event_count: 0,
  };
}

function emptySession(sessionId: string): SessionState {
  return { session_id: sessionId, started_at: null, ended_at: null, event_count: 0, actor_keys: [] };
}

/**
 * Folds one ingested event into the state and returns a new state object.
 * Ordering is defined by `ingest_seq`; events whose `ts` moves backwards for an
 * actor are counted as out-of-order and do not overwrite that actor's latest
 * observed status.
 */
export function reduce(state: QuestState, ingested: IngestedEvent): QuestState {
  if (ingested.namespace !== state.namespace) {
    throw new Error(`namespace mismatch: state=${state.namespace} event=${ingested.namespace}`);
  }

  const event = ingested.event;
  const actorKey = ingested.actor.actor_key;
  const previousActor = state.actors[actorKey] ?? emptyActor(ingested);
  const previousSession = state.sessions[event.session_id] ?? emptySession(event.session_id);

  const eventMs = Date.parse(event.ts);
  const previousMs = previousActor.last_event_ts === null ? null : Date.parse(previousActor.last_event_ts);
  const outOfOrder = previousMs !== null && eventMs < previousMs;

  const role = ingested.actor.role ?? previousActor.role;
  const roleSource = ingested.actor.role !== null ? ingested.actor.role_source : previousActor.role_source;

  let status = previousActor.status;
  let active = previousActor.active;
  let lastTool = previousActor.last_tool;
  let ignored = false;

  if (!outOfOrder) {
    switch (event.event_type) {
      case 'session_start':
        break;
      case 'session_end':
        active = false;
        status = 'ended';
        break;
      case 'agent_start':
        active = true;
        status = event.status ?? 'active';
        break;
      case 'agent_stop':
        active = false;
        status = event.status ?? 'stopped';
        break;
      case 'agent_status':
        if (event.status !== null) status = event.status;
        break;
      case 'tool_use':
        if (event.tool_name !== null) lastTool = event.tool_name;
        if (event.status !== null) status = event.status;
        break;
      case 'handoff':
        break;
      case 'heartbeat':
        break;
      default:
        // Well-formed but unknown event type: recorded, never interpreted.
        ignored = true;
        break;
    }
  }

  const nextActor: ActorState = {
    ...previousActor,
    role,
    resolved: role !== null,
    role_source: roleSource,
    status,
    active,
    last_tool: lastTool,
    last_event_ts: outOfOrder ? previousActor.last_event_ts : event.ts,
    last_ingest_seq: ingested.ingest_seq,
    event_count: previousActor.event_count + 1,
  };

  let nextActors: Record<string, ActorState> = { ...state.actors, [actorKey]: nextActor };
  if (!outOfOrder && event.event_type === 'session_end') {
    const deactivated: Record<string, ActorState> = {};
    for (const [key, actor] of Object.entries(nextActors)) {
      deactivated[key] =
        actor.session_id === event.session_id && actor.active ? { ...actor, active: false, status: 'ended' } : actor;
    }
    nextActors = deactivated;
  }

  const actorKeys = previousSession.actor_keys.includes(actorKey)
    ? previousSession.actor_keys
    : [...previousSession.actor_keys, actorKey];

  const nextSession: SessionState = {
    ...previousSession,
    started_at:
      !outOfOrder && event.event_type === 'session_start' && previousSession.started_at === null
        ? event.ts
        : previousSession.started_at,
    ended_at: !outOfOrder && event.event_type === 'session_end' ? event.ts : previousSession.ended_at,
    event_count: previousSession.event_count + 1,
    actor_keys: actorKeys,
  };

  const byType: Record<string, number> = { ...state.counters.by_type };
  byType[event.event_type] = (byType[event.event_type] ?? 0) + 1;

  return {
    namespace: state.namespace,
    // Carried by reference on purpose: events can never touch the player.
    player: state.player,
    sessions: { ...state.sessions, [event.session_id]: nextSession },
    actors: nextActors,
    last_ingest_seq: Math.max(state.last_ingest_seq, ingested.ingest_seq),
    counters: {
      applied: state.counters.applied + 1,
      ignored: state.counters.ignored + (ignored ? 1 : 0),
      out_of_order: state.counters.out_of_order + (outOfOrder ? 1 : 0),
      by_type: byType,
    },
  };
}

export function reduceAll(state: QuestState, events: readonly IngestedEvent[]): QuestState {
  let next = state;
  for (const event of events) next = reduce(next, event);
  return next;
}
