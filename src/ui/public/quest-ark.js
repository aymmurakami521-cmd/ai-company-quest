/**
 * Owner ARK — the management projection of the same read model.
 *
 * Quest is a projection, not a control plane. Everything here is a pure function
 * over the `ClientState` that `quest-view.js` already folds out of the SSE
 * stream, and it introduces no second `next_action`, no second attention rule
 * and no second run state machine: the ordering of `ACTOR_VISUAL_STATES`, the
 * freeze rule behind `stale` / `last_known_visual`, and the banner vocabulary of
 * `selectBanner` are the only sources of truth it reads from.
 *
 * The rule that shapes every selector below: where the current event contract
 * carries nothing, the projection says so. It never fills a gap with a plausible
 * value, and it never lets an unconfirmed state read as work in progress
 * (`docs/event-contract.md`, `docs/org-snapshot-design.md` §2.3).
 *
 * That rule is stricter here than on the office floor in three places, and every
 * one of them is about refusing to claim more than the stream supports rather
 * than classifying anything anew: `ARK_UNCONFIRMED_BANNER_CODES` freezes the
 * console through a recovery as well as a disconnection, `arkPhaseOnOpen` and
 * `arkRecoverySettles` keep that freeze standing until a recovery frame has
 * actually re-established what is current *and* the server has finished saying
 * whether ingestion is still running, and `reportedOwnStop` refuses to read a
 * generic `session_end` as somebody having finished - out of the stretch of the
 * log `trustedLog` can
 * still vouch for, and only the entries in it the fold actually acted on and can
 * be shown to have acted on, so neither an observation a recovery superseded nor
 * one the reducer declined nor one this client cannot place in the desk's own
 * order can be cited as proof about the run that stands now.
 *
 * `arkPhaseOnOpen` / `arkRecovered` / `arkRecoverySettles` are the only three
 * functions here that are not selectors, and they still hold the boundary: all
 * are pure, all speak only the connection vocabulary `quest-view.js` already
 * defines, and none is reachable from anything that could write.
 *
 * The command surface is a draft builder and nothing else. It structures what an
 * owner typed into a typed Task/Delegation payload and reports that there is no
 * authenticated boundary to hand it to. It performs no request, and this module
 * has no way to perform one.
 */

import {
  ACTOR_VISUAL_STATES,
  NOT_REPORTED,
  NO_EVIDENCE_IN_CONTRACT,
  selectBanner,
  selectDesks,
  selectHeader,
  visualForState,
} from './quest-view.js';

/** Stands in for a field a future contract will carry and this one does not. */
export const NOT_IN_CONTRACT = '現在のevent契約にはありません';

/**
 * How loudly an item asks for a person.
 *
 * `required` is an explicit request the run itself made - an approval wait.
 * `advised` is weaker on purpose: an error, a halt or a lost stream only means
 * nobody can currently say the work is fine, which is a different claim from the
 * run asking for a decision. Same distinction `HUMAN_ACTION` already draws in
 * `quest-view.js`; this is its ordering, not a new one.
 */
export const ARK_ATTENTION_LEVELS = Object.freeze(['required', 'advised']);

/** Closed vocabulary. Every Need You item carries exactly one of these. */
export const ARK_ATTENTION_REASONS = Object.freeze([
  'AWAITING_APPROVAL',
  'INGEST_HALTED',
  'RUN_ERROR',
  'STREAM_UNCONFIRMED',
]);

/**
 * The runtime classes Now separates.
 *
 * Deliberately not a new state machine: each one is a rename of a state the view
 * model already classifies, so a desk cannot be in a Now class its own visual
 * does not put it in.
 */
export const ARK_RUNTIME_CODES = Object.freeze([
  'BLOCKED',
  'HUMAN_WAIT',
  'EXECUTING',
  'ENDED',
  'IDLE',
  'UNKNOWN',
]);

/** Closed vocabulary of the Outcome column. */
export const ARK_OUTCOME_RESULTS = Object.freeze(['FAILED', 'STOPPED', 'COMPLETED']);

/** How many rows a compact panel shows before the rest moves into its drawer. */
export const ARK_SUMMARY_ROWS = 5;

/**
 * The banner codes under which nothing on this screen is being confirmed.
 *
 * Read straight out of `selectBanner`'s own vocabulary rather than restated as a
 * rule of its own, so the console cannot report 復旧中 in the banner and 実行中・
 * 確認済み in the same frame - which is exactly what it did while it took
 * `isStale` alone as the test.
 *
 * `isStale` covers three of these: a fail-closed namespace and a socket that is
 * gone or retrying. `STREAM_GAP` and `REPLAYING` are the two it does not, and
 * they matter here for a reason the office's desk cards can shrug off and a
 * management console cannot. Both mean frames are known to be missing right now
 * and the recovery `snapshot` has not landed yet, so what is on screen is an
 * observation from before the gap - and a recovery that is delayed, or that
 * never completes, would otherwise leave that observation reading as live work
 * indefinitely. `LOADING` is deliberately absent: `offline` and `connecting`
 * rebuild the office from empty, so there is no earlier observation to mistake
 * for a current one.
 */
export const ARK_UNCONFIRMED_BANNER_CODES = Object.freeze([
  'FAIL_CLOSED',
  'DISCONNECTED',
  'RECONNECTING',
  'STREAM_GAP',
  'REPLAYING',
]);

/**
 * The control frames that re-establish what is current after a socket opens.
 *
 * Exactly the two the stream contract can finish an open with: `server.ts` writes
 * a `snapshot` on a fresh connection and after every gap, and a `replay_end`
 * once a valid `Last-Event-ID` replay has been served. Nothing else on the wire
 * amounts to the server saying "what you are now holding is current", which is
 * the only claim that may lift the freeze below.
 */
