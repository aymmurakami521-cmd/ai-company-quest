/**
 * Types for the browser-native view model in `quest-view.js`.
 *
 * The implementation has to stay plain JS because the browser loads it as-is,
 * so its contract is declared here and exercised by `test/ui-view.test.ts`.
 */

/** States a status label can be classified into. `unknown` is not one of them. */
export type ActorVisualState =
  | 'error'
  | 'awaiting_approval'
  | 'planning'
  | 'working'
  | 'ended'
  | 'idle';

/** Every state the screen can display, including the one it lands on to avoid guessing. */
export type ActorDisplayState = ActorVisualState | 'unknown';

export type ConnectionPhase = 'offline' | 'connecting' | 'open' | 'reconnecting' | 'error';

export type Visual<TState extends string> = {
  readonly state: TState;
  /** Stable machine-readable label, also used as a CSS hook. */
  readonly code: string;
  /** Human-readable label shown next to the symbol. Never colour-only. */
  readonly label: string;
  readonly symbol: string;
};

/** Widened to the displayable set: `classifyActor` can land on `unknown`. */
export type ActorVisual = Visual<ActorDisplayState>;
export type ConnectionVisual = Visual<ConnectionPhase | 'fail_closed'>;

/**
 * The seat of a roster member no event has mentioned.
 *
 * A separate type from `ActorVisual` because `vacant` is deliberately outside
 * the actor vocabulary: it is the absence of events, not a state an event put
 * somebody into (`docs/org-snapshot-design.md` §2.3).
 */
export type VacantVisual = Visual<'vacant'>;
export type OfficeVisual = ActorVisual | VacantVisual;

/** Why the collector refused an organisation. Mirrors `OrgRejectRule`. */
export type OrgRejectRule =
  | 'not_object'
  | 'unsupported_schema'
  | 'missing_key'
  | 'type_error'
  | 'invalid_format'
  | 'field_too_long'
  | 'control_chars'
  | 'unsafe_content'
  | 'duplicate_id'
  | 'unknown_reference'
  | 'limit_exceeded';

export type ViewOrgDepartment = { id: string; name: string; display_order: number };

export type ViewOrgRole = {
  id: string;
  name: string;
  display_order: number;
  /** Null for every role that belongs to no department. */
  department_id: string | null;
  /** The comparison key against `ViewActor.runtime_agent_type`. May be null. */
  runtime_agent_type: string | null;
};

export type ViewOrgSnapshot = {
  departments: ViewOrgDepartment[];
  roles: ViewOrgRole[];
};

/**
 * The organisation, as the same closed three-value vocabulary the collector
 * uses. `absent` and `rejected` are distinct on purpose: they mean different
 * things to the reader and must never collapse into one another.
 */
export type ViewOrgState =
  | { status: 'absent' }
  | { status: 'accepted'; snapshot: ViewOrgSnapshot }
  /** `field` is a path such as `roles[3].name`: indexes, never values. */
  | { status: 'rejected'; field: string; rule: OrgRejectRule };

/** The subset of a wire event this screen reads. */
export type ViewWireEvent = {
  event_id: string;
  ingest_seq: number;
  namespace: string;
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
  summary: string | null;
};

export type ViewActor = {
  actor_key: string;
  session_id: string;
  agent_id: string | null;
  role: string | null;
  resolved: boolean;
  is_main_orchestrator: boolean;
  status: string | null;
  active: boolean;
  last_tool: string | null;
  /** The producer's label for the latest event. A summary, never a task name. */
  last_summary: string | null;
  last_event_type: string | null;
  /** Runtime configuration behind the desk. Not an org role. */
  runtime_agent_type: string | null;
  last_event_ts: string | null;
  last_ingest_seq: number;
  event_count: number;
};

/**
 * The human player, as the server's `state.player` entity reports them.
 *
 * A different kind of entity from `ViewActor`, and kept in its own field for
 * that reason: `reduce` never writes it, so no Claude event can change it.
 */
export type ViewPlayer = {
  kind: 'player';
  id: string;
  display_name: string;
};

export type ViewSession = {
  session_id: string;
  started_at: string | null;
  ended_at: string | null;
  event_count: number;
  actor_keys: string[];
};

