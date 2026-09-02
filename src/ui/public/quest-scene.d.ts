/**
 * Types for the render-plan projection in `quest-scene.js`.
 *
 * The implementation stays plain JS because the browser loads it as-is, so its
 * contract is declared here and exercised by `test/ui-scene.test.ts`.
 *
 * Everything in here is presentation data. None of it is durable business
 * state, none of it is a public API, and nothing shaped like `display_zone` or
 * `pose` is ever written back towards the ARK domain.
 */

import type { ActorDisplayState } from './quest-view.js';
import type { Appearance, Rect, WorstHidden } from './quest-world.js';

/** Draw order, coarse to fine. */
export type SceneLayer = 'backdrop' | 'zone' | 'fixture' | 'stage' | 'overlay';

/** Every sprite key this projection may ask for. A key, never a file or a URL. */
export type SceneSprite =
  | 'room'
  | 'wall'
  | 'floor'
  | 'zone_band'
  | 'pane'
  | 'poster'
  | 'clock'
  | 'chair'
  | 'worker'
  | 'vacant_seat'
  | 'monitor'
  | 'desk'
  | 'player';

/**
 * The closed animation vocabulary.
 *
 * `unknown` is the fail-closed member: a screen that cannot tell what somebody
 * is doing says so rather than picking the nearest cheerful pose.
 */
export type ScenePose =
  | 'idle'
  | 'walk'
  | 'desk_work'
  | 'meeting'
  | 'thinking'
  | 'waiting'
  | 'alert'
  | 'unknown';

/** Poses that assert observed work, and so may be withheld when evidence is stale. */
export type WorkPose = 'desk_work' | 'meeting' | 'walk';

export type SceneOverlayKind =
  | 'state_marker'
  | 'name_label'
  | 'state_label'
  | 'role_badge'
  | 'player_badge'
  | 'zone_name'
  | 'zone_hidden_state'
  | 'notice'
  | 'caption'
  | 'overflow';

export type ScenePoint = { x: number; y: number };

type SpriteBase = {
  /** Stable within one scene, and derived from the world's own identifiers. */
  id: string;
  sprite: SceneSprite;
  layer: SceneLayer;
  /** `layer * span + top edge * step + tie`. Ascending is paint order. */
  depth: number;
  rect: Rect;
};

export type SceneRoomSprite = SpriteBase & { sprite: 'room' | 'wall' };

export type SceneFloorSprite = SpriteBase & {
  sprite: 'floor';
  tile: { size: number; cols: number; rows: number };
};

export type SceneZoneSprite = SpriteBase & {
  sprite: 'zone_band';
  zone_id: string;
  /** The organisation's own kind, forwarded. Never an office metaphor. */
  zone_kind: string;
  seats: boolean;
  drawn: number;
  hidden: number;
  /** The worst state this room could not draw, or null. */
  hidden_state: WorstHidden | null;
};

export type SceneFixtureSprite = SpriteBase & { sprite: 'pane' | 'poster' | 'clock' };

export type SceneFurnitureSprite = SpriteBase & {
  sprite: 'chair' | 'monitor';
  actor_key: string;
};

export type SceneDeskSprite = SpriteBase & {
  sprite: 'desk';
  actor_key: string;
  parts: { front: Rect };
};

/**
 * A colleague, or the seat of one nobody has ever answered to.
 *
 * `state`, `code` and `symbol` are the business projection's, unchanged. `pose`
 * is presentation only: swapping the pose set or the artwork cannot change what
 * this sprite claims about anybody.
 */
export type SceneActorSprite = SpriteBase & {
  sprite: 'worker' | 'vacant_seat';
  actor_key: string;
  session_id: string;
  seat: number;
  is_main_orchestrator: boolean;
  /** False for a roster seat the stream has never mentioned. */
  occupied: boolean;
  pose: ScenePose;
  /** True when a work pose was suppressed because the evidence is not fresh. */
  pose_withheld: boolean;
  state: ActorDisplayState | string;
  code: string;
  symbol: string;
  appearance: Appearance | null;
  parts: { head: Rect; body: Rect; arm_left: Rect; arm_right: Rect };
};

