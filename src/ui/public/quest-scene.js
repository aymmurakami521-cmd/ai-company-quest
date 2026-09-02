/**
 * `buildScene(World)`: the render plan a painter is handed, and nothing else.
 *
 * This is the thin seam Issue #48 Slice 1 asks for. It sits *after*
 * `quest-world.js` and *before* any painter, and it turns a finished `World`
 * into a flat, ordered list of sprites and overlays: what to draw, which pose
 * to draw it in, in what depth order, and what has to be written on top.
 *
 * It is deliberately a projection and not a model:
 * - no DOM, no canvas, no network, no filesystem, no storage;
 * - no clock and no random source, so the same world is the same scene, always;
 * - no renderer API - not one `fillRect`, not one `drawImage`, no colour that
 *   is not already a fact of the `World` it was given;
 * - no mutation of anything it was passed, and nothing here is durable state.
 *
 * The one invariant everything else hangs off:
 *
 *   **A pose never carries business meaning. `state`, `code` and `symbol` do.**
 *
 * A pose is an animation slot. It is chosen from a closed vocabulary by a table
 * lookup on the state the business projection already decided, and it is the
 * *only* thing on a sprite that a future theme may reinterpret. Every sprite
 * that stands for a colleague carries the `state`, `code` and `symbol`
 * `quest-view.js` classified, unchanged, so swapping the artwork, the pose set
 * or the whole renderer cannot change what the screen claims about anybody.
 *
 * Nothing here decides that a human should look at something. The attention
 * *ordering* used to report what was left out is imported from
 * `quest-world.js`, not restated, so this file cannot become a second opinion
 * about which state matters most. Human Attention, approval and Evidence remain
 * the DOM's job; this module only makes sure a hidden failure travels into the
 * render plan instead of being dropped on the way (`overflow.hidden_state`).
 *
 * Not wired into the live screen. `quest-app.js` and `quest-canvas.js` are
 * untouched and the module is not in the served asset table, so this slice is
 * reversible: deleting this file and its test restores the previous tree.
 */

// The only import, and deliberately so: the order in which states ask to be
// looked at is a fact of the world model that already exists. Restating it here
// would create a second, silently drifting opinion about which state is worst -
// which is the one thing a presentation layer must never own.
import { ATTENTION_ORDER } from './quest-world.js';

/**
 * Draw order, coarse to fine. A sprite's layer decides everything before its
 * position does, so no amount of geometry can put the floor over a colleague.
 */
export const SCENE_LAYERS = Object.freeze(['backdrop', 'zone', 'fixture', 'stage', 'overlay']);

/**
 * Every sprite this projection may ask for, as a closed vocabulary.
 *
 * A key, not an asset: no file name, no URL, no licence, nothing acquired from
 * anywhere. Slice 2 binds these keys to a theme and an asset manifest; until
 * then a renderer is free to keep painting rectangles for all of them.
 */
export const SCENE_SPRITES = Object.freeze([
  'room',
  'wall',
  'floor',
  'zone_band',
  'pane',
  'poster',
  'clock',
  'chair',
  'worker',
  'vacant_seat',
  'monitor',
  'desk',
  'player',
]);

/**
 * The closed animation vocabulary, per Issue #48.
 *
 * It is short on purpose. A new workflow, a new department or a new runtime
 * event type must not require a new pose: what somebody is actually doing is
 * told by the zone they are in, the overlay on their desk and the DOM
 * inspector, never by inventing a nineteenth animation.
 *
 * `unknown` is the fail-closed member, and the reason the list is eight and not
 * seven. A screen that cannot tell what somebody is doing has to be able to say
 * so; folding that case into `idle` would state "not working" and folding it
 * into `waiting` would state "blocked", and both are claims this layer has no
 * evidence for.
 */
export const SCENE_POSES = Object.freeze([
  'idle',
  'walk',
  'desk_work',
  'meeting',
  'thinking',
  'waiting',
  'alert',
  'unknown',
]);

