/**
 * The internal render-plan projection (Issue #48, Slice 1).
 *
 * `buildScene` turns a finished `World` into sprite / pose / depth / overlay
 * data. Every case here is data in / data out: no DOM, no canvas, no clock,
 * nothing that can flake.
 *
 * What these tests hold in place - the Slice 1 acceptance criteria:
 * - the same world fixture always produces the same plan;
 * - the plan reads the business meaning and never re-derives it, so a visual
 *   change cannot move an actor, a state or a zone;
 * - a new department needs no renderer change: nothing in the plan is
 *   department-specific;
 * - unknown / disconnected / fail-closed is never drawn as an office at work;
 * - a seat nobody answers to gets no character at all;
 * - what the world could not draw stays reported, worst state included;
 * - human attention is never colour-only - the code and the symbol are on the
 *   node as text;
 * - the module stays pure: no DOM, network, clock, randomness, renderer API or
 *   runtime dependency.
 */

import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { DEMO_ORG } from '../src/demo/orgFixture.ts';
import { seedDemoStore } from '../src/demo/fixtures.ts';
import type { SanitizedEvent } from '../src/domain/event.ts';
import type { QuestState } from '../src/domain/reducer.ts';
import { makeEvent } from './helpers.ts';

import type { ClientState } from '../src/ui/public/quest-view.js';
import {
  ACTOR_VISUAL_STATES,
  applyHalt,
  applySnapshot,
  createClientState,
  selectDesks,
  selectHeader,
  selectOffice,
  selectPlayer,
  setConnectionPhase,
} from '../src/ui/public/quest-view.js';
import type { World } from '../src/ui/public/quest-world.js';
import { ATTENTION_ORDER, buildWorld } from '../src/ui/public/quest-world.js';
import type { Scene, SceneNode } from '../src/ui/public/quest-scene.js';
import {
  MAIN_BADGE_TEXT,
  OVERLAY_KINDS,
  POSE_BY_STATE,
  SCENE_LAYERS,
  SCENE_NODE_KINDS,
  SCENE_POSES,
  VACANT_STATE,
  buildScene,
  poseForState,
} from '../src/ui/public/quest-scene.js';

// ------------------------------------------------------------- fixtures ---

const VIEWPORT = { width: 960, height: 560, dpr: 1 };

const RUNTIME: Record<string, string> = {
  'orch-1': 'orchestrator',
  'impl-1': 'implementer',
  'ver-1': 'verifier',
  'rev-1': 'reviewer',
};

/**
 * A grouped office: the demo organisation, with the named agents seated in it.
 *
 * Every agent starts for real and is then told what it is doing, which is the
 * order the stream actually reports - so the state under test is one the event
 * contract can produce rather than one the fixture asserted into place.
 *
 * `status` is either one status for everybody or one per agent, because a real
 * office is rarely all in the same state - and the mixed case is where the plan
 * has to decide what the office as a whole is doing.
 */
function grouped(
  agents: readonly string[],
  status: string | Readonly<Record<string, string>> | null = null,
): ClientState {
  const store = new NamespaceStore({ namespace: 'live' });
  const statusFor = (agent: string): string | null =>
    status === null ? null : typeof status === 'string' ? status : (status[agent] ?? null);
  agents.forEach((agent, index) => {
    const base: Partial<SanitizedEvent> = {
      agent_id: agent,
      runtime_agent_type: RUNTIME[agent] ?? null,
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
    };
    store.ingestObject(makeEvent({ ...base, event_type: 'agent_start', status: 'active' }));
    const declared = statusFor(agent);
    if (declared !== null) {
      store.ingestObject(
        makeEvent({
          ...base,
          event_type: 'agent_status',
          status: declared,
          ts: new Date(Date.UTC(2026, 0, 1, 0, 1, 0, index)).toISOString(),
        }),
      );
    }
  });
  const state = JSON.parse(JSON.stringify(store.state)) as QuestState;
  return applySnapshot(createClientState('live'), {
    namespace: 'live',
    halted: false,
    halt_reason: null,
    last_ingest_seq: store.stats.last_ingest_seq,
    state: { ...state, org: DEMO_ORG },
  });
}

