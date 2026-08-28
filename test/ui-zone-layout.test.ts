/**
 * The floor plan: rooms, fixed seats, and what must not move.
 *
 * `test/ui-org.test.ts` holds the projection - who sits where. This holds the
 * geometry that projection is turned into, and the property the whole feature
 * exists for: **a seat's position comes from the organisation, not from the
 * stream.** A colleague arriving must not renumber the office, and a colleague
 * going quiet must not close their desk.
 *
 * The acceptance criteria are `docs/org-snapshot-design.md` §3.1 ①② and
 * §3.2 ①②③, plus one the owner added: resizing may change pixels but never the
 * logical arrangement.
 *
 * Nothing here touches the DOM or the clock. `buildWorld` is a pure function of
 * (projection, viewport).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { DEMO_ORG } from '../src/demo/orgFixture.ts';
import type { SanitizedEvent } from '../src/domain/event.ts';
import type { QuestState } from '../src/domain/reducer.ts';
import { makeEvent } from './helpers.ts';

import type { ClientState, OfficeDesk, OfficeZone } from '../src/ui/public/quest-view.js';
import {
  ACTOR_VISUAL_STATES,
  EXECUTIVE_ZONE_ID,
  UNASSIGNED_ZONE_ID,
  applySnapshot,
  createClientState,
  selectHeader,
  selectOffice,
  selectPlayer,
  visualForState,
} from '../src/ui/public/quest-view.js';
import { ATTENTION_ORDER, MAX_ROWS, buildWorld } from '../src/ui/public/quest-world.js';

// ------------------------------------------------------------------ setup ---

const VIEWPORT = { width: 960, height: 560, dpr: 1 };

const RUNTIME: Record<string, string> = {
  'orch-1': 'orchestrator',
  'impl-1': 'implementer',
  'ver-1': 'verifier',
  'rev-1': 'reviewer',
  'stranger-1': 'nobody-declares-this',
};

function client(agents: readonly string[], overrides: Partial<SanitizedEvent> = {}): ClientState {
  const store = new NamespaceStore({ namespace: 'live' });
  agents.forEach((agent, index) => {
    store.ingestObject(
      makeEvent({
        event_type: 'agent_start',
        agent_id: agent,
        status: 'active',
        runtime_agent_type: RUNTIME[agent] ?? null,
        // Distinct and ordered past nine actors, which a single digit is not.
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
        ...overrides,
      }),
    );
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

function world(state: ClientState, viewport = VIEWPORT) {
  const office = selectOffice(state);
  return buildWorld({
    desks: office.desks,
    zones: office.grouped ? office.zones : [],
    player: selectPlayer(state),
    header: selectHeader(state),
    viewport,
  });
}

/** Where each roster seat sits, keyed by the actor or role it belongs to. */
function seatBoxes(built: ReturnType<typeof world>): Map<string, string> {
  return new Map(built.actors.map((actor) => [actor.actor_key, JSON.stringify(actor.cell)]));
}

// ------------------------------------------------- the copied vocabulary ---

test('the attention order the canvas uses is the one the view model uses', () => {
  // `quest-world.js` imports nothing on purpose, so this list is a copy. A copy
  // that drifts would let the canvas call a state calm that the office calls
  // urgent, which is exactly the disagreement the ranking exists to prevent.
  assert.deepEqual([...ATTENTION_ORDER], [...ACTOR_VISUAL_STATES]);
});

// ------------------------------------------------------------- §3.1 ①② ---

test('the same organisation and viewport always build the same rectangles', () => {
  const state = client(['orch-1', 'impl-1', 'ver-1']);
  assert.deepEqual(world(state), world(state));
});

