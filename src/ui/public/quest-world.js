/**
 * Pure world model for the retro office canvas.
 *
 * `buildWorld` turns the projections the screen already trusts -
 * `selectDesks(state)`, `selectPlayer(state)` and `selectHeader(state)` from
 * `quest-view.js` - plus a viewport, into a fully resolved set of integer
 * rectangles. Nothing else goes in: no organisation snapshot, no invented
 * employee, no role that the collector did not resolve.
 *
 * The player is drawn from `selectPlayer` and from nowhere else. They stand in
 * their own strip below the desk grid, never in a seat: they are not a runtime
 * actor, they take no seat number, and they are absent from `world.actors`
 * entirely, so nothing that counts or iterates colleagues can pick them up.
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

/**
 * Most desk rows the canvas ever draws.
 *
 * The collector accepts up to `max_actors` (4096) actors, and six columns of
 * them would be 683 rows tall - a backing store no browser will allocate. The
 * canvas is the decorative layer, so it draws a bounded office and reports how
 * many seats it left out; the DOM desk list below it stays the complete,
 * accessible view of every actor.
 */
export const MAX_ROWS = 16;

/**
 * Height of the strip that carries a zone's name, in layout units.
 *
 * Part of the zone's own band rather than a gap between bands, so a zone
 * rectangle always encloses its own label and two zones can never overlap by
 * the width of a heading.
 */
export const ZONE_HEADER_UNITS = 18;

/**
 * Most zones the canvas ever draws.
 *
 * The collector accepts 64 departments and 64 facilities, and a room with 129
 * name strips is not a floor plan, so there is a bound. It has to clear the
 * organisation this screen is actually built for, though: six departments,
 * seven shared facilities, the 社長室 and 未所属 is fifteen rooms, and a bound
 * that hid three of them would drop rooms from the documented configuration.
 *
 * Zones past the bound are still *counted*, and the seats inside them are still
 * part of the office totals and of the worst-hidden-state report - being
 * undrawable is not the same as being absent.
 */
export const MAX_ZONES = 32;

/**
 * How much taller than its viewport a grouped office may be.
 *
 * The ungrouped office is one room and is fitted into the viewport, height
 * included. A floor plan is not one room: fitting six departments, the 社長室,
 * 未所属 and the shared facilities into the same box collapses the scale until
 * the desks are unreadable - correct geometry that nobody can read, which fails
 * the point of drawing a floor plan at all.
 *
 * So a grouped office is allowed to run past the fold and be scrolled, and this
 * is the bound on how far. It is not a licence to grow without limit: the
 * backing-store ceilings still apply on top of it.
 */
export const GROUPED_HEIGHT_RATIO = 2;

/**
 * How loudly a state asks to be looked at, worst first.
 *
 * A copy of `ACTOR_VISUAL_STATES` from `quest-view.js`, which this module
 * deliberately does not import: `buildWorld` takes projections and a viewport
 * and nothing else. `test/ui-world.test.ts` asserts the two lists are identical
 * so the copy cannot drift.
 *
 * It exists because seats the canvas could not draw must not be reported as a
 * bare number. A zone that has left a failing seat out looks calm, and a calm
 * room with an error hidden behind it is the one thing this screen may not do.
 */
export const ATTENTION_ORDER = Object.freeze([
  'error',
  'awaiting_approval',
  'planning',
  'working',
  'ended',
  'idle',
]);

function attentionRank(state) {
  const index = ATTENTION_ORDER.indexOf(state);
  return index === -1 ? ATTENTION_ORDER.length : index;
}

/**
 * The desk among these that most asks to be looked at, reduced to the closed
 * vocabulary the screen may print: state, code and symbol. Null when there are
 * none.
 *
 * The code and symbol travel with the state because the *reader* has to be told
 * what was hidden, not just how much. A number alone is the calm-looking report
 * of a failure this screen may not make.
 */