/** The ungrouped office the screen had before an organisation could group it. */
function ungrouped(): ClientState {
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

function world(state: ClientState, viewport = VIEWPORT): World {
  const office = selectOffice(state);
  return buildWorld({
    desks: office.grouped ? office.desks : selectDesks(state),
    zones: office.grouped ? office.zones : [],
    player: selectPlayer(state),
    header: selectHeader(state),
    viewport,
  });
}

function nodesOfKind(scene: Scene, kind: string): SceneNode[] {
  return scene.nodes.filter((node) => node.kind === kind);
}

// ---------------------------------------------------------- determinism ---

test('the same world always produces the same plan', () => {
  const built = world(grouped(['orch-1', 'impl-1', 'ver-1']));
  const first = buildScene(built);
  const second = buildScene(built);
  assert.deepEqual(first, second);

  // And two worlds built separately from the same fixture agree too, so the
  // plan depends on its input and on nothing that lives between two calls.
  const again = world(grouped(['orch-1', 'impl-1', 'ver-1']));
  assert.deepEqual(buildScene(again), first);
});

test('projecting a world leaves the world untouched', () => {
  const built = world(grouped(['orch-1', 'impl-1']));
  const before = JSON.stringify(built);
  buildScene(built);
  assert.equal(JSON.stringify(built), before, 'buildScene is read-only');
});

test('depth is the paint order, and every id is unique', () => {
  const scene = buildScene(world(grouped(['orch-1', 'impl-1', 'ver-1', 'rev-1'])));
  assert.ok(scene.nodes.length > 0, 'the plan has nodes');
  scene.nodes.forEach((node, index) => {
    assert.equal(node.depth, index, `node ${node.id} carries its own position`);
  });

  const ids = new Set(scene.nodes.map((node) => node.id));
  assert.equal(ids.size, scene.nodes.length, 'no two nodes share an id');

  // Layers are a total order back to front, so a renderer can walk the list once.
  const ranks = scene.nodes.map((node) => SCENE_LAYERS.indexOf(node.layer));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'layers never go backwards');
  assert.equal(ranks.includes(-1), false, 'every layer is in the closed list');
});

test('within one layer the nearer thing is painted last', () => {
  const scene = buildScene(world(grouped(['orch-1', 'impl-1', 'ver-1', 'rev-1'])));
  const stage = scene.nodes.filter((node) => node.layer === 'stage');
  assert.ok(stage.length > 1, 'the stage holds more than one thing');
  for (let index = 1; index < stage.length; index += 1) {
    const previous = stage[index - 1]!;
    const current = stage[index]!;
    assert.ok(
      previous.anchor.y < current.anchor.y ||
        (previous.anchor.y === current.anchor.y && previous.anchor.x <= current.anchor.x),
      `${previous.id} is painted before ${current.id}`,
    );
  }
});

test('the closed vocabularies are the only thing the plan emits', () => {
  const scene = buildScene(world(grouped(['orch-1', 'impl-1', 'ver-1'])));
  for (const node of scene.nodes) {
    assert.ok(SCENE_NODE_KINDS.includes(node.kind), `${node.kind} is a known kind`);
    if (node.sprite !== null && node.sprite.pose !== null) {
      assert.ok(SCENE_POSES.includes(node.sprite.pose), `${node.sprite.pose} is a known pose`);
    }
    for (const item of node.overlays) {
      assert.ok(OVERLAY_KINDS.includes(item.kind), `${item.kind} is a known overlay`);
      assert.equal(item.priority, OVERLAY_KINDS.indexOf(item.kind), 'priority is the rank');
    }
  }
});

// ------------------------------------------------------ business meaning ---

test('every drawn seat in the world is exactly one node, with the same state', () => {
  const built = world(grouped(['orch-1', 'impl-1', 'ver-1', 'rev-1']));
  const scene = buildScene(built);
  const characters = [...nodesOfKind(scene, 'actor'), ...nodesOfKind(scene, 'seat')];
  assert.equal(characters.length, built.actors.length, 'no seat is dropped or duplicated');

  built.actors.forEach((actor, index) => {
    const node = scene.nodes.find((candidate) => candidate.id.endsWith(`:${index}:${actor.actor_key}`));
    assert.ok(node !== undefined, `${actor.actor_key} is on the stage`);
    assert.equal(node.state, actor.state, 'the state is carried, never re-derived');
    assert.equal(node.key, actor.actor_key, 'the identity is carried');
    assert.deepEqual(node.rect, actor.cell, 'the geometry is the world`s own');
  });
});

