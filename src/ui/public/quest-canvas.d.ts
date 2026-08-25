/**
 * Types for the canvas painter in `quest-canvas.js`.
 *
 * `drawWorld` is declared against a minimal surface rather than the DOM's
 * `CanvasRenderingContext2D`, so `test/ui-canvas.test.ts` can hand it a
 * recording stub and assert exactly which drawing calls a world produces.
 */

import type { ActorVisualState } from './quest-view.js';
import type { World } from './quest-world.js';

/** The whole 2D surface this module is allowed to use. Notably: no `drawImage`. */
export type DrawSurface = {
  fillStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  imageSmoothingEnabled: boolean;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
};

export declare const PALETTE: Readonly<Record<string, string>>;
export declare const STATE_COLORS: Readonly<Record<ActorVisualState | string, string>>;
export declare const MARKER_BITMAPS: Readonly<Record<string, readonly string[]>>;

export declare function drawWorld(ctx: DrawSurface | null | undefined, world: World | null | undefined): void;
