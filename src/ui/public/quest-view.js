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
 * The seat of a roster member the stream has never mentioned.
 *
 * Deliberately NOT a member of `ACTOR_VISUAL_STATES` or `ACTOR_LEGEND_STATES`.
 * Those are the states an event can put an actor into; this one is the absence
 * of any event at all. Adding it to the closed visual vocabulary would let a
 * vacant seat be counted as a working colleague in `selectHeader`, and would
 * claim the roster tells us something about activity. It does not: the roster is
 * the record of which seats exist, never of who is working
 * (`docs/org-snapshot-design.md` §2.3).
 */
export const VACANT_SEAT_VISUAL = Object.freeze({
  state: 'vacant',
  code: 'VACANT',
  label: '不在',
  symbol: '□',
  tone: 'idle',
});

/**
 * Zone identity is namespaced by what the zone *is*, not by the id it came with.
 *
 * The `:` is load-bearing throughout. Organisation identifiers are
 * `^[a-z0-9][a-z0-9-]{0,63}$`, so a colon cannot appear in one - which is what
 * keeps these four families disjoint. Departments and facilities draw from one
 * id space upstream, so an unprefixed `dept-x` facility and a `dept-x`
 * department would share a zone key; and the collector accepts a department
 * literally called `unassigned`, which would collide with the container. Either
 * collision hands one role bucket to two zones and aliases the rendered element,
 * so the same seats are drawn twice and one zone node is never removed.
 */
export const DEPARTMENT_ZONE_PREFIX = 'dept:';
export const FACILITY_ZONE_PREFIX = 'facility:';

/** The Quest-side container for everyone the departments do not place. */
export const UNASSIGNED_ZONE_ID = 'zone:unassigned';

/**
 * The 社長室, which no organisation declares.
 *
 * 歩 is a Human and holds no Agent definition, so `roles` never carries them
 * (`docs/org-snapshot-design.md` §4.1). The zone therefore comes from
 * `state.player` and exists only while a snapshot names one. It holds no desk:
 * the player is not a colleague, has no seat, and is not selectable.
 */
export const EXECUTIVE_ZONE_ID = 'zone:executive';
export const EXECUTIVE_ZONE_NAME = '社長室';
export const UNASSIGNED_ZONE_NAME = '未所属';

/**
 * Client-side ceiling on the organisation projection.
 *
 * The collector already refuses an over-sized organisation, but a bound that
 * only exists on the server is a bound the screen does not have: this state is
 * rebuilt from whatever a `snapshot` frame carries. Over the limit the input
 * is refused, never truncated - a partial roster misreports *who is missing*
 * (`docs/org-snapshot-design.md` §2.4).
 */
export const ORG_LIMITS = Object.freeze({ departments: 64, roles: 512, facilities: 64 });

/** Longest display name accepted, in code points (upstream `maxLength: 100`). */
const ORG_NAME_MAX = 100;

/** Longest rejection field path kept. It carries indexes, never values. */
const ORG_FIELD_MAX = 128;

/** Identifier grammar of the upstream org definition (`org.schema.json`). */
const ORG_IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The wire's own label grammar, which `runtime_agent_type` is compared against. */
const ORG_WIRE_LABEL = /^[A-Za-z0-9_.:@#| -]{1,128}$/;

/**
 * What a rejection `field` is allowed to look like: a path of member names and
 * array indexes, or the collector's marker for the whole input.
 *
 * Anything else is not a path, and this value is rendered. A credential
 * assignment carrying a filesystem location is a well-formed string and a
 * badly-formed path, and the second is what decides whether it reaches the
 * screen.
 */
const ORG_FIELD_PATH = /^(\(root\)|[A-Za-z_][A-Za-z0-9_]*(\[\d+\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\d+\])?)*)$/;

/**
 * C0 and DEL, which is exactly what `hasControlChars` in
 * `src/domain/validate.ts` refuses.
 *
 * Deliberately not one character stricter. A client that refuses more than the
 * admission boundary does turns an organisation the collector accepted into
 * `ORG_REJECTED` on the screen - a degradation the operator is shown and can do
 * nothing about, because nothing is actually wrong. U+2028 and U+2029 were in
 * this set and are the reason the rule is spelled out here.
 */
