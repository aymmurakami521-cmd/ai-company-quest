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

/**
 * Ceiling on the human player's display name, mirroring `loadConfig`'s own cap
 * on `QUEST_PLAYER_NAME`. Applied again here because the screen trusts the
 * length of nothing it did not measure itself.
 */
export const PLAYER_NAME_MAX = 64;

/** Ceiling on the client-side activity log. */
export const MAX_LOG_ENTRIES = 50;

/**
 * Every visual state a *status label* can be classified into, in priority order.
 *
 * `unknown` is deliberately absent: it is not something a status can match, it
 * is where the screen lands when it refuses to guess. See `classifyActor`.
 */
export const ACTOR_VISUAL_STATES = Object.freeze([
  'error',
  'awaiting_approval',
  'planning',
  'working',
  'ended',
  'idle',
]);

/**
 * Every state the screen can actually display, including `unknown`.
 *
 * The legend and `selectHeader`'s per-state counts iterate this list, not
 * `ACTOR_VISUAL_STATES`: a desk that lands on `unknown` must have a legend row
 * to explain it and a counter bucket to land in. Counting into an uninitialised
 * bucket would produce `NaN` in the header instead of a number.
 */
export const ACTOR_LEGEND_STATES = Object.freeze([...ACTOR_VISUAL_STATES, 'unknown']);

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
  planning: Object.freeze({ state: 'planning', code: 'PLANNING', label: '計画中', symbol: '◆' }),
  working: Object.freeze({ state: 'working', code: 'WORKING', label: '作業中', symbol: '▶' }),
  ended: Object.freeze({ state: 'ended', code: 'ENDED', label: '完了 / 終了', symbol: '■' }),
  idle: Object.freeze({ state: 'idle', code: 'IDLE', label: '待機中', symbol: '⋯' }),
  /**
   * Not a state the session reported - the state the screen has when it will
   * not guess. Reached two ways: a status label this vocabulary does not know,
   * and a desk whose stream is no longer live (see `selectDesks`).
   */
  unknown: Object.freeze({ state: 'unknown', code: 'UNKNOWN', label: '状態不明', symbol: '?' }),
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
  /**
   * Only labels that say the session is *in a planning phase*. Deliberately
   * narrow: `thinking`, `reasoning` and `designing` are what an agent does while
   * working, not a declared planning phase, so they stay in `working` below. The
   * screen must never infer "planning" from a word that merely sounds like it.
   *
   * `statusTokens` splits on non-alphanumerics, so `plan_mode` and `plan-mode`
   * both reduce to the `plan` token and are covered here.
   */
  planning: Object.freeze(['plan', 'planning']),
  working: Object.freeze([
    'active', 'running', 'run', 'working', 'work', 'busy', 'thinking', 'executing', 'execute',
    'streaming', 'started', 'start', 'progress', 'tool',
    // Listed explicitly so they classify as work rather than falling through to
    // `unknown` now that an unrecognised label no longer guesses.
    'reasoning', 'designing', 'design', 'implementing', 'implement', 'building', 'build',
    'testing', 'test', 'reviewing', 'review', 'verifying', 'verify',
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

/**
 * Halt reasons, as a closed vocabulary. The server sends a token from this set;
 * anything else is treated as an unlabelled halt rather than rendered verbatim,
 * so the banner can never show an arbitrary string from the wire.
 */
const HALT_LABELS = Object.freeze({
  unsupported_schema: '未対応のschema versionを検出しました',
  state_limit: 'stateの上限に到達しました',
  producer_capacity: '記録側の容量上限に達し、以降の履歴が欠落しています',
});

/**
 * Stream-gap reasons, as a closed vocabulary too.
 *
 * `server.ts` emits exactly these three tokens on the replay path. Anything else
 * is reported as an unlabelled gap: the screen says a gap happened and how it
 * recovers, but it never echoes an arbitrary string off the wire.
 */
const GAP_LABELS = Object.freeze({
  invalid_last_event_id: 'Last-Event-IDの形式が不正でした',
  unknown_event_id: '再接続時のLast-Event-IDがreplay bufferにありませんでした',
  evicted: 'replay bufferから溢れた分があります',
});

/**
 * The human player, from a snapshot's `state.player`, or null.
 *
 * The player is a *different kind of entity* from a seated actor and is kept
 * apart from `actors` for exactly one reason: `reduce` in
 * `src/domain/reducer.ts` never writes it, so no Claude event can move, rename
 * or remove the person at the keyboard. Mirroring it into `actors` would put it
 * on the path every event walks, which is the one thing that contract forbids.
 *
 * Only the three fields the entity contract defines are kept, and the name is
 * re-clamped here: a payload is data to be checked, not to be trusted.
 */
export function normalizePlayer(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  if (raw.kind !== 'player') return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  const name = typeof raw.display_name === 'string' ? raw.display_name : '';
  return {
    kind: 'player',
    id: raw.id.slice(0, PLAYER_NAME_MAX),
    // An empty name would render as a blank figure with no way to tell who it
    // is, so the entity's own default stands in - never an invented person.
    display_name: name.length === 0 ? 'Player' : name.slice(0, PLAYER_NAME_MAX),
  };
}

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
 * - a "working" status on an actor the reducer has already deactivated reads as
 *   ended, since the stop event is the newer fact;
 * - a status that is *present but unrecognised* reads as `unknown`. The producer
 *   said something this screen cannot interpret, and reporting that honestly is
 *   the only correct answer - guessing "working" or "idle" from the `active`
 *   flag would be the screen inventing a state the session never claimed;
 * - a status that is *absent* still falls back to `active`, because that flag is
 *   a structural fact the shared reducer derives from `event_type` (an
 *   `agent_start` happened, or an `agent_stop` did). That is an observation, not
 *   a guess, which is why it survives while the case above does not.
 */
export function classifyActor(actor) {
  const present = actor !== null && actor !== undefined;
  const active = present && actor.active === true;
  const status = present ? actor.status : null;
  const classified = classifyStatus(status);
  if (classified === 'working' && !active) return ACTOR_VISUALS.ended;
  if (classified !== null) return ACTOR_VISUALS[classified];
  if (typeof status === 'string' && status.length > 0) return ACTOR_VISUALS.unknown;
  return active ? ACTOR_VISUALS.working : ACTOR_VISUALS.idle;
}

/**
 * Reduces a halt reason to a known token. `/health`-style `reason:detail`
 * strings are accepted, and only the reason part is kept - the detail is a
 * boundary fact for logs and health, not something the screen repeats.
 */
export function normalizeHaltReason(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const token = value.split(':')[0] ?? '';
  return ownProp(HALT_LABELS, token) === undefined ? null : token;
}

/** Readable text for a halt reason, or null when there is nothing certain to say. */
export function haltLabel(reason) {
  const token = normalizeHaltReason(reason);
  return token === null ? null : HALT_LABELS[token];
}

/** Reduces a stream-gap reason to a known token, or null for an unlabelled gap. */
export function normalizeGapReason(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return ownProp(GAP_LABELS, value) === undefined ? null : value;
}

/** Readable text for a stream-gap reason, or null when the token is unknown. */
export function gapLabel(reason) {
  const token = normalizeGapReason(reason);
  return token === null ? null : GAP_LABELS[token];
}

/**
 * Connection phases that mean "this office was being fed by a stream, and is
 * not any more".
 *
 * `offline` is deliberately NOT one of them. It is the phase a client state is
 * born in and the one it returns to when the namespace is switched, and both of
 * those rebuild the office from empty - so `offline` means "no stream yet",
 * never "the stream we had is gone". `connecting` is excluded for the same
 * reason: it is the first moment of a fresh stream, before the snapshot that
 * fills the office has even arrived.
 *
 * `error` and `reconnecting` are the two phases the app reports when a live
 * stream drops, which is exactly the case this guards.
 */
const STALE_PHASES = Object.freeze(['reconnecting', 'error']);

/**
 * Whether what the screen holds is still being confirmed by a live stream.
 *
 * A halt (fail-closed) counts, and so does a socket that is gone or retrying:
 * in every one of those cases the newest fact on screen is as old as the
 * disconnection, and continuing to paint it as a current state would be the
 * screen asserting something it cannot know. Deliberately derived from the
 * connection the app already tracks - there is no age threshold and no clock
 * here, so nothing goes stale merely because a session was quiet.
 */
export function isStale(connection) {
  if (connection === null || connection === undefined) return true;
  if (connection.halted === true) return true;
  return STALE_PHASES.includes(connection.phase);
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
      halt_reason: null,
      replaying: false,
      gap: null,
      last_event_id: null,
      last_frame_at_ms: null,
    },
    sessions: emptyMap(),
    actors: emptyMap(),
    /**
     * The human player, once a `snapshot` has named one. Null until then: this
     * screen never invents the person at the keyboard, it only repeats the
     * entity the server already holds.
     */
    player: null,
    last_ingest_seq: 0,
    last_event_ts: null,
    /**
     * The actor the operator is currently looking at, or `null`.
     *
     * A pointer into `state.actors`, never a seat number: seats are positions in
     * a deterministic ordering, so a new colleague joining renumbers them and a
     * stored seat would silently move the selection to somebody else.
     */
    selected_actor_key: null,
    counters: { applied: 0, ignored: 0, out_of_order: 0, foreign: 0, snapshots: 0, gaps: 0, halts: 0 },
    log: [],
  };
}