/**
 * The poses that assert somebody is *observably* getting work done.
 *
 * Kept as its own list because it is the thing the fail-closed rule below
 * withholds. Growing the pose vocabulary later without deciding whether the new
 * pose belongs here is how fake progress gets back in.
 */
export const WORK_POSES = Object.freeze(['desk_work', 'meeting', 'walk']);

/**
 * State to pose, as a table and not as logic.
 *
 * Every displayable state from `quest-view.js` has a row, plus `vacant` - the
 * absence of any event, which is not an actor state at all and so is never a
 * person's pose. Anything not in the table falls to `unknown`: an unrecognised
 * label is a thing this screen does not understand, not a thing that is fine.
 *
 * `walk` and `meeting` are in the vocabulary and in no row of this table. There
 * is no observation in the runtime today that says somebody crossed the room or
 * sat down with somebody else, and painting one anyway would be a picture of
 * work nobody reported. They stay unreachable until real evidence exists.
 */
export const POSE_BY_STATE = Object.freeze({
  error: 'alert',
  awaiting_approval: 'waiting',
  planning: 'thinking',
  working: 'desk_work',
  ended: 'idle',
  idle: 'idle',
  unknown: 'unknown',
  vacant: 'unknown',
});

/** Every overlay kind this projection may emit. Also closed. */
export const SCENE_OVERLAYS = Object.freeze([
  'state_marker',
  'name_label',
  'state_label',
  'role_badge',
  'player_badge',
  'zone_name',
  'zone_hidden_state',
  'notice',
  'caption',
  'overflow',
]);

/**
 * Connection codes that mean the last thing we heard is not fresh.
 *
 * `RECONNECTING` is deliberately absent: the stream dropped and is coming back,
 * the DOM already says so in a banner, and blanking every colleague on the
 * screen for the length of a retry would be its own kind of lie. `CONNECTING`
 * is absent for the same reason - a snapshot may already have been applied.
 */
export const STALE_CONNECTION_CODES = Object.freeze(['OFFLINE', 'DISCONNECTED', 'FAIL_CLOSED']);

/** One layer's worth of depth. Wide enough that a row can never reach the next. */
export const DEPTH_LAYER_SPAN = 1000000;
/** Depth added per pixel row, leaving `DEPTH_TIE_SLOTS` values free between rows. */
export const DEPTH_ROW_STEP = 8;
/** Tie slots inside one row, for sprites whose top edge is the same pixel. */
export const DEPTH_TIE_SLOTS = 8;
/** Rows above this share the last depth band rather than spilling into the next layer. */
export const DEPTH_MAX_ROW = 99999;

const EMPTY_RECT = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

const EMPTY_HUD = Object.freeze({
  mode: '—',
  connection_code: 'OFFLINE',
  connection_symbol: '○',
  halted: false,
  replaying: false,
  gapped: false,
  desk_count: 0,
  drawn_count: 0,
  hidden_count: 0,
  session_count: 0,
  player_present: false,
});