const ORG_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Why the forbidden-content scan is NOT repeated here.
 *
 * `src/domain/validate.ts` refuses absolute paths, credentials and shell
 * fragments in every label, organisation names included, and it is the only
 * writer of the payload this module reads: the page is served over loopback,
 * GET-only, with a Host allowlist and no CORS, so nothing else can put a
 * `snapshot` frame in front of it.
 *
 * Mirroring those rules into this file is also not possible. They are patterns
 * *made of* the very literals a shipped asset may not contain, and
 * `test/ui-server.test.ts` enforces that: a copy of `UNSAFE_RULES` here fails
 * the "shipped assets contain no path, secret or external destination" check
 * by being the thing it looks for.
 *
 * So content safety stays with the collector, and what this module re-checks is
 * what it alone can get wrong: shape, grammar, bounds, and the cross-row
 * invariants that decide whether two rendered elements collide.
 */
function orgUnsafe(value) {
  return ORG_CONTROL_CHARS.test(value);
}

/**
 * Why the collector refused an organisation, as a closed vocabulary.
 *
 * Mirrors `OrgRejectRule` in `src/domain/org.ts`. A rule this screen does not
 * know is reported as `type_error` rather than echoed: the second status
 * surface never prints an arbitrary string off the wire.
 */
export const ORG_REJECT_RULES = Object.freeze([
  'not_object',
  'unsupported_schema',
  'missing_key',
  'type_error',
  'invalid_format',
  'field_too_long',
  'control_chars',
  'unsafe_content',
  'duplicate_id',
  'unknown_reference',
  'limit_exceeded',
]);

/** The organisation state before any snapshot has been seen. */
const ORG_ABSENT_STATE = Object.freeze({ status: 'absent' });

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
    // `ok` is the outcome of one step, not the end of the actor: the LIVE
    // adapter emits it for every successful `PostToolUse`, and a colleague whose
    // last tool call succeeded is still at work. Without it here, every
    // successful step in LIVE would read as 状態不明 - which is exactly what it
    // did the first time this screen was opened against the scripted mission.
    'ok',
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

