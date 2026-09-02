/**
 * `buildScene(World)`: the internal render-plan projection (Issue #48, Slice 1).
 *
 * It sits between `quest-world.js` and whatever paints pixels. The world model
 * already decided *where* everything is; this module decides only *how* a
 * renderer should draw it: which sprite, which pose, in what paint order, and
 * which overlays have to be on top of it.
 *
 * What this module is **not**:
 * - not durable business state. A `Scene` is rebuilt from a `World` on demand
 *   and is never stored, never sent over the wire and never persisted. No UI
 *   metaphor invented here - a pose, a layer, a sprite id - may travel back into
 *   the ARK domain;
 * - not a public API. It is an internal seam so the renderer, the assets and the
 *   layout can be swapped without touching the business projection;
 * - not a second state machine. Every business meaning it repeats - the actor
 *   state, its code and symbol, the worst hidden state, the header facts - is
 *   carried through from `quest-view.js` by way of `quest-world.js`, and the one
 *   ranking it needs is imported from there rather than copied.
 *
 * Like the two modules above it, this file has no DOM, no network, no
 * filesystem, no timer, no clock and no randomness, and it names no
 * renderer-specific API: the plan is plain data, so a Canvas2D painter and any
 * later adapter read the same thing. Same world in, same scene out, always.
 *
 * Honesty rules it holds:
 * - an observed activity is only ever drawn for a state the stream actually
 *   reported. `unknown` gets its own pose, so a disconnected or fail-closed
 *   office can never be drawn as an office at work;
 * - a seat no actor answers to gets no character at all, because a vacant seat
 *   is the absence of events and not a person sitting still;
 * - `walk` and `meeting` exist in the vocabulary but are unreachable from a
 *   `World` today: nothing in the event contract observes either, and inventing
 *   them would be fake progress;
 * - state is never colour-only. Every drawn character carries a `state` overlay
 *   with the code and symbol the screen already prints as text.
 */

import { ATTENTION_ORDER } from './quest-world.js';

/**
 * The closed presentation-action vocabulary.
 *
 * Deliberately small and shared across every kind of work: new workflows are
 * distinguished by zone, overlay and the DOM inspector, never by a new pose.
 *
 * `unknown` is in the list because the absence of an observed activity is not an
 * activity. Folding it into `idle` would claim a calm desk, and folding it into
 * `waiting` would claim a colleague blocked on something - both are statements
 * the evidence does not support.
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
 * Actor state to pose. The keys are exactly `ActorDisplayState`.
 *
 * `vacant` is absent on purpose: it is handled as "no character", not as a pose.
 */
export const POSE_BY_STATE = Object.freeze({
  error: 'alert',
  awaiting_approval: 'waiting',
  planning: 'thinking',
  working: 'desk_work',
  ended: 'idle',
  idle: 'idle',
  unknown: 'unknown',
});

/** The state a seat carries when the roster placed it and no actor answers it. */
export const VACANT_STATE = 'vacant';

/**
 * Paint order, back to front. A node's layer is its coarse ordering; within one
 * layer nodes are sorted by their anchor, so a nearer desk covers a further one.
 */
export const SCENE_LAYERS = Object.freeze([
  'backdrop',
  'floor',
  'wall',
  'prop',
  'zone',
  'stage',
  'caption',
]);

/** Every kind of thing a plan can contain. Closed, so a renderer can switch on it. */
export const SCENE_NODE_KINDS = Object.freeze([
  'backdrop',
  'floor',
  'wall',
  'prop',
  'zone',
  'seat',
  'actor',
  'player',
  'notice',
  'caption',
]);

/**
 * Overlay kinds, worst first where they compete for the reader's eye.
 *
 * `state` is on every character; the three above it are added when the state
 * asks for a human. They are separate kinds rather than one flag because the
 * three mean different things: something failed, somebody must approve, and
 * nothing is being observed are not interchangeable.
 */