test('the pose vocabulary covers every actor state the screen can show', () => {
  for (const state of ACTOR_VISUAL_STATES) {
    const pose = POSE_BY_STATE[state];
    assert.ok(pose !== undefined, `${state} has a pose`);
    assert.ok(SCENE_POSES.includes(pose), `${state} maps into the vocabulary`);
  }
  assert.equal(POSE_BY_STATE.unknown, 'unknown', 'unknown is its own pose');
  // Only `working` is an at-work pose, and only the state the stream reported
  // as working may reach it.
  const working = ACTOR_VISUAL_STATES.filter((state) => POSE_BY_STATE[state] === 'desk_work');
  assert.deepEqual(working, ['working']);
});

test('an unrecognised state falls back to unknown, never to work', () => {
  assert.equal(poseForState('something-nobody-declared'), 'unknown');
  assert.equal(poseForState(''), 'unknown');
  assert.equal(poseForState(VACANT_STATE), 'unknown');
});

test('walk and meeting are declared but nothing today can emit them', () => {
  // Neither is observable from the event contract, so a colleague may not be
  // drawn walking or in a meeting on the strength of a guess.
  assert.ok(SCENE_POSES.includes('walk') && SCENE_POSES.includes('meeting'));
  const poses = new Set(
    Object.keys(POSE_BY_STATE).map((state) => POSE_BY_STATE[state as keyof typeof POSE_BY_STATE]),
  );
  assert.equal(poses.has('walk'), false, 'no state walks');
  assert.equal(poses.has('meeting'), false, 'no state is in a meeting');
});

// ------------------------------------------------- fail-closed semantics ---

test('a disconnected office is never drawn at work', () => {
  const live = setConnectionPhase(grouped(['orch-1', 'impl-1', 'ver-1']), 'open');
  const working = buildScene(world(live));
  assert.ok(
    nodesOfKind(working, 'actor').some((node) => node.sprite?.pose === 'desk_work'),
    'the connected office does show work',
  );

  // `error` and `reconnecting` are the phases that mean "the stream we had is
  // gone"; `offline` is the phase a fresh, empty client is born in.
  const offline = setConnectionPhase(live, 'error');
  const scene = buildScene(world(offline));
  const actors = nodesOfKind(scene, 'actor');
  assert.ok(actors.length > 0, 'the seats are still drawn');
  for (const node of actors) {
    assert.notEqual(node.sprite?.pose, 'desk_work', `${node.key} is not drawn working`);
    assert.equal(node.sprite?.pose, 'unknown', `${node.key} is drawn as unobserved`);
    assert.ok(
      node.overlays.some((item) => item.kind === 'unknown'),
      `${node.key} says so on the node`,
    );
  }
});

test('a fail-closed office is never drawn at work', () => {
  const halted = applyHalt(grouped(['orch-1', 'impl-1']), {
    namespace: 'live',
    halted: true,
    reason: 'state_limit',
    detail: 'ingestion stopped',
  });
  const scene = buildScene(world(halted));
  assert.equal(scene.hud?.halted, true, 'the plan still reports the halt');
  for (const node of nodesOfKind(scene, 'actor')) {
    assert.notEqual(node.sprite?.pose, 'desk_work', `${node.key} is not drawn working`);
  }
});

test('a seat nobody answers to gets furniture and no character', () => {
  // A full roster and an empty stream: every seat is vacant.
  const scene = buildScene(world(grouped([])));
  const seats = nodesOfKind(scene, 'seat');
  assert.ok(seats.length > 0, 'the roster still lays out its seats');
  assert.equal(nodesOfKind(scene, 'actor').length, 0, 'and puts nobody in them');
  for (const seat of seats) {
    assert.equal(seat.state, VACANT_STATE);
    assert.equal(seat.sprite?.id, 'seat.empty', 'no character sprite is requested');
    assert.equal(seat.sprite?.pose, null, 'and no pose is claimed');
    assert.equal(
      seat.overlays.some((item) => item.kind === 'attention' || item.kind === 'alert'),
      false,
      'an empty seat asks for no human attention',
    );
  }
});

// --------------------------------------------------------- attention ---

