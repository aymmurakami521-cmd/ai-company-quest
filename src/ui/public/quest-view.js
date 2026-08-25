/**
 * Pure view model for the retro office screen.
 *
 * No DOM, no network, no timers and no clock of its own - a caller that needs
 * elapsed time passes the current instant in. The browser module and the Node
 * tests import this exact file, so every rule the screen applies is the rule
 * the tests assert.
 *
 * Two contracts are mirrored here and nowhere else:
 *
 * 1. The fold. `applyEvent` reproduces `src/domain/reducer.ts` for the fields the
 *    screen shows, so a client that started from a `snapshot` and then followed
 *    the stream lands on the same actor and session state the server holds.
 *    `test/ui-view.test.ts` cross-checks it against the real `reduce` over the
 *    same event sequence, so the two cannot drift apart silently.
 * 2. The isolation. A client state belongs to exactly one namespace. A frame
 *    from the other namespace is refused and counted, never mixed in - the
 *    client-side echo of the reducer's namespace-mismatch throw.
 *
 * Everything retained is bounded: actors and sessions are bounded by the
 * server's `StateLimits`, and the activity log is capped at `MAX_LOG_ENTRIES`.
 */

/** Shown instead of an `agent_id` the producer could not attribute. */
export const UNATTRIBUTED_AGENT_LABEL = 'unattributed';

/** Ceiling on the client-side activity log. */
export const MAX_LOG_ENTRIES = 50;

/** Every visual state a desk can be in, in banner priority order. */
export const ACTOR_VISUAL_STATES = Object.freeze([
  'error',
  'awaiting_approval',
  'working',
  'ended',
  'idle',
]);

/**
 * Visual vocabulary. Each state carries a symbol AND a readable label, so the
 * screen never depends on colour or animation alone to say what is happening.
 */
const ACTOR_VISUALS = Object.freeze({
  error: Object.freeze({ state: 'error', code: 'ERROR', label: 'エラー / 停止', symbol: '✖' }),
  awaiting_approval: Object.freeze({
    state: 'awaiting_approval',
    code: 'APPROVAL',
    label: '承認待ち',
    symbol: '‼',
  }),
  working: Object.freeze({ state: 'working', code: 'WORKING', label: '作業中', symbol: '▶' }),
  ended: Object.freeze({ state: 'ended', code: 'ENDED', label: '完了 / 終了', symbol: '■' }),
  idle: Object.freeze({ state: 'idle', code: 'IDLE', label: '待機中', symbol: '⋯' }),
});

/**
 * Status tokens, most specific meaning first. `status` is a sanitized free-form
 * label, so it is normalised to lowercase tokens before lookup: `Fail-Closed`,
 * `fail_closed` and `FAIL CLOSED` all classify the same way.
 */
const STATUS_TOKENS = Object.freeze({
  error: Object.freeze([
    'error', 'errored', 'fail', 'failed', 'failure', 'closed_fail', 'denied', 'deny',
    'rejected', 'halted', 'halt', 'timeout', 'timedout', 'crash', 'crashed', 'abort', 'aborted',
  ]),
  awaiting_approval: Object.freeze([
    'approval', 'approve', 'approvals', 'permission', 'permissions', 'confirm', 'confirmation',
    'consent', 'authorize', 'authorization', 'ask', 'asking',
  ]),
  working: Object.freeze([
    'active', 'running', 'run', 'working', 'work', 'busy', 'thinking', 'executing', 'execute',
    'streaming', 'started', 'start', 'progress', 'tool',
  ]),
  ended: Object.freeze([
    'ended', 'end', 'stopped', 'stop', 'completed', 'complete', 'done', 'finished', 'finish',
    'exited', 'exit', 'cancelled', 'canceled',
  ]),
  idle: Object.freeze([
    'idle', 'waiting', 'wait', 'queued', 'queue', 'ready', 'paused', 'pause', 'standby', 'sleeping',
  ]),
});