function ownProp(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function integer(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

/** A rectangle reduced to four integers. Never the caller's object. */
function rectOf(source) {
  if (source === null || typeof source !== 'object') return { ...EMPTY_RECT };
  return {
    x: integer(source.x),
    y: integer(source.y),
    width: integer(source.width),
    height: integer(source.height),
  };
}

/**
 * Where a sprite sits in the paint order.
 *
 * Layer first, then the top edge of what it stands for, then a tie slot. Sorting
 * by the top edge is what makes the office read as a room seen from above and in
 * front: a chair is behind the colleague on it, and the desk in front of them
 * covers their hands, because 18 < 27 < 44 in the cell's own geometry.
 *
 * The number is stable and comparable, so a renderer may either walk `sprites`
 * in the order given or sort by `depth` and get the same picture.
 */
export function depthFor(layer, y, tie) {
  const rank = SCENE_LAYERS.indexOf(layer);
  const layerRank = rank === -1 ? SCENE_LAYERS.length : rank;
  const row = clamp(integer(y), 0, DEPTH_MAX_ROW);
  const slot = clamp(integer(tie), 0, DEPTH_TIE_SLOTS - 1);
  return layerRank * DEPTH_LAYER_SPAN + row * DEPTH_ROW_STEP + slot;
}

/**
 * The pose for a state, before the fail-closed rule below is applied.
 *
 * A table lookup and a fallback, with no branch that could read a state's
 * *meaning*. That is what keeps a new state from silently animating as work.
 */
export function poseFor(state) {
  const pose = ownProp(POSE_BY_STATE, text(state));
  return typeof pose === 'string' ? pose : 'unknown';
}

/**
 * Is what the screen is showing backed by a stream we are still hearing from?
 *
 * False when the collector fail-closed, when the connection is offline or
 * dropped, or when there is no world at all.
 */
function evidenceIsFresh(hud) {
  if (hud.halted === true) return false;
  return !STALE_CONNECTION_CODES.includes(hud.connection_code);
}

function attentionRank(state) {
  const index = ATTENTION_ORDER.indexOf(state);
  return index === -1 ? ATTENTION_ORDER.length : index;
}

/** The closed-vocabulary triple, copied. Never a free-form string off the wire. */
function statedAs(source) {
  return { state: text(source.state), code: text(source.code), symbol: text(source.symbol) };
}

function hudOf(world) {
  const source = world.hud === null || typeof world.hud !== 'object' ? {} : world.hud;
  return Object.freeze({
    mode: source.mode === 'LIVE' || source.mode === 'DEMO' ? source.mode : '—',
    connection_code: text(source.connection_code) || 'OFFLINE',
    connection_symbol: text(source.connection_symbol) || '○',
    halted: source.halted === true,
    replaying: source.replaying === true,
    gapped: source.gapped === true,
    desk_count: integer(source.desk_count),
    drawn_count: integer(source.drawn_count),
    hidden_count: integer(source.hidden_count),
    session_count: integer(source.session_count),
    player_present: source.player_present === true,
  });
}

function hiddenStateOf(source) {
  if (source === null || typeof source !== 'object') return null;
  return statedAs(source);
}

/**
 * Builds the render plan for one world.
 *
 * @param world a finished `World` from `quest-world.js`, or null.
 * @returns a `Scene`: sprites in paint order, overlays in paint order, and the
 *   closed-vocabulary facts a painter is allowed to repeat. Same world, same
 *   scene, every time - there is nothing in here that could differ between two
 *   calls with the same input.
 */
export function buildScene(world) {
  const source = world === null || typeof world !== 'object' ? {} : world;
  const hud = hudOf(source);
  const fresh = evidenceIsFresh(hud);
  const grouped = source.grouped === true;

  const sprites = [];
  const overlays = [];

  const push = (list, entry) => {
    list.push(entry);
    return entry;
  };

  // ------------------------------------------------------------- backdrop ---

  const room = rectOf(source.room);
  const wall = rectOf(source.wall);
  const floorSource = source.floor === null || typeof source.floor !== 'object' ? {} : source.floor;
  const floor = rectOf(floorSource);

  push(sprites, {
    id: 'room',
    sprite: 'room',
    layer: 'backdrop',
    depth: depthFor('backdrop', room.y, 0),
    rect: room,
  });
  push(sprites, {
    id: 'wall',
    sprite: 'wall',
    layer: 'backdrop',
    depth: depthFor('backdrop', wall.y, 1),
    rect: wall,
  });
  push(sprites, {
    id: 'floor',
    sprite: 'floor',
    layer: 'backdrop',
    depth: depthFor('backdrop', floor.y, 2),
    rect: floor,
    // The tiling the floor was laid out at. A theme may swap the tile artwork;
    // it may not change how many tiles the room is wide, because that is a
    // consequence of the room's size and not a decoration.
    tile: { size: integer(floorSource.tile), cols: integer(floorSource.cols), rows: integer(floorSource.rows) },
  });

  // ------------------------------------------------------------------ zones ---

  const zones = Array.isArray(source.zones) ? source.zones : [];
  zones.forEach((zone, index) => {
    const raw = zone === null || typeof zone !== 'object' ? {} : zone;
    const rect = rectOf(raw.rect);
    const hidden = hiddenStateOf(raw.hidden_state);
    push(sprites, {
      id: `zone:${text(raw.id) || index}`,
      sprite: 'zone_band',
      layer: 'zone',
      depth: depthFor('zone', rect.y, 0),
      rect,
      zone_id: text(raw.id),
      // The organisation's own kind (`development`, `executive`, ...), carried
      // through untouched. This layer never renames it into an office metaphor
      // and never writes one back: a display zone is a fact about this frame's
      // picture, not about the company.
      zone_kind: text(raw.kind),
      seats: raw.seats === true,
      drawn: integer(raw.drawn),
      hidden: integer(raw.hidden),
      // The worst state this room could not draw, forwarded verbatim. A room
      // that left a failure out must not arrive at the painter looking calm.
      hidden_state: hidden,
    });

    const nameLabel = raw.name_label === null || typeof raw.name_label !== 'object' ? {} : raw.name_label;
    if (text(nameLabel.text).length > 0) {
      push(overlays, {
        id: `zone-name:${text(raw.id) || index}`,
        kind: 'zone_name',
        layer: 'overlay',
        depth: depthFor('overlay', nameLabel.y, 0),
        anchor: { x: integer(nameLabel.x), y: integer(nameLabel.y) },
        size: integer(nameLabel.size),
        align: 'left',
        text: text(nameLabel.text),
      });
    }
    if (hidden !== null) {
      // Never colour alone. The overlay carries the symbol and the state code as
      // text, so a room outlined in an accent colour is also a room that says,
      // in characters, what is hidden inside it.
      push(overlays, {
        id: `zone-hidden:${text(raw.id) || index}`,
        kind: 'zone_hidden_state',
        layer: 'overlay',
        depth: depthFor('overlay', rect.y, 1),
        anchor: { x: rect.x, y: rect.y },
        size: integer(nameLabel.size),
        align: 'left',
        text: `${hidden.symbol} ${hidden.code}`,
        state: hidden.state,
        code: hidden.code,
        symbol: hidden.symbol,
      });
    }
  });

  // --------------------------------------------------------------- fixtures ---

  const props = Array.isArray(source.props) ? source.props : [];
  props.forEach((prop, index) => {
    const raw = prop === null || typeof prop !== 'object' ? {} : prop;
    const kind = text(raw.kind);
    // Only the three the world model authors. An unrecognised prop is dropped
    // rather than passed through as a sprite key nothing can draw.
    if (kind !== 'pane' && kind !== 'poster' && kind !== 'clock') return;
    const rect = rectOf(raw);
    push(sprites, {
      id: `prop:${kind}:${index}`,
      sprite: kind,
      layer: 'fixture',
      depth: depthFor('fixture', rect.y, clamp(index, 0, DEPTH_TIE_SLOTS - 1)),
      rect,
    });
  });

  // ------------------------------------------------------------------ stage ---

  const actors = Array.isArray(source.actors) ? source.actors : [];
  const columns = integer(source.columns);
  actors.forEach((actor, index) => {
    const raw = actor === null || typeof actor !== 'object' ? {} : actor;
    const key = text(raw.actor_key) || `seat-${index + 1}`;
    const facts = statedAs(raw);
    // Two colleagues on the same row share a top edge, so the column decides
    // their order. It is the seat's own position, not their arrival order, which
    // is what keeps a redraw from shuffling the room.
    const tie = columns > 0 ? index % columns : 0;

    const chair = rectOf(raw.chair);
    const body = rectOf(raw.body);
    const monitor = rectOf(raw.monitor);
    const desk = rectOf(raw.desk);

    push(sprites, {
      id: `chair:${key}`,
      sprite: 'chair',
      layer: 'stage',
      depth: depthFor('stage', chair.y, tie),
      rect: chair,
      actor_key: key,
    });

    const basePose = poseFor(facts.state);
    // Fail-closed, in the only direction a screen may fail: a claim is withheld,
    // never invented. When the collector has stopped or the stream is gone, the
    // last thing we heard may be true and may be hours stale - so the *animation*
    // stops asserting work while the state, code and symbol below stay exactly
    // what the business projection said. The reader still sees what was last
    // known; they no longer see a picture of it still happening.
    const withheld = !fresh && WORK_POSES.includes(basePose);
    // A seat the roster placed and nobody ever answered to is not a person. It
    // gets the seat's geometry so the floor plan does not move, and a sprite key
    // that cannot be mistaken for a colleague.
    const vacant = facts.state === 'vacant';

    push(sprites, {
      id: `actor:${key}`,
      sprite: vacant ? 'vacant_seat' : 'worker',
      layer: 'stage',
      // Anchored at the body, so the chair is behind this and the desk in front.
      depth: depthFor('stage', body.y, tie),
      rect: rectOf(raw.cell),
      actor_key: key,
      session_id: text(raw.session_id),
      seat: integer(raw.seat),
      is_main_orchestrator: raw.is_main_orchestrator === true,
      occupied: !vacant,
      pose: withheld ? 'unknown' : basePose,
      /** True when a work pose was suppressed because the evidence is not fresh. */
      pose_withheld: withheld,
      // Untouched, and the only thing on this sprite that means anything about
      // the business. A theme may repaint everything else.
      state: facts.state,
      code: facts.code,
      symbol: facts.symbol,
      // Resolved by the world model from the actor key alone: same colleague,
      // same look, forever. Copied, never re-derived here.
      appearance: raw.appearance === null || typeof raw.appearance !== 'object' ? null : { ...raw.appearance },
      parts: {
        head: rectOf(raw.head),
        body,
        arm_left: rectOf(raw.arm_left),
        arm_right: rectOf(raw.arm_right),
      },
    });

    push(sprites, {
      id: `monitor:${key}`,
      sprite: 'monitor',
      layer: 'stage',
      depth: depthFor('stage', monitor.y, tie),
      rect: monitor,
      actor_key: key,
    });
    push(sprites, {
      id: `desk:${key}`,
      sprite: 'desk',
      layer: 'stage',
      depth: depthFor('stage', desk.y, tie),
      rect: desk,
      actor_key: key,
      parts: { front: rectOf(raw.desk_front) },
    });

    // The state marker: a shape, not a colour. It is emitted for every seat,
    // including one whose pose was withheld, because "what we last heard" is
    // still a fact the reader is owed.
    const marker = rectOf(raw.marker);
    push(overlays, {
      id: `marker:${key}`,
      kind: 'state_marker',
      layer: 'overlay',
      depth: depthFor('overlay', marker.y, 0),
      anchor: { x: marker.x, y: marker.y },
      rect: marker,
      actor_key: key,
      state: facts.state,
      code: facts.code,
      symbol: facts.symbol,
      text: facts.symbol,
      align: 'left',
      size: marker.height,
    });

    const nameLabel = raw.name_label === null || typeof raw.name_label !== 'object' ? {} : raw.name_label;
    push(overlays, {
      id: `name:${key}`,
      kind: 'name_label',
      layer: 'overlay',
      depth: depthFor('overlay', nameLabel.y, 1),
      anchor: { x: integer(nameLabel.x), y: integer(nameLabel.y) },
      size: integer(nameLabel.size),
      align: 'center',
      // Already truncated to its box by the world model. This layer measures
      // nothing: measuring needs a font, and a font needs the DOM.
      text: text(nameLabel.text),
      actor_key: key,
    });

    const stateLabel = raw.state_label === null || typeof raw.state_label !== 'object' ? {} : raw.state_label;
    push(overlays, {
      id: `state:${key}`,
      kind: 'state_label',
      layer: 'overlay',
      depth: depthFor('overlay', stateLabel.y, 2),
      anchor: { x: integer(stateLabel.x), y: integer(stateLabel.y) },
      size: integer(stateLabel.size),
      align: 'center',
      text: text(stateLabel.text),
      actor_key: key,
      state: facts.state,
      code: facts.code,
      symbol: facts.symbol,
    });

    if (raw.is_main_orchestrator === true) {
      const badge = rectOf(raw.badge);
      push(overlays, {
        id: `role:${key}`,
        kind: 'role_badge',
        layer: 'overlay',
        depth: depthFor('overlay', badge.y, 3),
        anchor: { x: badge.x, y: badge.y },
        rect: badge,
        size: badge.height,
        align: 'left',
        text: 'MAIN',
        actor_key: key,
      });
    }
  });

  // The player is a sprite and never an entry in the actor list, exactly as they
  // are in the world model: no seat, no session, no runtime state. `idle` here is
  // the neutral standing figure, and the sprite carries `state: null` so it can
  // never be counted or read as a colleague who is idle.
  const player = source.player === null || typeof source.player !== 'object' ? null : source.player;
  if (player !== null) {
    const body = rectOf(player.body);
    push(sprites, {
      id: 'player',
      sprite: 'player',
      layer: 'stage',
      depth: depthFor('stage', body.y, DEPTH_TIE_SLOTS - 1),
      rect: rectOf(player.cell),
      player_id: text(player.id),
      pose: 'idle',
      pose_withheld: false,
      state: null,
      appearance:
        player.appearance === null || typeof player.appearance !== 'object' ? null : { ...player.appearance },
      parts: {
        head: rectOf(player.head),
        body,
        arm_left: rectOf(player.arm_left),
        arm_right: rectOf(player.arm_right),
        leg_left: rectOf(player.leg_left),
        leg_right: rectOf(player.leg_right),
      },
    });

    const badge = rectOf(player.badge);
    push(overlays, {
      id: 'player-badge',
      kind: 'player_badge',
      layer: 'overlay',
      depth: depthFor('overlay', badge.y, 4),
      anchor: { x: badge.x, y: badge.y },
      rect: badge,
      size: badge.height,
      align: 'center',
      text: text(player.badge_text),
    });

    const nameLabel = player.name_label === null || typeof player.name_label !== 'object' ? {} : player.name_label;
    push(overlays, {
      id: 'player-name',
      kind: 'name_label',
      layer: 'overlay',
      depth: depthFor('overlay', nameLabel.y, 5),
      anchor: { x: integer(nameLabel.x), y: integer(nameLabel.y) },
      size: integer(nameLabel.size),
      align: 'center',
      text: text(nameLabel.text),
    });
  }

  // -------------------------------------------------------- screen overlays ---

  const empty = source.empty === true;
  const notice = source.notice === null || typeof source.notice !== 'object' ? {} : source.notice;
  if (empty && text(notice.text).length > 0) {
    push(overlays, {
      id: 'notice',
      kind: 'notice',
      layer: 'overlay',
      depth: depthFor('overlay', notice.y, 6),
      anchor: { x: integer(notice.x), y: integer(notice.y) },
      size: integer(notice.size),
      align: 'center',
      text: text(notice.text),
    });
  }

  const captionBox = source.caption_box === null || typeof source.caption_box !== 'object' ? {} : source.caption_box;
  const caption = text(source.caption);
  if (caption.length > 0) {
    push(overlays, {
      id: 'caption',
      kind: 'caption',
      layer: 'overlay',
      depth: depthFor('overlay', captionBox.y, 6),
      anchor: { x: integer(captionBox.x), y: integer(captionBox.y) },
      size: integer(captionBox.size),
      align: 'left',
      text: caption,
    });
  }

  const overflowLabel =
    source.overflow_label === null || typeof source.overflow_label !== 'object' ? {} : source.overflow_label;
  if (text(overflowLabel.text).length > 0) {
    push(overlays, {
      id: 'overflow',
      kind: 'overflow',
      layer: 'overlay',
      depth: depthFor('overlay', overflowLabel.y, 7),
      anchor: { x: integer(overflowLabel.x), y: integer(overflowLabel.y) },
      size: integer(overflowLabel.size),
      align: 'left',
      text: text(overflowLabel.text),
    });
  }

  // ------------------------------------------------------------- attention ---

  const overflow = source.overflow === null || typeof source.overflow !== 'object' ? {} : source.overflow;
  const overflowZones =
    overflow.zones === null || typeof overflow.zones !== 'object' ? {} : overflow.zones;
  const hiddenState = hiddenStateOf(overflow.hidden_state);

  // The worst state among the seats that *were* drawn, ranked by the world
  // model's own order. Reported next to the hidden one so a renderer can tell
  // "the room is calm" from "the room looks calm because the loud part is off
  // screen" - it is a summary of what is already in `sprites`, not a new
  // judgement about what a human should do.
  let visibleWorst = null;
  let visibleRank = ATTENTION_ORDER.length + 1;
  for (const actor of actors) {
    const raw = actor === null || typeof actor !== 'object' ? {} : actor;
    const rank = attentionRank(text(raw.state));
    if (rank < visibleRank) {
      visibleRank = rank;
      visibleWorst = statedAs(raw);
    }
  }
  const hiddenRank = hiddenState === null ? ATTENTION_ORDER.length + 1 : attentionRank(hiddenState.state);
  const worst =
    visibleWorst === null && hiddenState === null
      ? null
      : hiddenRank < visibleRank
        ? { ...hiddenState, source: 'hidden' }
        : { ...visibleWorst, source: 'drawn' };

  // Sorted by depth, with the emission order above as the tie-break, so a
  // renderer may walk the list as given or sort it and get the same picture.
  sprites.sort((a, b) => a.depth - b.depth);
  overlays.sort((a, b) => a.depth - b.depth);

  // The buffer the world model sized. Named for what it is - a rectangle and a
  // pixel ratio - so nothing in this file reads as a handle on a drawing surface.
  const buffer = source.canvas === null || typeof source.canvas !== 'object' ? {} : source.canvas;

  return {
    canvas: {
      width: integer(buffer.width),
      height: integer(buffer.height),
      dpr: typeof buffer.dpr === 'number' && Number.isFinite(buffer.dpr) ? buffer.dpr : 1,
      device_width: integer(buffer.device_width),
      device_height: integer(buffer.device_height),
    },
    scale: typeof source.scale === 'number' && Number.isFinite(source.scale) ? source.scale : 0,
    columns,
    rows: integer(source.rows),
    grouped,
    empty,
    hud,
    /**
     * False when the stream is halted, offline or dropped.
     *
     * The reason a work pose is withheld, and the flag a renderer reads to draw
     * the whole room as "last known" rather than as "now".
     */
    evidence_fresh: fresh,
    sprites,
    overlays,
    attention: {
      total: integer(overflow.total),
      drawn: integer(overflow.drawn),
      hidden: integer(overflow.hidden),
      zones: {
        total: integer(overflowZones.total),
        drawn: integer(overflowZones.drawn),
        hidden: integer(overflowZones.hidden),
      },
      /** The worst state the picture left out, carried through unchanged. */
      hidden_state: hiddenState,
      /** The loudest state in the scene at all, and which side of the cut it is on. */
      worst,
    },
  };
}

/** An empty scene, for a screen that has no world yet. Nothing is claimed by it. */
export function emptyScene() {
  return buildScene({ hud: { ...EMPTY_HUD } });
}
