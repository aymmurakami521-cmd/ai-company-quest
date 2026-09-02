/**
 * The render plan: what a painter is told to draw, and what it may never infer.
 *
 * `buildScene` is a pure function of one finished `World`, so every case here is
 * data in / data out: no DOM, no canvas, no clock, nothing that can flake.
 *
 * What these tests hold in place (Issue #48 Slice 1 acceptance list):
 * - the same world always produces the same scene, field for field;
 * - sprite, pose, layer and overlay names come from closed vocabularies;
 * - `unknown`, a dropped connection and a fail-closed collector never become a
 *   pose that claims somebody is working;
 * - a state's `code` and `symbol` reach the painter with it, so attention can
 *   never be expressed by colour alone;
 * - a seat the picture left out keeps its worst state, exactly as the world
 *   model reported it;
 * - the actors, zones and states in a scene are the world's, unchanged: this
 *   layer adds no colleague, renames no room and decides no business meaning;
 * - a new department needs data, not renderer code;
 * - no colour, asset or theme token is invented here, so swapping either cannot
 *   move the business projection.
 */

import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { DEMO_ORG } from '../src/demo/orgFixture.ts';
import { seedDemoStore } from '../src/demo/fixtures.ts';
import type { QuestState } from '../src/domain/reducer.ts';
import { makeEvent } from './helpers.ts';

import type { ActorDisplayState, ClientState, Desk } from '../src/ui/public/quest-view.js';
import {
  ACTOR_LEGEND_STATES,
  applySnapshot,
  createClientState,
  selectDesks,
  selectHeader,
  selectOffice,
  selectPlayer,
  setConnectionPhase,
  visualForState,
} from '../src/ui/public/quest-view.js';
import type { World } from '../src/ui/public/quest-world.js';
import { MAX_ROWS, buildWorld } from '../src/ui/public/quest-world.js';
import type {
  Scene,
  SceneActorSprite,
  SceneOverlay,
  SceneSpriteEntry,
  SceneZoneSprite,
} from '../src/ui/public/quest-scene.js';
import {
  POSE_BY_STATE,
  SCENE_LAYERS,
  SCENE_OVERLAYS,
  SCENE_POSES,
  SCENE_SPRITES,
  STALE_CONNECTION_CODES,
  WORK_POSES,
  buildScene,
  depthFor,
  emptyScene,
  poseFor,
} from '../src/ui/public/quest-scene.js';

// ------------------------------------------------------------- fixtures ---

const VIEWPORT = { width: 960, height: 560, dpr: 1 };

const RUNTIME: Record<string, string> = {
  'orch-1': 'orchestrator',
  'impl-1': 'implementer',
  'ver-1': 'verifier',
};

/** A synthetic desk, so one visual state at a time can be exercised. */
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
    stale: false,
    last_known_visual: visualForState(state),
    ...overrides,
  };
}

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

/** An office grouped by the demo organisation, with the named agents at work. */
function orgState(agents: readonly string[], halted = false): ClientState {
  const store = new NamespaceStore({ namespace: 'live' });
  agents.forEach((agent, index) => {
    store.ingestObject(
      makeEvent({
        event_type: 'agent_start',
        agent_id: agent,
        status: 'active',
        runtime_agent_type: RUNTIME[agent] ?? null,
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      }),
    );
  });
  const state = JSON.parse(JSON.stringify(store.state)) as QuestState;
  return applySnapshot(createClientState('live'), {
    namespace: 'live',
    halted,
    halt_reason: halted ? 'ingest_error' : null,
    last_ingest_seq: store.stats.last_ingest_seq,
    state: { ...state, org: DEMO_ORG },
  });
}

/**
 * The same state, with the stream open.
 *
 * A freshly created client is offline, and an offline screen deliberately shows
 * nobody as working - so a fixture that wants to exercise a work pose has to say
 * that the stream is actually connected.
 */
function connected(state: ClientState): ClientState {
  return setConnectionPhase(state, 'open', 0);
}

function groupedWorld(state: ClientState, viewport = VIEWPORT): World {
  const office = selectOffice(state);
  return buildWorld({
    desks: office.desks,
    zones: office.grouped ? office.zones : [],
    player: selectPlayer(state),
    header: selectHeader(state),
    viewport,
  });
}

function flatWorld(desks: readonly Desk[], state: ClientState = connected(createClientState('live'))): World {
  return buildWorld({ desks, header: selectHeader(state), viewport: VIEWPORT });
}