/** The human owner. No seat, no session, and deliberately no state. */
export type ScenePlayerSprite = SpriteBase & {
  sprite: 'player';
  player_id: string;
  pose: ScenePose;
  pose_withheld: boolean;
  state: null;
  appearance: Appearance | null;
  parts: {
    head: Rect;
    body: Rect;
    arm_left: Rect;
    arm_right: Rect;
    leg_left: Rect;
    leg_right: Rect;
  };
};

export type SceneSpriteEntry =
  | SceneRoomSprite
  | SceneFloorSprite
  | SceneZoneSprite
  | SceneFixtureSprite
  | SceneFurnitureSprite
  | SceneDeskSprite
  | SceneActorSprite
  | ScenePlayerSprite;

/**
 * Something written over the world.
 *
 * Every overlay that carries a state carries its `code` and `symbol` too, so a
 * renderer can never express it with colour alone.
 */
export type SceneOverlay = {
  id: string;
  kind: SceneOverlayKind;
  layer: 'overlay';
  depth: number;
  anchor: ScenePoint;
  rect?: Rect;
  size: number;
  align: 'left' | 'center';
  /** Already truncated to its box by the world model. Never measured here. */
  text: string;
  actor_key?: string;
  state?: string;
  code?: string;
  symbol?: string;
};

/** Header facts the painter may repeat. A copy of `WorldHud`, closed vocabulary. */
export type SceneHud = {
  mode: 'LIVE' | 'DEMO' | '—';
  connection_code: string;
  connection_symbol: string;
  halted: boolean;
  replaying: boolean;
  gapped: boolean;
  desk_count: number;
  drawn_count: number;
  hidden_count: number;
  session_count: number;
  player_present: boolean;
};

/** The loudest state in the scene, and which side of the drawing cut it is on. */
export type SceneWorst = WorstHidden & { source: 'drawn' | 'hidden' };

/**
 * What the picture had to leave out.
 *
 * A summary of the world's own overflow report, forwarded so a hidden failure
 * cannot be dropped on the way to the painter. It decides nothing: Human
 * Attention, approval and Evidence stay with the DOM.
 */
export type SceneAttention = {
  total: number;
  drawn: number;
  hidden: number;
  zones: { total: number; drawn: number; hidden: number };
  hidden_state: WorstHidden | null;
  worst: SceneWorst | null;
};

export type Scene = {
  canvas: { width: number; height: number; dpr: number; device_width: number; device_height: number };
  scale: number;
  columns: number;
  rows: number;
  grouped: boolean;
  empty: boolean;
  hud: SceneHud;
  /** False when the stream is halted, offline or dropped. */
  evidence_fresh: boolean;
  /** Ascending `depth`, emission order as the tie-break. */
  sprites: SceneSpriteEntry[];
  overlays: SceneOverlay[];
  attention: SceneAttention;
};

export declare const SCENE_LAYERS: readonly SceneLayer[];
export declare const SCENE_SPRITES: readonly SceneSprite[];
export declare const SCENE_POSES: readonly ScenePose[];
export declare const WORK_POSES: readonly WorkPose[];
export declare const SCENE_OVERLAYS: readonly SceneOverlayKind[];
export declare const POSE_BY_STATE: Readonly<Record<string, ScenePose>>;
export declare const STALE_CONNECTION_CODES: readonly string[];
export declare const DEPTH_LAYER_SPAN: number;
export declare const DEPTH_ROW_STEP: number;
export declare const DEPTH_TIE_SLOTS: number;
export declare const DEPTH_MAX_ROW: number;

export declare function depthFor(layer: SceneLayer | string, y: number, tie: number): number;
export declare function poseFor(state: unknown): ScenePose;
export declare function buildScene(world: unknown): Scene;
export declare function emptyScene(): Scene;