test('state is on every character as text, never colour alone', () => {
  const scene = buildScene(world(grouped(['orch-1', 'impl-1', 'ver-1'])));
  const characters = [...nodesOfKind(scene, 'actor'), ...nodesOfKind(scene, 'seat')];
  assert.ok(characters.length > 0);
  for (const node of characters) {
    const state = node.overlays.find((item) => item.kind === 'state');
    assert.ok(state !== undefined, `${node.key} carries a state overlay`);
    assert.notEqual(state.code, '', 'with the code the screen prints');
    assert.notEqual(state.symbol, '', 'and the symbol beside it');
    assert.notEqual(state.text, '', 'as a label a reader can read');
  }
  // Nothing in the plan is a colour on its own: appearance is the only colour
  // channel and it belongs to an identity, not to a state.
  for (const node of scene.nodes) {
    for (const item of node.overlays) {
      assert.equal('color' in item, false, `${node.id} states meaning as text`);
    }
  }
});

test('an approval and a failure are different overlays, and unknown is a third', () => {
  const approval = buildScene(world(grouped(['orch-1'], 'awaiting_approval')));
  const waiting = nodesOfKind(approval, 'actor');
  assert.ok(waiting.length > 0);
  assert.ok(
    waiting.every((node) => node.overlays.some((item) => item.kind === 'attention')),
    'an approval asks for a human',
  );
  assert.ok(
    waiting.every((node) => node.sprite?.pose === 'waiting'),
    'and is drawn waiting, not working',
  );

  const failed = buildScene(world(grouped(['orch-1'], 'error')));
  const broken = nodesOfKind(failed, 'actor');
  assert.ok(broken.length > 0);
  assert.ok(
    broken.every((node) => node.overlays.some((item) => item.kind === 'alert')),
    'a failure is an alert',
  );
  assert.ok(
    broken.every((node) => node.overlays.some((item) => item.kind === 'attention') === false),
    'and is not filed as an approval',
  );

  // The three are ranked, worst first, and never collapse into one another.
  assert.ok(OVERLAY_KINDS.indexOf('alert') < OVERLAY_KINDS.indexOf('attention'));
  assert.ok(OVERLAY_KINDS.indexOf('attention') < OVERLAY_KINDS.indexOf('unknown'));
});

test('the worst state the world hid is still reported by the plan', () => {
  // More colleagues than the canvas draws, with the last of them failing.
  const store = new NamespaceStore({ namespace: 'live' });
  const total = 200;
  for (let index = 0; index < total; index += 1) {
    store.ingestObject(
      makeEvent({
        event_type: 'agent_start',
        agent_id: `agent-${String(index).padStart(3, '0')}`,
        status: index === total - 1 ? 'error' : 'active',
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      }),
    );
  }
  const state = applySnapshot(createClientState('live'), {
    namespace: 'live',
    halted: false,
    halt_reason: null,
    last_ingest_seq: store.stats.last_ingest_seq,
    state: JSON.parse(JSON.stringify(store.state)) as QuestState,
  });

  const built = world(state);
  assert.ok(built.overflow.hidden > 0, 'the world did leave seats out');
  assert.notEqual(built.overflow.hidden_state, null, 'and knows the worst of them');

  const scene = buildScene(built);
  assert.deepEqual(scene.attention.hidden, built.overflow.hidden_state, 'carried through unchanged');
  assert.deepEqual(scene.overflow, built.overflow, 'and so is the arithmetic');
  assert.equal(
    scene.nodes.some((node) => node.kind === 'caption' && node.id === 'overflow'),
    true,
    'the overflow line is part of the plan',
  );
});

test('a room that could not draw a failing seat carries that on the room', () => {
  const built = world(grouped(['orch-1', 'impl-1'], 'error'), { width: 960, height: 240, dpr: 1 });
  const withHidden = built.zones.filter((zone) => zone.hidden_state !== null);
  const scene = buildScene(built);
  for (const zone of withHidden) {
    const node = scene.nodes.find((candidate) => candidate.kind === 'zone' && candidate.key === zone.id);
    assert.ok(node !== undefined, `${zone.id} is in the plan`);
    const hidden = node.overlays.find((item) => item.kind === 'hidden');
    assert.ok(hidden !== undefined, `${zone.id} says what it could not draw`);
    assert.equal(hidden.code, zone.hidden_state!.code);
    assert.equal(hidden.symbol, zone.hidden_state!.symbol);
  }
});

