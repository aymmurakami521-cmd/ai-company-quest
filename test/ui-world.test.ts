/**
 * The canvas world model.
 *
 * `buildWorld` is a pure function of the projections the DOM screen already
 * shows plus a viewport, so every case here is data in / data out: no DOM, no
 * canvas, no clock, nothing that can flake.
 *
 * What these tests hold in place:
 * - the same input always produces the same office;
 * - an actor's seat and appearance depend on its `actor_key` and nothing else;
 * - the room always fits inside the canvas, at every viewport and DPR;
 * - no free-form string from the wire reaches the canvas layer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { seedDemoStore } from '../src/demo/fixtures.ts';
import type { QuestState } from '../src/domain/reducer.ts';
import { makeEvent } from './helpers.ts';

import type { ActorVisualState, ClientState, Desk, Header } from '../src/ui/public/quest-view.js';
import {
  ACTOR_VISUAL_STATES,
  applyFrame,
  applySnapshot,
  createClientState,
  selectDesks,
  selectHeader,
  setConnectionPhase,
  visualForState,
} from '../src/ui/public/quest-view.js';
import type { Rect, World, WorldActor } from '../src/ui/public/quest-world.js';
import {
  APPEARANCE_KEYS,
  EMPTY_COLUMNS,
  MAX_COLUMNS,
  MAX_DEVICE_PIXELS,
  MAX_DEVICE_SIDE,
  MAX_DPR,
  MAX_ROWS,
  MAX_SCALE,
  MIN_DEVICE_SCALE,
  MIN_SCALE,
  appearanceFor,
  appearanceSeed,
  buildWorld,
  deviceScaleFor,
  fitLabel,
} from '../src/ui/public/quest-world.js';

// ------------------------------------------------------------- fixtures ---

function demoState(): ClientState {
  const store = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(store);
  return applySnapshot(createClientState('demo'), {
    namespace: store.namespace,
    halted: store.stats.halted,
    halt_reason: store.stats.halt_reason,
    last_ingest_seq: store.stats.last_ingest_seq,
    state: JSON.parse(JSON.stringify(store.state)) as QuestState,
  });
}

function liveState(events: readonly Record<string, unknown>[]): ClientState {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires: unknown[] = [];
  store.subscribe((wire) => {
    wires.push(wire);
  });
  for (const event of events) store.ingestObject(event);
  let state = createClientState('live');
  for (const wire of wires) state = applyFrame(state, { kind: 'event', payload: wire });
  return state;
}

/** A synthetic desk, so one visual state at a time can be exercised. */
function desk(seat: number, state: ActorVisualState, overrides: Partial<Desk> = {}): Desk {
  return {
    seat,
    actor_key: `sess-1::agent-${seat}`,
    session_id: 'sess-1',
    display_name: `agent-${seat}`,
    is_main_orchestrator: false,
    role: null,
    resolved: false,
    status_label: null,
    last_tool: null,
    last_event_ts: null,
    event_count: 1,
    visual: visualForState(state),
    ...overrides,
  };
}

const VIEWPORT = { width: 960, height: 560, dpr: 1 };