/** Connection phases the app reports, plus the labels the screen shows. */
const CONNECTION_VISUALS = Object.freeze({
  offline: Object.freeze({ state: 'offline', code: 'OFFLINE', label: '未接続', symbol: '○' }),
  connecting: Object.freeze({ state: 'connecting', code: 'CONNECTING', label: '接続中', symbol: '◌' }),
  open: Object.freeze({ state: 'open', code: 'CONNECTED', label: '接続済み', symbol: '●' }),
  reconnecting: Object.freeze({
    state: 'reconnecting',
    code: 'RECONNECTING',
    label: '再接続中',
    symbol: '◍',
  }),
  error: Object.freeze({ state: 'error', code: 'DISCONNECTED', label: '切断 / エラー', symbol: '✖' }),
  fail_closed: Object.freeze({
    state: 'fail_closed',
    code: 'FAIL_CLOSED',
    label: '取り込み停止 (fail-closed)',
    symbol: '✖',
  }),
});

/** A new prototype-less map: a `session_id` of `__proto__` is just a key. */
function emptyMap() {
  return Object.create(null);
}

function ownProp(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** Own-property copy that keeps the null prototype (spread would not). */
function copyMap(source) {
  const target = emptyMap();
  if (source === null || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) target[key] = source[key];
  return target;
}

/** Lowercase alphanumeric tokens of a sanitized status label. */
export function statusTokens(status) {
  if (typeof status !== 'string' || status.length === 0) return [];
  return status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0);
}

/**
 * Maps a status label to a visual state, or null when nothing matches. Priority
 * is fixed by `ACTOR_VISUAL_STATES`, so `completed_with_error` reads as an error
 * and `tool_use_approval` reads as an approval wait.
 */
export function classifyStatus(status) {
  const tokens = statusTokens(status);
  if (tokens.length === 0) return null;
  for (const state of ACTOR_VISUAL_STATES) {
    const vocabulary = STATUS_TOKENS[state];
    for (const token of tokens) {
      if (vocabulary.includes(token)) return state;
    }
  }
  return null;
}

/** The visual vocabulary for a state name, for legends and log rows. */
export function visualForState(state) {
  return ownProp(ACTOR_VISUALS, state) ?? ACTOR_VISUALS.idle;
}

/**
 * The one place a desk's appearance is decided.
 *
 * - a recognised `status` wins, because it is what the session actually said;
 * - an unrecognised or absent status falls back to the `active` flag the shared
 *   reducer maintains;
 * - a "working" status on an actor the reducer has already deactivated reads as
 *   ended, since the stop event is the newer fact.
 */
export function classifyActor(actor) {
  const active = actor !== null && actor !== undefined && actor.active === true;
  const classified = classifyStatus(actor === null || actor === undefined ? null : actor.status);
  if (classified === 'working' && !active) return ACTOR_VISUALS.ended;
  if (classified !== null) return ACTOR_VISUALS[classified];
  return active ? ACTOR_VISUALS.working : ACTOR_VISUALS.idle;
}

/** Connection banner. A halted (fail-closed) namespace outranks every phase. */
export function classifyConnection(connection) {
  if (connection !== null && connection !== undefined && connection.halted === true) {
    return CONNECTION_VISUALS.fail_closed;
  }
  const phase = connection === null || connection === undefined ? 'offline' : connection.phase;
  return ownProp(CONNECTION_VISUALS, phase) ?? CONNECTION_VISUALS.offline;
}

/** A fresh, empty client state bound to one namespace for its whole lifetime. */
export function createClientState(namespace) {
  return {
    namespace,
    connection: {
      phase: 'offline',
      halted: false,
      replaying: false,
      gap: null,
      last_event_id: null,
      last_frame_at_ms: null,
    },
    sessions: emptyMap(),
    actors: emptyMap(),
    last_ingest_seq: 0,
    last_event_ts: null,
    counters: { applied: 0, ignored: 0, out_of_order: 0, foreign: 0, snapshots: 0, gaps: 0 },
    log: [],
  };
}