export const OVERLAY_KINDS = Object.freeze([
  'alert',
  'attention',
  'unknown',
  'hidden',
  'state',
  'identity',
  'name',
]);

/** Badge text this module owns. Never a string off the wire. */
export const MAIN_BADGE_TEXT = 'MAIN';

const LAYER_RANK = Object.freeze(
  Object.fromEntries(SCENE_LAYERS.map((layer, index) => [layer, index])),
);

/**
 * How loudly one state asks to be looked at, worst first, exactly as the world
 * model ranks it. Imported rather than restated: the office-wide and per-zone
 * worst-hidden-state reports use this ranking, and a second copy here could
 * drift and quietly weaken them.
 */
function attentionRank(state) {
  const index = ATTENTION_ORDER.indexOf(state);
  return index === -1 ? ATTENTION_ORDER.length : index;
}

/** The worst state among these actors, in the closed vocabulary, or null. */
function worstOf(actors) {
  let worst = null;
  let rank = ATTENTION_ORDER.length + 1;
  for (const actor of actors) {
    const candidate = attentionRank(actor.state);
    if (candidate < rank) {
      rank = candidate;
      worst = { state: actor.state, code: actor.code, symbol: actor.symbol };
    }
  }
  return worst;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function rectOf(source) {
  if (source === null || typeof source !== 'object') return null;
  const { x, y, width, height } = source;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  return { x, y, width, height };
}

/** A label's baseline point, or null when the world left the label empty. */
function textAt(label) {
  if (label === null || typeof label !== 'object') return null;
  if (text(label.text).length === 0) return null;
  return { x: label.x, y: label.y, size: label.size };
}

function overlay(kind, spec) {
  return {
    kind,
    priority: OVERLAY_KINDS.indexOf(kind),
    code: text(spec.code),
    symbol: text(spec.symbol),
    text: text(spec.text),
    rect: spec.rect ?? null,
    text_at: spec.text_at ?? null,
  };
}

/**
 * The pose for a state.
 *
 * Anything outside the closed vocabulary lands on `unknown` rather than on a
 * working pose: an unrecognised state is a state nobody observed.
 */
export function poseForState(state) {
  return Object.prototype.hasOwnProperty.call(POSE_BY_STATE, state) ? POSE_BY_STATE[state] : 'unknown';
}

/** A sprite request: an id the asset layer resolves, plus the pose it is in. */
function sprite(id, pose, appearance) {
  return { id, pose: pose ?? null, appearance: appearance ?? null };
}

/**
 * The attention overlays one drawn character needs, on top of its `state` one.
 *
 * Driven by the state alone, so a renderer never has to know what an approval or
 * a failure means - and so the meaning cannot drift from `quest-view.js`.
 */
function attentionOverlays(actor) {
  const shared = { code: actor.code, symbol: actor.symbol, text: text(actor.state_label?.text), rect: actor.marker };
  if (actor.state === 'error') return [overlay('alert', shared)];
  if (actor.state === 'awaiting_approval') return [overlay('attention', shared)];
  if (actor.state === 'unknown') return [overlay('unknown', shared)];
  return [];
}

function actorNode(actor, index) {
  const vacant = actor.state === VACANT_STATE;
  const overlays = [
    // Shape and text, always: the marker silhouette and the state code are what
    // keep a state readable without relying on its colour.
    overlay('state', {
      code: actor.code,
      symbol: actor.symbol,
      text: text(actor.state_label?.text),
      rect: actor.marker,
      text_at: textAt(actor.state_label),
    }),
    ...(vacant ? [] : attentionOverlays(actor)),
  ];
  if (actor.is_main_orchestrator === true) {
    overlays.push(overlay('identity', { code: MAIN_BADGE_TEXT, text: MAIN_BADGE_TEXT, rect: actor.badge }));
  }
  const name = textAt(actor.name_label);
  if (name !== null) {
    overlays.push(overlay('name', { text: text(actor.name_label.text), text_at: name }));
  }
  return {
    // Index-prefixed because a world can legitimately hold two seats with the
    // same fallback key - two zones each with a vacant first seat, say - and a
    // render plan whose ids collide is a plan a renderer cannot diff.
    id: `${vacant ? 'seat' : 'actor'}:${index}:${text(actor.actor_key)}`,
    kind: vacant ? 'seat' : 'actor',
    key: text(actor.actor_key),
    layer: 'stage',
    rect: rectOf(actor.cell),
    // A seat nobody answers to gets its furniture and no character. Drawing a
    // person there would invent an occupant the roster explicitly says is absent.
    sprite: vacant ? sprite('seat.empty', null, null) : sprite(`actor.${poseForState(actor.state)}`, poseForState(actor.state), actor.appearance ?? null),
    state: text(actor.state),
    attention_rank: attentionRank(actor.state),
    parts: actor,
    overlays,
  };
}

function playerNode(player) {
  const overlays = [
    overlay('identity', { code: text(player.badge_text), text: text(player.badge_text), rect: player.badge }),
  ];
  const name = textAt(player.name_label);
  if (name !== null) {
    overlays.push(overlay('name', { text: text(player.name_label.text), text_at: name }));
  }
  return {
    id: `player:${text(player.id)}`,
    kind: 'player',
    key: text(player.id),
    layer: 'stage',
    rect: rectOf(player.cell),
    // The human at the keyboard is not a runtime actor and carries no state, so
    // they get the one pose that claims nothing about work.
    sprite: sprite('player.idle', 'idle', player.appearance ?? null),
    state: null,
    attention_rank: ATTENTION_ORDER.length,
    parts: player,
    overlays,
  };
}

function zoneNode(zone, index) {
  const overlays = [];
  const name = textAt(zone.name_label);
  if (name !== null) {
    overlays.push(overlay('name', { text: text(zone.name_label.text), text_at: name }));
  }
  if (zone.hidden_state !== null && zone.hidden_state !== undefined) {
    // A room that could not draw a failing seat must not look like a calm room.
    overlays.push(
      overlay('hidden', {
        code: text(zone.hidden_state.code),
        symbol: text(zone.hidden_state.symbol),
        rect: rectOf(zone.rect),
      }),
    );
  }
  return {
    id: `zone:${index}:${text(zone.id)}`,
    kind: 'zone',
    key: text(zone.id),
    layer: 'zone',
    rect: rectOf(zone.rect),
    sprite: sprite(zone.seats === false ? 'zone.facility' : 'zone.room', null, null),
    state: null,
    attention_rank: zone.hidden_state ? attentionRank(zone.hidden_state.state) : ATTENTION_ORDER.length,
    parts: zone,
    overlays,
  };
}

function captionNode(id, label, kind) {
  return {
    id,
    kind,
    key: id,
    layer: 'caption',
    rect: null,
    sprite: null,
    state: null,
    attention_rank: ATTENTION_ORDER.length,
    parts: label,
    overlays: [overlay('name', { text: text(label.text), text_at: textAt(label) })],
  };
}

/** Bottom-centre of a node's box: what a painter sorts depth by. */
function anchorOf(rect) {
  if (rect === null) return { x: 0, y: 0 };
  return { x: rect.x + Math.round(rect.width / 2), y: rect.y + rect.height };
}

/**
 * Total order over nodes: layer, then how near the viewer the node's anchor is,
 * then the id. Totally ordered on purpose - two nodes can share a layer and an
 * anchor, and a plan whose order depended on the input array's order would stop
 * being reproducible the moment a zone was reordered upstream.
 */
function compareNodes(a, b) {
  const layers = LAYER_RANK[a.layer] - LAYER_RANK[b.layer];
  if (layers !== 0) return layers;
  if (a.anchor.y !== b.anchor.y) return a.anchor.y - b.anchor.y;
  if (a.anchor.x !== b.anchor.x) return a.anchor.x - b.anchor.x;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Turns a finished `World` into a render plan.
 *
 * @param world exactly what `buildWorld` returned.
 * @returns a `Scene`: nodes in paint order, each with a sprite request, a pose
 *   and its overlays. Same world in, same scene out.
 */
export function buildScene(world) {
  const source = world === null || typeof world !== 'object' ? {} : world;
  const actors = Array.isArray(source.actors) ? source.actors : [];
  const zones = Array.isArray(source.zones) ? source.zones : [];
  const props = Array.isArray(source.props) ? source.props : [];

  const canvas = source.canvas ?? { width: 0, height: 0, dpr: 1, device_width: 0, device_height: 0 };
  const nodes = [];

  nodes.push({
    id: 'backdrop',
    kind: 'backdrop',
    key: 'backdrop',
    layer: 'backdrop',
    rect: { x: 0, y: 0, width: canvas.width ?? 0, height: canvas.height ?? 0 },
    sprite: sprite('stage.backdrop', null, null),
    state: null,
    attention_rank: ATTENTION_ORDER.length,
    parts: null,
    overlays: [],
  });

  const floor = rectOf(source.floor);
  if (floor !== null) {
    nodes.push({
      id: 'floor',
      kind: 'floor',
      key: 'floor',
      layer: 'floor',
      rect: floor,
      sprite: sprite('floor.tile', null, null),
      state: null,
      attention_rank: ATTENTION_ORDER.length,
      parts: source.floor,
      overlays: [],
    });
  }

  const wall = rectOf(source.wall);
  if (wall !== null) {
    nodes.push({
      id: 'wall',
      kind: 'wall',
      key: 'wall',
      layer: 'wall',
      rect: wall,
      sprite: sprite('wall.back', null, null),
      state: null,
      attention_rank: ATTENTION_ORDER.length,
      parts: source.wall,
      overlays: [],
    });
  }

  props.forEach((prop, index) => {
    nodes.push({
      id: `prop:${index}:${text(prop.kind)}`,
      kind: 'prop',
      key: text(prop.kind),
      layer: 'prop',
      rect: rectOf(prop),
      sprite: sprite(`prop.${text(prop.kind)}`, null, null),
      state: null,
      attention_rank: ATTENTION_ORDER.length,
      parts: prop,
      overlays: [],
    });
  });

  zones.forEach((zone, index) => nodes.push(zoneNode(zone, index)));
  actors.forEach((actor, index) => nodes.push(actorNode(actor, index)));
  if (source.player !== null && source.player !== undefined) nodes.push(playerNode(source.player));

  if (source.empty === true && source.notice !== undefined && text(source.notice?.text).length > 0) {
    nodes.push(captionNode('notice', source.notice, 'notice'));
  }
  if (text(source.caption).length > 0 && source.caption_box !== undefined) {
    nodes.push(captionNode('caption', { ...source.caption_box, text: source.caption }, 'caption'));
  }
  if (text(source.overflow_label?.text).length > 0) {
    nodes.push(captionNode('overflow', source.overflow_label, 'caption'));
  }

  const ordered = nodes
    .map((node) => ({ ...node, anchor: anchorOf(node.rect ?? null) }))
    .sort(compareNodes)
    .map((node, depth) => ({ ...node, depth }));

  const drawn = actors.filter((actor) => actor.state !== VACANT_STATE);
  return {
    viewport: source.viewport ?? null,
    scale: typeof source.scale === 'number' ? source.scale : 1,
    canvas,
    grouped: source.grouped === true,
    empty: source.empty === true,
    // Carried through untouched: these are the header facts `quest-view.js`
    // classified, and this layer neither re-derives nor re-interprets them.
    hud: source.hud ?? null,
    overflow: source.overflow ?? null,
    attention: {
      /** The worst state actually on the stage, or null when nothing is drawn. */
      worst: worstOf(drawn),
      /** The worst state the world had to leave out. Straight from the world. */
      hidden: source.overflow?.hidden_state ?? null,
    },
    layers: SCENE_LAYERS,
    nodes: ordered,
  };
}