/**
 * Selects one seated actor, by key. `null` clears the selection.
 *
 * A key nobody is seated under is refused rather than stored - a selection that
 * points at nobody is exactly the stale actor state a re-layout has to remove,
 * and refusing it here means no other function has to defend against one.
 */
export function setSelectedActor(state, actorKey) {
  const next =
    typeof actorKey === 'string' && ownProp(state.actors, actorKey) !== undefined ? actorKey : null;
  if (next === state.selected_actor_key) return state;
  return { ...state, selected_actor_key: next };
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
    last_summary: null,
    last_event_type: null,
    runtime_agent_type: null,
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
    // The identity, kept beside the display name so the detail view can filter
    // this log to one desk without matching on a name two actors could share.
    actor_key: wire.actor_key,
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
  // Mirrors `reducer.ts` exactly, including the out-of-order rule: a value only
  // moves when the event carried one, and a late event moves nothing.
  let lastSummary = previousActor.last_summary;
  let runtimeAgentType = previousActor.runtime_agent_type;
  let ignored = false;

  if (!outOfOrder) {
    if (wire.summary !== null && wire.summary !== undefined) lastSummary = wire.summary;
    if (wire.runtime_agent_type !== null && wire.runtime_agent_type !== undefined) {
      runtimeAgentType = wire.runtime_agent_type;
    }
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
    last_summary: lastSummary,
    last_event_type: outOfOrder ? previousActor.last_event_type : wire.event_type,
    runtime_agent_type: runtimeAgentType,
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
      halt_reason: payload.halted === true ? normalizeHaltReason(payload.halt_reason) : null,
      replaying: false,
      gap: null,
      last_frame_at_ms: atMs === null ? state.connection.last_frame_at_ms : atMs,
    },
    sessions: copyMap(served.sessions),
    actors,
    // The snapshot is the server's whole state, so it is also the only thing
    // that can name the player. A snapshot without one leaves the screen with
    // none rather than keeping a person the server no longer reports.
    player: normalizePlayer(served.player),
    last_ingest_seq: typeof payload.last_ingest_seq === 'number' ? payload.last_ingest_seq : 0,
    last_event_ts: latestTs,
    // A snapshot replaces the office wholesale, so an actor that was selected
    // and is no longer seated has to go with it. Keeping the key would leave the
    // new layout carrying a selection from the old one.
    selected_actor_key:
      state.selected_actor_key !== null && ownProp(actors, state.selected_actor_key) !== undefined
        ? state.selected_actor_key
        : null,
    counters: { ...state.counters, snapshots: state.counters.snapshots + 1 },
  };
}