test('the attention ranking is the world`s own, not a second one', () => {
  const scene = buildScene(world(grouped(['orch-1', 'impl-1'], 'error')));
  for (const node of nodesOfKind(scene, 'actor')) {
    assert.equal(node.attention_rank, ATTENTION_ORDER.indexOf(node.state as string));
  }
  const worst = scene.attention.worst;
  assert.notEqual(worst, null, 'a failing office reports its worst state');
  assert.equal(worst!.state, 'error');
});

/** The office where one colleague is at work and one is not being observed. */
function mixedOffice(): Scene {
  return buildScene(
    world(grouped(['orch-1', 'impl-1'], { 'orch-1': 'working', 'impl-1': 'frobnicating' })),
  );
}

test('one unobserved colleague keeps the stage summary off `working`', () => {
  const scene = mixedOffice();
  const actors = nodesOfKind(scene, 'actor');
  const working = actors.filter((node) => node.state === 'working');
  const unobserved = actors.filter((node) => node.state === 'unknown');
  assert.ok(working.length > 0, 'somebody really is at work');
  assert.ok(unobserved.length > 0, 'and somebody really is unobserved');

  // The node itself already tells the truth twice over: the pose it is drawn in
  // and an overlay that says so in the screen`s own words.
  for (const node of unobserved) {
    assert.equal(node.sprite?.pose, 'unknown');
    assert.ok(node.overlays.some((item) => item.kind === 'unknown'));
  }

  // And the stage-wide summary may not round that away. A renderer that turns
  // `attention.worst` into one office-wide cue would otherwise advertise
  // progress while a desk on the same stage is explicitly unobserved.
  const worst = scene.attention.worst;
  assert.notEqual(worst, null, 'the stage does report a worst state');
  assert.equal(worst!.state, 'unknown', 'the unobserved desk wins over the working one');
  assert.notEqual(worst!.state, 'working');
  assert.equal(POSE_BY_STATE[worst!.state as keyof typeof POSE_BY_STATE], 'unknown');

  // Carried from the desk, not invented here: the code and symbol are the ones
  // `quest-view.js` already prints as text.
  const source = unobserved[0]!.parts as { code: string; symbol: string };
  assert.equal(worst!.code, source.code);
  assert.equal(worst!.symbol, source.symbol);

  assert.deepEqual(mixedOffice(), scene, 'and the guard is deterministic');
});

test('being unobserved never hides a failure or an approval behind it', () => {
  // The opposite mistake to the one above: reporting 状態不明 over a failure
  // would let a broken desk sit behind a calmer-looking summary.
  const failing = buildScene(
    world(
      grouped(['orch-1', 'impl-1', 'ver-1'], {
        'orch-1': 'working',
        'impl-1': 'frobnicating',
        'ver-1': 'error',
      }),
    ),
  );
  assert.equal(failing.attention.worst?.state, 'error');

  const asking = buildScene(
    world(
      grouped(['orch-1', 'impl-1', 'ver-1'], {
        'orch-1': 'working',
        'impl-1': 'frobnicating',
        'ver-1': 'approval',
      }),
    ),
  );
  assert.equal(asking.attention.worst?.state, 'awaiting_approval');

  // With nobody unobserved the summary is exactly the world`s ranking again, so
  // the guard cost the ordinary case nothing.
  const observed = buildScene(
    world(grouped(['orch-1', 'impl-1'], { 'orch-1': 'working', 'impl-1': 'idle' })),
  );
  assert.equal(observed.attention.worst?.state, 'working');
});

test('a stage whose desks are all unobserved says so, and says nothing else', () => {
  // Every desk `unknown` - the disconnected office - must not fall back to the
  // last ranked state it happened to see.
  const scene = buildScene(world(setConnectionPhase(grouped(['orch-1', 'impl-1']), 'error')));
  assert.equal(scene.attention.worst?.state, 'unknown');
  for (const node of nodesOfKind(scene, 'actor')) {
    assert.notEqual(node.sprite?.pose, 'desk_work');
  }
});

// ------------------------------------------------------- layout policy ---