function people(scene: Scene): SceneActorSprite[] {
  return scene.sprites.filter(
    (sprite): sprite is SceneActorSprite => sprite.sprite === 'worker' || sprite.sprite === 'vacant_seat',
  );
}

function zoneBands(scene: Scene): SceneZoneSprite[] {
  return scene.sprites.filter((sprite): sprite is SceneZoneSprite => sprite.sprite === 'zone_band');
}

function spriteById(scene: Scene, id: string): SceneSpriteEntry | undefined {
  return scene.sprites.find((sprite) => sprite.id === id);
}

function overlayById(scene: Scene, id: string): SceneOverlay | undefined {
  return scene.overlays.find((overlay) => overlay.id === id);
}

// --------------------------------------------------------- determinism ---

test('the same world always produces the same scene', () => {
  const state = demoState();
  const built = groupedWorld(state);

  assert.deepEqual(buildScene(built), buildScene(built));
  // A second, independently derived world of the same state agrees too, so the
  // scene depends on the world's values and on nothing it was called next to.
  assert.deepEqual(buildScene(groupedWorld(state)), buildScene(built));
});

test('building a scene does not touch the world it was given', () => {
  const built = groupedWorld(orgState(['impl-1', 'orch-1']));
  const before = JSON.parse(JSON.stringify(built)) as World;
  buildScene(built);
  assert.deepEqual(built, before, 'the world model is read, never written');
});

test('a world with nothing in it still produces a usable scene', () => {
  const scene = emptyScene();
  assert.equal(scene.sprites.filter((sprite) => sprite.sprite === 'worker').length, 0);
  assert.equal(scene.evidence_fresh, false, 'no stream is not a fresh stream');
  assert.equal(scene.attention.worst, null, 'and nothing is claimed about anybody');
});

// --------------------------------------------------- closed vocabularies ---

test('every sprite, layer, pose and overlay comes from a closed vocabulary', () => {
  const scenes = [
    buildScene(groupedWorld(orgState(['impl-1', 'orch-1', 'ver-1']))),
    buildScene(groupedWorld(orgState([]))),
    buildScene(flatWorld(ACTOR_LEGEND_STATES.map((state, index) => desk(index + 1, state)))),
    buildScene(groupedWorld(demoState())),
  ];

  for (const scene of scenes) {
    for (const sprite of scene.sprites) {
      assert.ok(SCENE_SPRITES.includes(sprite.sprite), `sprite key ${sprite.sprite} is in the vocabulary`);
      assert.ok(SCENE_LAYERS.includes(sprite.layer), `layer ${sprite.layer} is in the vocabulary`);
    }
    for (const person of people(scene)) {
      assert.ok(SCENE_POSES.includes(person.pose), `pose ${person.pose} is in the vocabulary`);
    }
    for (const overlay of scene.overlays) {
      assert.ok(SCENE_OVERLAYS.includes(overlay.kind), `overlay ${overlay.kind} is in the vocabulary`);
      assert.equal(overlay.layer, 'overlay');
    }
  }
});

test('every displayable state has a pose, and an unrecognised one falls to unknown', () => {
  for (const state of ACTOR_LEGEND_STATES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(POSE_BY_STATE, state),
      `${state} has a row in the pose table`,
    );
    assert.ok(SCENE_POSES.includes(poseFor(state)), `${state} maps into the vocabulary`);
  }
  // The absence of any event is not an actor state, and never a person's pose.
  assert.equal(poseFor('vacant'), 'unknown');
  // A label this screen does not understand is a thing it does not understand.
  assert.equal(poseFor('some-new-runtime-state'), 'unknown');
  assert.equal(poseFor(null), 'unknown');
  assert.equal(poseFor(undefined), 'unknown');
});

test('walk and meeting stay unreachable while nothing observes them', () => {
  // Both are in the vocabulary so a future observation has somewhere to land,
  // and in no row of the table so today nothing can animate work nobody saw.
  assert.ok(SCENE_POSES.includes('walk') && SCENE_POSES.includes('meeting'));
  const reachable = new Set(Object.values(POSE_BY_STATE));
  assert.equal(reachable.has('walk'), false, 'nothing today says a colleague crossed the room');
  assert.equal(reachable.has('meeting'), false, 'nothing today says two of them sat down together');
});

// ------------------------------------------------------- never fake work ---

test('unknown is never drawn as a working pose', () => {
  const scene = buildScene(flatWorld([desk(1, 'unknown'), desk(2, 'working')]));
  const unknown = people(scene).find((person) => person.state === 'unknown');
  assert.ok(unknown, 'the unknown seat is in the scene');
  assert.equal(unknown.pose, 'unknown');
  assert.equal(WORK_POSES.includes(unknown.pose as never), false);

  const working = people(scene).find((person) => person.state === 'working');
  assert.ok(working, 'and a seat the stream did confirm still works');
  assert.equal(working.pose, 'desk_work');
});

