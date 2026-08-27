/**
 * `draw(World)`.
 *
 * The painter is exercised against a recording surface: a plain object with the
 * same handful of methods a 2D context exposes, which appends every call to a
 * list. That makes the drawing itself assertable - the same world must produce
 * the same calls, five states must produce five different silhouettes, and no
 * call may ever reach for an image, a font file or a network resource.
 *
 * It also means these tests need no DOM and no canvas implementation, so they
 * run in the same plain `node --test` process as everything else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { seedDemoStore } from '../src/demo/fixtures.ts';
import type { QuestState } from '../src/domain/reducer.ts';
import { UI_ASSET_PATHS, uiAsset } from '../src/ui/assets.ts';

import type { ActorDisplayState, Desk, Header } from '../src/ui/public/quest-view.js';
import {
  ACTOR_LEGEND_STATES,
  applySnapshot,
  createClientState,
  selectDesks,
  selectHeader,
  visualForState,
} from '../src/ui/public/quest-view.js';
import type { World } from '../src/ui/public/quest-world.js';
import { buildWorld, measureCanvasViewport } from '../src/ui/public/quest-world.js';
import type { DrawSurface } from '../src/ui/public/quest-canvas.js';
import { MARKER_BITMAPS, STATE_COLORS, drawWorld } from '../src/ui/public/quest-canvas.js';

// -------------------------------------------------------- recording ctx ---

type Op = { op: string; args: readonly (string | number)[]; style: string };

type Recorder = DrawSurface & { ops: Op[] };

/** A 2D-context-shaped object that records instead of painting. */
function recorder(): Recorder {
  const ops: Op[] = [];
  const surface: Recorder = {
    ops,
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: true,
    save() {
      ops.push({ op: 'save', args: [], style: surface.fillStyle });
    },
    restore() {
      ops.push({ op: 'restore', args: [], style: surface.fillStyle });
    },
    setTransform(a, b, c, d, e, f) {
      ops.push({ op: 'setTransform', args: [a, b, c, d, e, f], style: surface.fillStyle });
    },
    clearRect(x, y, width, height) {
      ops.push({ op: 'clearRect', args: [x, y, width, height], style: surface.fillStyle });
    },
    fillRect(x, y, width, height) {
      ops.push({ op: 'fillRect', args: [x, y, width, height], style: surface.fillStyle });
    },
    fillText(text, x, y) {
      ops.push({ op: 'fillText', args: [text, x, y], style: `${surface.fillStyle}|${surface.font}|${surface.textAlign}` });
    },
  };
  return surface;
}

function paint(world: World): Op[] {
  const ctx = recorder();
  drawWorld(ctx, world);
  return ctx.ops;
}

function texts(ops: readonly Op[]): string[] {
  return ops.filter((entry) => entry.op === 'fillText').map((entry) => String(entry.args[0]));
}

// ------------------------------------------------------------- fixtures ---

const VIEWPORT = { width: 960, height: 560, dpr: 2 };

function desk(seat: number, state: ActorDisplayState, overrides: Partial<Desk> = {}): Desk {
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
    selected: false,
    visual: visualForState(state),
    ...overrides,
  };
}

function emptyHeader(): Header {
  return selectHeader(createClientState('live'));
}

function demoWorld(): World {
  const store = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(store);
  const state = applySnapshot(createClientState('demo'), {
    namespace: store.namespace,
    halted: store.stats.halted,
    halt_reason: store.stats.halt_reason,
    last_ingest_seq: store.stats.last_ingest_seq,
    state: JSON.parse(JSON.stringify(store.state)) as QuestState,
  });
  return buildWorld({ desks: selectDesks(state), header: selectHeader(state), viewport: VIEWPORT });
}

// ---------------------------------------------------------- determinism ---

test('the same world always paints the same calls, in the same order', () => {
  const world = demoWorld();
  assert.deepEqual(paint(world), paint(world));
  // Rebuilding the world from the same inputs paints identically too.
  assert.deepEqual(paint(demoWorld()), paint(world));
  assert.ok(paint(world).length > 100, 'the office is actually drawn, not skipped');
});