export function setConnectionPhase(state, phase, atMs = null) {
  const known = ownProp(CONNECTION_VISUALS, phase) !== undefined && phase !== 'fail_closed';
  return {
    ...state,
    connection: {
      ...state.connection,
      phase: known ? phase : 'offline',
      last_frame_at_ms: atMs === null ? state.connection.last_frame_at_ms : atMs,
    },
  };
}

function emptyActor(wire) {
  return {
    actor_key: wire.actor_key,
    session_id: wire.session_id,
    agent_id: wire.agent_id,
    role: null,
    resolved: false,
    is_main_orchestrator: wire.is_main_orchestrator === true,
    status: null,
    active: false,
    last_tool: null,
    last_event_ts: null,
    last_ingest_seq: 0,
    event_count: 0,
  };
}

function emptySession(sessionId) {
  return { session_id: sessionId, started_at: null, ended_at: null, event_count: 0, actor_keys: [] };
}

function logEntry(wire, visual) {
  return {
    event_id: wire.event_id,
    ingest_seq: wire.ingest_seq,
    ts: wire.ts,
    event_type: wire.event_type,
    actor: wire.agent_id === null ? UNATTRIBUTED_AGENT_LABEL : wire.agent_id,
    session_id: wire.session_id,
    status: wire.status,
    tool_name: wire.tool_name,
    summary: wire.summary,
    state: visual.state,
  };
}

/**
 * Folds one wire event, mirroring `reduce` in `src/domain/reducer.ts`.
 *
 * A foreign-namespace event is refused and counted rather than applied: LIVE and
 * DEMO never mix, on the server or here.
 */