test('a fail-closed collector withholds the work pose but not the last known state', () => {
  const live = buildScene(flatWorld([desk(1, 'working')], connected(orgState(['impl-1']))));
  const liveWorker = people(live).find((person) => person.state === 'working');
  assert.ok(liveWorker);
  assert.equal(liveWorker.pose, 'desk_work', 'a heard-from stream animates the work it reported');

  // The same desks the connected screen just animated, under a collector that
  // has stopped: nothing about the colleagues changed, only what may be claimed.
  const halted = flatWorld([desk(1, 'working'), desk(2, 'planning')], connected(orgState([], true)));
  const scene = buildScene(halted);
  assert.equal(scene.hud.halted, true);
  assert.equal(scene.evidence_fresh, false);
  for (const person of people(scene)) {
    assert.equal(
      WORK_POSES.includes(person.pose as never),
      false,
      'nobody is animated as working while ingestion is stopped',
    );
  }

  // The claim is withheld, never rewritten: what was last heard is still on the
  // screen as a state, a code and a symbol.
  const withheld = people(scene).find((person) => person.pose_withheld);
  assert.ok(withheld, 'at least one seat had a work pose to withhold');
  assert.equal(withheld.state, 'working');
  assert.ok(withheld.code.length > 0 && withheld.symbol.length > 0);
  const label = overlayById(scene, `state:${withheld.actor_key}`);
  assert.ok(label && label.text.length > 0, 'and it is written out, not only posed');
});

test('a dropped connection withholds the work pose the same way', () => {
  const disconnected = setConnectionPhase(orgState(['impl-1']), 'error');
  const scene = buildScene(groupedWorld(disconnected));
  assert.ok(
    STALE_CONNECTION_CODES.includes(scene.hud.connection_code),
    `${scene.hud.connection_code} counts as no fresh evidence`,
  );
  assert.equal(scene.evidence_fresh, false);
  for (const person of people(scene)) {
    assert.equal(WORK_POSES.includes(person.pose as never), false);
  }
});

test('a roster seat nobody answered to is not a person', () => {
  const scene = buildScene(groupedWorld(orgState([])));
  const seats = people(scene);
  assert.ok(seats.length > 0, 'the roster still lays the office out');
  for (const seat of seats) {
    assert.equal(seat.sprite, 'vacant_seat', 'and none of them is drawn as a colleague');
    assert.equal(seat.occupied, false);
    assert.equal(seat.pose, 'unknown');
  }
  assert.equal(scene.hud.desk_count, 0, 'nobody is counted as present');
});

// ------------------------------------------------- attention is not colour ---

test('every state that reaches an overlay reaches it with its code and symbol', () => {
  const scene = buildScene(flatWorld(ACTOR_LEGEND_STATES.map((state, index) => desk(index + 1, state))));
  const stateful = scene.overlays.filter((overlay) => overlay.state !== undefined);
  assert.ok(stateful.length > 0, 'states do reach the overlay list');
  for (const overlay of stateful) {
    assert.ok(overlay.code !== undefined && overlay.code.length > 0, `${overlay.id} carries a code`);
    assert.ok(overlay.symbol !== undefined && overlay.symbol.length > 0, `${overlay.id} carries a symbol`);
    assert.ok(overlay.text.length > 0, `${overlay.id} is written, not only coloured`);
  }
});

test('a seat the picture left out keeps its worst state', () => {
  // More seats than the canvas can ever draw, with the only error at the end so
  // it is certain to be one of the ones left out.
  const crowd = [
    ...Array.from({ length: MAX_ROWS * 6 + 8 }, (_, index) => desk(index + 1, 'idle')),
    desk(MAX_ROWS * 6 + 9, 'error'),
  ];
  const built = flatWorld(crowd);
  assert.ok(built.overflow.hidden > 0, 'the world model did leave seats out');
  assert.ok(built.overflow.hidden_state, 'and reported what was worst among them');

  const scene = buildScene(built);
  assert.deepEqual(
    scene.attention.hidden_state,
    built.overflow.hidden_state,
    'the scene forwards it unchanged',
  );
  assert.equal(scene.attention.hidden, built.overflow.hidden);
  assert.ok(scene.attention.worst, 'and the scene knows the loudest state in the office');
  assert.equal(scene.attention.worst.state, 'error');
  assert.equal(
    scene.attention.worst.source,
    'hidden',
    'a calm-looking room with the error off screen still says so',
  );
  const label = overlayById(scene, 'overflow');
  assert.ok(label && label.text.length > 0, 'and it is written on the screen too');
});