test('drawing starts from a device-pixel transform and clears the whole buffer', () => {
  const world = buildWorld({ desks: [desk(1, 'working')], header: emptyHeader(), viewport: VIEWPORT });
  const ops = paint(world);

  assert.equal(ops[0]?.op, 'save');
  assert.deepEqual(ops[1], { op: 'setTransform', args: [2, 0, 0, 2, 0, 0], style: '' });
  assert.deepEqual(ops[2]?.args, [0, 0, world.canvas.width, world.canvas.height]);
  assert.equal(ops[2]?.op, 'clearRect');
  assert.equal(ops.at(-1)?.op, 'restore', 'the context is handed back as it was found');
});

test('the transform follows the buffer the world actually built, not the raw ratio', () => {
  // A viewport big enough that the requested ratio would overflow the ceiling:
  // the buffer is lowered, and the painter must transform by the lowered value
  // or every rectangle would land off the canvas.
  const desks = Array.from({ length: 200 }, (_, index) => desk(index + 1, 'working'));
  const world = buildWorld({ desks, header: emptyHeader(), viewport: { width: 8192, height: 8192, dpr: 4 } });
  assert.ok(world.canvas.dpr < world.viewport.dpr, 'this case really is clamped');

  const transform = paint(world)[1];
  assert.equal(transform?.op, 'setTransform');
  assert.deepEqual(transform?.args, [world.canvas.dpr, 0, 0, world.canvas.dpr, 0, 0]);
  // The whole buffer is still cleared, in the same CSS-pixel space.
  assert.ok(world.canvas.width * world.canvas.dpr <= world.canvas.device_width + 1);
});

test('the transform is the ratio the padded canvas surface is actually shown at', () => {
  // The reported case: a 960px frame with 10px of padding on each side leaves a
  // 940px surface, and the buffer has to be built for that surface. What the
  // painter transforms by then really is the browser's device pixel ratio.
  const frameWidth = 960;
  const surfaceWidth = 940;
  const desks = Array.from({ length: 5 }, (_, index) => desk(index + 1, 'working'));

  for (const dpr of [1, 2, 3, 4]) {
    const viewport = measureCanvasViewport({
      surface_width: surfaceWidth,
      frame_width: frameWidth,
      window_height: 900,
      dpr,
    });
    const world = buildWorld({ desks, header: emptyHeader(), viewport });
    const transform = paint(world)[1];

    assert.equal(transform?.op, 'setTransform');
    assert.deepEqual(transform?.args, [dpr, 0, 0, dpr, 0, 0], `dpr ${dpr}: the transform`);
    // Buffer, transform and displayed surface agree: the pixel blocks land on
    // whole device pixels instead of being rescaled by 940/960.
    assert.equal(world.canvas.device_width, surfaceWidth * dpr, `dpr ${dpr}: the buffer`);
    assert.equal(world.canvas.device_width / surfaceWidth, dpr, `dpr ${dpr}: effective ratio`);
  }
});

test('an office larger than the canvas draws says how many seats it left out', () => {
  const desks = Array.from({ length: 400 }, (_, index) => desk(index + 1, 'idle'));
  const world = buildWorld({ desks, header: emptyHeader(), viewport: VIEWPORT });
  const ops = paint(world);
  const painted = texts(ops);

  assert.ok(world.overflow.hidden > 0, 'this office really does overflow');
  assert.ok(painted.includes(world.overflow_label.text), 'the count is on the canvas');
  assert.ok(world.overflow_label.text.includes(String(world.overflow.hidden)));

  // Exactly the drawn seats are named - counted by the label positions, since
  // a name may well have been shortened to its box.
  const namePlaces = new Set(world.actors.map((actor) => `${actor.name_label.x}:${actor.name_label.y}`));
  const nameOps = ops.filter(
    (entry) => entry.op === 'fillText' && namePlaces.has(`${entry.args[1]}:${entry.args[2]}`),
  );
  assert.equal(nameOps.length, world.actors.length, 'exactly the drawn seats are named');

  // An office that fits gets no such line, rather than a "0 hidden" one.
  const small = buildWorld({ desks: desks.slice(0, 3), header: emptyHeader(), viewport: VIEWPORT });
  assert.equal(small.overflow.hidden, 0);
  assert.equal(
    texts(paint(small)).some((entry) => entry.includes('残り')),
    false,
  );
});

