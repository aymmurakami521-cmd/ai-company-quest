/**
 * Types for the Owner ARK management projection in `quest-ark.js`.
 *
 * The implementation stays plain JS because the browser loads it as-is, so its
 * contract is declared here and exercised by `test/ui-ark.test.ts`.
 */

import type {
  ActorVisual,
  Banner,
  BannerCode,
  ClientState,
  ConnectionPhase,
  Header,
} from './quest-view.js';

/** How loudly an item asks for a person. `required` is an explicit request. */
export type ArkAttentionLevel = 'required' | 'advised';

export type ArkAttentionReason =
  | 'AWAITING_APPROVAL'
  | 'INGEST_HALTED'
  | 'RUN_ERROR'
  | 'STREAM_UNCONFIRMED';

/** A rename of a state the view model already classifies, never a new one. */
export type ArkRuntimeCode = 'BLOCKED' | 'HUMAN_WAIT' | 'EXECUTING' | 'ENDED' | 'IDLE' | 'UNKNOWN';

export type ArkOutcomeResult = 'FAILED' | 'STOPPED' | 'COMPLETED';

/** One fact off the stream, as a label the reader can follow back. */
export type ArkEvidenceRef = { label: string; value: string };

/**
 * Two kinds of evidence, kept apart on purpose.
 *
 * `trace` is what the stream reported and is always reachable. `artifacts` -
 * tests, CI, PR, commit - is not on the wire today, so it is reported absent
 * rather than left blank.
 */
export type ArkEvidence = {
  trace: readonly ArkEvidenceRef[];
  artifacts: { readonly available: false; readonly note: string };
};

/**
 * A Need You item: not "approve this", but the decision itself - why a person is
 * needed, what the choice is, and what happens if nobody makes it.
 *
 * `visual` and `last_known_visual` are null on a `connection` item: a lost
 * stream is a fact about the stream, not about anybody's desk.
 */
export type ArkAttentionItem = {
  id: string;
  kind: 'actor' | 'connection';
  reason_code: ArkAttentionReason;
  level: ArkAttentionLevel;
  reason: string;
  recommended: string;
  /** Descriptions of the decision, never controls. This screen dispatches none. */
  options: readonly string[];
  /** What happens if nobody acts. */
  inaction: string;
  title: string;
  detail: string;
  actor_key: string | null;
  display_name: string | null;
  visual: ActorVisual | null;
  last_known_visual: ActorVisual | null;
  /** False while nothing is confirming this. Never presented as a live fact. */
  confirmed: boolean;
  last_update: string | null;
  evidence: ArkEvidence;
  seat?: number;
  role?: string | null;
  session_id?: string;
};

export type ArkAttention = {
  items: ArkAttentionItem[];
  count: number;
  /** True when at least one item is an explicit request, not an advisory. */
  required: boolean;
};

export type ArkNowRow = {
  actor_key: string;
  display_name: string;
  seat: number;
  role: string | null;
  session_id: string;
  /**
   * What may be claimed now. `UNKNOWN` for the whole office whenever nothing is
   * confirming it - a lost stream, a halt, or a recovery still in progress.
   */
  runtime: ArkRuntimeCode;
  runtime_label: string;
  /** What the stream last said, kept through a freeze. */
  last_known_runtime: ArkRuntimeCode;
  visual: ActorVisual;
  last_known_visual: ActorVisual;
  confirmed: boolean;
  /** The producer's label for the latest event. Never a task name. */
  work: string | null;
  last_tool: string | null;
  updated_at: string | null;
  event_count: number;
};

export type ArkNow = {
  rows: ArkNowRow[];
  counts: Record<ArkRuntimeCode, number>;
  confirmed: boolean;
  as_of: string | null;
  /** A bucket the contract cannot fill. Reported, never guessed. */
  external_wait: { readonly available: false; readonly note: string };
};

export type ArkNextField = { key: string; label: string; value: string };

export type ArkNextRow = {
  actor_key: string;
  display_name: string;
  seat: number;
  role: string | null;
  /** Always null: no explicit next step exists on the wire today. */
  next_action: null;
  latest_summary: string | null;
  visual: ActorVisual;
  last_known_visual: ActorVisual;
  confirmed: boolean;
  updated_at: string | null;
};

export type ArkNext = {
  /** Always false today: the Delegation Contract is not in this read model. */
  contract_available: false;
  note: string;
  fields: readonly ArkNextField[];
  rows: ArkNextRow[];
};

