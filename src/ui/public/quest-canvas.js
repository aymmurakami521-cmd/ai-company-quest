/**
 * `draw(World)`: the only file in the project that paints pixels.
 *
 * It receives a finished `World` from `quest-world.js` and a 2D context, and
 * touches nothing else - no DOM lookup, no global, no clock, no random source,
 * no image, no font file, no network. Every shape is a `fillRect` on integer
 * coordinates or a `fillText` of a string the world already truncated, so the
 * same world always produces the same sequence of drawing calls.
 *
 * Deliberate omissions:
 * - no bitmap call and no external asset of any kind: the office is drawn from
 *   rectangles authored here, not copied from anywhere;
 * - no motion, no animation-frame callback and no timer: the canvas is
 *   repainted only when the state or the viewport changed, so
 *   `prefers-reduced-motion` has nothing to suppress;
 * - state is never colour-only: each actor carries a pixel marker whose *shape*
 *   differs per state, plus the symbol and the state code as text.
 */

/** Room and furniture colours. Mirrors the CSS tokens, but owned by this file. */
export const PALETTE = Object.freeze({
  backdrop: '#0d1018',
  roomEdge: '#0a0d14',
  wall: '#263250',
  wallDark: '#1b2440',
  wallTrim: '#3a4870',
  skirting: '#131a2c',
  floorA: '#4a3a30',
  floorB: '#41332a',
  floorLine: '#33271f',
  deskTop: '#8a6c4f',
  deskEdge: '#5f4a36',
  deskFront: '#6d543d',
  chair: '#39405c',
  chairEdge: '#252b41',
  monitorCase: '#20283c',
  screen: '#0f1622',
  text: '#e8ecf6',
  textDim: '#a3adc4',
  outline: '#0a0d14',
  paneGlass: '#7fc8ff',
  paneFrame: '#151d33',
  poster: '#f7d51d',
  posterInk: '#1b2440',
  clockFace: '#e8ecf6',
  badge: '#f7d51d',
  badgeInk: '#1b2440',
});

/** Per-state accent, used together with - never instead of - the marker shape. */
export const STATE_COLORS = Object.freeze({
  working: '#56d97e',
  awaiting_approval: '#ffb347',
  error: '#ff6b6b',
  ended: '#99a2b8',
  idle: '#6ec5ff',
});

/**
 * 5x5 pixel markers, one distinct silhouette per state. Shape carries the
 * meaning; the colour above only reinforces it.
 */
export const MARKER_BITMAPS = Object.freeze({
  working: Object.freeze(['#....', '##...', '###..', '##...', '#....']),
  awaiting_approval: Object.freeze(['..#..', '..#..', '..#..', '.....', '..#..']),
  error: Object.freeze(['#...#', '.#.#.', '..#..', '.#.#.', '#...#']),
  ended: Object.freeze(['#####', '#...#', '#...#', '#...#', '#####']),
  idle: Object.freeze(['.....', '.....', '#.#.#', '.....', '.....']),
});

const MONOSPACE = 'ui-monospace, monospace';

function stateColor(state) {
  return Object.prototype.hasOwnProperty.call(STATE_COLORS, state) ? STATE_COLORS[state] : STATE_COLORS.idle;
}

function markerBitmap(state) {
  return Object.prototype.hasOwnProperty.call(MARKER_BITMAPS, state)
    ? MARKER_BITMAPS[state]
    : MARKER_BITMAPS.idle;
}