test('a nonsense argument is ignored rather than thrown at', () => {
  assert.doesNotThrow(() => {
    drawWorld(recorder(), null);
    drawWorld(null, demoWorld());
  });
});

// ---------------------------------------------------------- what is drawn ---

test('floor, wall, desks, characters, names and state marks are all painted', () => {
  const world = buildWorld({
    desks: [desk(1, 'working', { is_main_orchestrator: true }), desk(2, 'error')],
    header: emptyHeader(),
    viewport: VIEWPORT,
  });
  const ops = paint(world);
  const rects = ops.filter((entry) => entry.op === 'fillRect');

  const drew = (box: { x: number; y: number; width: number; height: number }): boolean =>
    rects.some((entry) => entry.args[0] === box.x && entry.args[1] === box.y);

  assert.ok(drew(world.wall), 'the back wall is drawn');
  assert.ok(drew(world.floor), 'the floor is drawn');
  for (const prop of world.props) assert.ok(drew(prop), `the ${prop.kind} is drawn`);
  for (const actor of world.actors) {
    assert.ok(drew(actor.desk), `seat ${actor.seat}: desk`);
    assert.ok(drew(actor.monitor), `seat ${actor.seat}: monitor`);
    assert.ok(drew(actor.head), `seat ${actor.seat}: head`);
    assert.ok(drew(actor.chair), `seat ${actor.seat}: chair`);
  }

  const painted = texts(ops);
  assert.ok(painted.includes('agent-1'), 'every character is named on the canvas');
  assert.ok(painted.includes('agent-2'));
  assert.ok(painted.includes('M'), 'the main orchestrator is badged');
  assert.ok(painted.some((entry) => entry.includes('WORKING')), 'the state code is painted, not just a colour');
  assert.ok(painted.some((entry) => entry.includes('ERROR')));
  assert.ok(painted.includes(world.caption));
});

test('an empty office is drawn as a room with a notice, not as a blank canvas', () => {
  const world = buildWorld({ desks: [], header: emptyHeader(), viewport: VIEWPORT });
  const ops = paint(world);

  assert.ok(ops.filter((entry) => entry.op === 'fillRect').length > 10, 'the room is still painted');
  assert.ok(texts(ops).includes(world.notice.text));
  assert.equal(
    texts(ops).some((entry) => entry.includes('IDLE')),
    false,
    'and nobody is invented to fill it',
  );
});

test('the player is painted as a standing person, apart from every colleague', () => {
  const desks = [desk(1, 'working', { is_main_orchestrator: true }), desk(2, 'idle')];
  const player = { kind: 'player' as const, id: 'player', display_name: '歩' };
  const world = buildWorld({ desks, player, header: emptyHeader(), viewport: VIEWPORT });
  const ops = paint(world);
  const rects = ops.filter((entry) => entry.op === 'fillRect');
  const at = (box: { x: number; y: number }): Op[] =>
    rects.filter((entry) => entry.args[0] === box.x && entry.args[1] === box.y);

  assert.ok(world.player !== null);
  for (const [name, box] of [
    ['head', world.player.head],
    ['body', world.player.body],
    ['left leg', world.player.leg_left],
    ['right leg', world.player.leg_right],
    ['badge', world.player.badge],
  ] as const) {
    assert.ok(at(box).length > 0, `the player's ${name} is drawn`);
  }

  const painted = texts(ops);
  assert.ok(painted.includes('歩'), 'the player is named on the canvas');
  assert.ok(painted.includes(world.player.badge_text), 'and badged as the person at the keyboard');
  assert.ok(painted.includes('agent-1'), 'the colleagues are still named too');

  // The player's badge is not the MAIN badge: two different people, two
  // different marks, in two different colours.
  const badgeStyle = at(world.player.badge)[0]?.style;
  const mainBadge = at(world.actors[0]?.badge ?? { x: -1, y: -1 })[0]?.style;
  assert.ok(badgeStyle !== undefined && mainBadge !== undefined, 'both badges were painted');
  assert.notEqual(badgeStyle, mainBadge, 'the player is not badged like the main orchestrator');

  // No state colour is used on them, because they have no runtime state.
  const shirt = at(world.player.body).map((entry) => entry.style);
  for (const color of Object.values(STATE_COLORS)) {
    assert.equal(shirt.includes(color), false, 'the player is never painted in a state colour');
  }
});