function emptyHeader(): Header {
  return selectHeader(createClientState('live'));
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function actorRects(actor: WorldActor): Rect[] {
  return [actor.chair, actor.head, actor.body, actor.arm_left, actor.arm_right, actor.desk, actor.monitor];
}

// --------------------------------------------------------- determinism ---

test('the same projections and viewport always build the same world', () => {
  const state = demoState();
  const input = { desks: selectDesks(state), header: selectHeader(state), viewport: VIEWPORT };

  assert.deepEqual(buildWorld(input), buildWorld(input));
  // A second, independently derived projection of the same state agrees too.
  assert.deepEqual(
    buildWorld({ desks: selectDesks(state), header: selectHeader(state), viewport: { ...VIEWPORT } }),
    buildWorld(input),
  );
});

test('an actor keeps its seat and its look whatever else changes around it', () => {
  const key = 'sess-1::agent-1';
  const first = buildWorld({
    desks: [desk(1, 'working'), desk(2, 'idle'), desk(3, 'error')],
    header: emptyHeader(),
    viewport: VIEWPORT,
  });
  // Same actor, different state, more colleagues, a different viewport.
  const second = buildWorld({
    desks: [desk(1, 'ended'), desk(2, 'working'), desk(3, 'idle'), desk(4, 'awaiting_approval')],
    header: emptyHeader(),
    viewport: { width: 1440, height: 900, dpr: 2 },
  });

  const left = first.actors.find((actor) => actor.actor_key === key);
  const right = second.actors.find((actor) => actor.actor_key === key);
  assert.ok(left !== undefined && right !== undefined);
  assert.deepEqual(left.appearance, right.appearance, 'the same actor_key always looks the same');
  assert.equal(left.seat, right.seat, 'seating comes from the projection, not from the canvas');
  // The appearance is a closed set of channels plus its seed.
  assert.deepEqual(Object.keys(left.appearance).sort(), ['seed', ...APPEARANCE_KEYS].sort());
});

test('appearance is derived from the actor key alone and differs between actors', () => {
  assert.equal(appearanceSeed('sess-1::agent-1'), appearanceSeed('sess-1::agent-1'));
  assert.notEqual(appearanceSeed('sess-1::agent-1'), appearanceSeed('sess-1::agent-2'));
  assert.deepEqual(appearanceFor('sess-1::agent-1'), appearanceFor('sess-1::agent-1'));

  // Over a realistic spread of keys the palettes are actually used, so two
  // colleagues are distinguishable rather than uniformly grey.
  const looks = new Set<string>();
  for (let index = 0; index < 40; index += 1) {
    looks.add(JSON.stringify(appearanceFor(`sess-1::agent-${index}`)));
  }
  assert.ok(looks.size > 20, `expected varied appearances, saw ${looks.size}`);

  // A non-string key is handled rather than thrown at.
  assert.equal(appearanceSeed(null), appearanceSeed(''));
});

// -------------------------------------------------------- office shapes ---

test('an office with no runtime actor still draws a room', () => {
  const world = buildWorld({ desks: [], header: emptyHeader(), viewport: VIEWPORT });

  assert.equal(world.empty, true);
  assert.deepEqual(world.actors, []);
  assert.equal(world.hud.desk_count, 0);
  assert.ok(world.room.width > 0 && world.room.height > 0);
  assert.ok(world.floor.height > 0 && world.wall.height > 0);
  assert.ok(world.props.length > 0, 'the empty room is still a room');
  assert.ok(world.notice.text.length > 0, 'the empty office says so on the canvas too');
  assert.equal(world.notice.text.endsWith('…'), false, 'and says it in full');
  assert.equal(world.rows, 1);
  // A room, not a one-desk corridor - but still no invented occupant.
  assert.equal(world.columns, EMPTY_COLUMNS);
});

test('one actor, several actors: the grid is bounded and every desk fits the room', () => {
  for (const count of [1, 2, 5, 12, 40]) {
    const desks = Array.from({ length: count }, (_, index) => desk(index + 1, 'idle'));
    const world = buildWorld({ desks, header: emptyHeader(), viewport: VIEWPORT });

    assert.equal(world.actors.length, count, `${count} desks`);
    assert.equal(world.empty, false);
    assert.ok(world.columns >= 1 && world.columns <= MAX_COLUMNS, `${count}: columns ${world.columns}`);
    assert.equal(world.rows, Math.ceil(count / world.columns), `${count}: rows`);

    const canvas: Rect = { x: 0, y: 0, width: world.canvas.width, height: world.canvas.height };
    assert.ok(contains(canvas, world.room), `${count}: the room fits the canvas`);
    for (const actor of world.actors) {
      assert.ok(contains(world.room, actor.cell), `${count}: seat ${actor.seat} fits the room`);
      for (const rect of actorRects(actor)) {
        assert.ok(contains(canvas, rect), `${count}: seat ${actor.seat} part fits the canvas`);
      }
      // The labels sit inside the canvas, so no name is cut off at the edge.
      assert.ok(actor.name_label.y <= world.canvas.height, `${count}: name label on canvas`);
      assert.ok(actor.state_label.y <= world.canvas.height, `${count}: state label on canvas`);
    }
    // Seats never overlap: each cell has its own grid slot.
    const slots = new Set(world.actors.map((actor) => `${actor.cell.x}:${actor.cell.y}`));
    assert.equal(slots.size, count, `${count}: every desk has its own cell`);
  }
});

test('the DEMO office carries all five visual states through to the world', () => {
  const state = demoState();
  const world = buildWorld({ desks: selectDesks(state), header: selectHeader(state), viewport: VIEWPORT });

  const seen = new Set(world.actors.map((actor) => actor.state));
  for (const name of ACTOR_VISUAL_STATES) assert.ok(seen.has(name), `the world keeps the ${name} state`);

  // Every actor carries a symbol and a state code, not colour alone.
  for (const actor of world.actors) {
    assert.ok(actor.symbol.length > 0, `${actor.actor_key} has a symbol`);
    assert.ok(actor.code.length > 0, `${actor.actor_key} has a state code`);
    assert.ok(actor.state_label.text.includes(actor.symbol) || actor.state_label.text.endsWith('…'));
  }
  assert.equal(world.hud.mode, 'DEMO');
  assert.equal(world.hud.desk_count, world.actors.length);
});

test('the main orchestrator is marked on the canvas as well as in the DOM', () => {
  const desks = [desk(1, 'working', { is_main_orchestrator: true }), desk(2, 'idle')];
  const world = buildWorld({ desks, header: emptyHeader(), viewport: VIEWPORT });
  assert.equal(world.actors[0]?.is_main_orchestrator, true);
  assert.equal(world.actors[1]?.is_main_orchestrator, false);
  assert.ok((world.actors[0]?.badge.width ?? 0) > 0);
});

// ------------------------------------------------ viewport, DPR, labels ---

test('the canvas buffer follows the device pixel ratio, and absurd values are clamped', () => {
  const desks = [desk(1, 'working')];
  for (const dpr of [1, 1.25, 1.5, 2, 3, 4]) {
    const world = buildWorld({ desks, header: emptyHeader(), viewport: { ...VIEWPORT, dpr } });
    assert.equal(world.viewport.dpr, dpr, `dpr ${dpr} is kept`);
    assert.equal(world.canvas.device_width, Math.round(world.canvas.width * dpr), `dpr ${dpr}: buffer width`);
    assert.equal(world.canvas.device_height, Math.round(world.canvas.height * dpr), `dpr ${dpr}: buffer height`);
  }

  for (const [given, expected] of [
    [0, 1],
    [-4, 1],
    [99, MAX_DPR],
    // A value that is not a finite number is not clamped but replaced: there is
    // nothing sensible to clamp `NaN` or `Infinity` to.
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ] as const) {
    const world = buildWorld({ desks, header: emptyHeader(), viewport: { ...VIEWPORT, dpr: given } });
    assert.equal(world.viewport.dpr, expected, `dpr ${String(given)}`);
    assert.ok(world.canvas.device_width > 0 && world.canvas.device_height > 0);
  }
});

test('resizing the viewport re-lays the office out without cropping it', () => {
  const desks = Array.from({ length: 7 }, (_, index) => desk(index + 1, 'working'));
  const widths = [320, 480, 768, 1024, 1440, 1920];
  let previousColumns = 0;

  for (const width of widths) {
    const world = buildWorld({ desks, header: emptyHeader(), viewport: { width, height: 560, dpr: 2 } });
    assert.ok(world.scale >= MIN_SCALE && world.scale <= MAX_SCALE, `${width}: scale ${world.scale}`);
    assert.ok(world.columns >= previousColumns, `${width}: a wider screen never seats fewer per row`);
    previousColumns = world.columns;

    const canvas: Rect = { x: 0, y: 0, width: world.canvas.width, height: world.canvas.height };
    assert.ok(contains(canvas, world.room), `${width}: the room is never cropped`);
    assert.ok(world.canvas.width >= world.room.width, `${width}: canvas wide enough`);
    assert.equal(world.actors.length, desks.length, `${width}: nobody is dropped when it gets narrow`);
  }

  // A viewport too small to be believed still yields a drawable world.
  const tiny = buildWorld({ desks, header: emptyHeader(), viewport: { width: 1, height: 1, dpr: 1 } });
  assert.ok(tiny.canvas.width > 0 && tiny.canvas.height > 0);
  assert.equal(tiny.actors.length, desks.length);
  assert.ok(contains({ x: 0, y: 0, width: tiny.canvas.width, height: tiny.canvas.height }, tiny.room));

  // A missing viewport falls back to a default rather than producing NaN boxes.
  const fallback = buildWorld({ desks, header: emptyHeader(), viewport: null });
  for (const value of [fallback.canvas.width, fallback.canvas.height, fallback.scale]) {
    assert.ok(Number.isFinite(value) && value > 0);
  }
  assert.deepEqual(buildWorld(null).actors, []);
});

test('a long name is truncated to its box instead of running over the desk', () => {
  const long = 'a'.repeat(200);
  const world = buildWorld({
    desks: [desk(1, 'idle', { display_name: long })],
    header: emptyHeader(),
    viewport: VIEWPORT,
  });
  const text = world.actors[0]?.name_label.text ?? '';
  assert.ok(text.length < long.length, 'the label is shortened');
  assert.ok(text.endsWith('…'), 'and says so');
  assert.equal(fitLabel(long, 68, 10), fitLabel(long, 68, 10), 'truncation is deterministic');
  assert.equal(fitLabel('short', 68, 10), 'short', 'a label that fits is left alone');
  assert.equal(fitLabel(null, 68, 10), '', 'a missing label is empty, never "null"');
});

// ------------------------------------------------- backing-store bounds ---

/** Everything a browser has to allocate, asserted in one place. */
function assertBufferBounded(world: World, label: string): void {
  const { device_width: width, device_height: height, dpr } = world.canvas;
  for (const [name, value] of [
    ['device_width', width],
    ['device_height', height],
    ['dpr', dpr],
    ['width', world.canvas.width],
    ['height', world.canvas.height],
  ] as const) {
    assert.ok(Number.isFinite(value), `${label}: ${name} is finite`);
    assert.ok(value > 0, `${label}: ${name} is positive, never a zero dimension`);
  }
  assert.ok(Number.isInteger(width) && Number.isInteger(height), `${label}: the buffer is whole pixels`);
  assert.ok(width <= MAX_DEVICE_SIDE, `${label}: device_width ${width}`);
  assert.ok(height <= MAX_DEVICE_SIDE, `${label}: device_height ${height}`);
  assert.ok(width * height <= MAX_DEVICE_PIXELS, `${label}: area ${width * height}`);
  assert.ok(dpr <= world.viewport.dpr, `${label}: the buffer never asks for more than the screen offers`);
  assert.ok(dpr >= MIN_DEVICE_SCALE, `${label}: the buffer never collapses`);
}

test('the backing store stays inside its ceilings at every actor count, DPR and viewport', () => {
  // `max_actors` is 4096, and the counts either side of the drawn ceiling are
  // the ones where the cap either does or does not engage.
  const counts = [0, 1, 40, MAX_ROWS * MAX_COLUMNS - 1, MAX_ROWS * MAX_COLUMNS, MAX_ROWS * MAX_COLUMNS + 1, 4096];
  const viewports = [
    { width: 240, height: 240 },
    { width: 320, height: 480 },
    { width: 960, height: 560 },
    { width: 1920, height: 1080 },
    { width: 8192, height: 8192 },
  ];

  for (const count of counts) {
    const desks = Array.from({ length: count }, (_, index) => desk(index + 1, 'working'));
    for (const size of viewports) {
      for (const dpr of [1, 1.5, 2, 3, 4]) {
        const world = buildWorld({ desks, header: emptyHeader(), viewport: { ...size, dpr } });
        assertBufferBounded(world, `${count} desks at ${size.width}x${size.height}@${dpr}`);
        assert.ok(world.rows <= MAX_ROWS, `${count}: rows ${world.rows}`);
        assert.ok(world.actors.length <= MAX_ROWS * MAX_COLUMNS, `${count}: drawn ${world.actors.length}`);
      }
    }
  }
});

test('the office the collector accepts at its ceiling is drawn as a bounded buffer', () => {
  // The exact case the review reproduced: before the cap this was a
  // 3840x125904 buffer, 483,471,360 device pixels, ~1.9 GB of RGBA.
  const desks = Array.from({ length: 4096 }, (_, index) => desk(index + 1, 'working'));
  const world = buildWorld({ desks, header: emptyHeader(), viewport: { width: 960, height: 560, dpr: MAX_DPR } });

  assertBufferBounded(world, '4096 desks at 960x560@4');
  assert.ok(world.canvas.device_height < 8192, `device_height ${world.canvas.device_height}`);
  assert.ok(
    world.canvas.device_width * world.canvas.device_height < 16_000_000,
    `area ${world.canvas.device_width * world.canvas.device_height}`,
  );
  // The floor is painted tile by tile, so its loop is bounded by the same cap.
  assert.ok(world.floor.rows * world.floor.cols < 20_000, 'the floor is not a hundred thousand tiles');
});

test('the requested device pixel ratio is honoured until a ceiling actually bites', () => {
  // An ordinary office: nothing is lowered, so the canvas is as crisp as the
  // screen. `Math.round(css * dpr)` is exactly what the buffer comes out as.
  for (const dpr of [1, 1.25, 1.5, 2, 3, 4]) {
    assert.equal(deviceScaleFor(960, 544, dpr), dpr, `960x544@${dpr} fits`);
  }
  // A canvas whose area alone is over the ceiling is scaled down, not truncated.
  const wide = deviceScaleFor(8192, 4700, 4);
  assert.ok(wide > MIN_DEVICE_SCALE && wide < 1, `expected a lowered ratio, got ${wide}`);
  assert.ok(8192 * wide <= MAX_DEVICE_SIDE && 4700 * wide <= MAX_DEVICE_SIDE);
  assert.ok(8192 * wide * 4700 * wide <= MAX_DEVICE_PIXELS);
  // Deterministic: the same box always gets the same ratio.
  assert.equal(deviceScaleFor(8192, 4700, 4), wide);
});

test('seats the canvas does not draw are counted out loud, not quietly dropped', () => {
  const total = MAX_ROWS * MAX_COLUMNS + 25;
  const desks = Array.from({ length: total }, (_, index) => desk(index + 1, 'idle'));
  const world = buildWorld({ desks, header: emptyHeader(), viewport: VIEWPORT });

  assert.equal(world.overflow.total, total, 'the world knows how many there are');
  assert.equal(world.overflow.drawn, world.actors.length);
  assert.equal(world.overflow.drawn + world.overflow.hidden, world.overflow.total, 'nothing is unaccounted for');
  assert.ok(world.overflow.hidden > 0);

  // The header count is the whole office, so the canvas never understates it.
  assert.equal(world.hud.desk_count, total);
  assert.equal(world.hud.drawn_count, world.overflow.drawn);
  assert.equal(world.hud.hidden_count, world.overflow.hidden);

  // The notice is integers this module counted plus its own literals: no name,
  // no key and no wire string travels with it.
  assert.ok(world.overflow_label.text.includes(String(world.overflow.hidden)));
  assert.ok(world.overflow_label.text.includes(String(total)));
  assert.ok(world.overflow_label.y <= world.canvas.height, 'and it lands on the canvas');
  assert.ok(world.overflow_label.y > world.caption_box.y, 'below the caption, never on top of it');

  // Seats that fit produce no notice at all.
  const small = buildWorld({ desks: desks.slice(0, 4), header: emptyHeader(), viewport: VIEWPORT });
  assert.deepEqual(small.overflow, { total: 4, drawn: 4, hidden: 0 });
  assert.equal(small.overflow_label.text, '');
  assert.equal(small.caption.includes('描画'), false);
});

test('capping what is drawn never reorders or rewrites the seats that are', () => {
  const desks = Array.from({ length: 300 }, (_, index) => desk(index + 1, 'working'));
  const world = buildWorld({ desks, header: emptyHeader(), viewport: VIEWPORT });

  // The drawn seats are the projection's own leading run, in its own order -
  // no reshuffling, no sampling, no substitute actor for the ones left out.
  assert.deepEqual(
    world.actors.map((actor) => actor.actor_key),
    desks.slice(0, world.actors.length).map((entry) => entry.actor_key),
  );
  for (const actor of world.actors) {
    const projected = desks.find((entry) => entry.actor_key === actor.actor_key);
    assert.ok(projected !== undefined);
    assert.equal(actor.seat, projected.seat, 'seat numbers come from the projection');
  }
  // Every drawn desk still sits inside the room it was laid out in.
  for (const actor of world.actors) assert.ok(contains(world.room, actor.cell), `seat ${actor.seat} fits`);
});

test('a fail-closed office that overflows still reports both facts', () => {
  let state = liveState([makeEvent({ event_type: 'agent_start', agent_id: 'worker-1', status: 'active' })]);
  state = setConnectionPhase(state, 'open', 1_000);
  state = applyFrame(state, {
    kind: 'fail_closed',
    payload: { namespace: 'live', halted: true, reason: 'state_limit', detail: 'actors:4096' },
    at_ms: 2_000,
  });
  const header = selectHeader(state);
  const desks = Array.from({ length: 4096 }, (_, index) => desk(index + 1, 'idle'));

  const world = buildWorld({ desks, header, viewport: { width: 960, height: 560, dpr: MAX_DPR } });
  assert.equal(world.hud.halted, true, 'the halt is still signalled');
  assert.ok(world.caption.includes('取り込み停止'));
  assert.equal(world.hud.desk_count, 4096, 'and the office is not emptied by the cap');
  assert.ok(world.overflow.hidden > 0);
  assertBufferBounded(world, 'fail-closed 4096 desks');
  // The halt detail is still a boundary fact, not a picture.
  assert.equal(JSON.stringify(world).includes('actors:4096'), false);
});

// ------------------------------------------------------ safety boundary ---

test('only closed-vocabulary header facts reach the canvas', () => {
  // A gap reason is free-form: the DOM banner renders it as text, the canvas
  // must not repeat it at all.
  let state = setConnectionPhase(createClientState('live'), 'open', 1_000);
  state = applyFrame(state, { kind: 'stream_gap', payload: { reason: '<img src=x onerror=1>' }, at_ms: 2_000 });

  const world = buildWorld({ desks: selectDesks(state), header: selectHeader(state), viewport: VIEWPORT });
  const serialized = JSON.stringify(world);

  assert.equal(world.hud.gapped, true, 'the gap is still signalled');
  assert.equal(serialized.includes('<img'), false, 'the reason string is not carried');
  assert.equal(serialized.includes('onerror'), false);
  assert.equal(Object.keys(world.hud).includes('gap_reason'), false);
  assert.ok(world.caption.includes('LIVE'));
});

test('the canvas repeats no raw status label and invents no field', () => {
  const state = liveState([
    makeEvent({
      event_type: 'tool_use',
      agent_id: 'worker-1',
      status: 'running_freeform_marker',
      tool_name: 'grep',
    }),
  ]);
  const desks = selectDesks(state);
  assert.equal(desks[0]?.status_label, 'running_freeform_marker', 'the projection still carries it for the DOM');
  assert.equal(desks[0]?.last_tool, 'grep');

  const world = buildWorld({ desks, header: selectHeader(state), viewport: VIEWPORT });
  const serialized = JSON.stringify(world);

  // The name is shown, because that is what a desk is for. The raw status
  // label and the tool name stay in the DOM layer that already renders them.
  assert.ok(serialized.includes('worker-1'));
  assert.equal(serialized.includes('freeform_marker'), false, 'no raw status label on the canvas');
  assert.equal(serialized.includes('grep'), false, 'no tool name on the canvas');

  const actorFields = new Set([
    'seat', 'actor_key', 'session_id', 'state', 'symbol', 'code', 'is_main_orchestrator', 'appearance',
    'cell', 'chair', 'head', 'body', 'arm_left', 'arm_right', 'desk', 'desk_front', 'monitor', 'badge',
    'marker', 'name_label', 'state_label',
  ]);
  for (const actor of world.actors) {
    for (const key of Object.keys(actor)) assert.ok(actorFields.has(key), `unexpected world actor field ${key}`);
  }
});

test('an unresolved role is never guessed at, on the canvas either', () => {
  const state = liveState([makeEvent({ event_type: 'agent_start', agent_id: 'worker-1', status: 'active' })]);
  const desks = selectDesks(state);
  assert.equal(desks[0]?.role, null);

  const world = buildWorld({ desks, header: selectHeader(state), viewport: VIEWPORT });
  // Nothing role-shaped is synthesised: the world carries no role field at all.
  assert.equal(JSON.stringify(world).includes('"role"'), false);
  assert.equal(world.actors.length, 1, 'and no extra colleague is imagined');
});

test('a world is built from the projections only: no player and no extra actor', () => {
  const state = demoState();
  const desks = selectDesks(state);
  const world = buildWorld({ desks, header: selectHeader(state), viewport: VIEWPORT });

  assert.equal(world.actors.length, desks.length);
  assert.deepEqual(
    world.actors.map((actor) => actor.actor_key),
    desks.map((entry) => entry.actor_key),
  );
});

test('a prototype-shaped actor key is just a key here too', () => {
  const world = buildWorld({
    desks: [desk(1, 'idle', { actor_key: '__proto__', display_name: 'constructor' })],
    header: emptyHeader(),
    viewport: VIEWPORT,
  });
  assert.equal(world.actors[0]?.actor_key, '__proto__');
  // Rendered as an ordinary name (possibly shortened to its box), not resolved
  // through a prototype and not treated as anything special.
  assert.ok(world.actors[0]?.name_label.text.startsWith('construct'));
  assert.deepEqual(appearanceFor('__proto__'), appearanceFor('__proto__'));
});

test('a fail-closed office keeps its desks and says it is frozen', () => {
  let state = liveState([makeEvent({ event_type: 'agent_start', agent_id: 'worker-1', status: 'active' })]);
  state = setConnectionPhase(state, 'open', 1_000);
  state = applyFrame(state, {
    kind: 'fail_closed',
    payload: { namespace: 'live', halted: true, reason: 'state_limit', detail: 'actors:1' },
    at_ms: 2_000,
  });

  const world: World = buildWorld({ desks: selectDesks(state), header: selectHeader(state), viewport: VIEWPORT });
  assert.equal(world.hud.halted, true);
  assert.equal(world.hud.connection_code, 'FAIL_CLOSED');
  assert.equal(world.actors.length, 1, 'fail closed freezes the office, it does not empty it');
  assert.equal(world.empty, false);
  assert.ok(world.caption.includes('取り込み停止'));
  // The detail string that came with the halt is a boundary fact, not a picture.
  assert.equal(JSON.stringify(world).includes('actors:1'), false);
});
