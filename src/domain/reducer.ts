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
 *   handling. Events cannot change it, ever. The `org` slot is held on exactly
 *   the same terms: it comes from configuration, not from the stream.
 * - A state belongs to exactly one namespace; folding a foreign-namespace event
 *   throws instead of silently mixing LIVE and DEMO.
 * - Everything the state retains per event is bounded by explicit limits carried
 *   in the state itself. An event that would grow a retention structure past its
 *   limit is refused, never applied partially and never silently evicted: the
 *   collector turns that refusal into a fail-closed halt, so what is served
 *   always remains a complete prefix of the stream.
 * - Every map keyed by stream content is prototype-less and read through
 *   `ownProperty`, so an identifier like `__proto__` or `constructor` is just an
 *   identifier and can never resolve to an inherited `Object.prototype` member.
 */

import type { Namespace, SanitizedEvent } from './event.ts';
import type { ResolvedActor } from './actor.ts';
import type { OrgState } from './orgSnapshot.ts';
import { ORG_ABSENT } from './orgSnapshot.ts';
import { copyRecord, emptyRecord, ownProperty } from './record.ts';

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

/**
 * Ceilings on every structure whose size is driven by event content. They are
 * part of the state so that a replay of the same stream through the same limits
 * is bit-for-bit the same fold, wherever it runs.
 */
export type StateLimits = {
  /** Distinct `session_id` values retained. */
  max_sessions: number;
  /** Distinct actors retained across all sessions. */
  max_actors: number;
  /** Length of any single session's `actor_keys` list. */
  max_actors_per_session: number;
  /** Distinct `event_type` buckets in `counters.by_type`. */
  max_event_types: number;
};

/**
 * Sized for a local workstation: far above any plausible sanitized session, far
 * below anything that could exhaust a Node heap. Roughly a few MB of state at
 * the ceiling, which is also the worst case for an SSE snapshot.
 */
export const DEFAULT_STATE_LIMITS: StateLimits = {
  max_sessions: 512,
  max_actors: 4096,
  max_actors_per_session: 256,
  max_event_types: 64,
};

export type StateLimitKind = 'sessions' | 'actors' | 'actors_per_session' | 'event_types';

/** Which ceiling an event would have crossed. Carries no identifier, ever. */
export type StateLimitViolation = {
  limit: StateLimitKind;
  max: number;
};

export type QuestState = {
  namespace: Namespace;
  player: PlayerEntity;
  /**
   * The validated organisation snapshot, or the reason there is none.
   *
   * Independent of the event state on purpose (see `domain/orgSnapshot.ts`):
   * it is supplied once at startup from configuration, `reduce` only carries it
   * by reference, and no event can create, change or remove it.
   */
  org: OrgState;
  limits: StateLimits;
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

/**
 * Raised by `reduce` for an event that would push a retention structure past its
 * limit. The message names the limit and its value only - never a `session_id`,
 * an `agent_id`, an `event_type` or any other stream content.
 */
export class StateLimitExceededError extends Error {
  readonly limit: StateLimitKind;
  readonly max: number;
  /** Sanitized, safe for health output and logs. */
  readonly detail: string;

  constructor(violation: StateLimitViolation) {
    super(`state limit reached: ${violation.limit}:${violation.max}`);
    this.name = 'StateLimitExceededError';
    this.limit = violation.limit;
    this.max = violation.max;
    this.detail = `${violation.limit}:${violation.max}`;
  }
}

export function createInitialState(
  namespace: Namespace,
  player: PlayerEntity = DEFAULT_PLAYER,
  limits: StateLimits = DEFAULT_STATE_LIMITS,
  org: OrgState = ORG_ABSENT,
): QuestState {
  return {
    namespace,
    player,
    org,
    limits: { ...limits },
    sessions: emptyRecord<SessionState>(),
    actors: emptyRecord<ActorState>(),
    last_ingest_seq: 0,
    counters: { applied: 0, ignored: 0, out_of_order: 0, by_type: emptyRecord<number>() },
  };
}

/**
 * Reports the ceiling `ingested` would cross, or null when it fits. Only *new*
 * keys count: an event for an already-tracked actor, session or event type adds
 * nothing to retain and is always allowed, so a live session never starts
 * failing because of its own event volume.
 */
export function checkStateLimits(state: QuestState, ingested: IngestedEvent): StateLimitViolation | null {
  const limits = state.limits;
  const sessionId = ingested.event.session_id;
  const actorKey = ingested.actor.actor_key;
  // Own-property lookups: a `session_id` of `__proto__` or `constructor` must
  // read as "not tracked yet", not as an inherited `Object.prototype` member.
  const session = ownProperty(state.sessions, sessionId);

  if (session === undefined && Object.keys(state.sessions).length >= limits.max_sessions) {
    return { limit: 'sessions', max: limits.max_sessions };
  }
  if (ownProperty(state.actors, actorKey) === undefined && Object.keys(state.actors).length >= limits.max_actors) {
    return { limit: 'actors', max: limits.max_actors };
  }
  if (
    session !== undefined &&
    !session.actor_keys.includes(actorKey) &&
    session.actor_keys.length >= limits.max_actors_per_session
  ) {
    return { limit: 'actors_per_session', max: limits.max_actors_per_session };
  }
  if (
    ownProperty(state.counters.by_type, ingested.event.event_type) === undefined &&
    Object.keys(state.counters.by_type).length >= limits.max_event_types
  ) {
    return { limit: 'event_types', max: limits.max_event_types };
  }
  return null;
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

  const violation = checkStateLimits(state, ingested);
  if (violation !== null) throw new StateLimitExceededError(violation);

  const event = ingested.event;
  const actorKey = ingested.actor.actor_key;
  const previousActor = ownProperty(state.actors, actorKey) ?? emptyActor(ingested);
  const previousSession = ownProperty(state.sessions, event.session_id) ?? emptySession(event.session_id);

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

  let nextActors: Record<string, ActorState> = copyRecord(state.actors);
  nextActors[actorKey] = nextActor;
  if (!outOfOrder && event.event_type === 'session_end') {
    const deactivated: Record<string, ActorState> = emptyRecord<ActorState>();
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

  const byType: Record<string, number> = copyRecord(state.counters.by_type);
  byType[event.event_type] = (ownProperty(byType, event.event_type) ?? 0) + 1;

  const nextSessions = copyRecord(state.sessions);
  nextSessions[event.session_id] = nextSession;

  return {
    namespace: state.namespace,
    // Carried by reference on purpose: events can never touch the player.
    player: state.player,
    // Same rule for the org snapshot: it is configuration, and no event may
    // create, update or invalidate it.
    org: state.org,
    // Likewise: limits are configuration, not something a producer can raise.
    limits: state.limits,
    sessions: nextSessions,
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