export function applyEvent(state, wire, atMs = null) {
  if (wire === null || typeof wire !== 'object' || wire.namespace !== state.namespace) {
    return { ...state, counters: { ...state.counters, foreign: state.counters.foreign + 1 } };
  }

  const previousActor = ownProp(state.actors, wire.actor_key) ?? emptyActor(wire);
  const previousSession = ownProp(state.sessions, wire.session_id) ?? emptySession(wire.session_id);

  const eventMs = Date.parse(wire.ts);
  const previousMs = previousActor.last_event_ts === null ? null : Date.parse(previousActor.last_event_ts);
  const outOfOrder = previousMs !== null && eventMs < previousMs;

  const role = wire.role ?? previousActor.role;
  let status = previousActor.status;
  let active = previousActor.active;
  let lastTool = previousActor.last_tool;
  let ignored = false;

  if (!outOfOrder) {
    switch (wire.event_type) {
      case 'session_start':
        break;
      case 'session_end':
        active = false;
        status = 'ended';
        break;
      case 'agent_start':
        active = true;
        status = wire.status ?? 'active';
        break;
      case 'agent_stop':
        active = false;
        status = wire.status ?? 'stopped';
        break;
      case 'agent_status':
        if (wire.status !== null) status = wire.status;
        break;
      case 'tool_use':
        if (wire.tool_name !== null) lastTool = wire.tool_name;
        if (wire.status !== null) status = wire.status;
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

  const nextActor = {
    ...previousActor,
    role,
    resolved: role !== null,
    is_main_orchestrator: wire.is_main_orchestrator === true,
    status,
    active,
    last_tool: lastTool,
    last_event_ts: outOfOrder ? previousActor.last_event_ts : wire.ts,
    last_ingest_seq: wire.ingest_seq,
    event_count: previousActor.event_count + 1,
  };

  let nextActors = copyMap(state.actors);
  nextActors[wire.actor_key] = nextActor;
  if (!outOfOrder && wire.event_type === 'session_end') {
    const deactivated = emptyMap();
    for (const key of Object.keys(nextActors)) {
      const actor = nextActors[key];
      deactivated[key] =
        actor.session_id === wire.session_id && actor.active
          ? { ...actor, active: false, status: 'ended' }
          : actor;
    }
    nextActors = deactivated;
  }

  const actorKeys = previousSession.actor_keys.includes(wire.actor_key)
    ? previousSession.actor_keys
    : [...previousSession.actor_keys, wire.actor_key];

  const nextSessions = copyMap(state.sessions);
  nextSessions[wire.session_id] = {
    ...previousSession,
    started_at:
      !outOfOrder && wire.event_type === 'session_start' && previousSession.started_at === null
        ? wire.ts
        : previousSession.started_at,
    ended_at: !outOfOrder && wire.event_type === 'session_end' ? wire.ts : previousSession.ended_at,
    event_count: previousSession.event_count + 1,
    actor_keys: actorKeys,
  };

  const log = [logEntry(wire, classifyActor(nextActor)), ...state.log].slice(0, MAX_LOG_ENTRIES);

  return {
    ...state,
    connection: {
      ...state.connection,
      last_event_id: wire.event_id,
      last_frame_at_ms: atMs === null ? state.connection.last_frame_at_ms : atMs,
    },
    sessions: nextSessions,
    actors: nextActors,
    last_ingest_seq: Math.max(state.last_ingest_seq, wire.ingest_seq),
    last_event_ts: outOfOrder ? state.last_event_ts : wire.ts,
    counters: {
      ...state.counters,
      applied: state.counters.applied + 1,
      ignored: state.counters.ignored + (ignored ? 1 : 0),
      out_of_order: state.counters.out_of_order + (outOfOrder ? 1 : 0),
    },
    log,
  };
}

/**
 * Replaces the whole view with the server's authoritative state. This is the
 * recovery path after a `stream_gap`, so it also clears the gap banner.
 */
export function applySnapshot(state, payload, atMs = null) {
  if (payload === null || typeof payload !== 'object' || payload.namespace !== state.namespace) {
    return { ...state, counters: { ...state.counters, foreign: state.counters.foreign + 1 } };
  }
  const served = payload.state === null || typeof payload.state !== 'object' ? {} : payload.state;
  const actors = copyMap(served.actors);
  let latestTs = null;
  for (const key of Object.keys(actors)) {
    const ts = actors[key].last_event_ts;
    if (typeof ts === 'string' && (latestTs === null || ts > latestTs)) latestTs = ts;
  }
  return {
    ...state,
    connection: {
      ...state.connection,
      halted: payload.halted === true,
      replaying: false,
      gap: null,
      last_frame_at_ms: atMs === null ? state.connection.last_frame_at_ms : atMs,
    },
    sessions: copyMap(served.sessions),
    actors,
    last_ingest_seq: typeof payload.last_ingest_seq === 'number' ? payload.last_ingest_seq : 0,
    last_event_ts: latestTs,
    counters: { ...state.counters, snapshots: state.counters.snapshots + 1 },
  };
}

/**
 * Routes one SSE frame. Unknown frame kinds are counted, never guessed at.
 *
 * `stream_gap` is surfaced as an explicit banner and left standing until the
 * `snapshot` that follows it clears it - the server never fills a gap silently,
 * and neither does the screen.
 */
export function applyFrame(state, frame) {
  if (frame === null || typeof frame !== 'object') return state;
  const atMs = typeof frame.at_ms === 'number' ? frame.at_ms : null;
  switch (frame.kind) {
    case 'event':
      return applyEvent(state, frame.payload, atMs);
    case 'snapshot':
      return applySnapshot(state, frame.payload, atMs);
    case 'replay_start':
      return {
        ...state,
        connection: { ...state.connection, replaying: true, last_frame_at_ms: atMs ?? state.connection.last_frame_at_ms },
      };
    case 'replay_end':
      return {
        ...state,
        connection: { ...state.connection, replaying: false, last_frame_at_ms: atMs ?? state.connection.last_frame_at_ms },
      };
    case 'stream_gap': {
      const payload = frame.payload === null || typeof frame.payload !== 'object' ? {} : frame.payload;
      const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
      return {
        ...state,
        connection: {
          ...state.connection,
          gap: { reason },
          last_frame_at_ms: atMs ?? state.connection.last_frame_at_ms,
        },
        counters: { ...state.counters, gaps: state.counters.gaps + 1 },
      };
    }
    default:
      return { ...state, counters: { ...state.counters, ignored: state.counters.ignored + 1 } };
  }
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Deterministic seating: sessions by start time then id, and within a session
 * the main orchestrator first, then agents by id, with the unattributed actor
 * last. The same state always produces the same office layout.
 */
export function selectDesks(state) {
  const sessions = Object.keys(state.sessions).sort((a, b) => {
    const left = state.sessions[a];
    const right = state.sessions[b];
    const leftStart = left.started_at ?? '';
    const rightStart = right.started_at ?? '';
    if (leftStart !== rightStart) return compareStrings(leftStart, rightStart);
    return compareStrings(a, b);
  });
  const order = emptyMap();
  sessions.forEach((sessionId, index) => {
    order[sessionId] = index;
  });

  const actors = Object.keys(state.actors).map((key) => state.actors[key]);
  actors.sort((left, right) => {
    const leftSession = ownProp(order, left.session_id) ?? sessions.length;
    const rightSession = ownProp(order, right.session_id) ?? sessions.length;
    if (leftSession !== rightSession) return leftSession - rightSession;
    if (left.is_main_orchestrator !== right.is_main_orchestrator) return left.is_main_orchestrator ? -1 : 1;
    if (left.agent_id === null || right.agent_id === null) {
      if (left.agent_id !== right.agent_id) return left.agent_id === null ? 1 : -1;
    } else if (left.agent_id !== right.agent_id) {
      return compareStrings(left.agent_id, right.agent_id);
    }
    return compareStrings(left.actor_key, right.actor_key);
  });

  return actors.map((actor, index) => {
    const visual = classifyActor(actor);
    return {
      seat: index + 1,
      actor_key: actor.actor_key,
      session_id: actor.session_id,
      display_name: actor.agent_id === null ? UNATTRIBUTED_AGENT_LABEL : actor.agent_id,
      is_main_orchestrator: actor.is_main_orchestrator === true,
      // Roles are shown only when the collector actually resolved one. This
      // screen never guesses a job title from a structural fact.
      role: actor.resolved === true ? actor.role : null,
      resolved: actor.resolved === true,
      status_label: actor.status,
      last_tool: actor.last_tool,
      last_event_ts: actor.last_event_ts,
      event_count: actor.event_count,
      visual,
    };
  });
}

/** Header summary: mode, connection, counts and the emptiness of the office. */
export function selectHeader(state) {
  const desks = selectDesks(state);
  const byState = emptyMap();
  for (const name of ACTOR_VISUAL_STATES) byState[name] = 0;
  for (const desk of desks) byState[desk.visual.state] += 1;
  return {
    mode: state.namespace === 'live' ? 'LIVE' : 'DEMO',
    namespace: state.namespace,
    connection: classifyConnection(state.connection),
    halted: state.connection.halted === true,
    replaying: state.connection.replaying === true,
    gap: state.connection.gap,
    empty: desks.length === 0,
    desk_count: desks.length,
    session_count: Object.keys(state.sessions).length,
    last_ingest_seq: state.last_ingest_seq,
    last_event_ts: state.last_event_ts,
    last_frame_at_ms: state.connection.last_frame_at_ms,
    by_state: byState,
  };
}

/**
 * "N秒前" for the last frame. `nowMs` is injected so the caller owns the clock
 * and the tests stay deterministic.
 */
export function describeFreshness(state, nowMs) {
  const at = state.connection.last_frame_at_ms;
  if (typeof at !== 'number' || typeof nowMs !== 'number') return '未受信';
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000));
  if (seconds < 1) return 'たった今';
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  return `${Math.floor(minutes / 60)}時間前`;
}