test('a world without a player paints nobody extra', () => {
  const desks = [desk(1, 'idle')];
  const without = paint(buildWorld({ desks, header: emptyHeader(), viewport: VIEWPORT }));
  assert.equal(texts(without).includes('YOU'), false, 'no badge for a player that was never named');
});

test('each visual state gets its own silhouette, not just its own colour', () => {
  const signatures = new Map<string, string>();
  const colors = new Set<string>();

  for (const state of ACTOR_LEGEND_STATES) {
    const world = buildWorld({ desks: [desk(1, state)], header: emptyHeader(), viewport: VIEWPORT });
    const actor = world.actors[0];
    assert.ok(actor !== undefined);

    // Only the blocks inside the marker box: that is the shape carrying meaning.
    const marker = paint(world).filter(
      (entry) =>
        entry.op === 'fillRect' &&
        Number(entry.args[0]) >= actor.marker.x &&
        Number(entry.args[0]) < actor.marker.x + actor.marker.width &&
        Number(entry.args[1]) >= actor.marker.y &&
        Number(entry.args[1]) < actor.marker.y + actor.marker.height,
    );
    assert.ok(marker.length > 0, `${state}: a marker is drawn`);
    // Geometry only - the colour is deliberately excluded from the signature.
    signatures.set(state, JSON.stringify(marker.map((entry) => entry.args)));
    colors.add(STATE_COLORS[state] ?? '');
  }

  assert.equal(
    new Set(signatures.values()).size,
    ACTOR_LEGEND_STATES.length,
    'one distinguishable shape per displayable state',
  );
  assert.equal(
    colors.size,
    ACTOR_LEGEND_STATES.length,
    'and one distinguishable colour per state as a second cue',
  );
  assert.equal(
    new Set(Object.values(MARKER_BITMAPS).map((rows) => rows.join('/'))).size,
    ACTOR_LEGEND_STATES.length,
  );
  // A state with no entry of its own would silently paint as `idle`, which is
  // exactly the kind of quiet wrong answer this screen must not give.
  for (const state of ACTOR_LEGEND_STATES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(MARKER_BITMAPS, state),
      `${state} has its own marker, not the idle fallback`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(STATE_COLORS, state),
      `${state} has its own colour, not the idle fallback`,
    );
  }
});

test('the same actor is painted the same way whatever its neighbours are doing', () => {
  const alone = buildWorld({ desks: [desk(1, 'working')], header: emptyHeader(), viewport: VIEWPORT });
  const crowded = buildWorld({
    desks: [desk(1, 'working'), desk(2, 'error'), desk(3, 'ended')],
    header: emptyHeader(),
    viewport: VIEWPORT,
  });

  const first = alone.actors[0];
  const same = crowded.actors[0];
  assert.ok(first !== undefined && same !== undefined);
  assert.deepEqual(first.appearance, same.appearance);

  // The colours a character is painted with come from that appearance, so the
  // styles used for its own body parts agree too - wherever the desk landed.
  const stylesOf = (world: World, key: string): string[] => {
    const actor = world.actors.find((entry) => entry.actor_key === key);
    assert.ok(actor !== undefined);
    const ops = paint(world);
    const parts = [actor.chair, actor.head, actor.body, actor.arm_left, actor.arm_right, actor.monitor, actor.desk];
    return parts.flatMap((part) =>
      ops
        .filter(
          (entry) =>
            entry.op === 'fillRect' &&
            entry.args[0] === part.x &&
            entry.args[1] === part.y &&
            entry.args[2] === part.width &&
            entry.args[3] === part.height,
        )
        .map((entry) => entry.style),
    );
  };
  const painted = stylesOf(alone, first.actor_key);
  assert.ok(painted.length >= 7, 'every body part was actually located');
  assert.deepEqual(painted, stylesOf(crowded, first.actor_key));
});

// ------------------------------------------------------ safety boundary ---