/**
 * Applies a `fail_closed` control frame: the collector stopped ingesting while
 * this client was connected.
 *
 * Ingestion stopping produces no event, so without this frame the screen would
 * keep reporting a healthy connection indefinitely. The halt is sticky: what is
 * on screen stays, labelled as frozen at the halt.
 */
export function applyHalt(state, payload, atMs = null) {
  const frame = payload === null || typeof payload !== 'object' ? {} : payload;
  if (frame.namespace !== undefined && frame.namespace !== state.namespace) {
    return { ...state, counters: { ...state.counters, foreign: state.counters.foreign + 1 } };
  }
  return {
    ...state,
    connection: {
      ...state.connection,
      halted: true,
      halt_reason: normalizeHaltReason(frame.reason),
      replaying: false,
      last_frame_at_ms: atMs === null ? state.connection.last_frame_at_ms : atMs,
    },
    counters: { ...state.counters, halts: state.counters.halts + 1 },
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
    case 'fail_closed':
      return applyHalt(state, frame.payload, atMs);
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
  // One decision for the whole office: either the stream is confirming these
  // states or it is not. Derived once so every desk agrees with the banner.
  const stale = isStale(state.connection);
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
    // What the stream last said this desk was doing...
    const lastKnown = classifyActor(actor);
    // ...and what the screen is entitled to claim right now. While the stream is
    // not confirming anything, that is `UNKNOWN` - but `last_known_visual` keeps
    // the observation itself, so the card can show "停止時点: ◯◯" rather than
    // quietly dropping what was already learned.
    const visual = stale ? ACTOR_VISUALS.unknown : lastKnown;
    return {
      seat: index + 1,
      actor_key: actor.actor_key,
      session_id: actor.session_id,
      display_name: actor.agent_id === null ? UNATTRIBUTED_AGENT_LABEL : actor.agent_id,
      is_main_orchestrator: actor.is_main_orchestrator === true,
      // Derived, never stored per desk: at most one desk is ever selected, and a
      // key that no longer matches anybody simply selects nothing.
      selected: actor.actor_key === state.selected_actor_key,
      // Roles are shown only when the collector actually resolved one. This
      // screen never guesses a job title from a structural fact.
      role: actor.resolved === true ? actor.role : null,
      resolved: actor.resolved === true,
      status_label: actor.status,
      last_tool: actor.last_tool,
      last_event_ts: actor.last_event_ts,
      event_count: actor.event_count,
      visual,
      stale,
      last_known_visual: lastKnown,
    };
  });
}

