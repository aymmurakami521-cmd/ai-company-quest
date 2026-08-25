/**
 * Pure world model for the retro office canvas.
 *
 * `buildWorld` turns the two projections the screen already trusts -
 * `selectDesks(state)` and `selectHeader(state)` from `quest-view.js` - plus a
 * viewport, into a fully resolved set of integer rectangles. Nothing else goes
 * in: no organisation snapshot, no player, no invented employee, no role that
 * the collector did not resolve.
 *
 * Like `quest-view.js` this module has no DOM, no network, no timer and no
 * clock. It draws on no randomness either: an actor's appearance is
 * derived from its `actor_key`, so the same actor always looks the same and the
 * whole layout is reproducible from its inputs alone. The browser module and the
 * Node tests import this exact file.
 *
 * Coordinates: layout is authored in abstract *units* and multiplied by a
 * quarter-stepped `scale` to reach CSS pixels. Every rectangle that leaves this
 * module is already rounded to integers, so `draw(World)` never has to decide
 * anything - it only paints what it is handed.
 */

/** Gap between the canvas edge and the office room, in units. */
export const OUTER_MARGIN = 10;

/** Gap between the room walls and the first desk, in units. */
export const ROOM_PADDING = 10;

/** Height of the back wall strip, in units. */
export const WALL_UNITS = 44;

/** Floor tile pitch, in units. */
export const FLOOR_TILE_UNITS = 16;

/** One desk cell: a desk, its chair, its character and its two labels. */
export const CELL_UNITS = Object.freeze({ width: 72, height: 92 });

/** Scale is snapped to this step so pixel blocks stay crisp. */
export const SCALE_STEP = 0.25;

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;

/** Ceiling on desks per row, so a very wide screen still reads as an office. */
export const MAX_COLUMNS = 6;

/** Width, in cells, of an office that has no runtime actor in it yet. */
export const EMPTY_COLUMNS = 3;

/** The caption strip below the room. Fixed size: it must stay readable at any scale. */
export const CAPTION_SIZE = 11;
export const CAPTION_STRIP = 16;

/** Desired CSS pixels per desk cell when deciding how many columns fit. */
export const TARGET_CELL_PX = 132;

/** Device pixel ratio is clamped: a hostile or exotic value cannot blow up the buffer. */
export const MAX_DPR = 4;

const MIN_VIEWPORT = 240;
const MAX_VIEWPORT = 8192;

/** Layout of one cell, in units, relative to the cell's top-left corner. */
const CELL_PARTS = Object.freeze({
  marker: Object.freeze({ x: 31, y: 0, width: 10, height: 10 }),
  chair: Object.freeze({ x: 24, y: 18, width: 24, height: 18 }),
  head: Object.freeze({ x: 29, y: 14, width: 14, height: 14 }),
  body: Object.freeze({ x: 25, y: 27, width: 22, height: 18 }),
  armLeft: Object.freeze({ x: 20, y: 29, width: 5, height: 14 }),
  armRight: Object.freeze({ x: 47, y: 29, width: 5, height: 14 }),
  desk: Object.freeze({ x: 6, y: 44, width: 60, height: 14 }),
  deskFront: Object.freeze({ x: 6, y: 58, width: 60, height: 5 }),
  monitor: Object.freeze({ x: 27, y: 36, width: 18, height: 12 }),
  badge: Object.freeze({ x: 6, y: 44, width: 14, height: 8 }),
  nameLabel: Object.freeze({ x: 36, y: 72, width: 68, height: 10 }),
  stateLabel: Object.freeze({ x: 36, y: 85, width: 68, height: 9 }),
});

/**
 * Appearance palettes. Fixed, hand-authored colour lists - no external asset and
 * nothing copied from another game. An index into each list is derived from the
 * actor key, so two actors differ but one actor never does.
 */
const SKIN_TONES = Object.freeze(['#f3cfa6', '#e3ad7e', '#c98d55', '#9a6336', '#6f4326', '#ffdcb8']);
const HAIR_COLORS = Object.freeze(['#2b2118', '#5a3921', '#8c5a2b', '#c8a24a', '#7a2f2f', '#3b4a6b', '#8f8f9c']);
const SHIRT_COLORS = Object.freeze([
  '#3f7fd6', '#4caf7d', '#d1603d', '#8558c4', '#d8b23a', '#3aa8b8', '#c85c8e', '#5b6b8c',
]);
const TROUSER_COLORS = Object.freeze(['#2a3350', '#3a2f28', '#1f4038', '#403050', '#4a3a52']);
const HAIR_STYLES = Object.freeze(['short', 'bob', 'spiky', 'bun', 'cap']);

/** Every appearance channel, so tests can assert the set is closed. */
export const APPEARANCE_KEYS = Object.freeze(['skin', 'hair', 'hair_style', 'shirt', 'trouser']);

