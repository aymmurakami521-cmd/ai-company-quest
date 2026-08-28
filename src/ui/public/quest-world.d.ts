/**
 * Types for the pure world model in `quest-world.js`.
 *
 * The implementation stays plain JS because the browser loads it as-is, so its
 * contract is declared here and exercised by `test/ui-world.test.ts`.
 */

import type {
  ActorDisplayState,
  Desk,
  Header,
  OfficeDesk,
  OfficeZone,
  PlayerProjection,
} from './quest-view.js';

export type Rect = { x: number; y: number; width: number; height: number };

export type Viewport = { width: number; height: number; dpr: number };

export type HairStyle = 'short' | 'bob' | 'spiky' | 'bun' | 'cap';

/** Derived from `actor_key` alone: same actor, same look, forever. */
export type Appearance = {
  seed: number;
  skin: string;
  hair: string;
  hair_style: HairStyle;
  shirt: string;
  trouser: string;
};

export type WorldLabel = { x: number; y: number; size: number; text: string };

export type WorldActor = {
  seat: number;
  actor_key: string;
  session_id: string;
  state: ActorDisplayState | string;
  symbol: string;
  code: string;
  is_main_orchestrator: boolean;
  appearance: Appearance;
  cell: Rect;
  chair: Rect;
  head: Rect;
  body: Rect;
  arm_left: Rect;
  arm_right: Rect;
  desk: Rect;
  desk_front: Rect;
  monitor: Rect;
  badge: Rect;
  marker: Rect;
  name_label: WorldLabel;
  state_label: WorldLabel;
};

/**
 * The human player on the canvas: standing, in their own strip below the desk
 * grid. No seat, no session, no state - and never an entry in `World.actors`.
 */
export type WorldPlayer = {
  kind: 'player';
  id: string;
  appearance: Appearance;
  cell: Rect;
  head: Rect;
  body: Rect;
  arm_left: Rect;
  arm_right: Rect;
  leg_left: Rect;
  leg_right: Rect;
  badge: Rect;
  /** This module's own literal, never a string off the wire. */
  badge_text: string;
  name_label: WorldLabel;
};

/** `pane` is a window in the office wall; the identifier avoids the global's name. */
export type WorldProp = Rect & { kind: 'pane' | 'poster' | 'clock' };

/** Closed-vocabulary header facts. No free-form wire string reaches the canvas. */
export type WorldHud = {
  mode: 'LIVE' | 'DEMO' | '—';
  connection_code: string;
  connection_symbol: string;
  halted: boolean;
  replaying: boolean;
  gapped: boolean;
  /** Every actor the projection carried, including the ones the canvas caps off. */
  desk_count: number;
  /** Seats actually painted: `min(desk_count, MAX_ROWS * columns)`. */
  drawn_count: number;
  /** `desk_count - drawn_count`, stated on the canvas whenever it is not zero. */
  hidden_count: number;
  session_count: number;
  /** Presence only. The player holds no seat, so `desk_count` excludes them. */
  player_present: boolean;
};

/** How much of the office the canvas drew. `drawn + hidden === total`, always. */
export type WorldOverflow = {
  total: number;
  drawn: number;
  hidden: number;
  /**
   * The worst state among the seats that were left out, or null when none were.
   *
   * A count on its own lets a hidden failure sit behind a tidy number, which is
   * the one thing this screen may not do.
   */
  hidden_state: string | null;
  /** Rooms, counted the same way. All zero when the office is ungrouped. */
  zones: { total: number; drawn: number; hidden: number };
};

/** One room on the floor plan. */
export type WorldZone = {
  id: string;
  kind: string;
  rect: Rect;
  name_label: WorldLabel;
  /** False for rooms nobody sits in: 社長室 and 共用施設. */
  seats: boolean;
  drawn: number;
  hidden: number;
  /** Worst state this room could not draw, or null. */
  hidden_state: string | null;
};