export const ARK_RECOVERY_FRAMES = Object.freeze(['snapshot', 'replay_end']);

/**
 * The connection phase the console may claim when the socket reports `open`.
 *
 * `open` is the transport saying the socket came up, which is a different claim
 * from the office being current - and on an automatic `EventSource` reconnect the
 * two are far apart: `open` is delivered before the queued `replay_start` /
 * `stream_gap` / `snapshot`, so taking it at face value hands every desk observed
 * before the drop straight back as confirmed 実行中 for the window in between,
 * and indefinitely if the stream stalls after opening. Over an office that
 * already holds desks the console therefore stays `reconnecting` until
 * `arkRecovered` sees one of `ARK_RECOVERY_FRAMES`.
 *
 * Deliberately the existing phase vocabulary rather than a rule of its own:
 * `RECONNECTING` is already an `ARK_UNCONFIRMED_BANNER_CODES` member, so the
 * freeze this produces is the freeze the console already applies, the banner
 * already has wording for it, and Need You already explains it. No second state
 * machine, and nothing about any desk's own state is decided here.
 *
 * An office with no desks yet takes `open` as it comes, for the same reason
 * `LOADING` is not a frozen state: it is rebuilding from empty, so there is no
 * earlier observation to mistake for a current one.
 */
export function arkPhaseOnOpen(state) {
  return Object.keys(state.actors).length === 0 ? 'open' : 'reconnecting';
}

/**
 * Whether this frame is the authoritative recovery the console has been holding
 * `reconnecting` for.
 *
 * Only ever lifts a freeze, never starts one, and only for a frame the fold
 * actually accepted - a foreign-namespace payload is refused by `applyFrame` and
 * counted, and a frame that established nothing may not end a recovery.
 */
export function arkRecovered(before, after, frameKind) {
  if (before.connection.phase !== 'reconnecting') return false;
  if (!ARK_RECOVERY_FRAMES.includes(frameKind)) return false;
  return after.counters.foreign === before.counters.foreign;
}

/**
 * The recovery frames that state the namespace's health in their own payload.
 *
 * A `snapshot` carries `halted` and `halt_reason`, so applying it settles both
 * questions the console has to answer after a drop - what the office looks like
 * *and* whether ingestion is still running - in the same frame.
 *
 * A `replay_end` settles only the first. `server.ts:332-337` writes a queued
 * `fail_closed` immediately *after* it, because a halt that happened while this
 * client was offline reaches nobody through the replay itself. Both frames leave
 * the server in one write, but the browser dispatches them as two events, so
 * declaring the recovery healthy on the first one renders every retained desk as
 * confirmed 実行中 for the frame before the halt lands. `arkRecoverySettles`
 * says which of the two a frame is, so `quest-ark-app.js` can hold the freeze
 * over the rest of the burst rather than claiming health it does not yet have.
 */
export const ARK_SETTLING_RECOVERY_FRAMES = Object.freeze(['snapshot']);

export function arkRecoverySettles(frameKind) {
  return ARK_SETTLING_RECOVERY_FRAMES.includes(frameKind);
}

const RUNTIME_BY_STATE = Object.freeze({
  error: 'BLOCKED',
  awaiting_approval: 'HUMAN_WAIT',
  planning: 'EXECUTING',
  working: 'EXECUTING',
  ended: 'ENDED',
  idle: 'IDLE',
  unknown: 'UNKNOWN',
});

const RUNTIME_LABELS = Object.freeze({
  BLOCKED: '停止（エラー）',
  HUMAN_WAIT: '人間待ち',
  EXECUTING: '実行中',
  ENDED: '終了',
  IDLE: '待機',
  UNKNOWN: '状態不明',
});

/**
 * Why "外部待ち" is a bucket this screen refuses to fill.
 *
 * The issue asks Now to separate executing / external wait / human wait /
 * blocked. Three of those are classifiable from the sanitized event contract;
 * "waiting on something outside the run" is not reported by anything on the
 * wire, so the bucket is rendered as unavailable rather than being guessed at
 * from, say, a long gap since the last event - which would be the screen
 * inventing a fact about a system it cannot see.
 */
export const ARK_EXTERNAL_WAIT_NOTE =
  '外部待ちを示すfieldが現在のevent契約にないため、この区分は判定できません。';

const OUTCOME_LABELS = Object.freeze({
  FAILED: '失敗',
  STOPPED: '中断',
  COMPLETED: '完了',
});

const OUTCOME_FOLLOW_UP = Object.freeze({
  FAILED: '未解決: 失敗の原因確認と、再実行するか停止するかの判断',
  STOPPED: '未解決: この担当自身の完了報告がないまま作業が終わっています',
  COMPLETED: null,
});