test('rooms never overlap and never leave the room they are in', () => {
  const state = client(['orch-1', 'impl-1', 'ver-1', 'stranger-1']);
  const built = world(state);
  assert.ok(built.zones.length > 0, 'the office is grouped');

  for (const zone of built.zones) {
    const { rect } = zone;
    assert.ok(rect.x >= built.room.x, `${zone.id} starts inside the room`);
    assert.ok(rect.x + rect.width <= built.room.x + built.room.width, `${zone.id} ends inside it`);
    assert.ok(rect.y >= built.room.y, `${zone.id} is below the top wall`);
    assert.ok(rect.y + rect.height <= built.room.y + built.room.height, `${zone.id} is above the floor edge`);
    assert.ok(rect.height > 0 && rect.width > 0, `${zone.id} has a real area`);
  }
  for (let i = 1; i < built.zones.length; i += 1) {
    const above = built.zones[i - 1]!.rect;
    const below = built.zones[i]!.rect;
    assert.ok(above.y + above.height <= below.y, 'bands are stacked, never overlapping');
  }
});

test('every drawn desk is inside the room its zone declares', () => {
  const state = client(['orch-1', 'impl-1', 'ver-1', 'rev-1', 'stranger-1']);
  const built = world(state);
  const seatZones = built.zones.filter((zone) => zone.seats);
  for (const actor of built.actors) {
    const home = seatZones.find(
      (zone) =>
        actor.cell.y >= zone.rect.y && actor.cell.y + actor.cell.height <= zone.rect.y + zone.rect.height,
    );
    assert.ok(home !== undefined, `${actor.actor_key} is inside a room that seats people`);
  }
});

// ------------------------------------------------------------ §3.2 ①②③ ---

test('an office with no actors still draws every roster seat', () => {
  const built = world(client([]));
  // Seven roles in the DEMO organisation, none of them reported by the stream.
  const seats = built.actors.length;
  assert.equal(seats, DEMO_ORG.status === 'accepted' ? DEMO_ORG.snapshot.roles.length : -1);
  for (const actor of built.actors) {
    assert.equal(actor.state, 'vacant', 'and none of them is given an activity');
  }
});

test('actors coming and going never move a roster seat', () => {
  // The property the whole feature is for. `seat` in the ungrouped office is an
  // index into a sorted list, so it moves whenever anybody joins; a roster seat
  // belongs to the organisation and may not.
  const empty = seatBoxes(world(client([])));
  const some = seatBoxes(world(client(['impl-1'])));
  const more = seatBoxes(world(client(['orch-1', 'impl-1', 'ver-1', 'rev-1'])));
  const withStranger = seatBoxes(world(client(['orch-1', 'impl-1', 'ver-1', 'rev-1', 'stranger-1'])));

  // Every roster seat that exists in the empty office keeps its exact box in
  // every busier one. Seats are keyed by role there, by actor once filled, so
  // the comparison is made on the boxes themselves.
  const boxesOf = (map: Map<string, string>) => [...map.values()].sort();
  const rosterBoxes = boxesOf(empty);
  for (const [label, busier] of [
    ['one actor', some],
    ['four actors', more],
    ['plus a stranger', withStranger],
  ] as const) {
    for (const box of rosterBoxes) {
      assert.ok(boxesOf(busier).includes(box), `${label}: the roster seat at ${box} did not move`);
    }
  }
});

test('the seat a colleague occupies is decided by the roster, not by arrival order', () => {
  const forward = seatBoxes(world(client(['orch-1', 'impl-1', 'ver-1'])));
  const reversed = seatBoxes(world(client(['ver-1', 'impl-1', 'orch-1'])));
  for (const [key, box] of forward) {
    if (key.startsWith('seat-')) continue;
    assert.equal(reversed.get(key), box, `${key} sits in the same place either way`);
  }
});

// ------------------------------------------------- resize invariance -------

test('resizing changes pixels, never the logical arrangement', () => {
  const state = client(['orch-1', 'impl-1', 'ver-1', 'stranger-1']);
  const shape = (viewport: typeof VIEWPORT) => {
    const built = world(state, viewport);
    return {
      zones: built.zones.map((zone) => ({ id: zone.id, kind: zone.kind, seats: zone.seats, drawn: zone.drawn })),
      seats: built.actors.map((actor) => actor.actor_key),
    };
  };

  const wide = shape({ width: 1400, height: 900, dpr: 1 });
  for (const viewport of [
    { width: 960, height: 560, dpr: 1 },
    { width: 640, height: 480, dpr: 2 },
    { width: 320, height: 400, dpr: 3 },
  ]) {
    assert.deepEqual(shape(viewport), wide, `${viewport.width}x${viewport.height} keeps the same office`);
  }

  // Pixels do move, or this test would be proving nothing.
  assert.notDeepEqual(world(state, { width: 320, height: 400, dpr: 1 }).room, world(state, wideViewport()).room);
});