/** Closed vocabulary; mirrors `HaltReason` in `src/collector/store.ts`. */
export type HaltReasonToken = 'unsupported_schema' | 'state_limit' | 'producer_capacity';

/** Closed vocabulary; mirrors the `stream_gap` reasons `src/server/server.ts` emits. */
export type GapReasonToken = 'invalid_last_event_id' | 'unknown_event_id' | 'evicted';

export type ViewConnection = {
  phase: ConnectionPhase;
  halted: boolean;
  /** Non-null only when the server named a reason this screen knows. */
  halt_reason: HaltReasonToken | null;
  replaying: boolean;
  gap: { reason: string } | null;
  last_event_id: string | null;
  last_frame_at_ms: number | null;
};

export type ViewLogEntry = {
  event_id: string;
  ingest_seq: number;
  ts: string;
  event_type: string;
  actor: string;
  /** Identity behind `actor`, so a log can be filtered to exactly one desk. */
  actor_key: string;
  session_id: string;
  status: string | null;
  tool_name: string | null;
  summary: string | null;
  state: ActorDisplayState;
};

export type ClientState = {
  namespace: string;
  connection: ViewConnection;
  sessions: Record<string, ViewSession>;
  actors: Record<string, ViewActor>;
  /** Null until a `snapshot` names one. Never invented by the screen. */
  player: ViewPlayer | null;
  /** Operator input, not stream content: only a `snapshot` changes it. */
  org: ViewOrgState;
  last_ingest_seq: number;
  last_event_ts: string | null;
  /** `actor_key` of the seat the operator selected, or `null`. Always one that is seated. */
  selected_actor_key: string | null;
  counters: {
    applied: number;
    ignored: number;
    out_of_order: number;
    foreign: number;
    snapshots: number;
    gaps: number;
    halts: number;
  };
  log: ViewLogEntry[];
};

export type SnapshotPayload = {
  namespace: string;
  halted: boolean;
  halt_reason: string | null;
  last_ingest_seq: number;
  state: {
    actors?: Record<string, ViewActor>;
    sessions?: Record<string, ViewSession>;
    player?: ViewPlayer;
  };
};

/** The `fail_closed` control frame: ingestion stopped while this client was connected. */
export type HaltPayload = {
  namespace: string;
  halted: true;
  reason: HaltReasonToken;
  detail: string;
};

export type Frame =
  | { kind: 'event'; payload: unknown; at_ms?: number }
  | { kind: 'snapshot'; payload: unknown; at_ms?: number }
  | { kind: 'fail_closed'; payload: unknown; at_ms?: number }
  | { kind: 'replay_start'; payload?: unknown; at_ms?: number }
  | { kind: 'replay_end'; payload?: unknown; at_ms?: number }
  | { kind: 'stream_gap'; payload?: unknown; at_ms?: number }
  | { kind: string; payload?: unknown; at_ms?: number };

export type Desk = {
  seat: number;
  actor_key: string;
  session_id: string;
  display_name: string;
  is_main_orchestrator: boolean;
  /** Non-null only when the collector resolved a role. Never inferred here. */
  role: string | null;
  resolved: boolean;
  status_label: string | null;
  last_tool: string | null;
  last_event_ts: string | null;
  event_count: number;
  /** True for the one desk `selected_actor_key` points at. */
  selected: boolean;
  /** What the screen may claim now: `UNKNOWN` whenever `stale` is true. */
  visual: ActorVisual;
  /** True while no live stream is confirming this desk's state. */
  stale: boolean;
  /**
   * What the stream last said, kept even while `stale`. The card shows it as
   * "停止時点", so a disconnection freezes the office instead of erasing it.
   */
  last_known_visual: ActorVisual;
};

export type Header = {
  mode: 'LIVE' | 'DEMO';
  namespace: string;
  connection: ConnectionVisual;
  halted: boolean;
  halt_reason: HaltReasonToken | null;
  replaying: boolean;
  gap: { reason: string } | null;
  empty: boolean;
  desk_count: number;
  session_count: number;
  last_ingest_seq: number;
  last_event_ts: string | null;
  last_frame_at_ms: number | null;
  by_state: Record<ActorDisplayState, number>;
};