function clamp(value, low, high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * FNV-1a over the UTF-16 code units of a string, low byte then high byte, so a
 * Japanese identifier mixes as thoroughly as an ASCII one.
 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Stable 32-bit seed for one actor. Derived only from the safe `actor_key`. */
export function appearanceSeed(actorKey) {
  return fnv1a(typeof actorKey === 'string' ? actorKey : '');
}

function pick(list, seed, salt) {
  return list[fnv1a(`${salt}#${seed}`) % list.length];
}

/**
 * The look of one actor: five channels, each a fixed-list lookup keyed by the
 * actor's own identifier. Same key in, same look out, forever.
 */
export function appearanceFor(actorKey) {
  const seed = appearanceSeed(actorKey);
  return {
    seed,
    skin: pick(SKIN_TONES, seed, 'skin'),
    hair: pick(HAIR_COLORS, seed, 'hair'),
    hair_style: pick(HAIR_STYLES, seed, 'style'),
    shirt: pick(SHIRT_COLORS, seed, 'shirt'),
    trouser: pick(TROUSER_COLORS, seed, 'trouser'),
  };
}

/**
 * True for the code points a monospace font renders at full em width - CJK,
 * kana and the fullwidth forms. A Japanese label is roughly 1.6x as wide as the
 * same number of Latin characters, and ignoring that is how a name runs off the
 * side of its desk.
 */
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/**
 * Width of a string in pixels.
 *
 * Deliberately arithmetic rather than `measureText`: the world must come out
 * identical in a browser and in a test process that has no font stack at all,
 * and a canvas measurement would make the layout depend on the installed fonts.
 * The constants are a monospace approximation, applied with a margin below.
 */
export function textWidth(text, fontSize) {
  const safe = typeof text === 'string' ? text : '';
  let width = 0;
  for (let index = 0; index < safe.length; index += 1) {
    width += isWide(safe.charCodeAt(index)) ? fontSize : fontSize * 0.62;
  }
  return width;
}

/** Truncates a label, with an ellipsis, to what its box can actually hold. */
export function fitLabel(text, boxPixels, fontSize) {
  const safe = typeof text === 'string' ? text : '';
  if (safe.length === 0) return '';
  if (textWidth(safe, fontSize) <= boxPixels) return safe;
  const ellipsis = textWidth('…', fontSize);
  let width = 0;
  let cut = 0;
  while (cut < safe.length) {
    const next = width + (isWide(safe.charCodeAt(cut)) ? fontSize : fontSize * 0.62);
    if (next + ellipsis > boxPixels) break;
    width = next;
    cut += 1;
  }
  return `${safe.slice(0, Math.max(1, cut))}…`;
}

function normalizeViewport(raw) {
  const source = raw === null || typeof raw !== 'object' ? {} : raw;
  return {
    width: clamp(Math.floor(finite(source.width, 960)), MIN_VIEWPORT, MAX_VIEWPORT),
    height: clamp(Math.floor(finite(source.height, 560)), MIN_VIEWPORT, MAX_VIEWPORT),
    // Rounded to a hundredth: a jittering DPR must not produce a new world on
    // every frame, and an absurd value cannot allocate an absurd buffer.
    dpr: Math.round(clamp(finite(source.dpr, 1), 1, MAX_DPR) * 100) / 100,
  };
}

/** Places a unit-space rectangle at a scaled origin, rounded to whole pixels. */
function place(originX, originY, scale, spec) {
  return {
    x: Math.round(originX + spec.x * scale),
    y: Math.round(originY + spec.y * scale),
    width: Math.max(1, Math.round(spec.width * scale)),
    height: Math.max(1, Math.round(spec.height * scale)),
  };
}

/**
 * Columns are bounded by the viewport, by `MAX_COLUMNS` and by the desk count.
 * An office with nobody in it still gets a room-shaped room rather than a
 * one-desk-wide corridor.
 */
function columnsFor(deskCount, viewportWidth) {
  const usable = viewportWidth - 2 * OUTER_MARGIN;
  const byWidth = Math.floor(usable / TARGET_CELL_PX);
  const bounded = clamp(byWidth, 1, MAX_COLUMNS);
  return Math.max(1, Math.min(bounded, deskCount === 0 ? EMPTY_COLUMNS : deskCount));
}

function snapScale(value) {
  const stepped = Math.floor(value / SCALE_STEP) * SCALE_STEP;
  return clamp(Math.round(stepped * 100) / 100, MIN_SCALE, MAX_SCALE);
}

/**
 * The wall furniture. Positions come from the room width alone, so the same
 * room always gets the same panes - nothing here is random and nothing is
 * loaded from anywhere.
 */
function buildProps(roomX, roomY, scale, roomWidthUnits) {
  const props = [];
  const panes = clamp(Math.floor(roomWidthUnits / 90), 1, 4);
  const pitch = roomWidthUnits / (panes + 1);
  for (let index = 0; index < panes; index += 1) {
    props.push({
      // A wall pane. Named "pane" so no browser global's name appears in a
      // module that is required to have no access to any of them.
      kind: 'pane',
      ...place(roomX, roomY, scale, {
        x: Math.round(pitch * (index + 1) - 14),
        y: 10,
        width: 28,
        height: 20,
      }),
    });
  }
  props.push({ kind: 'poster', ...place(roomX, roomY, scale, { x: 8, y: 8, width: 18, height: 24 }) });
  props.push({
    kind: 'clock',
    ...place(roomX, roomY, scale, { x: Math.max(30, roomWidthUnits - 26), y: 9, width: 14, height: 14 }),
  });
  return props;
}

/**
 * Header facts the canvas is allowed to repeat.
 *
 * Only closed-vocabulary values reach the canvas: the mode, the connection
 * `code`/`symbol` this screen defines, and counts. Free-form strings from the
 * wire - a `status` label, a `stream_gap` reason - stay in the DOM layer that
 * already renders them as text.
 */
function buildHud(header, deskCount) {
  const source = header === null || header === undefined ? {} : header;
  const connection = source.connection === null || typeof source.connection !== 'object' ? {} : source.connection;
  return {
    mode: source.mode === 'DEMO' ? 'DEMO' : source.mode === 'LIVE' ? 'LIVE' : '—',
    connection_code: typeof connection.code === 'string' ? connection.code : 'OFFLINE',
    connection_symbol: typeof connection.symbol === 'string' ? connection.symbol : '○',
    halted: source.halted === true,
    replaying: source.replaying === true,
    // Presence only: the reason string is free-form, so it is never painted.
    gapped: source.gap !== null && source.gap !== undefined,
    desk_count: deskCount,
    session_count: typeof source.session_count === 'number' ? source.session_count : 0,
  };
}

/** Caption line, assembled from this module's own literals. */
function captionFor(hud) {
  const parts = [hud.mode, `${hud.connection_symbol} ${hud.connection_code}`, `在席 ${hud.desk_count}`];
  if (hud.halted) parts.push('取り込み停止');
  else if (hud.gapped) parts.push('ストリーム欠落');
  else if (hud.replaying) parts.push('replay中');
  return parts.join('  ·  ');
}

function normalizeDesk(desk, index) {
  const source = desk === null || typeof desk !== 'object' ? {} : desk;
  const visual = source.visual === null || typeof source.visual !== 'object' ? {} : source.visual;
  return {
    seat: typeof source.seat === 'number' ? source.seat : index + 1,
    actor_key: typeof source.actor_key === 'string' ? source.actor_key : `seat-${index + 1}`,
    session_id: typeof source.session_id === 'string' ? source.session_id : '',
    display_name: typeof source.display_name === 'string' ? source.display_name : '',
    is_main_orchestrator: source.is_main_orchestrator === true,
    state: typeof visual.state === 'string' ? visual.state : 'idle',
    symbol: typeof visual.symbol === 'string' ? visual.symbol : '⋯',
    code: typeof visual.code === 'string' ? visual.code : 'IDLE',
  };
}

/**
 * Builds the whole drawable office.
 *
 * @param input `{ desks, header, viewport: { width, height, dpr } }` - `desks`
 *   and `header` are exactly what `selectDesks` / `selectHeader` returned.
 * @returns a `World`: integer rectangles, resolved colours and finished label
 *   strings. Same input, same world, every time.
 */
export function buildWorld(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const rawDesks = Array.isArray(source.desks) ? source.desks : [];
  const desks = rawDesks.map(normalizeDesk);
  const viewport = normalizeViewport(source.viewport);
  const hud = buildHud(source.header ?? null, desks.length);

  const columns = columnsFor(desks.length, viewport.width);
  const rows = Math.max(1, Math.ceil(desks.length / columns));

  const roomWidthUnits = columns * CELL_UNITS.width + 2 * ROOM_PADDING;
  const roomHeightUnits = WALL_UNITS + rows * CELL_UNITS.height + 2 * ROOM_PADDING;

  const scale = snapScale(
    Math.min(
      (viewport.width - 2 * OUTER_MARGIN) / roomWidthUnits,
      (viewport.height - 2 * OUTER_MARGIN) / roomHeightUnits,
      MAX_SCALE,
    ),
  );

  // The room is sized from the *rounded* parts it is made of, never from a
  // second rounding of the unit total: that is what makes "the grid fits inside
  // the room" exact rather than approximate at small scales.
  const wallHeight = Math.round(WALL_UNITS * scale);
  const pad = Math.round(ROOM_PADDING * scale);
  const margin = Math.round(OUTER_MARGIN * scale);
  const cellWidth = Math.round(CELL_UNITS.width * scale);
  const cellHeight = Math.round(CELL_UNITS.height * scale);

  const roomWidth = 2 * pad + columns * cellWidth;
  const roomHeight = wallHeight + 2 * pad + rows * cellHeight;

  // The canvas is exactly as large as the room plus its margin, so the room can
  // never be cropped: at the smallest scale the canvas grows instead.
  const canvasWidth = Math.max(viewport.width, roomWidth + 2 * margin);
  // The caption gets its own strip under the room, so it can never land on the
  // furniture and never has to shrink with the scale.
  const canvasHeight = roomHeight + 2 * margin + CAPTION_STRIP;

  const roomX = Math.round((canvasWidth - roomWidth) / 2);
  const roomY = margin;

  const floorY = roomY + wallHeight;
  const floorHeight = roomHeight - wallHeight;
  const floorTile = Math.max(2, Math.round(FLOOR_TILE_UNITS * scale));

  const gridX = roomX + pad;
  const gridY = floorY + pad;

  const noticeSize = clamp(Math.round(10 * scale), 9, 14);
  const nameSize = Math.max(8, Math.round(CELL_PARTS.nameLabel.height * scale));
  const stateSize = Math.max(7, Math.round(CELL_PARTS.stateLabel.height * scale));
  const labelBox = Math.round(CELL_PARTS.nameLabel.width * scale);

  const actors = desks.map((desk, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = gridX + column * cellWidth;
    const cellY = gridY + row * cellHeight;
    const name = place(cellX, cellY, scale, CELL_PARTS.nameLabel);
    const stateLabel = place(cellX, cellY, scale, CELL_PARTS.stateLabel);
    return {
      seat: desk.seat,
      actor_key: desk.actor_key,
      session_id: desk.session_id,
      state: desk.state,
      symbol: desk.symbol,
      code: desk.code,
      is_main_orchestrator: desk.is_main_orchestrator,
      appearance: appearanceFor(desk.actor_key),
      cell: { x: cellX, y: cellY, width: cellWidth, height: cellHeight },
      chair: place(cellX, cellY, scale, CELL_PARTS.chair),
      head: place(cellX, cellY, scale, CELL_PARTS.head),
      body: place(cellX, cellY, scale, CELL_PARTS.body),
      arm_left: place(cellX, cellY, scale, CELL_PARTS.armLeft),
      arm_right: place(cellX, cellY, scale, CELL_PARTS.armRight),
      desk: place(cellX, cellY, scale, CELL_PARTS.desk),
      desk_front: place(cellX, cellY, scale, CELL_PARTS.deskFront),
      monitor: place(cellX, cellY, scale, CELL_PARTS.monitor),
      badge: place(cellX, cellY, scale, CELL_PARTS.badge),
      marker: place(cellX, cellY, scale, CELL_PARTS.marker),
      name_label: {
        x: name.x,
        y: name.y,
        size: nameSize,
        text: fitLabel(desk.display_name, labelBox, nameSize),
      },
      state_label: {
        x: stateLabel.x,
        y: stateLabel.y,
        size: stateSize,
        text: fitLabel(`${desk.symbol} ${desk.code}`, labelBox, stateSize),
      },
    };
  });

  return {
    viewport,
    scale,
    columns,
    rows,
    empty: actors.length === 0,
    hud,
    // The caption strip spans the canvas, not the room: a one-desk office is a
    // narrow room, and the connection state still has to be readable in full.
    caption: fitLabel(captionFor(hud), canvasWidth - 2 * margin, CAPTION_SIZE),
    canvas: {
      width: canvasWidth,
      height: canvasHeight,
      device_width: Math.max(1, Math.round(canvasWidth * viewport.dpr)),
      device_height: Math.max(1, Math.round(canvasHeight * viewport.dpr)),
    },
    room: { x: roomX, y: roomY, width: roomWidth, height: roomHeight },
    wall: { x: roomX, y: roomY, width: roomWidth, height: wallHeight },
    floor: {
      x: roomX,
      y: floorY,
      width: roomWidth,
      height: floorHeight,
      tile: floorTile,
      cols: Math.ceil(roomWidth / floorTile),
      rows: Math.ceil(floorHeight / floorTile),
    },
    props: buildProps(roomX, roomY, scale, roomWidth / scale),
    actors,
    notice: {
      x: roomX + Math.round(roomWidth / 2),
      y: floorY + Math.round(floorHeight / 2),
      size: noticeSize,
      text: fitLabel('席は空です — eventが届くと着席します', roomWidth - 2 * pad, noticeSize),
    },
    caption_box: { x: margin, y: roomY + roomHeight + margin + CAPTION_SIZE, size: CAPTION_SIZE },
  };
}
