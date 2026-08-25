/**
 * Types for the pure world model in `quest-world.js`.
 *
 * The implementation stays plain JS because the browser loads it as-is, so its
 * contract is declared here and exercised by `test/ui-world.test.ts`.
 */

import type { ActorVisualState, Desk, Header } from './quest-view.js';

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
  state: ActorVisualState | string;
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
  desk_count: number;
  session_count: number;
};

export type World = {
  viewport: Viewport;
  scale: number;
  columns: number;
  rows: number;
  empty: boolean;
  hud: WorldHud;
  caption: string;
  canvas: { width: number; height: number; device_width: number; device_height: number };
  room: Rect;
  wall: Rect;
  floor: Rect & { tile: number; cols: number; rows: number };
  props: WorldProp[];
  actors: WorldActor[];
  notice: WorldLabel;
  caption_box: { x: number; y: number; size: number };
};

export type WorldInput = {
  desks?: readonly Desk[];
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
export declare const APPEARANCE_KEYS: readonly string[];

export declare function appearanceSeed(actorKey: unknown): number;
export declare function appearanceFor(actorKey: unknown): Appearance;
export declare function textWidth(text: unknown, fontSize: number): number;
export declare function fitLabel(text: unknown, boxPixels: number, fontSize: number): string;
export declare function buildWorld(input: WorldInput | null | undefined): World;