test('the loudest state that is on screen is reported as being on screen', () => {
  const scene = buildScene(flatWorld([desk(1, 'idle'), desk(2, 'error'), desk(3, 'working')]));
  assert.equal(scene.attention.hidden, 0);
  assert.ok(scene.attention.worst);
  assert.equal(scene.attention.worst.state, 'error');
  assert.equal(scene.attention.worst.source, 'drawn');
});

// -------------------------------------------------------------- ordering ---

test('depth puts the chair behind a colleague and the desk in front of them', () => {
  const scene = buildScene(flatWorld([desk(1, 'working')]));
  const key = 'sess-1::agent-1';
  const chair = spriteById(scene, `chair:${key}`);
  const worker = spriteById(scene, `actor:${key}`);
  const monitor = spriteById(scene, `monitor:${key}`);
  const table = spriteById(scene, `desk:${key}`);
  assert.ok(chair && worker && monitor && table);
  assert.ok(chair.depth < worker.depth, 'the chair is behind the person on it');
  assert.ok(worker.depth < monitor.depth, 'the monitor stands in front of them');
  assert.ok(monitor.depth < table.depth, 'and the desk top is nearest the viewer');
});

test('sprites arrive in paint order, and a layer never reaches into the next', () => {
  const scene = buildScene(groupedWorld(orgState(['impl-1', 'orch-1', 'ver-1'])));
  const depths = scene.sprites.map((sprite) => sprite.depth);
  assert.deepEqual(depths, [...depths].sort((a, b) => a - b), 'the list is already sorted');
  assert.deepEqual(
    scene.overlays.map((overlay) => overlay.depth),
    [...scene.overlays.map((overlay) => overlay.depth)].sort((a, b) => a - b),
  );

  // Whatever the geometry, layer order wins: the deepest thing in one layer is
  // still behind the shallowest thing in the next.
  for (let index = 1; index < SCENE_LAYERS.length; index += 1) {
    const lower = SCENE_LAYERS[index - 1];
    const upper = SCENE_LAYERS[index];
    if (lower === undefined || upper === undefined) continue;
    const deepest = scene.sprites.filter((sprite) => sprite.layer === lower).map((sprite) => sprite.depth);
    const shallowest = scene.sprites.filter((sprite) => sprite.layer === upper).map((sprite) => sprite.depth);
    if (deepest.length === 0 || shallowest.length === 0) continue;
    assert.ok(Math.max(...deepest) < Math.min(...shallowest), `${lower} is entirely behind ${upper}`);
  }
});

test('depth is bounded, so no row can ever spill into the layer above it', () => {
  const floorBottom = depthFor('backdrop', 1e9, 7);
  const zoneTop = depthFor('zone', 0, 0);
  assert.ok(floorBottom < zoneTop, 'even an absurd coordinate stays inside its layer');
});

// ------------------------------------------- the world keeps its meaning ---

test('the scene has exactly the world model’s colleagues, states and rooms', () => {
  const built = groupedWorld(orgState(['impl-1', 'orch-1']));
  const scene = buildScene(built);

  assert.deepEqual(
    people(scene).map((person) => person.actor_key),
    built.actors.map((actor) => actor.actor_key),
    'no colleague is added, dropped or reordered',
  );
  assert.deepEqual(
    people(scene).map((person) => [person.state, person.code, person.symbol]),
    built.actors.map((actor) => [actor.state, actor.code, actor.symbol]),
    'and none of their states is reinterpreted',
  );
  assert.deepEqual(
    zoneBands(scene).map((zone) => [zone.zone_id, zone.zone_kind]),
    built.zones.map((zone) => [zone.id, zone.kind]),
    'the rooms keep the organisation’s own ids and kinds',
  );
  assert.deepEqual(scene.hud, built.hud, 'and the header facts are repeated, not recomputed');
});

test('the player is a sprite, never a colleague, and carries no state', () => {
  const scene = buildScene(groupedWorld(orgState(['impl-1'])));
  const player = spriteById(scene, 'player');
  assert.ok(player && player.sprite === 'player');
  assert.equal(player.state, null, 'the human owner has no runtime state to report');
  assert.equal(
    people(scene).some((person) => person.id === 'player'),
    false,
    'and is not counted among the colleagues',
  );
  assert.ok(overlayById(scene, 'player-badge'), 'they are labelled instead of inferred');
});