test('a new department needs no change to the plan builder', () => {
  const base = grouped(['orch-1', 'impl-1']);
  const scene = buildScene(world(base));
  const zones = nodesOfKind(scene, 'zone');
  assert.ok(zones.length > 0, 'the floor plan has rooms');

  // Every room is projected the same way: an id, a rect and a name. Nothing in
  // the plan names a department, so one more of them is one more node.
  const office = selectOffice(base);
  const known = new Set(office.zones.map((zone) => zone.id));
  for (const node of zones) {
    assert.ok(known.has(node.key), `${node.key} came from the projection`);
    assert.ok(node.sprite?.id === 'zone.room' || node.sprite?.id === 'zone.facility');
  }

  const source = readFileSync(new URL('../src/ui/public/quest-scene.js', import.meta.url), 'utf8');
  for (const zone of office.zones) {
    assert.equal(source.includes(zone.name), false, `${zone.name} is not written into the module`);
    assert.equal(source.includes(zone.id), false, `${zone.id} is not written into the module`);
  }
});

test('the ungrouped office projects through the same code path', () => {
  const scene = buildScene(world(ungrouped()));
  assert.equal(scene.grouped, false);
  assert.equal(nodesOfKind(scene, 'zone').length, 0, 'one room, so no room outlines');
  assert.ok(nodesOfKind(scene, 'actor').length > 0, 'and the colleagues are still on the stage');
  assert.ok(nodesOfKind(scene, 'floor').length === 1 && nodesOfKind(scene, 'wall').length === 1);
});

test('the human player is a node of their own, with no state and no seat', () => {
  const state = applySnapshot(grouped(['orch-1']), {
    namespace: 'live',
    halted: false,
    halt_reason: null,
    last_ingest_seq: 99,
    state: { player: { kind: 'player', id: 'owner-1', display_name: 'Owner' } },
  });
  const built = world(state);
  assert.notEqual(built.player, null, 'the world placed a player');

  const scene = buildScene(built);
  const players = nodesOfKind(scene, 'player');
  assert.equal(players.length, 1);
  assert.equal(players[0]!.state, null, 'the player carries no runtime state');
  assert.equal(players[0]!.sprite?.pose, 'idle', 'and claims no work');
  assert.equal(
    nodesOfKind(scene, 'actor').some((node) => node.key === 'owner-1'),
    false,
    'and is never one of the colleagues',
  );
});

test('the main orchestrator badge is this module`s own literal', () => {
  // `main` is the one agent id the collector calls the main orchestrator.
  const scene = buildScene(world(grouped(['main', 'impl-1'])));
  const main = nodesOfKind(scene, 'actor').filter((node) =>
    node.overlays.some((item) => item.kind === 'identity' && item.code === MAIN_BADGE_TEXT),
  );
  assert.ok(main.length > 0, 'the orchestrator is badged');
});

// ------------------------------------------------------------- purity ---

test('the module is pure: no DOM, network, clock, randomness or renderer API', () => {
  const source = readFileSync(new URL('../src/ui/public/quest-scene.js', import.meta.url), 'utf8');
  const forbidden = [
    /\bdocument\b/,
    /\bwindow\b/,
    /\bnavigator\b/,
    /\blocalStorage\b/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bEventSource\b/,
    /\bDate\b/,
    /\bperformance\b/,
    /Math\.random/,
    /setTimeout|setInterval|requestAnimationFrame/,
    /\brequire\s*\(/,
    /\bgetContext\b/,
    /\bfillRect\b|\bfillText\b|\bdrawImage\b/,
    /node:/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `quest-scene.js must not use ${String(pattern)}`);
  }

  // One import, and it is the world model directly above it: no framework was
  // added for the sake of an abstraction, and no second business projection.
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['./quest-world.js']);
});

test('the plan repeats the header facts and never re-derives them', () => {
  const built = world(grouped(['orch-1', 'impl-1']));
  const scene = buildScene(built);
  assert.deepEqual(scene.hud, built.hud);
  assert.deepEqual(scene.canvas, built.canvas);
  assert.deepEqual(scene.viewport, built.viewport);
  assert.equal(scene.scale, built.scale);
});

test('an absent or malformed world is a plan with nothing in it, not a throw', () => {
  for (const input of [null, undefined, {}, { actors: null, zones: 'nope' }]) {
    const scene = buildScene(input as never);
    assert.equal(Array.isArray(scene.nodes), true);
    assert.equal(nodesOfKind(scene, 'actor').length, 0, 'nobody is invented');
    assert.equal(scene.attention.worst, null);
  }
});