const ATTENTION_COPY = Object.freeze({
  AWAITING_APPROVAL: Object.freeze({
    level: 'required',
    reason: 'このAI社員は承認待ちで停止しています。人間の判断がないと先へ進みません。',
    recommended: '承認するか却下するかを、実行元（Control Plane側）で判断してください。',
    options: Object.freeze(['承認して継続する', '却下して停止する', '追加情報を求める']),
    inaction: '承認されるまで待機し続け、この作業は1歩も進みません。',
  }),
  RUN_ERROR: Object.freeze({
    level: 'advised',
    reason: 'このAI社員はエラーを報告しました。作業が完了していない可能性があります。',
    recommended: '直近の動きを確認し、再実行するか停止するかを決めてください。',
    options: Object.freeze(['原因を確認して再実行する', 'この作業を停止する', '担当を変える']),
    inaction: '失敗したまま放置され、これに続く作業も進みません。',
  }),
  INGEST_HALTED: Object.freeze({
    level: 'required',
    reason: '取り込みがfail-closedで停止しました。画面のstateは停止時点のままです。',
    recommended: 'collectorの停止理由を確認し、取り込みを再開してください。',
    options: Object.freeze(['collectorを再起動する', '停止理由を調査する']),
    inaction: '以後どれだけ作業が進んでも、この画面には一切反映されません。',
  }),
  STREAM_UNCONFIRMED: Object.freeze({
    level: 'advised',
    reason: 'ストリームが状態を確認できていません。表示中のstateは停止時点の観測です。',
    recommended: '再接続し、いま実際に何が動いているかを確認し直してください。',
    options: Object.freeze(['再接続する', 'collectorが動いているか確認する']),
    inaction: 'いま何が起きているかを誰も確認できない状態が続きます。',
  }),
});