function fill(ctx, color, x, y, width, height) {
  if (width <= 0 || height <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}

/** A filled rectangle with a one-pixel-ish dark border, drawn as four rects. */
function panel(ctx, color, edge, box) {
  fill(ctx, edge, box.x, box.y, box.width, box.height);
  const inset = Math.max(1, Math.round(box.width / 24));
  fill(ctx, color, box.x + inset, box.y + inset, box.width - 2 * inset, box.height - 2 * inset);
}

function label(ctx, color, text, x, y, size, align) {
  if (typeof text !== 'string' || text.length === 0) return;
  ctx.fillStyle = color;
  ctx.font = `${size}px ${MONOSPACE}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, y);
}

function drawFloor(ctx, floor) {
  fill(ctx, PALETTE.floorA, floor.x, floor.y, floor.width, floor.height);
  // Checkerboard, clipped by hand so no tile can spill outside the room.
  for (let row = 0; row < floor.rows; row += 1) {
    for (let col = 0; col < floor.cols; col += 1) {
      if ((row + col) % 2 === 0) continue;
      const x = floor.x + col * floor.tile;
      const y = floor.y + row * floor.tile;
      fill(
        ctx,
        PALETTE.floorB,
        x,
        y,
        Math.min(floor.tile, floor.x + floor.width - x),
        Math.min(floor.tile, floor.y + floor.height - y),
      );
    }
  }
  fill(ctx, PALETTE.skirting, floor.x, floor.y, floor.width, Math.max(1, Math.round(floor.tile / 4)));
}

function drawWall(ctx, wall) {
  fill(ctx, PALETTE.wall, wall.x, wall.y, wall.width, wall.height);
  fill(ctx, PALETTE.wallDark, wall.x, wall.y, wall.width, Math.max(1, Math.round(wall.height / 6)));
  fill(
    ctx,
    PALETTE.wallTrim,
    wall.x,
    wall.y + wall.height - Math.max(1, Math.round(wall.height / 10)),
    wall.width,
    Math.max(1, Math.round(wall.height / 10)),
  );
}

function drawProp(ctx, prop) {
  if (prop.kind === 'pane') {
    panel(ctx, PALETTE.paneGlass, PALETTE.paneFrame, prop);
    const barX = prop.x + Math.round(prop.width / 2) - 1;
    fill(ctx, PALETTE.paneFrame, barX, prop.y, 2, prop.height);
    fill(ctx, PALETTE.paneFrame, prop.x, prop.y + Math.round(prop.height / 2) - 1, prop.width, 2);
    return;
  }
  if (prop.kind === 'poster') {
    panel(ctx, PALETTE.poster, PALETTE.posterInk, prop);
    fill(
      ctx,
      PALETTE.posterInk,
      prop.x + Math.round(prop.width / 4),
      prop.y + Math.round(prop.height / 3),
      Math.max(1, Math.round(prop.width / 2)),
      Math.max(1, Math.round(prop.height / 8)),
    );
    return;
  }
  // clock
  panel(ctx, PALETTE.clockFace, PALETTE.paneFrame, prop);
  const cx = prop.x + Math.round(prop.width / 2);
  const cy = prop.y + Math.round(prop.height / 2);
  fill(ctx, PALETTE.posterInk, cx, cy - Math.round(prop.height / 3), 2, Math.round(prop.height / 3));
  fill(ctx, PALETTE.posterInk, cx, cy, Math.round(prop.width / 3), 2);
}

function drawHair(ctx, actor) {
  const { head, appearance } = actor;
  const unit = Math.max(1, Math.round(head.height / 7));
  fill(ctx, appearance.hair, head.x, head.y, head.width, unit * 2);
  switch (appearance.hair_style) {
    case 'bob':
      fill(ctx, appearance.hair, head.x, head.y, unit, head.height - unit);
      fill(ctx, appearance.hair, head.x + head.width - unit, head.y, unit, head.height - unit);
      break;
    case 'spiky':
      for (let index = 0; index < 3; index += 1) {
        fill(ctx, appearance.hair, head.x + unit + index * unit * 2, head.y - unit, unit, unit);
      }
      break;
    case 'bun':
      fill(ctx, appearance.hair, head.x + Math.round(head.width / 2) - unit, head.y - unit * 2, unit * 2, unit * 2);
      break;
    case 'cap':
      fill(ctx, appearance.hair, head.x - unit, head.y + unit, head.width + unit * 2, unit);
      break;
    default:
      // 'short': the top band above is the whole style.
      break;
  }
}

function drawCharacter(ctx, actor) {
  const { appearance } = actor;
  const accent = stateColor(actor.state);

  panel(ctx, PALETTE.chair, PALETTE.chairEdge, actor.chair);

  fill(ctx, PALETTE.outline, actor.arm_left.x, actor.arm_left.y, actor.arm_left.width, actor.arm_left.height);
  fill(ctx, PALETTE.outline, actor.arm_right.x, actor.arm_right.y, actor.arm_right.width, actor.arm_right.height);
  fill(
    ctx,
    appearance.skin,
    actor.arm_left.x + 1,
    actor.arm_left.y + 1,
    Math.max(1, actor.arm_left.width - 2),
    Math.max(1, actor.arm_left.height - 2),
  );
  fill(
    ctx,
    appearance.skin,
    actor.arm_right.x + 1,
    actor.arm_right.y + 1,
    Math.max(1, actor.arm_right.width - 2),
    Math.max(1, actor.arm_right.height - 2),
  );

  panel(ctx, appearance.shirt, PALETTE.outline, actor.body);
  // Collar in the trouser tone, so two channels are visible from the front.
  fill(
    ctx,
    appearance.trouser,
    actor.body.x + 2,
    actor.body.y + actor.body.height - Math.max(2, Math.round(actor.body.height / 4)),
    Math.max(1, actor.body.width - 4),
    Math.max(2, Math.round(actor.body.height / 4)),
  );

  panel(ctx, appearance.skin, PALETTE.outline, actor.head);
  drawHair(ctx, actor);
  // Eyes: two dark blocks, always inside the head box.
  const eye = Math.max(1, Math.round(actor.head.width / 7));
  const eyeY = actor.head.y + Math.round(actor.head.height * 0.55);
  fill(ctx, PALETTE.outline, actor.head.x + eye * 2, eyeY, eye, eye);
  fill(ctx, PALETTE.outline, actor.head.x + actor.head.width - eye * 3, eyeY, eye, eye);

  // Desk, then the monitor on top of it, so the actor reads as sitting behind.
  fill(ctx, PALETTE.deskEdge, actor.desk.x, actor.desk.y, actor.desk.width, actor.desk.height);
  fill(
    ctx,
    PALETTE.deskTop,
    actor.desk.x + 1,
    actor.desk.y + 1,
    Math.max(1, actor.desk.width - 2),
    Math.max(1, actor.desk.height - 2),
  );
  fill(ctx, PALETTE.deskFront, actor.desk_front.x, actor.desk_front.y, actor.desk_front.width, actor.desk_front.height);

  panel(ctx, PALETTE.monitorCase, PALETTE.outline, actor.monitor);
  const screenInset = Math.max(2, Math.round(actor.monitor.width / 8));
  fill(
    ctx,
    PALETTE.screen,
    actor.monitor.x + screenInset,
    actor.monitor.y + screenInset,
    Math.max(1, actor.monitor.width - 2 * screenInset),
    Math.max(1, actor.monitor.height - 2 * screenInset),
  );
  // The screen glows in the state accent: a second, redundant cue.
  fill(
    ctx,
    accent,
    actor.monitor.x + screenInset,
    actor.monitor.y + screenInset,
    Math.max(1, actor.monitor.width - 2 * screenInset),
    Math.max(1, Math.round(actor.monitor.height / 6)),
  );

  if (actor.is_main_orchestrator) {
    fill(ctx, PALETTE.badge, actor.badge.x, actor.badge.y, actor.badge.width, actor.badge.height);
    label(
      ctx,
      PALETTE.badgeInk,
      'M',
      actor.badge.x + Math.round(actor.badge.width / 2),
      actor.badge.y + actor.badge.height - Math.max(1, Math.round(actor.badge.height / 5)),
      Math.max(6, actor.badge.height - 2),
      'center',
    );
  }
}

function drawMarker(ctx, actor) {
  const bitmap = markerBitmap(actor.state);
  const pixel = Math.max(1, Math.round(actor.marker.width / 5));
  const color = stateColor(actor.state);
  // A dark plate behind the marker keeps it readable on any floor tile.
  fill(ctx, PALETTE.outline, actor.marker.x - 1, actor.marker.y - 1, pixel * 5 + 2, pixel * 5 + 2);
  for (let row = 0; row < bitmap.length; row += 1) {
    const line = bitmap[row];
    for (let col = 0; col < line.length; col += 1) {
      if (line[col] !== '#') continue;
      fill(ctx, color, actor.marker.x + col * pixel, actor.marker.y + row * pixel, pixel, pixel);
    }
  }
}

function drawActor(ctx, actor) {
  drawMarker(ctx, actor);
  drawCharacter(ctx, actor);
  label(ctx, PALETTE.text, actor.name_label.text, actor.name_label.x, actor.name_label.y, actor.name_label.size, 'center');
  label(
    ctx,
    stateColor(actor.state),
    actor.state_label.text,
    actor.state_label.x,
    actor.state_label.y,
    actor.state_label.size,
    'center',
  );
}

/**
 * Paints one world onto one 2D context.
 *
 * The context is reset to a device-pixel-ratio transform first, so the world's
 * CSS-pixel rectangles land on the right device pixels whatever the screen.
 *
 * @param ctx a `CanvasRenderingContext2D`, or anything with the same surface.
 * @param world a `World` from `buildWorld`.
 */
export function drawWorld(ctx, world) {
  if (ctx === null || ctx === undefined || world === null || typeof world !== 'object') return;

  ctx.save();
  ctx.setTransform(world.viewport.dpr, 0, 0, world.viewport.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, world.canvas.width, world.canvas.height);
  fill(ctx, PALETTE.backdrop, 0, 0, world.canvas.width, world.canvas.height);

  fill(ctx, PALETTE.roomEdge, world.room.x - 2, world.room.y - 2, world.room.width + 4, world.room.height + 4);
  drawWall(ctx, world.wall);
  for (const prop of world.props) drawProp(ctx, prop);
  drawFloor(ctx, world.floor);

  for (const actor of world.actors) drawActor(ctx, actor);

  if (world.empty) {
    label(ctx, PALETTE.textDim, world.notice.text, world.notice.x, world.notice.y, world.notice.size, 'center');
  }

  label(ctx, PALETTE.textDim, world.caption, world.caption_box.x, world.caption_box.y, world.caption_box.size, 'left');

  ctx.restore();
}
