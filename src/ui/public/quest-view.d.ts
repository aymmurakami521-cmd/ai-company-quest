/**
 * Types for the browser-native view model in `quest-view.js`.
 *
 * The implementation has to stay plain JS because the browser loads it as-is,
 * so its contract is declared here and exercised by `test/ui-view.test.ts`.
 */

export type ActorVisualState = 'error' | 'awaiting_approval' | 'working' | 'ended' | 'idle';

export type ConnectionPhase = 'offline' | 'connecting' | 'open' | 'reconnecting' | 'error';

export type Visual<TState extends string> = {
  readonly state: TState;
  /** Stable machine-readable label, also used as a CSS hook. */
  readonly code: string;
  /** Human-readable label shown next to the symbol. Never colour-only. */
  readonly label: string;
  readonly symbol: string;
};

export type ActorVisual = Visual<ActorVisualState>;
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

export type ViewSession = {
  session_id: string;
  started_at: string | null;
  ended_at: string | null;
  event_count: number;
  actor_keys: string[];
};

export type ViewConnection = {
  phase: ConnectionPhase;
  halted: boolean;
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
  last_ingest_seq: number;
  last_event_ts: string | null;
  counters: {
    applied: number;
    ignored: number;
    out_of_order: number;
    foreign: number;
    snapshots: number;
    gaps: number;
  };
  log: ViewLogEntry[];
};

export type SnapshotPayload = {
  namespace: string;
  halted: boolean;
  last_ingest_seq: number;
  state: { actors?: Record<string, ViewActor>; sessions?: Record<string, ViewSession> };
};

export type Frame =
  | { kind: 'event'; payload: unknown; at_ms?: number }
  | { kind: 'snapshot'; payload: unknown; at_ms?: number }
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
  visual: ActorVisual;
};

export type Header = {
  mode: 'LIVE' | 'DEMO';
  namespace: string;
  connection: ConnectionVisual;
  halted: boolean;
  replaying: boolean;
  gap: { reason: string } | null;
  empty: boolean;
  desk_count: number;
  session_count: number;
  last_ingest_seq: number;
  last_event_ts: string | null;
  last_frame_at_ms: number | null;
  by_state: Record<ActorVisualState, number>;
};

export declare const UNATTRIBUTED_AGENT_LABEL: string;
export declare const MAX_LOG_ENTRIES: number;
export declare const ACTOR_VISUAL_STATES: readonly ActorVisualState[];

export declare function statusTokens(status: string | null): string[];
export declare function classifyStatus(status: string | null): ActorVisualState | null;
export declare function visualForState(state: string): ActorVisual;
export declare function classifyActor(actor: Partial<ViewActor> | null | undefined): ActorVisual;
export declare function classifyConnection(connection: Partial<ViewConnection> | null | undefined): ConnectionVisual;
export declare function createClientState(namespace: string): ClientState;
export declare function setConnectionPhase(state: ClientState, phase: string, atMs?: number | null): ClientState;
export declare function applyEvent(state: ClientState, wire: unknown, atMs?: number | null): ClientState;
export declare function applySnapshot(state: ClientState, payload: unknown, atMs?: number | null): ClientState;
export declare function applyFrame(state: ClientState, frame: Frame): ClientState;
export declare function selectDesks(state: ClientState): Desk[];
export declare function selectHeader(state: ClientState): Header;
export declare function describeFreshness(state: ClientState, nowMs: number | null): string;