/**
 * The screen's closed status vocabulary. Exactly one code is showing at any
 * moment, so there is no state of the screen that reports nothing.
 */
export type BannerCode =
  | 'FAIL_CLOSED'
  | 'DISCONNECTED'
  | 'RECONNECTING'
  | 'STREAM_GAP'
  | 'REPLAYING'
  | 'LOADING'
  | 'EMPTY'
  | 'CONNECTED';

export type Banner = {
  readonly code: BannerCode;
  /** Colour hook only: `code` and `symbol` already carry the meaning as text. */
  readonly tone: 'error' | 'warn' | 'info' | 'ok';
  readonly symbol: string;
  readonly message: string;
};

/**
 * The player, projected for the screen.
 *
 * Not a `Desk`: no seat, no `actor_key`, no session, no visual state, because
 * none of those are facts about the person at the keyboard.
 */
export type PlayerProjection = {
  kind: 'player';
  id: string;
  display_name: string;
};

export declare const UNATTRIBUTED_AGENT_LABEL: string;
export declare const PLAYER_NAME_MAX: number;
export declare const MAX_LOG_ENTRIES: number;
export declare const ACTOR_VISUAL_STATES: readonly ActorVisualState[];
export declare const ACTOR_LEGEND_STATES: readonly ActorDisplayState[];
export declare const BANNER_CODES: readonly BannerCode[];

export declare function statusTokens(status: string | null): string[];
export declare function classifyStatus(status: string | null): ActorVisualState | null;
export declare function visualForState(state: string): ActorVisual;
export declare function classifyActor(actor: Partial<ViewActor> | null | undefined): ActorVisual;
export declare function isStale(connection: ViewConnection | null | undefined): boolean;
export declare function classifyConnection(connection: Partial<ViewConnection> | null | undefined): ConnectionVisual;
export declare function createClientState(namespace: string): ClientState;
export declare function setConnectionPhase(state: ClientState, phase: string, atMs?: number | null): ClientState;
export declare function setSelectedActor(state: ClientState, actorKey: string | null): ClientState;
export declare function applyEvent(state: ClientState, wire: unknown, atMs?: number | null): ClientState;
export declare function applySnapshot(state: ClientState, payload: unknown, atMs?: number | null): ClientState;
export declare function applyHalt(state: ClientState, payload: unknown, atMs?: number | null): ClientState;
export declare function normalizeHaltReason(value: unknown): HaltReasonToken | null;
export declare function haltLabel(reason: unknown): string | null;
export declare function normalizeGapReason(value: unknown): GapReasonToken | null;
export declare function gapLabel(reason: unknown): string | null;
export declare function applyFrame(state: ClientState, frame: Frame): ClientState;
export declare function normalizePlayer(raw: unknown): ViewPlayer | null;
/**
 * A desk in the organisation-grouped office.
 *
 * Widens `Desk` where the roster makes a field optional rather than certain: a
 * vacant seat has no actor and no dynamic seat number, and an actor the roster
 * does not know has no roster seat. Neither field is ever derived from the
 * other (`docs/org-snapshot-design.md` §4.4).
 */
export type OfficeDesk = Omit<
  Desk,
  'seat' | 'actor_key' | 'visual' | 'last_known_visual' | 'session_id' | 'display_name'
> & {
  /** False for a roster seat no actor answers to. */
  occupied: boolean;
  /** Position in the dynamic ordering. Null for a vacant roster seat. */
  seat: number | null;
  /** Position in the roster. Null for an actor the roster does not know. */
  roster_seat: number | null;
  actor_key: string | null;
  session_id: string | null;
  role_id: string | null;
  /** What the stream called this actor. Null on a seat no actor answers to. */
  display_name: string | null;
  /** The roster's label for this seat. Null for an actor the roster does not know. */
  role_name: string | null;
  /**
   * Every actor this desk stands for, in the office's own order.
   *
   * More than one when several actors answer to the seat's comparison key.
   * That is usually the same colleague running in several sessions, but an
   * actor is keyed by `(session_id, agent_id)`, so one session running two
   * agents of the same runtime type lands here too - this is a count of actors,
   * never of sessions (`docs/org-snapshot-design.md` §4.2). Empty on a vacant
   * roster seat.
   */
  occupants: string[];
  visual: OfficeVisual;
  last_known_visual: OfficeVisual;
};