function worstState(desks) {
  let worst = null;
  let rank = ATTENTION_ORDER.length + 1;
  for (const desk of desks) {
    const candidate = attentionRank(desk.state);
    if (candidate < rank) {
      rank = candidate;
      worst = { state: desk.state, code: desk.code, symbol: desk.symbol };
    }
  }
  return worst;
}

/** Hard ceiling on either side of the backing store, in device pixels. */
export const MAX_DEVICE_SIDE = 8192;

/**
 * Hard ceiling on the backing store's area, in device pixels.
 *
 * 16,777,216 is the smallest area limit documented across the browsers this
 * screen can run in, so a buffer under it is one every one of them accepts.
 */
export const MAX_DEVICE_PIXELS = 16777216;

/** The buffer is never scaled below this: a canvas of zero pixels draws nothing. */
export const MIN_DEVICE_SCALE = 0.05;

/** Share of the browser's inner height the office is allowed to take. */
export const VIEWPORT_HEIGHT_RATIO = 0.62;

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

/** Height of the strip the player stands in, below the desk grid, in units. */
export const PLAYER_STRIP_UNITS = 58;

/**
 * The player's own silhouette, in units, relative to their strip's top-left.
 *
 * Standing, and made of different parts from a desk cell: legs instead of a
 * chair, and no desk, monitor or state marker at all. A colleague's shape says
 * "seated, working"; this one says "here, at the keyboard" - so the two read
 * apart at a glance, before any colour or label is involved.
 */
const PLAYER_PARTS = Object.freeze({
  head: Object.freeze({ x: 29, y: 4, width: 14, height: 14 }),
  body: Object.freeze({ x: 25, y: 18, width: 22, height: 20 }),
  armLeft: Object.freeze({ x: 20, y: 20, width: 5, height: 16 }),
  armRight: Object.freeze({ x: 47, y: 20, width: 5, height: 16 }),
  legLeft: Object.freeze({ x: 28, y: 38, width: 7, height: 8 }),
  legRight: Object.freeze({ x: 37, y: 38, width: 7, height: 8 }),
  badge: Object.freeze({ x: 4, y: 6, width: 17, height: 9 }),
  nameLabel: Object.freeze({ x: 36, y: 54, width: 68, height: 10 }),
});

/**
 * Appearance palettes. Fixed, hand-authored colour lists - no external asset and
 * nothing copied from another game. An index into each list is derived from the
 * actor key, so two actors differ but one actor never does.
 */
const SKIN_TONES = Object.freeze(['#f3cfa6', '#e3ad7e', '#c98d55', '#9a6336', '#6f4326', '#ffdcb8']);
const HAIR_COLORS = Object.freeze(['#2b2118', '#5a3921', '#8c5a2b', '#c8a24a', '#7a2f2f', '#3b4a6b', '#8f8f9c']);
const HAIR_STYLES = Object.freeze(['short', 'bob', 'spiky', 'bun', 'cap']);

/**
 * The outfit colours a *runtime actor* can be given. Exported so the test suite
 * can hold the one rule that matters here: the player's outfit is drawn from
 * neither list, so no colleague can ever be mistaken for the human player.
 */
export const ACTOR_SHIRT_COLORS = Object.freeze([
  '#3f7fd6', '#4caf7d', '#d1603d', '#8558c4', '#d8b23a', '#3aa8b8', '#c85c8e', '#5b6b8c',
]);
export const ACTOR_TROUSER_COLORS = Object.freeze(['#2a3350', '#3a2f28', '#1f4038', '#403050', '#4a3a52']);

/**
 * The player's outfit: two colours reserved for them and used by nobody else.
 *
 * Skin and hair still vary with the player's own id, so a renamed player is a
 * recognisably different person - but the outfit is fixed, so "which one is me"
 * never depends on remembering a colour that an AI colleague might also draw.
 */
export const PLAYER_OUTFIT = Object.freeze({ shirt: '#f2f4fb', trouser: '#161b2b' });