/**
 * The human player in the office, or null before a snapshot named one.
 *
 * Deliberately *not* a `Desk`: the player has no seat number, no `actor_key`, no
 * session and no visual state, because none of those are facts about them. A
 * desk is a runtime actor the collector resolved; this is the person the office
 * belongs to. Keeping the two projections separate is what stops the player
 * appearing in the colleague list, in the seat count, or in a selection.
 */
export function selectPlayer(state) {
  const player = state === null || state === undefined ? null : state.player;
  if (player === null || player === undefined) return null;
  return { kind: 'player', id: player.id, display_name: player.display_name };
}

/** Header summary: mode, connection, counts and the emptiness of the office. */
export function selectHeader(state) {
  const desks = selectDesks(state);
  const byState = emptyMap();
  // Every displayable state, `unknown` included - see `ACTOR_LEGEND_STATES`.
  for (const name of ACTOR_LEGEND_STATES) byState[name] = 0;
  for (const desk of desks) byState[desk.visual.state] += 1;
  return {
    mode: state.namespace === 'live' ? 'LIVE' : 'DEMO',
    namespace: state.namespace,
    connection: classifyConnection(state.connection),
    halted: state.connection.halted === true,
    halt_reason: state.connection.halted === true ? normalizeHaltReason(state.connection.halt_reason) : null,
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
 * Every situation the status banner reports, in the order it resolves them.
 *
 * This is the screen's closed status vocabulary: exactly one of these codes is
 * showing at any moment, in LIVE and in DEMO alike, and there is no state of the
 * screen that shows none of them. Order is priority - a halted namespace matters
 * more than a lost socket, which matters more than a gap, and so on down to the
 * ordinary connected office.
 */
export const BANNER_CODES = Object.freeze([
  'FAIL_CLOSED',
  'DISCONNECTED',
  'RECONNECTING',
  'STREAM_GAP',
  'REPLAYING',
  'LOADING',
  'EMPTY',
  'CONNECTED',
]);

const BANNER_VISUALS = Object.freeze({
  FAIL_CLOSED: Object.freeze({ tone: 'error', symbol: '✖' }),
  DISCONNECTED: Object.freeze({ tone: 'error', symbol: '✖' }),
  RECONNECTING: Object.freeze({ tone: 'warn', symbol: '◍' }),
  STREAM_GAP: Object.freeze({ tone: 'warn', symbol: '‼' }),
  REPLAYING: Object.freeze({ tone: 'info', symbol: '◌' }),
  LOADING: Object.freeze({ tone: 'info', symbol: '◌' }),
  EMPTY: Object.freeze({ tone: 'info', symbol: '⋯' }),
  CONNECTED: Object.freeze({ tone: 'ok', symbol: '●' }),
});

function bannerMessage(code, header) {
  switch (code) {
    case 'FAIL_CLOSED': {
      const reason = haltLabel(header.halt_reason);
      return (
        '取り込みが停止しています (fail-closed)。表示中のstateは停止時点のままです。' +
        (reason === null ? '' : `理由: ${reason}。`)
      );
    }
    case 'DISCONNECTED':
      return '接続が切れました。「再接続」を押すか、collectorが動いているか確認してください。';
    case 'RECONNECTING':
      return '再接続中です。Last-Event-IDから続きを取得します。';
    case 'STREAM_GAP': {
      const reason = gapLabel(header.gap === null ? null : header.gap.reason);
      return (
        'ストリームに欠落がありました。snapshotから復旧します。' + (reason === null ? '' : `理由: ${reason}。`)
      );
    }
    case 'REPLAYING':
      return '取りこぼし分をreplay中です。';
    case 'LOADING':
      return 'ストリームに接続しています。';
    case 'EMPTY':
      return `${header.mode}に接続済みです。まだ在席しているAI社員はいません。`;
    default:
      return `${header.mode}に接続済みです。${header.desk_count}席のstateを表示しています。`;
  }
}

function bannerCode(header) {
  if (header.halted) return 'FAIL_CLOSED';
  const phase = header.connection.state;
  if (phase === 'error') return 'DISCONNECTED';
  if (phase === 'reconnecting') return 'RECONNECTING';
  if (header.gap !== null) return 'STREAM_GAP';
  if (header.replaying) return 'REPLAYING';
  if (phase === 'offline' || phase === 'connecting') return 'LOADING';
  return header.empty ? 'EMPTY' : 'CONNECTED';
}

/**
 * The status banner for a header.
 *
 * Always returns a banner: the screen has no silent state. `code` and `symbol`
 * carry the meaning on their own, so `tone` is only ever the colour of something
 * the reader could already have read as text.
 */
export function selectBanner(header) {
  const code = bannerCode(header);
  const visual = ownProp(BANNER_VISUALS, code) ?? BANNER_VISUALS.CONNECTED;
  return { code, tone: visual.tone, symbol: visual.symbol, message: bannerMessage(code, header) };
}

/**
 * Wording for what the office is asking of the person looking at it.
 *
 * A closed vocabulary on purpose. "要確認" is deliberately weaker than "人間の
 * 確認が必要": an approval wait is a request the session actually made, while an
 * error or an uninterpretable status only means nobody can currently say the
 * work is fine. Claiming the latter is a formal request for action would be the
 * screen inventing an obligation the stream never reported.
 */
export const HUMAN_ACTION = Object.freeze({
  required: '人間の確認が必要',
  advised: '要確認',
  none: '現在、明示的な対応要求なし',
});

/** Stands in for anything the event contract simply does not carry. */
export const NOT_REPORTED = '未報告';

/**
 * Why "担当タスク" is always `未報告` today.
 *
 * The sanitized event model carries no business task title, id or reference
 * (`docs/event-contract.md`). The external hook wire does have a `task.id`, but
 * it belongs to Claude's own bookkeeping - `TaskCreated` / `TaskCompleted` are
 * mapped to an internal event type the reducer explicitly does not interpret as
 * company work - so presenting it as the task a colleague is assigned to would
 * be wrong, not merely imprecise. `summary` is the label for one event, so it is
 * shown as 最新の概要 and never promoted to a task name.
 */
export const NO_TASK_REFERENCE = NOT_REPORTED;

/** Said plainly, so nobody reads an empty row as "there was no evidence". */
export const NO_EVIDENCE_IN_CONTRACT = '現在のevent契約には成果物への参照がありません';

/** How many of an actor's own log rows the detail view shows. */
export const DETAIL_LOG_ENTRIES = 5;

function humanActionFor(visual) {
  if (visual.state === 'awaiting_approval') return HUMAN_ACTION.required;
  if (visual.state === 'error' || visual.state === 'unknown') return HUMAN_ACTION.advised;
  return HUMAN_ACTION.none;
}

/**
 * Everything known about the one selected desk, or null when none is.
 *
 * Pure, like every other selector here: it reads the client state and returns
 * data. It opens no request, and it derives no fact the stream did not report -
 * where the contract carries nothing, the field says so rather than guessing.
 */
export function selectDetail(state) {
  const key = state.selected_actor_key;
  if (typeof key !== 'string' || key.length === 0) return null;
  const desk = selectDesks(state).find((item) => item.actor_key === key);
  if (desk === undefined) return null;

  const session = ownProp(state.sessions, desk.session_id) ?? null;
  const actor = ownProp(state.actors, key) ?? null;
  const own = state.log.filter((entry) => entry.actor_key === key);

  return {
    actor_key: desk.actor_key,
    display_name: desk.display_name,
    seat: desk.seat,
    is_main_orchestrator: desk.is_main_orchestrator,
    // Only when the collector resolved one. This screen never guesses a title.
    role: desk.resolved ? desk.role : null,
    runtime_agent_type: actor === null ? null : (actor.runtime_agent_type ?? null),

    visual: desk.visual,
    stale: desk.stale,
    last_known_visual: desk.last_known_visual,
    status_label: desk.status_label,

    /** Explicit business task. See `NO_TASK_REFERENCE` - the contract has none. */
    task: null,
    /** The producer's label for the latest event. Not a task name. */
    latest_summary: actor === null ? null : (actor.last_summary ?? null),
    /** Only ever an explicitly reported next step; the screen predicts nothing. */
    next_action: null,
    human_action: humanActionFor(desk.visual),

    last_event_type: actor === null ? null : (actor.last_event_type ?? null),
    last_tool: desk.last_tool,
    last_event_ts: desk.last_event_ts,
    event_count: desk.event_count,

    session_id: desk.session_id,
    session_ended_at: session === null ? null : session.ended_at,

    /**
     * The most recent thing this desk did that was not itself a failure. Read
     * from the log the client already holds, so it is bounded and may be absent
     * - which is reported as such rather than filled in.
     */
    last_non_error: own.find((entry) => entry.state !== 'error') ?? null,
    /** Recovery, retry and handoff are not in the contract. Never claimed here. */
    recovery: null,
    /** No artifact, test, review or commit reference exists on the wire today. */
    evidence: null,
    recent: own.slice(0, DETAIL_LOG_ENTRIES),
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