export type OfficeZone = {
  id: string;
  name: string;
  kind: 'department' | 'unassigned';
  desks: OfficeDesk[];
};

/**
 * `grouped` is false whenever the organisation was not accepted, and then
 * `zones` is empty and `desks` is exactly `selectDesks(state)` - the screen the
 * prototype had before the roster existed.
 */
export type OfficeProjection = {
  grouped: boolean;
  zones: OfficeZone[];
  /** Every desk in render order, zone by zone when grouped. */
  desks: OfficeDesk[] | Desk[];
};

/** The closed vocabulary of the second status surface. */
export type SecondaryStatusCode = 'ORG_ACCEPTED' | 'ORG_ABSENT' | 'ORG_REJECTED';

export type SecondaryStatus = {
  readonly code: SecondaryStatusCode;
  readonly tone: 'warn' | 'info' | 'ok';
  readonly message: string;
  /** `field / rule` for a refusal, null otherwise. Never a value or a name. */
  readonly detail: string | null;
  /** True whenever the office fell back to the organisation-less screen. */
  readonly degraded: boolean;
};

export declare const VACANT_SEAT_VISUAL: VacantVisual;
export declare const UNASSIGNED_ZONE_ID: string;
export declare const UNASSIGNED_ZONE_NAME: string;
export declare const ORG_LIMITS: { readonly departments: number; readonly roles: number };
export declare const ORG_REJECT_RULES: readonly OrgRejectRule[];
export declare const SECONDARY_STATUS_CODES: readonly SecondaryStatusCode[];

export declare function normalizeOrg(raw: unknown): ViewOrgState;
export declare function selectDesks(state: ClientState): Desk[];
export declare function selectOffice(state: ClientState): OfficeProjection;
export declare function selectSecondaryStatus(state: ClientState): SecondaryStatus;

/**
 * The selected desk in full, or null when nothing is selected.
 *
 * Fields that are `null` mean the event contract carries nothing for them - the
 * screen reports the absence instead of filling it in. See the constants below
 * for the wording each absence is rendered with.
 */
export type ActorDetail = {
  actor_key: string;
  display_name: string;
  seat: number;
  is_main_orchestrator: boolean;
  role: string | null;
  runtime_agent_type: string | null;

  visual: ActorVisual;
  stale: boolean;
  last_known_visual: ActorVisual;
  status_label: string | null;

  /** An explicit BUSINESS task. Always null today; see `NO_TASK_REFERENCE`. */
  task: string | null;
  /** The producer's label for the latest event. Never a task name. */
  latest_summary: string | null;
  /** Only an explicitly reported next step. Always null today. */
  next_action: string | null;
  human_action: string;

  last_event_type: string | null;
  last_tool: string | null;
  last_event_ts: string | null;
  event_count: number;

  session_id: string;
  session_ended_at: string | null;

  /** Most recent non-error activity for this desk, from the bounded client log. */
  last_non_error: ViewLogEntry | null;
  /** Retry / handoff / checkpoint are not in the contract. Always null. */
  recovery: string | null;
  /** No artifact, test, review or commit reference exists on the wire today. */
  evidence: string | null;
  recent: ViewLogEntry[];
};

export declare function selectDetail(state: ClientState): ActorDetail | null;

export declare const HUMAN_ACTION: {
  readonly required: string;
  readonly advised: string;
  readonly none: string;
};
export declare const NOT_REPORTED: string;
export declare const NO_TASK_REFERENCE: string;
export declare const NO_EVIDENCE_IN_CONTRACT: string;
export declare const DETAIL_LOG_ENTRIES: number;
export declare function selectPlayer(state: ClientState | null | undefined): PlayerProjection | null;
export declare function selectHeader(state: ClientState): Header;
export declare function selectBanner(header: Header): Banner;
export declare function describeFreshness(state: ClientState, nowMs: number | null): string;
