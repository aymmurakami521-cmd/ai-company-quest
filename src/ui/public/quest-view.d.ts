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
  session_id: string;
  status: string | null;
  tool_name: string | null;
  summary: string | null;
  state: ActorVisualState;
};

export type ClientState = {
  namespace: string;
  connection: ViewConnection;
  sessions: Record<string, ViewSession>;
  actors: Record<string, ViewActor>;
  /** Null until a `snapshot` names one. Never invented by the screen. */
  player: ViewPlayer | null;
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
  visual: ActorVisual;
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
export declare function selectDesks(state: ClientState): Desk[];
export declare function selectPlayer(state: ClientState | null | undefined): PlayerProjection | null;
export declare function selectHeader(state: ClientState): Header;
export declare function selectBanner(header: Header): Banner;
export declare function describeFreshness(state: ClientState, nowMs: number | null): string;