/** Code points, not UTF-16 code units: the iterator pairs surrogates for us. */
function countChars(value) {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** Clamps by code points, so a surrogate pair is never cut in half. */
function clampChars(value, max) {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join('');
}

/** A rendered label: length-bounded and content-checked, never clamped. */
function orgName(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (countChars(value) > ORG_NAME_MAX) return null;
  return orgUnsafe(value) ? null : value;
}

/** An identifier, against the grammar the collector admitted it under. */
function orgId(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function orgOrder(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `null` for anything that is not a usable department row. */
function normalizeDepartment(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = orgId(raw.id, ORG_IDENTIFIER);
  const name = orgName(raw.name);
  const order = orgOrder(raw.display_order);
  if (id === null || name === null || order === null) return null;
  return { id, name, display_order: order };
}

/**
 * `null` for anything that is not a usable shared-facility row.
 *
 * These are 共用施設 - rooms the organisation declares. Not to be confused with
 * the runtime `activity.facility` the hook wire carries and `hookAdapter.ts`
 * drops: that one is *where an actor currently is* (会議室, カフェ), a fact about
 * a person at a moment. This one is a place on the floor plan. They are
 * different concepts and must not share a name or a field.
 */
function normalizeFacility(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = orgId(raw.id, ORG_IDENTIFIER);
  const name = orgName(raw.name);
  const order = orgOrder(raw.display_order);
  if (id === null || name === null || order === null) return null;
  return { id, name, display_order: order };
}

/** `null` for anything that is not a usable roster row. */
function normalizeRole(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = orgId(raw.id, ORG_IDENTIFIER);
  const name = orgName(raw.name);
  const order = orgOrder(raw.display_order);
  if (id === null || name === null || order === null) return null;
  // Both are nullable upstream, and a null one is a fact, not a gap: a role with
  // no department belongs in 未所属, and a role with no comparison key is a
  // seat no event can ever fill. A *present* one has to be well formed, though -
  // an unusable identifier is a refusal, not a null.
  const department =
    raw.department_id === null || raw.department_id === undefined
      ? null
      : orgId(raw.department_id, ORG_IDENTIFIER);
  if (department === null && raw.department_id !== null && raw.department_id !== undefined) return null;
  const runtime =
    raw.runtime_agent_type === null || raw.runtime_agent_type === undefined
      ? null
      : orgId(raw.runtime_agent_type, ORG_WIRE_LABEL);
  if (runtime === null && raw.runtime_agent_type !== null && raw.runtime_agent_type !== undefined) {
    return null;
  }
  return { id, name, display_order: order, department_id: department, runtime_agent_type: runtime };
}

/** `false` as soon as a key repeats. A repeated id aliases a rendered element. */
function uniqueBy(rows, pick) {
  const seen = emptyMap();
  for (const row of rows) {
    const key = pick(row);
    if (key === null) continue;
    if (ownProp(seen, key) !== undefined) return false;
    seen[key] = true;
  }
  return true;
}

/**
 * All-or-nothing, exactly like the collector's own admission rule: one bad row
 * refuses the whole list rather than quietly shortening the roster.
 */
function normalizeOrgList(raw, limit, normalizeOne) {
  if (!Array.isArray(raw) || raw.length > limit) return null;
  const out = [];
  for (const entry of raw) {
    const one = normalizeOne(entry);
    if (one === null) return null;
    out.push(one);
  }
  return out;
}

function normalizeOrgSnapshot(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const departments = normalizeOrgList(raw.departments, ORG_LIMITS.departments, normalizeDepartment);
  const roles = normalizeOrgList(raw.roles, ORG_LIMITS.roles, normalizeRole);
  // `facilities` may be absent on an older payload; an empty floor is a fact,
  // not a refusal. A malformed one is still a refusal.
  const facilities =
    raw.facilities === undefined
      ? []
      : normalizeOrgList(raw.facilities, ORG_LIMITS.facilities, normalizeFacility);
  if (departments === null || roles === null || facilities === null) return null;

  // The cross-row invariants the collector already admitted this under, applied
  // again. They are not re-checked out of distrust of the collector: this module
  // rebuilds the organisation from a `snapshot` frame, so anything not enforced
  // here is not enforced at all on the way to the screen. A repeated id aliases
  // a zone or a desk element; a dangling department reference is a role the
  // organisation does not actually place.
  if (!uniqueBy(departments, (department) => department.id)) return null;
  if (!uniqueBy(facilities, (facility) => facility.id)) return null;
  if (!uniqueBy(roles, (role) => role.id)) return null;
  if (!uniqueBy(roles, (role) => role.runtime_agent_type)) return null;
  const known = emptyMap();
  for (const department of departments) known[department.id] = true;
  for (const role of roles) {
    if (role.department_id !== null && ownProp(known, role.department_id) === undefined) return null;
  }
  return { departments, roles, facilities };
}

/**
 * The organisation, from a snapshot's `state.org`, as a closed three-value
 * vocabulary.
 *
 * A payload is data to be checked, not to be trusted, so the accepted case is
 * rebuilt row by row here as well. The important half is what happens when that
 * fails: the result is `rejected`, never `absent`. Those two mean different
 * things to the reader - "no organisation was configured" versus "an
 * organisation was configured and this screen refused it" - and collapsing the
 * second into the first is exactly the silent degradation
 * `docs/org-snapshot-design.md` §2.4 forbids.
 */
export function normalizeOrg(raw) {
  if (raw === null || typeof raw !== 'object') return ORG_ABSENT_STATE;
  if (raw.status === 'rejected') {
    const known = ORG_REJECT_RULES.indexOf(raw.rule) !== -1;
    // The field path is rendered, so it is checked as a path rather than kept as
    // a string. A value that is not one is reported as a refusal of the whole
    // input, which is true, instead of being printed.
    const path = typeof raw.field === 'string' ? clampChars(raw.field, ORG_FIELD_MAX) : '';
    return {
      status: 'rejected',
      field: ORG_FIELD_PATH.test(path) ? path : 'snapshot',
      rule: known ? raw.rule : 'type_error',
    };
  }
  if (raw.status !== 'accepted') return ORG_ABSENT_STATE;
  const snapshot = normalizeOrgSnapshot(raw.snapshot);
  if (snapshot === null) return { status: 'rejected', field: 'snapshot', rule: 'type_error' };
  return { status: 'accepted', snapshot };
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
    /**
     * The organisation, from the server's own `state.org`. Operator input, not
     * stream content: only a `snapshot` can change it, and no event ever does
     * (`docs/org-snapshot-design.md` §2.1).
     */
    org: ORG_ABSENT_STATE,
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
    // Same rule as the player: the snapshot is the server's whole state, so it
    // is the only frame that can name an organisation. A snapshot without one
    // leaves the screen with none rather than keeping an organisation the
    // server no longer reports.
    org: normalizeOrg(served.org),
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
 * How loudly a state asks to be looked at.
 *
 * `ACTOR_VISUAL_STATES` is already written worst-first - error, approval,
 * planning, working, ended, idle - so its index *is* the rank and there is no
 * second ordering to keep in step with it. `unknown` is not in that list and
 * sorts last, which is right: while the stream is not confirming anything every
 * desk is `unknown` together, so the rank cannot decide anything and the
 * ordering below falls through to the office's own.
 */
function attentionRank(visual) {
  const index = ACTOR_VISUAL_STATES.indexOf(visual.state);
  return index === -1 ? ACTOR_VISUAL_STATES.length : index;
}

/**
 * Which of the actors behind one roster seat the seat shows.
 *
 * `docs/org-snapshot-design.md` §4.2 requires this to be derived from the whole
 * group, and the reason is the failure it prevents: `selectDesks` orders actors
 * by oldest session, so simply taking the first lets a finished older run sit on
 * top of a newer one that is failing. The DEMO does exactly that - `dev-1`
 * ended while `sync-1` errored - and the seat would have read 完了 with the
 * error nowhere on the screen.
 *
 * So the seat shows the state that most asks to be looked at, and ties fall back
 * to the office's existing order, which makes the choice total and repeatable.
 * One seat can only carry one state; the rule is that the one it carries is
 * never the one that hides a problem.
 */
function representative(occupants) {
  let best = occupants[0];
  let bestRank = attentionRank(best.visual);
  for (let i = 1; i < occupants.length; i += 1) {
    const rank = attentionRank(occupants[i].visual);
    if (rank < bestRank) {
      best = occupants[i];
      bestRank = rank;
    }
  }
  return best;
}

/** Declared order first, identifier second, so the order is total. */
function compareOrgOrder(left, right) {
  if (left.display_order !== right.display_order) return left.display_order - right.display_order;
  return compareStrings(left.id, right.id);
}

/** The seat of a roster member no event has ever mentioned. */
function vacantSeat(role, rosterSeat) {
  return {
    // A seat nobody occupies has no actor to select, so it carries no key. The
    // click handler asks `setSelectedActor` for this and gets a cleared
    // selection, and the button itself is disabled - a vacant seat is not a
    // colleague you can open.
    actor_key: null,
    occupied: false,
    seat: null,
    roster_seat: rosterSeat,
    role_id: role.id,
    // No actor, so no reported name. The card falls back to the roster label,
    // which is the only name this seat has.
    display_name: null,
    role_name: role.name,
    is_main_orchestrator: false,
    selected: false,
    // Nobody is behind this seat, so there is no session to aggregate.
    occupants: [],
    // Every one of these is a fact the stream never reported. They stay null so
    // the card renders 「—」 rather than inventing an activity for somebody the
    // roster only promises has a desk (`docs/org-snapshot-design.md` §2.3).
    role: null,
    resolved: false,
    status_label: null,
    last_tool: null,
    last_event_ts: null,
    session_id: null,
    event_count: 0,
    visual: VACANT_SEAT_VISUAL,
    stale: false,
    last_known_visual: VACANT_SEAT_VISUAL,
  };
}

/**
 * The office as zones of desks, or the flat colleague list when there is no
 * organisation to group by.
 *
 * This is the first projection that mixes two sources, and the whole contract is
 * in how it refuses to blend them (`docs/org-snapshot-design.md` §2.3):
 *
 * - a roster member with a matching actor is seated, with the actor's state;
 * - a roster member with no actor keeps their seat and gets **no** state;
 * - an actor with no roster member goes to 未所属 and is **never dropped**,
 *   because the event stream is the record and the roster is not.
 *
 * The comparison key is `runtime_agent_type` and only that (§4.2). `agent_id` is
 * a name inside a session and `session_id` is a run, while a roster seat belongs
 * to a person across every session they ever appear in - so several actors can
 * answer to one seat, and the seat stays one seat.
 *
 * Grouping is refused wholesale unless the organisation was accepted, which is
 * what makes the degraded path identical to the pre-organisation screen rather
 * than a half-built version of this one.
 */
export function selectOffice(state) {
  const desks = selectDesks(state);
  const org = state === null || state === undefined ? null : (state.org ?? null);
  if (org === null || org.status !== 'accepted') return { grouped: false, zones: [], desks };

  const snapshot = org.snapshot;
  const zones = [];

  // 社長室 first, and only when a snapshot has named a player. It is the one
  // zone the organisation cannot declare, and it holds no desk.
  const player = state.player ?? null;
  if (player !== null) {
    zones.push({
      id: EXECUTIVE_ZONE_ID,
      name: EXECUTIVE_ZONE_NAME,
      kind: 'executive',
      seats: false,
      desks: [],
    });
  }

  // Departments, in the order the organisation declares them.
  const zoneIndex = emptyMap();
  for (const department of snapshot.departments.slice().sort(compareOrgOrder)) {
    const zone = {
      id: `${DEPARTMENT_ZONE_PREFIX}${department.id}`,
      name: department.name,
      kind: 'department',
      seats: true,
      desks: [],
    };
    zoneIndex[department.id] = zone;
    zones.push(zone);
  }

  // 未所属 is a container this screen makes, not a department the organisation
  // declares: it holds the roles that belong to no department *and* the actors
  // the roster does not know (`docs/org-snapshot-design.md` §4.1).
  const unassigned = {
    id: UNASSIGNED_ZONE_ID,
    name: UNASSIGNED_ZONE_NAME,
    kind: 'unassigned',
    seats: true,
    desks: [],
  };
  zones.push(unassigned);

  // 共用施設 last. Rooms, not people: nobody is seated in one, so they carry no
  // desk and never receive an actor.
  for (const facility of snapshot.facilities.slice().sort(compareOrgOrder)) {
    zones.push({
      id: `${FACILITY_ZONE_PREFIX}${facility.id}`,
      name: facility.name,
      kind: 'facility',
      seats: false,
      desks: [],
    });
  }

  // Occupied desks by comparison key, keeping `selectDesks` order inside each
  // bucket so "which actor represents this seat" is decided by the ordering the
  // office already uses, not by a second rule invented here.
  const byType = emptyMap();
  for (const desk of desks) {
    const actor = ownProp(state.actors, desk.actor_key);
    const type = actor === undefined ? null : actor.runtime_agent_type;
    if (typeof type !== 'string' || type.length === 0) continue;
    const bucket = ownProp(byType, type);
    if (bucket === undefined) byType[type] = [desk];
    else bucket.push(desk);
  }

  const rolesByZone = emptyMap();
  for (const role of snapshot.roles) {
    const zone =
      role.department_id === null ? undefined : ownProp(zoneIndex, role.department_id);
    const zoneId = zone === undefined ? UNASSIGNED_ZONE_ID : zone.id;
    const bucket = ownProp(rolesByZone, zoneId);
    if (bucket === undefined) rolesByZone[zoneId] = [role];
    else bucket.push(role);
  }

  const seated = emptyMap();
  let rosterSeat = 0;
  for (const zone of zones) {
    // 社長室 and 共用施設 are rooms, not seating. No role can be filed under one,
    // and skipping them here is what keeps `rosterSeat` counting seats only.
    if (zone.seats !== true) continue;
    const roles = (ownProp(rolesByZone, zone.id) ?? []).slice().sort(compareOrgOrder);
    for (const role of roles) {
      rosterSeat += 1;
      const bucket = role.runtime_agent_type === null ? [] : (ownProp(byType, role.runtime_agent_type) ?? []);
      // Every actor answering to this comparison key, not just the first.
      //
      // A roster seat belongs to a person and a session is one run of their
      // work, so the same colleague appearing in two sessions at once is one
      // colleague at one desk - not a colleague plus a stranger in 未所属
      // (`docs/org-snapshot-design.md` §4.2). Splitting them would break "15名
      // 固定着席" the moment anybody ran twice, and would show one roster
      // employee in their department and again as somebody the roster does not
      // know.
      const occupants = [];
      for (const desk of bucket) {
        if (ownProp(seated, desk.actor_key) === undefined) occupants.push(desk);
      }
      if (occupants.length === 0) {
        zone.desks.push(vacantSeat(role, rosterSeat));
        continue;
      }
      // Derived from the whole group, not from whoever happens to be first.
      const lead = representative(occupants);
      for (const desk of occupants) seated[desk.actor_key] = true;
      zone.desks.push({
        ...lead,
        occupied: true,
        // Kept beside `seat`, never instead of it: `seat` is this actor's place
        // in the dynamic ordering and moves as colleagues come and go, while
        // this one belongs to the roster and does not. Neither is derived from
        // the other (`docs/org-snapshot-design.md` §4.4).
        roster_seat: rosterSeat,
        role_id: role.id,
        // Beside the reported name, never instead of it. `display_name` is what
        // the stream called this actor and is what the canvas sprite and the
        // detail pane show; overwriting it here would leave one card reading
        // 開発担当 while the same actor reads `dev-1` two panes away, and with
        // two actors answering to one seat the operator could not tell which of
        // them is sitting in it.
        role_name: role.name,
        // Every actor the seat stands for, so an aggregated desk can say how
        // many are behind it and no actor is silently absorbed. Actors, not
        // sessions: the key is `(session_id, agent_id)`, so one session running
        // two agents of this runtime type contributes two of them.
        occupants: occupants.map((desk) => desk.actor_key),
      });
    }
  }

  // Everyone the roster does not know, in the office's own order. Appended
  // rather than dropped: the stream said they are here.
  for (const desk of desks) {
    if (ownProp(seated, desk.actor_key) !== undefined) continue;
    unassigned.desks.push({
      ...desk,
      occupied: true,
      roster_seat: null,
      role_id: null,
      role_name: null,
      occupants: [desk.actor_key],
    });
  }

  const flat = [];
  for (const zone of zones) for (const desk of zone.desks) flat.push(desk);
  return { grouped: true, zones, desks: flat };
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
 * The second status surface, as a closed vocabulary.
 *
 * Separate from the banner on purpose. The banner shows exactly one code and
 * that code is about the *stream*; folding an organisation code into it would
 * let 「組織なし」 push `FAIL_CLOSED` or `DISCONNECTED` off the screen and hide a
 * broken stream behind a merely-degraded office
 * (`docs/org-snapshot-design.md` §4.7).
 *
 * The surface is general - run state, approvals and stalls are meant to land
 * here too once their vocabulary is fixed - but the vocabulary shipped with it
 * is the organisation's alone. It is also not a live region: the banner stays
 * the only one, so a rare organisation change never interrupts a screen reader
 * mid-sentence.
 */
export const SECONDARY_STATUS_CODES = Object.freeze([
  'ORG_ACCEPTED',
  'ORG_ABSENT',
  'ORG_REJECTED',
]);

const SECONDARY_STATUS_VISUALS = Object.freeze({
  ORG_ACCEPTED: Object.freeze({
    tone: 'ok',
    message: '組織snapshotを採用しています。席は組織定義の順で固定です。',
  }),
  ORG_ABSENT: Object.freeze({
    tone: 'info',
    message: '組織snapshotが未設定のため、組織なしの表示へ縮退しています。',
  }),
  ORG_REJECTED: Object.freeze({
    tone: 'warn',
    message: '組織snapshotを検証で拒否したため、組織なしの表示へ縮退しています。',
  }),
});

/**
 * Always returns a code. There is no state in which this surface is blank:
 * a screen that silently stops grouping is the one failure
 * `docs/org-snapshot-design.md` §2.4 rules out.
 */
export function selectSecondaryStatus(state) {
  const org = state === null || state === undefined ? null : (state.org ?? null);
  const status = org === null ? 'absent' : org.status;
  const code = status === 'accepted' ? 'ORG_ACCEPTED' : status === 'rejected' ? 'ORG_REJECTED' : 'ORG_ABSENT';
  const visual = ownProp(SECONDARY_STATUS_VISUALS, code) ?? SECONDARY_STATUS_VISUALS.ORG_ABSENT;
  return {
    code,
    tone: visual.tone,
    message: visual.message,
    // Field path and rule name only - both closed, both index-bearing at most.
    // No employee name, department name or path ever reaches the screen
    // (`docs/org-snapshot-design.md` §2.4).
    detail: code === 'ORG_REJECTED' ? `${org.field} / ${org.rule}` : null,
    degraded: code !== 'ORG_ACCEPTED',
  };
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