function wideViewport() {
  return { width: 1400, height: 900, dpr: 1 };
}

// ------------------------------------- rooms that hold nobody --------------

test('the 社長室 comes from the player and holds no desk', () => {
  const built = world(client(['impl-1']));
  const executive = built.zones.find((zone) => zone.id === EXECUTIVE_ZONE_ID);
  assert.ok(executive !== undefined, 'a named player gives the office a 社長室');
  assert.equal(executive.seats, false, 'nobody is seated in it');
  assert.equal(executive.drawn, 0);

  // The player stands in it, and is still not a colleague.
  assert.ok(built.player !== null);
  assert.ok(built.player.cell.y >= executive.rect.y);
  assert.ok(built.player.cell.y + built.player.cell.height <= executive.rect.y + executive.rect.height);
  assert.equal(
    built.actors.some((actor) => actor.actor_key === built.player?.id),
    false,
    'and holds no seat',
  );
});

test('shared facilities are rooms, not colleagues', () => {
  const built = world(client(['impl-1']));
  const facilities = built.zones.filter((zone) => zone.kind === 'facility');
  assert.ok(facilities.length > 0, 'the DEMO organisation declares some');
  for (const facility of facilities) {
    assert.equal(facility.seats, false);
    assert.equal(facility.drawn, 0);
    assert.equal(facility.hidden, 0, 'a room with no seats has no hidden seat either');
  }
  // Facilities come last, after 未所属.
  const ids = built.zones.map((zone) => zone.id);
  assert.ok(ids.indexOf(UNASSIGNED_ZONE_ID) < ids.indexOf(facilities[0]!.id));
});

// --------------------------------- the Round-4 rule, applied to rooms ------

test('a room that could not draw a failing seat does not look calm', () => {
  // The lesson from the aggregated-seat review: a count alone lets a problem
  // hide behind a tidy number. A zone whose overflow contains an error reports
  // that state alongside the count, so the outline can carry it.
  const many = Array.from({ length: MAX_ROWS * 8 }, (_unused, index) => `bulk-${index}`);
  const state = client(many);
  const office = selectOffice(state);

  // Force an overflow inside one zone by putting every actor in it.
  const failing = visualForState('error');
  const zones: OfficeZone[] = office.zones.map((zone) =>
    zone.id === UNASSIGNED_ZONE_ID
      ? {
          ...zone,
          desks: (office.desks as OfficeDesk[]).map((desk, index) => ({
            ...desk,
            // The last one is failing, and it is the one that will not fit.
            visual: index === office.desks.length - 1 ? failing : desk.visual,
          })),
        }
      : zone,
  );
  const built = buildWorld({
    desks: office.desks,
    zones,
    player: selectPlayer(state),
    header: selectHeader(state),
    viewport: { width: 480, height: 400, dpr: 1 },
  });

  const crowded = built.zones.find((zone) => zone.id === UNASSIGNED_ZONE_ID);
  assert.ok((crowded?.hidden ?? 0) > 0, 'the room really did run out of space');
  assert.equal(crowded?.hidden_state, 'error', 'and says the worst thing it could not draw');
  assert.equal(built.overflow.hidden_state, 'error', 'the office says so too');
  assert.equal(built.overflow.drawn + built.overflow.hidden, built.overflow.total, 'nothing unaccounted for');
});

test('an ungrouped office is the single room it has always been', () => {
  const state = client(['impl-1', 'stranger-1']);
  const plain: ClientState = { ...state, org: { status: 'absent' } };
  const built = world(plain);
  assert.equal(built.grouped, false);
  assert.deepEqual(built.zones, []);
  assert.deepEqual(built.overflow.zones, { total: 0, drawn: 0, hidden: 0 });
  assert.equal(built.overflow.total, 2, 'and it draws the actors, not a roster');
});