/** Own-property read on a null-prototype map. */
function ownProp(map, key) {
  if (map === null || map === undefined || typeof key !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** The office's own 状態不明, reused rather than restated. */
const UNKNOWN_VISUAL = visualForState('unknown');

/** Whether the stream is currently confirming anything this screen shows. */
function unconfirmedStream(banner) {
  return ARK_UNCONFIRMED_BANNER_CODES.includes(banner.code);
}

/**
 * What this screen may claim about one desk right now, and what it may not.
 *
 * `selectDesks` already freezes a desk to `UNKNOWN` when its own `stale` rule
 * fires; this widens that freeze to the recovery states in
 * `ARK_UNCONFIRMED_BANNER_CODES` without touching the office's rule. One
 * decision for the whole console, so Need You, Now, Next and Outcome cannot
 * disagree about whether a row is a live observation.
 *
 * `last_known_visual` is untouched either way: the observation is kept and
 * labelled as one, never dropped and never presented as current.
 */
function claim(desk, frozen) {
  const unconfirmed = frozen || desk.stale;
  return { visual: unconfirmed ? UNKNOWN_VISUAL : desk.visual, confirmed: !unconfirmed };
}

/**
 * How loudly a state asks to be looked at.
 *
 * `ACTOR_VISUAL_STATES` is written worst-first, so its index is the rank. Read
 * from that array rather than restated here, so this screen can never disagree
 * with the office about which state matters more.
 */
function attentionRank(visual) {
  const index = ACTOR_VISUAL_STATES.indexOf(visual.state);
  return index === -1 ? ACTOR_VISUAL_STATES.length : index;
}

function levelRank(level) {
  const index = ARK_ATTENTION_LEVELS.indexOf(level);
  return index === -1 ? ARK_ATTENTION_LEVELS.length : index;
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A label/value pair the reader can follow back into the stream. */
function ref(label, value) {
  return { label, value: typeof value === 'string' && value.length > 0 ? value : NOT_REPORTED };
}

/**
 * What can be shown to back a claim.
 *
 * Two kinds, kept apart. `trace` is what the stream actually reported and is
 * always reachable. `artifacts` - tests, CI, PR, commit, files - is not on the
 * wire at all today, so it is reported as absent rather than left blank: a blank
 * row reads as "there was no evidence", which is a different and wrong claim.
 */
function evidenceFor(state, desk) {
  const actor = desk.actor_key === null ? null : (ownProp(state.actors, desk.actor_key) ?? null);
  return {
    trace: Object.freeze([
      ref('session', desk.session_id),
      ref('actor_key', desk.actor_key),
      ref('最終event種別', actor === null ? null : actor.last_event_type),
      ref('最後のツール', desk.last_tool),
      ref('生のstatus', desk.status_label),
      ref('最新の概要', actor === null ? null : actor.last_summary),
      ref('最終更新', desk.last_event_ts),
      ref('観測event数', String(desk.event_count)),
    ]),
    artifacts: Object.freeze({ available: false, note: NO_EVIDENCE_IN_CONTRACT }),
  };
}

/** The same two kinds, for an item about the stream rather than about a desk. */
function connectionEvidence(header) {
  return {
    trace: Object.freeze([
      ref('namespace', header.namespace),
      ref('接続状態', `${header.connection.symbol} ${header.connection.label}`),
      ref('最新 ingest_seq', String(header.last_ingest_seq)),
      ref('最終event時刻', header.last_event_ts),
      ref('在席', String(header.desk_count)),
    ]),
    artifacts: Object.freeze({ available: false, note: NO_EVIDENCE_IN_CONTRACT }),
  };
}

/**
 * Which reason a desk raises, from what the stream last actually said.
 *
 * Read from `last_known_visual`, not `visual`, for the reason `representative()`
 * in `quest-view.js` gives: while the stream is stale every desk's `visual` is
 * `UNKNOWN` together, so ranking on it would make an approval wait and a failure
 * disappear from Need You at exactly the moment nobody can check for themselves.
 * The item still carries `confirmed: false`, so it is never presented as a live
 * observation.
 *
 * `unknown` is deliberately not a per-desk reason. A lost stream is one fact
 * about one connection; turning it into one item per colleague would bury the
 * approval wait it is sitting next to under a wall of duplicates. It is raised
 * once, by `connectionAttention`.
 */
function deskReason(desk) {
  const state = desk.last_known_visual.state;
  if (state === 'awaiting_approval') return 'AWAITING_APPROVAL';
  if (state === 'error') return 'RUN_ERROR';
  return null;
}

function packet(reasonCode, fields) {
  const copy = ownProp(ATTENTION_COPY, reasonCode);
  return {
    reason_code: reasonCode,
    level: copy.level,
    reason: copy.reason,
    recommended: copy.recommended,
    // Descriptions of the decision, never controls: this screen dispatches
    // nothing. They exist so the packet says what the choice actually is.
    options: copy.options,
    inaction: copy.inaction,
    ...fields,
  };
}

/**
 * One connection-level item, or null when the stream has nothing to report.
 *
 * Derived from `selectBanner`, so the vocabulary is the one the office already
 * shows and there is no second connection rule to keep in step.
 */
function connectionAttention(header, banner) {
  if (banner.code === 'FAIL_CLOSED') {
    return packet('INGEST_HALTED', {
      id: 'connection:fail_closed',
      kind: 'connection',
      actor_key: null,
      display_name: null,
      title: `取り込み停止 (${banner.code})`,
      detail: banner.message,
      visual: null,
      last_known_visual: null,
      confirmed: false,
      last_update: header.last_event_ts,
      evidence: connectionEvidence(header),
    });
  }
  // Every remaining code that leaves the office unconfirmed, recovery included:
  // if the rows are being frozen to 状態不明, Need You says why in the same frame.
  if (unconfirmedStream(banner)) {
    return packet('STREAM_UNCONFIRMED', {
      id: 'connection:unconfirmed',
      kind: 'connection',
      actor_key: null,
      display_name: null,
      title: `状態を確認できていません (${banner.code})`,
      detail: banner.message,
      visual: null,
      last_known_visual: null,
      confirmed: false,
      last_update: header.last_event_ts,
      evidence: connectionEvidence(header),
    });
  }
  return null;
}

/**
 * Need You: every decision packet, worst first.
 *
 * Ordering is total and deterministic: explicit requests before advisories, then
 * the office's own worst-first state rank, then the item id. Nothing here
 * depends on the clock.
 */
export function selectAttention(state) {
  const header = selectHeader(state);
  const banner = selectBanner(header);
  const frozen = unconfirmedStream(banner);
  const desks = selectDesks(state);
  const items = [];

  const connection = connectionAttention(header, banner);
  if (connection !== null) items.push(connection);

  for (const desk of desks) {
    const reasonCode = deskReason(desk);
    if (reasonCode === null) continue;
    const now = claim(desk, frozen);
    items.push(
      packet(reasonCode, {
        id: `actor:${desk.actor_key}`,
        kind: 'actor',
        actor_key: desk.actor_key,
        display_name: desk.display_name,
        title: desk.display_name,
        detail: desk.status_label ?? NOT_REPORTED,
        // What the screen may claim now (UNKNOWN while nothing is confirming
        // it) and what was last observed, kept apart exactly as the desk cards
        // keep them.
        visual: now.visual,
        last_known_visual: desk.last_known_visual,
        confirmed: now.confirmed,
        last_update: desk.last_event_ts,
        evidence: evidenceFor(state, desk),
        seat: desk.seat,
        role: desk.role,
        session_id: desk.session_id,
      }),
    );
  }

  items.sort((left, right) => {
    const byLevel = levelRank(left.level) - levelRank(right.level);
    if (byLevel !== 0) return byLevel;
    // A connection item has no desk state to rank, and sorts above the desks at
    // its own level: it is the reason their states cannot be trusted.
    const leftRank = left.last_known_visual === null ? -1 : attentionRank(left.last_known_visual);
    const rightRank = right.last_known_visual === null ? -1 : attentionRank(right.last_known_visual);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return compareStrings(left.id, right.id);
  });

  return {
    items,
    count: items.length,
    /** True when at least one item is an explicit request, not an advisory. */
    required: items.some((item) => item.level === 'required'),
  };
}

function runtimeFor(visual) {
  return ownProp(RUNTIME_BY_STATE, visual.state) ?? 'UNKNOWN';
}

/** The label for a runtime code. Text, so the class is never a colour alone. */
export function runtimeLabel(code) {
  return ownProp(RUNTIME_LABELS, code) ?? RUNTIME_LABELS.UNKNOWN;
}

/**
 * Now: actual runtime state, and only that.
 *
 * The class of every row comes from `claim`, which is `UNKNOWN` for the whole
 * office while the stream is not confirming anything - a disconnection, a halt
 * *or* a recovery in progress - so none of those leaves a row that reads as
 * still working. `last_known_runtime` keeps the observation itself, marked as
 * such.
 */
export function selectNow(state) {
  const desks = selectDesks(state);
  const frozen = unconfirmedStream(selectBanner(selectHeader(state)));
  const counts = {};
  for (const code of ARK_RUNTIME_CODES) counts[code] = 0;

  const rows = desks.map((desk) => {
    const now = claim(desk, frozen);
    const runtime = runtimeFor(now.visual);
    counts[runtime] += 1;
    return {
      actor_key: desk.actor_key,
      display_name: desk.display_name,
      seat: desk.seat,
      role: desk.role,
      session_id: desk.session_id,
      runtime,
      runtime_label: runtimeLabel(runtime),
      last_known_runtime: runtimeFor(desk.last_known_visual),
      visual: now.visual,
      last_known_visual: desk.last_known_visual,
      confirmed: now.confirmed,
      // The producer's label for the latest event. Never promoted to a task.
      work: desk.status_label,
      last_tool: desk.last_tool,
      updated_at: desk.last_event_ts,
      event_count: desk.event_count,
    };
  });

  rows.sort((left, right) => {
    const byRank = attentionRank(left.last_known_visual) - attentionRank(right.last_known_visual);
    if (byRank !== 0) return byRank;
    return left.seat - right.seat;
  });

  return {
    rows,
    counts,
    /** False while nothing is confirming these states. Never inferred per row. */
    confirmed: !frozen,
    as_of: state.last_event_ts,
    /** A bucket the contract cannot fill. Reported, not guessed. */
    external_wait: Object.freeze({ available: false, note: ARK_EXTERNAL_WAIT_NOTE }),
  };
}

/**
 * The Delegation Contract fields Next is meant to show, each one fail-closed.
 *
 * They are listed rather than omitted so the shape of what is missing is
 * visible: an owner reading this screen can see that "success condition" is a
 * thing the ARK will show and that today's read model does not carry it. When
 * the upstream contract gains them, the values change here and nothing else on
 * this screen has to move.
 */
export const ARK_NEXT_FIELDS = Object.freeze([
  Object.freeze({ key: 'goal', label: 'task / goal', value: NOT_IN_CONTRACT }),
  Object.freeze({ key: 'success_condition', label: 'success condition', value: NOT_IN_CONTRACT }),
  Object.freeze({ key: 'planned_steps', label: 'planned steps', value: NOT_IN_CONTRACT }),
  Object.freeze({ key: 'assignee', label: 'assigned AI / role', value: NOT_IN_CONTRACT }),
  Object.freeze({ key: 'expected_cost', label: 'expected time / cost', value: NOT_IN_CONTRACT }),
  Object.freeze({ key: 'human_gate', label: '予定されるHuman Gate', value: NOT_IN_CONTRACT }),
]);

export const ARK_NEXT_NOTE =
  'Delegation Contract（goal / success condition / planned steps / Human Gate）は現在のread modelにありません。予定そのものは表示できないため、いま計画中と報告されている作業だけを出しています。';

/**
 * Next: what is reported as being planned, and nothing beyond that.
 *
 * `selectDetail().next_action` is null by contract and this screen does not
 * improve on it. The only forward-looking fact the wire carries is that a desk
 * classified itself as `planning`, so that is what the rows are - each one
 * saying, in words, that the next step itself was not reported.
 */
export function selectNext(state) {
  const desks = selectDesks(state);
  const frozen = unconfirmedStream(selectBanner(selectHeader(state)));
  const rows = desks
    .filter((desk) => desk.last_known_visual.state === 'planning')
    .map((desk) => {
      const actor = ownProp(state.actors, desk.actor_key) ?? null;
      const now = claim(desk, frozen);
      return {
        actor_key: desk.actor_key,
        display_name: desk.display_name,
        seat: desk.seat,
        role: desk.role,
        /** Only ever an explicitly reported next step. The screen predicts none. */
        next_action: null,
        latest_summary: actor === null ? null : (actor.last_summary ?? null),
        visual: now.visual,
        last_known_visual: desk.last_known_visual,
        confirmed: now.confirmed,
        updated_at: desk.last_event_ts,
      };
    });
  rows.sort((left, right) => left.seat - right.seat);
  return { contract_available: false, note: ARK_NEXT_NOTE, fields: ARK_NEXT_FIELDS, rows };
}

/** The label for an outcome result. Text, never a colour alone. */
export function outcomeLabel(result) {
  return ownProp(OUTCOME_LABELS, result) ?? result;
}

/**
 * The event types that are a desk's own report about itself having finished.
 *
 * `session_end` is deliberately not one of them, and that is the whole point of
 * this list. The shared reducer rewrites *every* actor still active in a session
 * to `ended` when a `session_end` arrives - so a colleague whose only event was
 * `agent_start` lands on `ended` because somebody else's run stopped, not
 * because it finished anything. `hookAdapter.ts` drops `session.end_reason` and
 * `outcome.is_interrupt` on the way in, so nothing on the wire afterwards says
 * which of the two it was.
 *
 * Reading `ended` as 完了 there would be the screen inventing a success. So
 * completion has to be attributable to the desk itself, through a stop report it
 * made about itself.
 */
const ACTOR_COMPLETION_EVENTS = Object.freeze(['agent_stop']);

/**
 * The events that are a desk speaking about its own activity at all.
 *
 * Only these two decide the question below, and everything else is stepped over:
 * a `tool_use` or an `agent_status` describes a moment inside the work rather
 * than the start or the end of it, and a `session_end` is the run stopping
 * rather than this desk reporting anything.
 */
const ACTOR_LIFECYCLE_EVENTS = Object.freeze(['agent_start', 'agent_stop']);

/**
 * The stretch of the log that is still evidence about the office as it stands.
 *
 * The log outlives the state it described. `applySnapshot` replaces the actors
 * wholesale with the server's fold and leaves `state.log` untouched, so after a
 * recovery the client is holding entries from before the gap - observations of
 * runs the server has since carried further, and in some cases finished, begun
 * again and ended. Reading a stop out of that stretch would be the console
 * manufacturing a completion out of a report the snapshot has already
 * superseded: a desk that stopped, started again unseen and was then ended by a
 * generic `session_end` would come back as 完了.
 *
 * The boundary is in the data rather than in any bookkeeping of this screen's
 * own. `NamespaceStore.accept` spends exactly one `ingest_seq` per accepted
 * event, so the frames a client actually applied are consecutive, and whatever a
 * snapshot filled in on its behalf is a jump. The window is therefore the run of
 * entries that reaches `last_ingest_seq` without a break - the events observed
 * since the last snapshot, and the whole log when nothing was ever missed.
 *
 * Fail-closed at both ends: an office whose current position was established by
 * a snapshot has no entry at `last_ingest_seq`, so the window is empty and
 * nothing below may cite the log at all.
 */
function trustedLog(state) {
  const log = Array.isArray(state.log) ? state.log : [];
  const trusted = [];
  let expected = state.last_ingest_seq;
  for (const entry of log) {
    if (entry.ingest_seq !== expected) break;
    trusted.push(entry);
    expected -= 1;
  }
  return trusted;
}

/**
 * The ts this desk's applied history had already reached before the trusted
 * window opens, or null when nothing older is left to say.
 *
 * The rule below needs to know what the fold was comparing against when the
 * window's first entry for a desk arrived, and that comparison happened before
 * the window. The entries the window no longer covers can answer it, and the
 * applied ones need not be told apart from the rest to do so: an entry the fold
 * ignored is by definition older than the applied high-water mark of its moment,
 * so the newest ts among *all* of a desk's older entries is exactly the newest
 * among its applied ones.
 *
 * They can answer it only when they are the whole of that history, though, and
 * that is the one thing they may not be assumed to be. The entries
 * older than the window are on the far side of a recovery: `applySnapshot`
 * replaced the actors with the server's fold and left them standing, so between
 * the newest of them and the window there can be a stretch this client never
 * saw - and the fold's mark moved through it. Taking the newest surviving entry
 * as the mark then puts the floor *below* where the fold actually stood, and a
 * late `agent_stop` that the reducer refused against the snapshot-era mark is
 * accepted by the replay below and read back as a completion report.
 *
 * So the entries are usable only when they can be shown to be the desk's entire
 * pre-window history, and the read model says whether they are: the fold counts
 * every event it takes for a desk, applied or not, in `event_count`. When the
 * window's entries and the older ones together account for that count, nothing
 * was folded on this client's behalf and the newest of them *is* the mark the
 * fold was comparing against. When they fall short - a snapshot filled the
 * difference in, or `MAX_LOG_ENTRIES` has moved past it - the mark is unknown,
 * and unknown is not "nothing yet": it fails closed.
 *
 * Zero older entries is the same rule, not a special case. It means either a
 * desk born inside the window, which the count confirms, or a desk whose whole
 * history a snapshot brought, which the count refuses.
 */
function orderFloor(log, trusted, actorKey, actor) {
  let seen = 0;
  let floor = null;
  for (const entry of trusted) if (entry.actor_key === actorKey) seen += 1;
  for (let index = trusted.length; index < log.length; index += 1) {
    const entry = log[index];
    if (entry.actor_key !== actorKey) continue;
    seen += 1;
    const ms = Date.parse(entry.ts);
    if (floor === null || ms > floor) floor = ms;
  }
  const counted = actor === null ? null : actor.event_count;
  if (typeof counted !== 'number' || counted !== seen) return { known: false, ms: null };
  return { known: true, ms: floor };
}

/**
 * Where in the window the desk's latest applied event sits, or -1 when the
 * window does not contain it.
 *
 * The fold publishes that event: `last_event_ts` moves only when an event is
 * acted on, so the desk's newest applied entry is the one carrying that ts, and
 * *everything the desk sent after it was declined*. That is the fact `orderFloor`
 * cannot supply on its own. A floor reconstructed from the log runs out whenever
 * the entries that would establish it are gone - a snapshot filled that stretch
 * in on this client's behalf, or the log has simply moved past it - and a null
 * floor accepts the window's first entry for a desk unconditionally. A late
 * `agent_stop` landing there was then read as a completion report on a desk the
 * fold had already ended, which is a generic `session_end` manufacturing a
 * success by the back door.
 *
 * Anchoring on `last_event_ts` closes that without needing the floor at all:
 * no event can follow the last applied one and have been applied itself, so
 * every entry newer than this index is provably one the fold refused. The
 * scan takes the newest match because an entry newer in arrival than the true
 * anchor was declined, and a declined event is *strictly* older than the mark it
 * was compared against - so it can never carry the mark's own ts.
 *
 * Fail-closed: a desk whose latest applied event is not in the window has no
 * entry there that can be shown to have been applied, so the window says nothing
 * about it and `reportedOwnStop` falls back to the fold's own `last_event_type`.
 */
function appliedAnchor(trusted, actorKey, actor) {
  if (actor === null || typeof actor.last_event_ts !== 'string') return -1;
  const mark = Date.parse(actor.last_event_ts);
  if (!Number.isFinite(mark)) return -1;
  for (let index = 0; index < trusted.length; index += 1) {
    const entry = trusted[index];
    if (entry.actor_key !== actorKey) continue;
    if (Date.parse(entry.ts) === mark) return index;
  }
  return -1;
}

/**
 * The desk's own entries the fold acted on, oldest first.
 *
 * The log records what arrived, not what was accepted: `applyEvent` writes every
 * well-formed event to it, including the ones it then declines to act on. An
 * event whose `ts` is older than the desk's latest applied event is one of those
 * - the reducer counts it `out_of_order` and deliberately leaves the desk's
 * status, activity and `last_event_type` where they were - so an `agent_stop`
 * that arrived late stopped nothing, and reading it back out of the log as a
 * completion report would be the console crediting the desk with a finish the
 * read model itself refused.
 *
 * The rule applied here is `applyEvent`'s own, on the same field, in the same
 * direction - a replay of the fold's decision over the desk's own entries rather
 * than a second lifecycle of this screen's making. Nothing else about an event is
 * re-decided: this says only which entries the read model let speak.
 *
 * It is read between two bounds, and both come from the read model.
 * `appliedAnchor` is where the desk's applied history ends, and everything the
 * window holds past it was refused. `orderFloor` is where that history stood
 * when the window opened, and without it the replay has nothing to compare the
 * window's first entry against - so when the floor is unknown the window is
 * allowed to show only the one entry that needs no comparison, the anchor
 * itself, and the reading falls back to the fold's own `last_event_type`.
 */
function appliedOwnEntries(log, trusted, actorKey, actor) {
  const anchor = appliedAnchor(trusted, actorKey, actor);
  if (anchor === -1) return [];
  const floor = orderFloor(log, trusted, actorKey, actor);
  if (!floor.known) return [trusted[anchor]];
  const applied = [];
  // `trusted` is newest-first; the fold saw these in the opposite order.
  let previousMs = floor.ms;
  for (let index = trusted.length - 1; index >= anchor; index -= 1) {
    const entry = trusted[index];
    if (entry.actor_key !== actorKey) continue;
    const eventMs = Date.parse(entry.ts);
    if (previousMs !== null && eventMs < previousMs) continue;
    previousMs = eventMs;
    applied.push(entry);
  }
  return applied;
}

/**
 * Whether this desk's own latest report about itself was a stop.
 *
 * `last_event_type` alone cannot answer this, and the ordinary main-agent
 * lifecycle is why: `Stop` then `SessionEnd` fold into the *same* actor, so the
 * generic session frame overwrites the explicit `agent_stop` that came before it
 * and a genuinely finished orchestrator would read as 中断 with a follow-up line
 * claiming it never reported finishing. The fold keeps no per-actor history, but
 * the client already retains the last `MAX_LOG_ENTRIES` events it applied with
 * the `actor_key` each one belonged to - so the stop is still there to be found,
 * in the read model this console already reads and nowhere else.
 *
 * Read newest-first and stopping at the first lifecycle entry, so it is the
 * desk's *latest* report that decides: a stop that a later `agent_start`
 * superseded is a finished earlier run, not evidence about this one.
 *
 * Read out of `trustedLog` rather than the whole log, so it is also the desk's
 * latest report *about the office as it now stands*: an entry from before a
 * recovery describes a state the snapshot replaced, and may not be cited as
 * proof about what replaced it. And read out of `appliedOwnEntries` rather than
 * the window as it stands, so it is a report the read model actually accepted: a
 * late `agent_stop` the fold declined to act on is in the log all the same, and
 * it stopped nothing.
 *
 * Bounded, and honest about that: past the log window - on a state rebuilt from
 * a `snapshot`, whose own log is all pre-recovery, and on any desk whose history
 * began before this client's log and so cannot be ordered out of it - there is
 * no entry left that can be shown to have been applied, and the reading falls
 * back to `last_event_type`, which the fold always carries and which a snapshot
 * always re-establishes. The cost is real and is paid deliberately: a browser
 * opened mid-run reads a finished orchestrator as 中断, because a `session_end`
 * has overwritten the only field left to read. That direction under-claims a
 * completion, which is the safe half; the other one, a generic `session_end`
 * manufacturing a success, is what may never happen.
 */
function reportedOwnStop(log, trusted, actorKey, actor) {
  if (typeof actorKey === 'string') {
    const applied = appliedOwnEntries(log, trusted, actorKey, actor);
    for (let index = applied.length - 1; index >= 0; index -= 1) {
      const entry = applied[index];
      if (!ACTOR_LIFECYCLE_EVENTS.includes(entry.event_type)) continue;
      return ACTOR_COMPLETION_EVENTS.includes(entry.event_type);
    }
  }
  return actor !== null && ACTOR_COMPLETION_EVENTS.includes(actor.last_event_type);
}

/**
 * Which outcome a desk has reached, or null while it has not reached one.
 *
 * Only `FAILED` and `COMPLETED` are positive claims, and each needs the desk's
 * own report behind it: a failure it classified as one, or a stop it announced
 * itself. Everything that stopped without such a report is `STOPPED`, whose
 * follow-up line says the one thing that is actually known about it - the work
 * ended and this desk never reported finishing it. Three cases land there:
 *
 * - a desk the session ended *around* while it was still mid-work or waiting;
 * - a desk the `session_end` rewrite moved to `ended` without it ever saying so;
 * - a desk whose latest event merely carried a finished-sounding status.
 *
 * Narrower than it looks from the outside: in the streams this reads, a
 * completion is an `agent_stop`, and those still land on 完了 - including the
 * main orchestrator whose own stop is followed by the `session_end` that closes
 * the run, which `reportedOwnStop` finds rather than losing to the newer frame.
 */
function outcomeFor(log, trusted, desk, actor, session) {
  const observed = desk.last_known_visual.state;
  if (observed === 'error') return 'FAILED';
  if (observed === 'ended') {
    return reportedOwnStop(log, trusted, desk.actor_key, actor) ? 'COMPLETED' : 'STOPPED';
  }
  if (session !== null && session.ended_at !== null && session.ended_at !== undefined) {
    return 'STOPPED';
  }
  return null;
}

/**
 * Outcome: what finished, how it finished, and what evidence there is.
 *
 * Failures first: an outcome list that opens with successes is one an owner
 * scrolls past.
 */
export function selectOutcome(state) {
  const desks = selectDesks(state);
  const frozen = unconfirmedStream(selectBanner(selectHeader(state)));
  // One window for the whole panel, so no two rows read the same log differently.
  const log = Array.isArray(state.log) ? state.log : [];
  const trusted = trustedLog(state);
  const rows = [];
  for (const desk of desks) {
    const session = ownProp(state.sessions, desk.session_id) ?? null;
    const actor = desk.actor_key === null ? null : (ownProp(state.actors, desk.actor_key) ?? null);
    const result = outcomeFor(log, trusted, desk, actor, session);
    if (result === null) continue;
    const now = claim(desk, frozen);
    rows.push({
      actor_key: desk.actor_key,
      display_name: desk.display_name,
      seat: desk.seat,
      role: desk.role,
      result,
      result_label: outcomeLabel(result),
      /** The producer's label for the latest event, not a result description. */
      summary: desk.status_label,
      follow_up: ownProp(OUTCOME_FOLLOW_UP, result) ?? null,
      session_id: desk.session_id,
      session_ended_at: session === null ? null : (session.ended_at ?? null),
      ended_at: desk.last_event_ts,
      confirmed: now.confirmed,
      visual: now.visual,
      last_known_visual: desk.last_known_visual,
      evidence: evidenceFor(state, desk),
    });
  }
  rows.sort((left, right) => {
    const byResult =
      ARK_OUTCOME_RESULTS.indexOf(left.result) - ARK_OUTCOME_RESULTS.indexOf(right.result);
    if (byResult !== 0) return byResult;
    return left.seat - right.seat;
  });
  return {
    rows,
    counts: {
      FAILED: rows.filter((row) => row.result === 'FAILED').length,
      STOPPED: rows.filter((row) => row.result === 'STOPPED').length,
      COMPLETED: rows.filter((row) => row.result === 'COMPLETED').length,
    },
    /** Tests, CI, PR, commit and artifact refs are not on the wire today. */
    artifacts: Object.freeze({ available: false, note: NO_EVIDENCE_IN_CONTRACT }),
  };
}

// ------------------------------------------------------ command surface ---

/** Longest delegation text accepted, in code points. */
export const ARK_COMMAND_MAX = 400;

export const ARK_COMMAND_STATUSES = Object.freeze(['empty', 'rejected', 'ready']);

/** Why a draft was refused. Closed, and never echoing the text back. */
export const ARK_COMMAND_REJECTS = Object.freeze(['empty', 'too_long', 'control_chars']);

const ARK_COMMAND_REJECT_MESSAGES = Object.freeze({
  empty: '依頼内容を入力してください。',
  too_long: `依頼内容が長すぎます（上限 ${ARK_COMMAND_MAX} 文字）。`,
  control_chars: '制御文字は使えません。',
});

/** The same rule the organisation validator uses: C0 and DEL, nothing else. */
const COMMAND_CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]');

/**
 * The one honest thing this screen can say about sending a task.
 *
 * There is no authenticated Control boundary for Quest to hand a delegation to,
 * and Quest is not allowed to become one: it opens two documented read-only SSE
 * endpoints and nothing else. So the draft is built, shown, and explicitly not
 * dispatched. Saying "送信しました" here - or quietly doing nothing while looking
 * like it worked - is the exact failure this constant exists to prevent.
 */
export const ARK_SUBMISSION = Object.freeze({
  available: false,
  code: 'NOT_CONNECTED',
  message:
    '送信先の認証済みControl boundaryが未接続です。この画面からTaskは送信されません（内容の組み立てまで）。',
});

/** The version of the draft payload shape below. */
export const ARK_COMMAND_SCHEMA_VERSION = 1;

function countChars(value) {
  let total = 0;
  for (const character of value) {
    if (character.length > 0) total += 1;
  }
  return total;
}

/**
 * Structures what an owner typed into the typed Task/Delegation payload a
 * trusted boundary would accept, and reports that there is nowhere to send it.
 *
 * Pure: no clock, no request, no side effect. `at` is passed in by the caller so
 * the draft can carry a timestamp without this function reading one.
 */
export function buildCommandDraft(input, context = {}) {
  const raw = typeof input === 'string' ? input : '';
  const intent = raw.trim();
  const length = countChars(intent);

  let reject = null;
  if (length === 0) reject = 'empty';
  else if (length > ARK_COMMAND_MAX) reject = 'too_long';
  else if (COMMAND_CONTROL_CHARS.test(intent)) reject = 'control_chars';

  const status = reject === null ? 'ready' : reject === 'empty' ? 'empty' : 'rejected';
  const namespace = typeof context.namespace === 'string' ? context.namespace : null;
  const target =
    typeof context.target_actor_key === 'string' && context.target_actor_key.length > 0
      ? context.target_actor_key
      : null;

  return {
    status,
    reject,
    message: reject === null ? null : (ownProp(ARK_COMMAND_REJECT_MESSAGES, reject) ?? null),
    length,
    max: ARK_COMMAND_MAX,
    payload:
      status !== 'ready'
        ? null
        : {
            schema_version: ARK_COMMAND_SCHEMA_VERSION,
            kind: 'owner_task_delegation',
            origin: 'owner_ark_console',
            namespace,
            intent,
            target_actor_key: target,
            drafted_at: typeof context.at === 'string' ? context.at : null,
            /** Stated in the payload itself: nothing dispatched this. */
            dispatch: 'none',
          },
    submission: ARK_SUBMISSION,
  };
}

/**
 * The whole console in one call, so the DOM layer holds no projection logic of
 * its own and every panel is derived from exactly the same state.
 */
export function selectArk(state) {
  const header = selectHeader(state);
  return {
    header,
    banner: selectBanner(header),
    attention: selectAttention(state),
    now: selectNow(state),
    next: selectNext(state),
    outcome: selectOutcome(state),
  };
}
