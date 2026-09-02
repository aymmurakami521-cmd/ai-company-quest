/**
 * Types for the internal render-plan projection in `quest-scene.js`.
 *
 * The implementation stays plain JS because the browser loads it as-is, so its
 * contract is declared here and exercised by `test/ui-scene.test.ts`.
 *
 * Nothing here is durable business state or a public API: a `Scene` is derived
 * from a `World` on demand, and no name in this file - a pose, a layer, a sprite
 * id - may be written back into the ARK domain.
 */

import type { ActorDisplayState } from './quest-view.js';
import type {
  Appearance,
  Rect,
  Viewport,
  World,
  WorldActor,
  WorldHud,
  WorldLabel,
  WorldOverflow,
  WorldPlayer,
  WorldProp,
  WorldZone,
  WorstHidden,
} from './quest-world.js';

/**
 * The closed presentation-action vocabulary.
 *
 * `walk` and `meeting` are declared but unreachable from a `World` today:
 * nothing in the event contract observes either, so emitting one would be
 * invented progress.
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

export type SceneLayer = 'backdrop' | 'floor' | 'wall' | 'prop' | 'zone' | 'stage' | 'caption';

export type SceneNodeKind =
  | 'backdrop'
  | 'floor'
  | 'wall'
  | 'prop'
  | 'zone'
  /** A roster seat no actor answers to: furniture, and deliberately no character. */
  | 'seat'
  | 'actor'
  | 'player'
  | 'notice'
  | 'caption';

export type SceneOverlayKind =
  | 'alert'
  | 'attention'
  | 'unknown'
  | 'hidden'
  | 'state'
  | 'identity'
  | 'name';

/** A text baseline the world already positioned and truncated. */
export type SceneTextAt = { x: number; y: number; size: number };

/**
 * Something that has to be legible on top of a node.
 *
 * `code` and `symbol` are the screen's own closed vocabulary, so a state is
 * never carried by colour alone.
 */
export type SceneOverlay = {
  readonly kind: SceneOverlayKind;
  /** Index into `OVERLAY_KINDS`: lower is more urgent. */
  readonly priority: number;
  readonly code: string;
  readonly symbol: string;
  readonly text: string;
  readonly rect: Rect | null;
  readonly text_at: SceneTextAt | null;
};

/**
 * A request to the asset layer, not an asset.
 *
 * `id` is a logical name (`actor.desk_work`, `prop.pane`); resolving it to a
 * bitmap, a rectangle recipe or anything else is the renderer's business.
 */
export type SceneSprite = {
  readonly id: string;
  readonly pose: ScenePose | null;
  /** The world's per-identity colours, or null for anything that is not a person. */
  readonly appearance: Appearance | null;
};

export type SceneNode = {
  /** Unique within one scene; index-prefixed, because world keys can repeat. */
  readonly id: string;
  readonly kind: SceneNodeKind;
  /** The world identity behind this node: `actor_key`, zone id, player id. */
  readonly key: string;
  readonly layer: SceneLayer;
  /** Position in paint order. Equals this node's index in `Scene.nodes`. */
  readonly depth: number;
  /** Bottom-centre of `rect`: what depth within a layer is sorted by. */
  readonly anchor: { x: number; y: number };
  readonly rect: Rect | null;
  readonly sprite: SceneSprite | null;
  /** The actor state this node stands for, or null for anything stateless. */
  readonly state: ActorDisplayState | string | null;
  /** The world's own attention ranking. Lower asks louder to be looked at. */
  readonly attention_rank: number;
  /** The world object this node was projected from, unchanged. */
  readonly parts: WorldActor | WorldPlayer | WorldZone | WorldProp | WorldLabel | Rect | null;
  readonly overlays: SceneOverlay[];
};

export type SceneAttention = {
  /**
   * Worst state among the characters actually on the stage, or null.
   *
   * Fail-safe about the unobserved: while any drawn character is `unknown`, this
   * is never a state that reads as ordinary work, so an office-wide cue built on
   * it cannot advertise progress nobody saw. Only `error` and `awaiting_approval`
   * - the two states that ask for a person - still win over it.
   */
  readonly worst: WorstHidden | null;
  /** Worst state the world could not draw. Carried through untouched. */
  readonly hidden: WorstHidden | null;
};

export type Scene = {
  readonly viewport: Viewport | null;
  readonly scale: number;
  readonly canvas: World['canvas'];
  readonly grouped: boolean;
  readonly empty: boolean;
  /** Header facts, unchanged from the world. Never re-derived here. */
  readonly hud: WorldHud | null;
  readonly overflow: WorldOverflow | null;
  readonly attention: SceneAttention;
  readonly layers: readonly SceneLayer[];
  /** Every node, back to front. */
  readonly nodes: SceneNode[];
};

export declare const SCENE_POSES: readonly ScenePose[];
export declare const POSE_BY_STATE: Readonly<Record<ActorDisplayState, ScenePose>>;
export declare const VACANT_STATE: string;
export declare const SCENE_LAYERS: readonly SceneLayer[];
export declare const SCENE_NODE_KINDS: readonly SceneNodeKind[];
export declare const OVERLAY_KINDS: readonly SceneOverlayKind[];
export declare const MAIN_BADGE_TEXT: string;

export declare function poseForState(state: string): ScenePose;
export declare function buildScene(world: World | null | undefined): Scene;