export type ArkOutcomeRow = {
  actor_key: string;
  display_name: string;
  seat: number;
  role: string | null;
  result: ArkOutcomeResult;
  result_label: string;
  summary: string | null;
  follow_up: string | null;
  session_id: string;
  session_ended_at: string | null;
  ended_at: string | null;
  confirmed: boolean;
  visual: ActorVisual;
  last_known_visual: ActorVisual;
  evidence: ArkEvidence;
};

export type ArkOutcome = {
  rows: ArkOutcomeRow[];
  counts: Record<ArkOutcomeResult, number>;
  artifacts: { readonly available: false; readonly note: string };
};

export type ArkCommandStatus = 'empty' | 'rejected' | 'ready';
export type ArkCommandReject = 'empty' | 'too_long' | 'control_chars';

/**
 * The typed Task/Delegation payload a trusted boundary would accept.
 *
 * Built and shown. Never sent: `dispatch` says so in the payload itself.
 */
export type ArkCommandPayload = {
  schema_version: number;
  kind: 'owner_task_delegation';
  origin: 'owner_ark_console';
  namespace: string | null;
  intent: string;
  target_actor_key: string | null;
  drafted_at: string | null;
  dispatch: 'none';
};

export type ArkCommandDraft = {
  status: ArkCommandStatus;
  reject: ArkCommandReject | null;
  message: string | null;
  length: number;
  max: number;
  payload: ArkCommandPayload | null;
  submission: typeof ARK_SUBMISSION;
};

export type ArkCommandContext = {
  namespace?: string | null;
  target_actor_key?: string | null;
  /** Injected by the caller, so the builder itself reads no clock. */
  at?: string | null;
};

export type ArkConsole = {
  header: Header;
  banner: Banner;
  attention: ArkAttention;
  now: ArkNow;
  next: ArkNext;
  outcome: ArkOutcome;
};

export declare const NOT_IN_CONTRACT: string;
export declare const ARK_ATTENTION_LEVELS: readonly ArkAttentionLevel[];
export declare const ARK_ATTENTION_REASONS: readonly ArkAttentionReason[];
export declare const ARK_RUNTIME_CODES: readonly ArkRuntimeCode[];
export declare const ARK_OUTCOME_RESULTS: readonly ArkOutcomeResult[];
export declare const ARK_SUMMARY_ROWS: number;
/** Banner codes under which no row on this console is a live observation. */
export declare const ARK_UNCONFIRMED_BANNER_CODES: readonly BannerCode[];
/** The control frames that re-establish what is current after a socket opens. */
export declare const ARK_RECOVERY_FRAMES: readonly string[];
/** The subset of those that also carry the namespace's halt state themselves. */
export declare const ARK_SETTLING_RECOVERY_FRAMES: readonly string[];
export declare const ARK_EXTERNAL_WAIT_NOTE: string;
export declare const ARK_NEXT_FIELDS: readonly ArkNextField[];
export declare const ARK_NEXT_NOTE: string;
export declare const ARK_COMMAND_MAX: number;
export declare const ARK_COMMAND_STATUSES: readonly ArkCommandStatus[];
export declare const ARK_COMMAND_REJECTS: readonly ArkCommandReject[];
export declare const ARK_COMMAND_SCHEMA_VERSION: number;
export declare const ARK_SUBMISSION: {
  readonly available: false;
  readonly code: 'NOT_CONNECTED';
  readonly message: string;
};

/**
 * The phase the console may claim when the socket reports `open`: `reconnecting`
 * over an office that already holds desks, so a reconnect stays unconfirmed
 * until a recovery frame lands, and `open` when it is rebuilding from empty.
 */
export declare function arkPhaseOnOpen(state: ClientState): ConnectionPhase;
/** Whether this applied frame is the recovery that may lift that freeze. */
export declare function arkRecovered(
  before: ClientState,
  after: ClientState,
  frameKind: string,
): boolean;
/**
 * Whether that recovery frame settles the namespace's health as well as its
 * office. False for `replay_end`, which a queued `fail_closed` can still follow.
 */
export declare function arkRecoverySettles(frameKind: string): boolean;

export declare function runtimeLabel(code: string): string;
export declare function outcomeLabel(result: string): string;
export declare function selectAttention(state: ClientState): ArkAttention;
export declare function selectNow(state: ClientState): ArkNow;
export declare function selectNext(state: ClientState): ArkNext;
export declare function selectOutcome(state: ClientState): ArkOutcome;
export declare function buildCommandDraft(
  input: unknown,
  context?: ArkCommandContext,
): ArkCommandDraft;
export declare function selectArk(state: ClientState): ArkConsole;