export type World = {
  viewport: Viewport;
  scale: number;
  columns: number;
  rows: number;
  empty: boolean;
  hud: WorldHud;
  overflow: WorldOverflow;
  caption: string;
  canvas: {
    width: number;
    height: number;
    /** The ratio the buffer was built at: `viewport.dpr` unless a ceiling bit. */
    dpr: number;
    device_width: number;
    device_height: number;
  };
  room: Rect;
  wall: Rect;
  floor: Rect & { tile: number; cols: number; rows: number };
  props: WorldProp[];
  actors: WorldActor[];
  /** The rooms, in draw order. Empty whenever the office is ungrouped. */
  zones: WorldZone[];
  /** True when an accepted organisation grouped the office into rooms. */
  grouped: boolean;
  /** Null when no snapshot has named a player yet. */
  player: WorldPlayer | null;
  notice: WorldLabel;
  caption_box: { x: number; y: number; size: number };
  /** Empty text when nothing was left out of the drawing. */
  overflow_label: WorldLabel;
};

/**
 * Measurements of the canvas surface, in CSS pixels.
 *
 * `surface_width` is the canvas element's own content box; `frame_width` is the
 * padded box around it and is a fallback only.
 */
export type CanvasMeasurement = {
  surface_width?: number;
  frame_width?: number;
  window_height?: number;
  dpr?: number;
};

export type WorldInput = {
  desks?: readonly Desk[] | readonly OfficeDesk[];
  /**
   * The rooms to lay the desks out in.
   *
   * Empty or absent lays out the single ungrouped room, which is what the
   * office was before an organisation could group it - the same code path, with
   * one band and no name strip.
   */
  zones?: readonly OfficeZone[];
  player?: PlayerProjection | null;
  header?: Header | null;
  viewport?: Partial<Viewport> | null;
};

export declare const OUTER_MARGIN: number;
export declare const ROOM_PADDING: number;
export declare const WALL_UNITS: number;
export declare const FLOOR_TILE_UNITS: number;
export declare const CELL_UNITS: { readonly width: number; readonly height: number };
export declare const SCALE_STEP: number;
export declare const MIN_SCALE: number;
export declare const MAX_SCALE: number;
export declare const MAX_COLUMNS: number;
export declare const EMPTY_COLUMNS: number;
export declare const CAPTION_SIZE: number;
export declare const CAPTION_STRIP: number;
export declare const TARGET_CELL_PX: number;
export declare const MAX_DPR: number;
export declare const MAX_ROWS: number;
export declare const MAX_ZONES: number;
export declare const ZONE_HEADER_UNITS: number;
export declare const GROUPED_HEIGHT_RATIO: number;
/** A copy of `ACTOR_VISUAL_STATES`; `test/ui-zone-layout.test.ts` pins them equal. */
export declare const ATTENTION_ORDER: readonly string[];
export declare const MAX_DEVICE_SIDE: number;
export declare const MAX_DEVICE_PIXELS: number;
export declare const MIN_DEVICE_SCALE: number;
export declare const VIEWPORT_HEIGHT_RATIO: number;
export declare const APPEARANCE_KEYS: readonly string[];
export declare const PLAYER_STRIP_UNITS: number;
export declare const PLAYER_BADGE_TEXT: string;
export declare const PLAYER_OUTFIT: { readonly shirt: string; readonly trouser: string };
export declare const ACTOR_SHIRT_COLORS: readonly string[];
export declare const ACTOR_TROUSER_COLORS: readonly string[];

export declare function deviceScaleFor(cssWidth: number, cssHeight: number, dpr: number): number;
export declare function measureCanvasViewport(source: CanvasMeasurement | null | undefined): Viewport;

export declare function appearanceSeed(actorKey: unknown): number;
export declare function appearanceFor(actorKey: unknown): Appearance;
export declare function playerAppearanceFor(playerId: unknown): Appearance;
export declare function textWidth(text: unknown, fontSize: number): number;
export declare function fitLabel(text: unknown, boxPixels: number, fontSize: number): string;
export declare function buildWorld(input: WorldInput | null | undefined): World;