test('the painter reaches for no image, font file or external resource', () => {
  const source = uiAsset('/ui/quest-canvas.js')?.body.toString('utf8') ?? '';
  const world = uiAsset('/ui/quest-world.js')?.body.toString('utf8') ?? '';
  assert.ok(source.length > 0 && world.length > 0);

  for (const [name, text] of [
    ['quest-canvas.js', source],
    ['quest-world.js', world],
  ] as const) {
    for (const forbidden of [
      'drawImage',
      'createPattern',
      'new Image',
      'ImageBitmap',
      'FontFace',
      'toDataURL',
      'importScripts',
      'Worker(',
    ]) {
      assert.equal(text.includes(forbidden), false, `${name}: ${forbidden}`);
    }
    // Same discipline as the view model: no DOM, no clock, no randomness.
    assert.equal(
      /\bdocument\b|\bwindow\b|EventSource|setTimeout|setInterval|requestAnimationFrame|Date\.now|Math\.random/.test(text),
      false,
      `${name}: reaches outside its arguments`,
    );
    assert.equal(/innerHTML|outerHTML|\beval\(|new Function\(/.test(text), false, `${name}: dynamic code`);
    assert.equal(/console\.(log|info|warn|error|debug)/.test(text), false, `${name}: console output`);
  }

  // The canvas modules are served exactly like the rest of the screen.
  assert.ok(UI_ASSET_PATHS.includes('/ui/quest-canvas.js'));
  assert.ok(UI_ASSET_PATHS.includes('/ui/quest-world.js'));
});

test('nothing but rectangles and text is ever asked of the context', () => {
  const ctx = recorder();
  drawWorld(ctx, demoWorld());
  const allowed = new Set(['save', 'restore', 'setTransform', 'clearRect', 'fillRect', 'fillText']);
  for (const entry of ctx.ops) assert.ok(allowed.has(entry.op), `unexpected drawing call ${entry.op}`);
  assert.equal(ctx.imageSmoothingEnabled, false, 'pixel blocks stay sharp');
});

test('the app wires the canvas layer up without touching the stream', () => {
  const app = uiAsset('/ui/quest-app.js')?.body.toString('utf8') ?? '';
  assert.ok(app.includes("from './quest-world.js'"), 'the app builds the tested world');
  assert.ok(app.includes("from './quest-canvas.js'"), 'and paints with the tested painter');

  // Still exactly one stream, still the same two namespaces.
  assert.deepEqual(app.match(/new EventSource\([^)]*\)/g) ?? [], ['new EventSource(`/events/${namespace}`)']);
  assert.ok(app.includes("const NAMESPACES = ['live', 'demo']"));

  // The canvas is repainted on change and on resize - never on an animation
  // timer, so `prefers-reduced-motion` has nothing to suppress.
  assert.equal(/requestAnimationFrame|setInterval\(paintCanvas|animate/.test(app), false, 'no canvas animation loop');

  // The buffer is sized from the canvas surface itself. The frame around it is
  // padded, so measuring that is what put a 3840-pixel buffer in a 940-pixel
  // box; it survives only as the fallback for a canvas with no layout box.
  assert.ok(app.includes('surface_width: dom.canvas === null ? 0 : dom.canvas.clientWidth'), 'the surface is measured');
  assert.ok(app.includes('measureCanvasViewport('), 'through the tested, DOM-free helper');
  const css = uiAsset('/ui/quest.css')?.body.toString('utf8') ?? '';
  assert.ok(/\.office__canvas\s*\{[^}]*padding:/.test(css), 'the frame really is padded');
  assert.ok(/\.office__canvas-surface\s*\{[^}]*width:\s*100%/.test(css), 'and the surface really is its content box');

  // The canvas is the decorative layer; the DOM stays the accessible one.
  const html = uiAsset('/')?.body.toString('utf8') ?? '';
  assert.ok(html.includes('id="office-canvas"'));
  assert.ok(/<canvas[^>]*aria-hidden="true"/.test(html), 'the canvas is hidden from assistive technology');
  for (const id of ['desks', 'legend', 'log', 'banner', 'empty-state', 'stat-connection']) {
    assert.ok(html.includes(`id="${id}"`), `the DOM layer still has #${id}`);
  }
});