test('a room the organisation added needs data, not renderer code', () => {
  const small = buildScene(groupedWorld(orgState(['impl-1'])));
  const wide = buildScene(groupedWorld(orgState(['impl-1', 'orch-1', 'ver-1'])));

  assert.equal(zoneBands(small).length, groupedWorld(orgState(['impl-1'])).zones.length);
  assert.ok(zoneBands(small).length > 1, 'the demo organisation has several rooms');
  for (const zone of [...zoneBands(small), ...zoneBands(wide)]) {
    // Every band is described by the zone it came from. Nothing here is keyed on
    // a department name, so a new one is a new row and not a new branch.
    assert.equal(typeof zone.zone_id, 'string');
    assert.equal(typeof zone.zone_kind, 'string');
  }
});

test('a room that could not draw a failing seat says so in words', () => {
  const built = groupedWorld(orgState(['impl-1']), { width: 320, height: 200, dpr: 1 });
  const scene = buildScene(built);
  for (const zone of built.zones) {
    const band = scene.sprites.find(
      (sprite): sprite is SceneZoneSprite => sprite.sprite === 'zone_band' && sprite.zone_id === zone.id,
    );
    assert.ok(band, `${zone.id} is in the scene`);
    assert.deepEqual(band.hidden_state, zone.hidden_state, 'with the same hidden state the world reported');
    if (zone.hidden_state !== null) {
      const notice = overlayById(scene, `zone-hidden:${zone.id}`);
      assert.ok(notice, 'and a written notice, not only an outline colour');
      assert.ok(notice.text.includes(zone.hidden_state.code));
    }
  }
});

// ------------------------------------------------ theme and asset boundary ---

test('no colour, asset path or theme token is invented in the render plan', () => {
  const scene = buildScene(groupedWorld(demoState()));
  const offenders: string[] = [];
  const walk = (value: unknown, path: string): void => {
    // The appearance is the world model's own resolved palette, derived from the
    // actor key. It is copied through, so it is the one place colours may be.
    if (path.endsWith('.appearance')) return;
    if (typeof value === 'string') {
      if (/^#[0-9a-f]{3,8}$/i.test(value) || /\.(png|jpg|jpeg|svg|webp|gif)$/i.test(value)) {
        offenders.push(`${path} = ${value}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    }
  };
  walk(scene, 'scene');
  assert.deepEqual(offenders, [], 'a theme or asset swap cannot need a change in this layer');
});

// ---------------------------------------------------------------- purity ---

test('the projection reaches for nothing outside the world it was given', () => {
  const source = readFileSync(new URL('../src/ui/public/quest-scene.js', import.meta.url), 'utf8');
  // Prose is allowed to name the things the code may not use, so the scan is of
  // the code alone.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const forbidden: readonly [string, RegExp][] = [
    ['the DOM', /\b(document|window|navigator|localStorage|sessionStorage|HTMLElement)\b/],
    ['a global', /\bglobalThis\b/],
    ['the network', /\b(fetch|XMLHttpRequest|EventSource|WebSocket)\b/],
    ['the filesystem', /\bnode:|require\(/],
    ['the clock', /\b(Date|performance|setTimeout|setInterval|requestAnimationFrame)\b/],
    ['a random source', /Math\.random/],
    [
      'a renderer API',
      /\b(getContext|fillRect|fillText|clearRect|setTransform|drawImage|createImageBitmap|CanvasRenderingContext2D)\b/,
    ],
  ];
  for (const [what, pattern] of forbidden) {
    assert.equal(pattern.test(code), false, `the render plan never touches ${what}`);
  }

  // One import, and it is the world model whose attention order this layer must
  // not restate. A second import is how a presentation seam quietly becomes a
  // second business projection.
  const imports = code.match(/^\s*import[\s\S]*?from\s+'([^']+)'/gm) ?? [];
  assert.equal(imports.length, 1, 'exactly one import');
  assert.match(imports.join('\n'), /'\.\/quest-world\.js'/);
});

test('the render plan is not wired into the live screen yet', () => {
  // Slice 1 is a seam, not a redesign: the painter and the glue are untouched,
  // so the canvas keeps behaving exactly as it does on `main` and this file can
  // be deleted without a migration.
  const canvas = readFileSync(new URL('../src/ui/public/quest-canvas.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/ui/public/quest-app.js', import.meta.url), 'utf8');
  assert.equal(/quest-scene/.test(canvas), false, 'the painter does not read it');
  assert.equal(/quest-scene/.test(app), false, 'and neither does the glue');
});