/** Text on the player's badge. This module's own literal, never off the wire. */
export const PLAYER_BADGE_TEXT = 'YOU';

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
    shirt: pick(ACTOR_SHIRT_COLORS, seed, 'shirt'),
    trouser: pick(ACTOR_TROUSER_COLORS, seed, 'trouser'),
  };
}

/**
 * The look of the human player.
 *
 * Seeded from the player's own id under a salt of its own, so it is as
 * deterministic as a colleague's - and dressed from `PLAYER_OUTFIT`, which no
 * colleague can draw from. Same identity, same face, different clothes: the two
 * are told apart by construction rather than by a lucky hash.
 */
export function playerAppearanceFor(playerId) {
  const seed = appearanceSeed(`player:${typeof playerId === 'string' ? playerId : ''}`);
  return {
    seed,
    skin: pick(SKIN_TONES, seed, 'skin'),
    hair: pick(HAIR_COLORS, seed, 'hair'),
    hair_style: pick(HAIR_STYLES, seed, 'style'),
    shirt: PLAYER_OUTFIT.shirt,
    trouser: PLAYER_OUTFIT.trouser,
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

/**
 * The viewport one canvas *surface* offers, from measurements a caller took.
 *
 * The width that matters is the canvas element's own content box - the box the
 * browser paints the backing store into. The frame around it carries padding,
 * so its `clientWidth` is the wider outer box: sizing a buffer from that puts,
 * for a 960px frame with 10px of padding on each side at ratio 4, a 3840-pixel
 * buffer onto a 940-pixel surface. The browser then rescales by 4.085 and the
 * pixel blocks this screen is made of stop landing on whole device pixels.
 *
 * The frame width is a last resort only, for a canvas that has no layout box to
 * report yet; it is an over-estimate by exactly the padding, so it is used when
 * the alternative is no measurement at all rather than as an equal option.
 *
 * No element is touched here: the caller passes plain numbers, which is what
 * keeps this module testable in Node and free of any browser global.
 *
 * @param source `{ surface_width, frame_width, window_height, dpr }` in CSS
 *   pixels, as `clientWidth` / `innerHeight` / `devicePixelRatio` report them.
 * @returns a `Viewport` already clamped exactly like `buildWorld` clamps one.
 */
export function measureCanvasViewport(source) {
  const raw = source === null || typeof source !== 'object' ? {} : source;
  const surface = Math.floor(finite(raw.surface_width, 0));
  const frame = Math.floor(finite(raw.frame_width, 0));
  return normalizeViewport({
    width: surface > 0 ? surface : frame,
    height: Math.round(finite(raw.window_height, 0) * VIEWPORT_HEIGHT_RATIO),
    dpr: raw.dpr,
  });
}

/**
 * How many device pixels one CSS pixel is allowed to become.
 *
 * The requested ratio is honoured whenever the resulting buffer fits under both
 * ceilings, so an ordinary office is as crisp as the screen it is on. When it
 * would not fit, the ratio is lowered - a slightly soft canvas is the price of
 * a canvas the browser will actually allocate, and every fact on it is also in
 * the DOM below at full fidelity.
 */
export function deviceScaleFor(cssWidth, cssHeight, dpr) {
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  const limit = Math.min(MAX_DEVICE_SIDE / width, MAX_DEVICE_SIDE / height, Math.sqrt(MAX_DEVICE_PIXELS / (width * height)));
  if (limit >= dpr) return dpr;
  // Snapped down to a hundredth, like the ratio itself, so the buffer is
  // reproducible rather than dependent on the last bit of a float.
  return Math.max(MIN_DEVICE_SCALE, Math.floor(limit * 100) / 100);
}

/**
 * The backing store for one CSS-pixel canvas.
 *
 * Every dimension that leaves here is a positive integer, no side exceeds
 * `MAX_DEVICE_SIDE`, and the product never exceeds `MAX_DEVICE_PIXELS` - the
 * last clamp closes the gap rounding could otherwise open.
 */
function buildBuffer(cssWidth, cssHeight, dpr) {
  const scale = deviceScaleFor(cssWidth, cssHeight, dpr);
  const width = clamp(Math.max(1, Math.round(cssWidth * scale)), 1, MAX_DEVICE_SIDE);
  let height = clamp(Math.max(1, Math.round(cssHeight * scale)), 1, MAX_DEVICE_SIDE);
  if (width * height > MAX_DEVICE_PIXELS) {
    height = Math.max(1, Math.floor(MAX_DEVICE_PIXELS / width));
  }
  return { scale, width, height };
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
/**
 * A zone, rebuilt from the projection key by key.
 *
 * `seats: false` is a room nobody sits in - 社長室 and 共用施設 - so it gets a
 * band and a name and never a cell. A zone with no desks is still a zone: a
 * department the stream has said nothing about exists, and drawing the empty
 * room is how the screen says so.
 */
function normalizeZone(zone, index) {
  const source = zone === null || typeof zone !== 'object' ? {} : zone;
  const rawDesks = Array.isArray(source.desks) ? source.desks : [];
  return {
    id: typeof source.id === 'string' ? source.id : `zone-${index + 1}`,
    name: typeof source.name === 'string' ? source.name : '',
    kind: typeof source.kind === 'string' ? source.kind : 'department',
    seats: source.seats !== false,
    desks: rawDesks.map(normalizeDesk),
  };
}

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
function buildHud(header, overflow, player, present) {
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
    // Colleagues, not seats. `overflow.total` counts everything the canvas has
    // to lay out, and in a grouped office that includes roster seats nobody has
    // answered to - so reading it here would put 「在席 7」 on the canvas while
    // the DOM, which counts actors, says 0. The canvas still caps what it
    // *paints* and never what it admits exists; that is `drawn`/`hidden` below.
    desk_count: present,
    drawn_count: overflow.drawn,
    hidden_count: overflow.hidden,
    session_count: typeof source.session_count === 'number' ? source.session_count : 0,
    // Presence only. The player is not a seat, so it is deliberately absent
    // from `desk_count` - which is what keeps "在席 N" a count of colleagues.
    player_present: player !== null && player !== undefined,
  };
}

/**
 * The player projection, reduced to what the canvas may paint: an identity and
 * a name. Anything else on the object is ignored rather than carried along.
 */
function normalizePlayer(player) {
  if (player === null || typeof player !== 'object') return null;
  if (player.kind !== 'player') return null;
  const id = typeof player.id === 'string' ? player.id : '';
  if (id.length === 0) return null;
  return { id, display_name: typeof player.display_name === 'string' ? player.display_name : '' };
}

/** Caption line, assembled from this module's own literals. */
function captionFor(hud) {
  const parts = [hud.mode, `${hud.connection_symbol} ${hud.connection_code}`, `在席 ${hud.desk_count}`];
  if (hud.hidden_count > 0) parts.push(`描画 ${hud.drawn_count}`);
  if (hud.halted) parts.push('取り込み停止');
  else if (hud.gapped) parts.push('ストリーム欠落');
  else if (hud.replaying) parts.push('replay中');
  return parts.join('  ·  ');
}

/**
 * The overflow line, for an office with more seats than the canvas draws.
 *
 * Three integers this module counted itself and nothing else - no name, no key,
 * no wire string - so the reader learns exactly what is missing and where the
 * rest of it is.
 */
function overflowTextFor(overflow) {
  // 「枠」 and not 「席」: this counts drawn cards, and a roster seat can hold
  // several colleagues while a vacant one holds none. README uses the same word.
  const parts = [`表示 ${overflow.drawn} 枠 / 全 ${overflow.total} 枠`];
  if (overflow.zones.hidden > 0) parts.push(`区画 ${overflow.zones.drawn} / ${overflow.zones.total}`);
  // What was left out, not only how much. Without this the ungrouped office -
  // which has no zone outline to colour - reports a hidden failure as a calm
  // number, and the room outlines are the only other place a state is drawn.
  if (overflow.hidden_state !== null) {
    parts.push(`未描画に ${overflow.hidden_state.symbol} ${overflow.hidden_state.code} あり`);
  }
  parts.push(`残り ${overflow.hidden} 枠は下の一覧に表示`);
  return parts.join('  ·  ');
}

function normalizeDesk(desk, index) {
  const source = desk === null || typeof desk !== 'object' ? {} : desk;
  const visual = source.visual === null || typeof source.visual !== 'object' ? {} : source.visual;
  return {
    seat: typeof source.seat === 'number' ? source.seat : index + 1,
    // A plain `Desk` carries no `occupied` field and is an actor by
    // construction, so absence means occupied. Only the office projection marks
    // a seat as answered by nobody.
    occupied: source.occupied !== false,
    /**
     * How many colleagues this one desk stands for.
     *
     * A desk is not a person. A roster seat with nobody at it stands for none;
     * a seat several actors of the same runtime type answer to stands for all
     * of them; every other desk stands for exactly one. Counting desks instead
     * would make the canvas disagree with the DOM about how many people are in
     * the company, which is the one number they both claim to show.
     */
    occupant_count: Array.isArray(source.occupants) ? source.occupants.length : 1,
    // Present only on a desk the roster placed. Never filled in from `seat`:
    // one is a position in a dynamic ordering, the other belongs to the
    // organisation (`docs/org-snapshot-design.md` §4.4).
    roster_seat: typeof source.roster_seat === 'number' ? source.roster_seat : null,
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
  const player = normalizePlayer(source.player ?? null);
  const viewport = normalizeViewport(source.viewport);

  // Zones, when the office is grouped by an organisation. Absent, the office is
  // the single ungrouped room it has always been, expressed below as one band
  // with no name strip - so the ungrouped layout is not a second code path that
  // could drift from this one.
  const rawZones = Array.isArray(source.zones) ? source.zones : [];
  const grouped = rawZones.length > 0;
  const allZones = rawZones.map(normalizeZone);
  const zonesDrawn = allZones.slice(0, MAX_ZONES);
  const zonesCut = allZones.slice(MAX_ZONES);

  // A grouped office takes its column count from the **roster alone**.
  //
  // This is the difference between a floor plan and a list. `columnsFor` reads
  // the desk count and the viewport width, and both of those move: a colleague
  // the roster does not know joins 未所属 and widens it, or the viewport crosses a
  // width threshold. Either one would re-flow every band - changing which row a
  // seat is on, where the zones below it start, and in a tight budget whether a
  // seat is drawn at all - which is precisely the "actors and resize never move
  // a roster seat" contract (`docs/org-snapshot-design.md` §3.2 ①③).
  //
  // So the width of the grid is a fact about the organisation, and the viewport
  // decides only how many pixels each cell gets.
  const widestRoster = zonesDrawn.reduce(
    (most, zone) => Math.max(most, zone.desks.filter((desk) => desk.roster_seat !== null).length),
    0,
  );
  const columns = grouped
    ? clamp(widestRoster, 1, MAX_COLUMNS)
    : columnsFor(desks.length, viewport.width);

  // Rows are capped before anything is sized, so the office the canvas has to
  // hold is bounded whatever the collector accepted. `drawn` are the seats that
  // get painted; the rest are counted, named on the canvas only as a number,
  // and shown in full by the DOM desk list.
  const bands = [];
  if (grouped) {
    // The row budget is spent in declared zone order, so which seats overflow is
    // decided by the organisation and not by who arrived first. A zone that runs
    // out of budget still gets its band and its name: the department exists
    // whether or not the canvas can draw its desks.
    let remaining = MAX_ROWS;
    for (const zone of zonesDrawn) {
      const needed = zone.seats ? Math.max(1, Math.ceil(zone.desks.length / columns)) : 0;
      const rows = Math.min(needed, Math.max(0, remaining));
      remaining -= rows;
      const drawn = zone.desks.slice(0, Math.min(zone.desks.length, rows * columns));
      bands.push({ zone, rows, drawn, hidden: zone.desks.slice(drawn.length) });
    }
  } else {
    const rows = Math.min(Math.max(1, Math.ceil(desks.length / columns)), MAX_ROWS);
    const drawn = desks.slice(0, Math.min(desks.length, rows * columns));
    bands.push({ zone: null, rows, drawn, hidden: desks.slice(drawn.length) });
  }

  const rows = bands.reduce((sum, band) => sum + band.rows, 0);
  const drawn = bands.flatMap((band) => band.drawn);
  // Seats inside a zone the canvas could not draw are hidden seats, not absent
  // ones: they count towards the totals and towards the worst-hidden-state
  // report exactly like a seat that overflowed its own band. Dropping them here
  // is what would make an unrenderable room a silent truncation.
  const hiddenDesks = [...bands.flatMap((band) => band.hidden), ...zonesCut.flatMap((zone) => zone.desks)];
  const total = grouped
    ? allZones.reduce((sum, zone) => sum + zone.desks.length, 0)
    : desks.length;
  const overflow = {
    total,
    drawn: drawn.length,
    hidden: total - drawn.length,
    // A count alone would let a zone that left a failing seat out look calm.
    // The worst state among the seats the canvas could not draw is reported
    // with the number, so a hidden error is still on the screen as a fact.
    hidden_state: worstState(hiddenDesks),
    zones: { total: allZones.length, drawn: zonesDrawn.length, hidden: allZones.length - zonesDrawn.length },
  };

  // Colleagues, counted the way the DOM counts them: per actor, not per desk.
  //
  // A `Desk` from `selectDesks` carries no `occupants`, so it stands for one and
  // the ungrouped office counts exactly as it always did. In a grouped office a
  // vacant roster seat stands for nobody and an aggregated seat stands for
  // everyone behind it - anything else puts a different number of colleagues on
  // the canvas than in the header above it.
  const countPresent = (rows) => rows.reduce((sum, desk) => sum + desk.occupant_count, 0);
  const present = grouped
    ? allZones.reduce((sum, zone) => sum + countPresent(zone.desks), 0)
    : countPresent(desks);
  const hud = buildHud(source.header ?? null, overflow, player, present);

  // The player's strip is added to the room, never taken out of the grid: the
  // desks keep the seats and the coordinates they would have had without one,
  // so whether a snapshot names a player changes nothing about the seating.
  //
  // When the office is grouped the player is not in a strip at all: they stand
  // in the 社長室, which is a band like any other (`docs/org-snapshot-design.md`
  // §4.1). The strip below the grid is the ungrouped office's arrangement.
  const executiveBand = grouped
    ? (bands.find((band) => band.zone !== null && band.zone.kind === 'executive') ?? null)
    : null;
  const playerInZone = executiveBand !== null && player !== null;
  const playerStripUnits = player === null || playerInZone ? 0 : PLAYER_STRIP_UNITS;
  // Height each band contributes: its name strip, its rows, and - for the
  // 社長室 - room for the person standing in it.
  const bandUnits = (band) =>
    (band.zone === null ? 0 : ZONE_HEADER_UNITS) +
    band.rows * CELL_UNITS.height +
    (band === executiveBand && player !== null ? PLAYER_STRIP_UNITS : 0);
  const bandsUnits = bands.reduce((sum, band) => sum + bandUnits(band), 0);
  const roomWidthUnits = columns * CELL_UNITS.width + 2 * ROOM_PADDING;
  const roomHeightUnits = WALL_UNITS + bandsUnits + playerStripUnits + 2 * ROOM_PADDING;

  const heightBudget = grouped ? viewport.height * GROUPED_HEIGHT_RATIO : viewport.height;
  const scale = snapScale(
    Math.min(
      (viewport.width - 2 * OUTER_MARGIN) / roomWidthUnits,
      (heightBudget - 2 * OUTER_MARGIN) / roomHeightUnits,
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
  // Zero in a grouped office: the player stands in the 社長室 band, whose height
  // already includes this strip. Adding it again would leave an empty floor band
  // under every zone and make the room taller than the unit-space budget it was
  // scaled from.
  const playerStrip = playerStripUnits === 0 ? 0 : Math.round(PLAYER_STRIP_UNITS * scale);

  const zoneHeader = grouped ? Math.round(ZONE_HEADER_UNITS * scale) : 0;
  const roomWidth = 2 * pad + columns * cellWidth;
  const bandHeight = (band) =>
    (band.zone === null ? 0 : zoneHeader) +
    band.rows * cellHeight +
    (band === executiveBand && player !== null ? Math.round(PLAYER_STRIP_UNITS * scale) : 0);
  const bandsHeight = bands.reduce((sum, band) => sum + bandHeight(band), 0);
  const roomHeight = wallHeight + 2 * pad + bandsHeight + playerStrip;

  // The room is centred in whatever width the canvas ends up with, so sideways
  // the outer margin decides one thing only: whether the canvas has to be wider
  // than the viewport it is displayed in. It gives way before that happens - a
  // canvas wider than the surface showing it is one the browser rescales, and
  // the space around the room is backdrop either way.
  const sideMargin = Math.max(0, Math.min(margin, Math.floor((viewport.width - roomWidth) / 2)));
  // The canvas is exactly as large as the room plus that margin, so the room can
  // never be cropped: at the smallest scale the canvas grows instead.
  const canvasWidth = Math.max(viewport.width, roomWidth + 2 * sideMargin);
  // The caption gets its own strip under the room, so it can never land on the
  // furniture and never has to shrink with the scale. An office with seats the
  // canvas did not draw gets a second strip for the count, so the two lines
  // cannot overlap either.
  // A room the canvas could not draw is news even when it held no seats: an
  // organisation whose thirty-third zone silently vanishes is the same silent
  // truncation as a dropped desk.
  const anythingHidden = overflow.hidden > 0 || overflow.zones.hidden > 0;
  const captionLines = anythingHidden ? 2 : 1;
  const canvasHeight = roomHeight + 2 * margin + CAPTION_STRIP * captionLines;

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

  // Bands are walked in order and each keeps its own running origin, so a seat's
  // coordinate comes from (which zone, which place in that zone) and from
  // nothing else. Actors arriving or leaving change what is *in* a cell, never
  // where the cell is.
  const zoneRects = [];
  const actors = [];
  let bandY = gridY;
  let playerCell = null;
  const zoneNameSize = Math.max(8, Math.round(11 * scale));
  for (const band of bands) {
    const headerHeight = band.zone === null ? 0 : zoneHeader;
    const height = bandHeight(band);
    if (band.zone !== null) {
      zoneRects.push({
        id: band.zone.id,
        kind: band.zone.kind,
        rect: { x: gridX, y: bandY, width: columns * cellWidth, height },
        name_label: {
          x: gridX + Math.round(4 * scale),
          y: bandY + Math.round(ZONE_HEADER_UNITS * scale) - Math.round(5 * scale),
          size: zoneNameSize,
          text: fitLabel(band.zone.name, columns * cellWidth - Math.round(8 * scale), zoneNameSize),
        },
        seats: band.zone.seats,
        drawn: band.drawn.length,
        hidden: band.hidden.length,
        // Same rule as the office-wide count: a zone that could not draw a
        // failing seat must not look like a zone with nothing wrong in it.
        hidden_state: worstState(band.hidden),
      });
    }
    if (band === executiveBand && player !== null) {
      playerCell = { x: gridX, y: bandY + headerHeight };
    }
    band.drawn.forEach((desk, index) => {
      actors.push({ desk, cellX: gridX + (index % columns) * cellWidth, cellY: bandY + headerHeight + Math.floor(index / columns) * cellHeight });
    });
    bandY += height;
  }

  const placedActors = actors.map(({ desk, cellX, cellY }) => {
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

  // The player stands in the strip below the last desk row, at the left edge of
  // the grid. Their position comes from the grid's own geometry, so it is as
  // reproducible as every seat and never overlaps one.
  const worldPlayer =
    player === null
      ? null
      : (() => {
          // In the 社長室 when the office is grouped, in the strip below the
          // last desk row when it is not. Either way the position comes from
          // the grid's own geometry, so it is as reproducible as every seat and
          // never overlaps one.
          const cellX = playerCell === null ? gridX : playerCell.x;
          const cellY = playerCell === null ? gridY + bandsHeight : playerCell.y;
          const name = place(cellX, cellY, scale, PLAYER_PARTS.nameLabel);
          return {
            kind: 'player',
            id: player.id,
            appearance: playerAppearanceFor(player.id),
            cell: { x: cellX, y: cellY, width: cellWidth, height: playerStrip },
            head: place(cellX, cellY, scale, PLAYER_PARTS.head),
            body: place(cellX, cellY, scale, PLAYER_PARTS.body),
            arm_left: place(cellX, cellY, scale, PLAYER_PARTS.armLeft),
            arm_right: place(cellX, cellY, scale, PLAYER_PARTS.armRight),
            leg_left: place(cellX, cellY, scale, PLAYER_PARTS.legLeft),
            leg_right: place(cellX, cellY, scale, PLAYER_PARTS.legRight),
            badge: place(cellX, cellY, scale, PLAYER_PARTS.badge),
            badge_text: PLAYER_BADGE_TEXT,
            name_label: {
              x: name.x,
              y: name.y,
              size: nameSize,
              text: fitLabel(player.display_name, labelBox, nameSize),
            },
          };
        })();

  const buffer = buildBuffer(canvasWidth, canvasHeight, viewport.dpr);
  const captionY = roomY + roomHeight + margin + CAPTION_SIZE;

  return {
    viewport,
    scale,
    columns,
    rows,
    empty: placedActors.length === 0,
    hud,
    overflow,
    // The caption strip spans the canvas, not the room: a one-desk office is a
    // narrow room, and the connection state still has to be readable in full.
    caption: fitLabel(captionFor(hud), canvasWidth - 2 * margin, CAPTION_SIZE),
    canvas: {
      width: canvasWidth,
      height: canvasHeight,
      // The ratio the buffer was actually built at. It is the requested one
      // unless that would have exceeded a ceiling, so `draw(World)` transforms
      // by this and never by the raw `viewport.dpr`.
      dpr: buffer.scale,
      device_width: buffer.width,
      device_height: buffer.height,
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
    actors: placedActors,
    // The rooms the office is divided into, in the order they are drawn. Empty
    // whenever the office is ungrouped, which is what the canvas reads to know
    // it is painting the single-room layout.
    zones: zoneRects,
    grouped,
    // A field of its own, never an entry in `actors`: the seat count, the
    // overflow arithmetic and every loop over colleagues stay untouched by it.
    player: worldPlayer,
    notice: {
      x: roomX + Math.round(roomWidth / 2),
      y: floorY + Math.round(floorHeight / 2),
      size: noticeSize,
      text: fitLabel('席は空です — eventが届くと着席します', roomWidth - 2 * pad, noticeSize),
    },
    caption_box: { x: margin, y: captionY, size: CAPTION_SIZE },
    // Empty text when nothing was left out, so the painter has one condition to
    // check and never paints a "0 seats hidden" line.
    overflow_label: {
      x: margin,
      y: captionY + CAPTION_STRIP,
      size: CAPTION_SIZE,
      text: anythingHidden ? fitLabel(overflowTextFor(overflow), canvasWidth - 2 * margin, CAPTION_SIZE) : '',
    },
  };
}
