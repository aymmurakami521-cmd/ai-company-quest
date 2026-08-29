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
import { readFileSync } from 'node:fs';
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
import {
  ATTENTION_ORDER,
  GROUPED_HEIGHT_RATIO,
  MAX_DEVICE_PIXELS,
  MAX_DEVICE_SIDE,
  MAX_ROWS,
  MAX_ZONES,
  MIN_SCALE,
  buildWorld,
} from '../src/ui/public/quest-world.js';

// ------------------------------------------------------------------ setup ---

const VIEWPORT = { width: 960, height: 560, dpr: 1 };

const RUNTIME: Record<string, string> = {
  'orch-1': 'orchestrator',
  'impl-1': 'implementer',
  'ver-1': 'verifier',
  'rev-1': 'reviewer',
  'stranger-1': 'nobody-declares-this',
  'stranger-2': 'nor-this-one',
  // A second actor answering to the same roster seat as `impl-1`.
  'impl-2': 'implementer',
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

/**
 * Each seat's *place* in the office: which room, and where in that room.
 *
 * The distinction matters. Pixels legitimately move - a taller office is drawn
 * at a smaller scale, so every coordinate shrinks with it. What may never move
 * is the arrangement: the room a seat is in, and its row and column inside that
 * room. That is the property `docs/org-snapshot-design.md` §3.2 ③ is about, and
 * it is what an operator actually navigates by.
 */
function logicalSeats(built: ReturnType<typeof world>): Map<string, string> {
  const rooms = built.zones.filter((zone) => zone.seats);
  const counts = new Map<string, number>();
  const places = new Map<string, string>();
  for (const actor of built.actors) {
    const room = rooms.find(
      (zone) => actor.cell.y >= zone.rect.y && actor.cell.y + actor.cell.height <= zone.rect.y + zone.rect.height,
    );
    const id = room?.id ?? 'nowhere';
    const seen = counts.get(id) ?? 0;
    counts.set(id, seen + 1);
    places.set(actor.actor_key, `${id}#${Math.floor(seen / built.columns)},${seen % built.columns}`);
  }
  return places;
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
  //
  // "May not move" is about the arrangement, not the pixels: a busier office is
  // taller and is therefore drawn smaller, so coordinates shrink together. What
  // has to hold is that the seat is in the same room, in the same row and
  // column, whoever else is on screen.
  const crowd = Array.from({ length: 40 }, (_unused, index) => `bulk-${index}`);
  const empty = logicalSeats(world(client([])));

  for (const [label, agents] of [
    ['one actor', ['impl-1']],
    ['four actors', ['orch-1', 'impl-1', 'ver-1', 'rev-1']],
    ['plus a stranger', ['orch-1', 'impl-1', 'ver-1', 'rev-1', 'stranger-1']],
    // The case the first version of this test missed: the column count was
    // taken from the widest *zone*, so colleagues the roster does not know
    // widened 未所属 and re-flowed every band on the floor.
    ['swamped by strangers', ['orch-1', 'impl-1', ...crowd]],
  ] as const) {
    const busier = logicalSeats(world(client(agents)));
    const places = new Set(busier.values());
    for (const place of empty.values()) {
      assert.ok(places.has(place), `${label}: the roster seat at ${place} is still there`);
    }
  }

  // The column count is the thing every seat position is derived from, so it is
  // asserted directly rather than only through its consequences.
  const columnsOf = (agents: readonly string[]) => world(client(agents)).columns;
  const base = columnsOf([]);
  for (const agents of [['impl-1'], ['orch-1', 'impl-1', 'ver-1', 'rev-1'], ['orch-1', ...crowd]]) {
    assert.equal(columnsOf(agents), base, 'the grid width is a fact about the organisation');
  }

  // Pixels are allowed to move, and do - otherwise the distinction above would
  // be untested.
  assert.notDeepEqual(
    [...seatBoxes(world(client(['orch-1', ...crowd]))).values()].sort(),
    [...seatBoxes(world(client([]))).values()].sort(),
  );
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
      // `columns` is what the first version of this test left out, and it is
      // what decides the row and column every seat lands on: reading only the
      // ids let a viewport-derived grid width pass as "the same arrangement".
      columns: built.columns,
      rows: built.rows,
      zones: built.zones.map((zone) => ({
        id: zone.id,
        kind: zone.kind,
        seats: zone.seats,
        drawn: zone.drawn,
        hidden: zone.hidden,
      })),
      seats: built.actors.map((actor) => actor.actor_key),
      // Where each seat sits *within its own band*, which is the logical
      // position pixels are allowed to scale but not to rearrange.
      grid: built.actors.map((actor, index) => `${index % built.columns}/${Math.floor(index / built.columns)}`),
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
  // The state travels with its code and symbol, because the reader has to be
  // told *what* was hidden and the label prints from a closed vocabulary.
  assert.deepEqual(
    crowded?.hidden_state,
    { state: 'error', code: 'ERROR', symbol: '✖' },
    'and says the worst thing it could not draw',
  );
  assert.deepEqual(built.overflow.hidden_state, crowded?.hidden_state, 'the office says so too');
  // And it is on the canvas, not only in the model.
  assert.ok(built.overflow_label.text.includes('ERROR'), 'the notice names the hidden state');
  assert.ok(built.overflow_label.text.includes('✖'));
  assert.equal(built.overflow.drawn + built.overflow.hidden, built.overflow.total, 'nothing unaccounted for');
});

test('a room the canvas cannot draw is still counted, seats and all', () => {
  // Truncating the zone list used to drop its seats from every total, so an
  // organisation with more rooms than the canvas draws reported fewer seats
  // than it had - and a failure inside one of those rooms vanished with it.
  const state = client(['impl-1']);
  const office = selectOffice(state);
  const failing = visualForState('error');
  const extra: OfficeZone[] = Array.from({ length: MAX_ZONES + 4 }, (_unused, index) => ({
    id: `dept:filler-${index}`,
    name: `部署${index}`,
    kind: 'department' as const,
    seats: true,
    desks: [
      {
        ...(office.desks as OfficeDesk[])[0]!,
        actor_key: null,
        role_id: `filler-${index}`,
        occupants: [],
        occupied: false,
        visual: failing,
        last_known_visual: failing,
      },
    ],
  }));
  const built = buildWorld({
    desks: office.desks,
    zones: [...office.zones, ...extra],
    player: selectPlayer(state),
    header: selectHeader(state),
    viewport: VIEWPORT,
  });

  assert.ok(built.overflow.zones.hidden > 0, 'some rooms really did not fit');
  assert.equal(
    built.overflow.zones.drawn + built.overflow.zones.hidden,
    built.overflow.zones.total,
    'and the rooms are all accounted for',
  );
  assert.equal(built.overflow.drawn + built.overflow.hidden, built.overflow.total, 'so are their seats');
  assert.deepEqual(
    built.overflow.hidden_state,
    { state: 'error', code: 'ERROR', symbol: '✖' },
    'a failure inside an undrawn room is still reported',
  );
  assert.ok(built.overflow_label.text.includes('区画'), 'and the notice says rooms were left out');
});

test('rooms left out are announced even when they held no seats', () => {
  // The overflow notice used to appear only when *desks* were hidden, so an
  // organisation whose extra rooms were all empty lost them without a word -
  // the same silent truncation, one level up.
  const state = client(['impl-1']);
  const office = selectOffice(state);
  const empties: OfficeZone[] = Array.from({ length: MAX_ZONES + 4 }, (_unused, index) => ({
    id: `facility:filler-${index}`,
    name: `施設${index}`,
    kind: 'facility' as const,
    seats: false,
    desks: [],
  }));
  const built = buildWorld({
    desks: office.desks,
    zones: [...office.zones, ...empties],
    player: selectPlayer(state),
    header: selectHeader(state),
    viewport: VIEWPORT,
  });

  assert.ok(built.overflow.zones.hidden > 0, 'rooms really were left out');
  assert.equal(built.overflow.hidden, 0, 'and no seat was, which is the case that used to be silent');
  assert.notEqual(built.overflow_label.text, '', 'the notice still appears');
  assert.ok(built.overflow_label.text.includes('区画'), 'and says rooms were left out');
});

test('the canvas asks for a colour by state name, not by the whole record', () => {
  // `hidden_state` became `{state, code, symbol}` when the notice had to name
  // what was hidden. Passing the record to `stateColor` silently falls back to
  // the idle colour, so a room holding an error is outlined as calm - the very
  // thing the outline exists to prevent.
  const canvas = readFileSync(new URL('../src/ui/public/quest-canvas.js', import.meta.url), 'utf8');
  assert.match(canvas, /stateColor\(zone\.hidden_state\.state\)/, 'the room outline reads .state');
  assert.match(canvas, /stateColor\(world\.overflow\.hidden_state\.state\)/, 'so does the notice');
  assert.equal(
    /stateColor\((?:zone|world\.overflow)\.hidden_state\)/.test(canvas),
    false,
    'and neither passes the record',
  );
});

test('在席 counts colleagues, never roster seats nobody answered to', () => {
  // A full roster with an empty stream: the DOM says nobody is at their desk,
  // and the canvas caption has to agree with it.
  const built = world(client([]));
  assert.ok(built.actors.length > 0, 'the seats are drawn');
  assert.equal(built.hud.desk_count, 0, 'and none of them is counted as present');

  const busy = world(client(['impl-1', 'stranger-1']));
  assert.equal(busy.hud.desk_count, 2, 'only the actors count');
  assert.ok(busy.overflow.total > 2, 'while the layout still accounts for every seat');
});

test('an aggregated seat counts everyone behind it, not the desk it is', () => {
  // A desk is not a person. Two actors of the same runtime type share one roster
  // seat, so counting occupied *desks* put 「在席 1」 on the canvas while the DOM
  // header, which counts actors, said 2 - the two halves of one screen
  // disagreeing about how many colleagues the company has.
  const twins = ['impl-1', 'impl-2'];
  const state = client(twins);
  const office = selectOffice(state);
  const built = world(state);

  // One seat, two people.
  const seat = office.zones
    .flatMap((zone) => zone.desks)
    .find((desk) => desk.role_id === 'role-implementer');
  assert.equal(seat?.occupants.length, 2, 'both actors answer to the one seat');
  assert.equal(
    office.zones.flatMap((zone) => zone.desks).filter((desk) => desk.role_id === 'role-implementer').length,
    1,
    'and the roster seat stays a single seat',
  );

  // The two counts of the same fact agree.
  assert.equal(selectHeader(state).desk_count, 2, 'the DOM header counts actors');
  assert.equal(built.hud.desk_count, 2, 'and the canvas says the same number');
});

test('presence counts nobody for an empty roster and one each for strangers', () => {
  // The two ends of the same rule, so the fix above cannot be a special case.
  assert.equal(world(client([])).hud.desk_count, 0, 'a full roster nobody answered to is nobody');
  assert.equal(
    world(client(['stranger-1', 'stranger-2'])).hud.desk_count,
    2,
    'colleagues the roster does not know still count once each',
  );
});

test('the player in the 社長室 does not also get a strip below the office', () => {
  // The unit-space budget stopped adding the strip once the player moved into a
  // band; the pixel-space calculation did not, so the room was drawn taller than
  // the height it had been scaled to fit.
  const built = world(client(['impl-1']));
  assert.ok(built.player !== null);

  const bands = built.zones.reduce((sum, zone) => sum + zone.rect.height, 0);
  const wall = built.wall.height;
  const padding = built.room.height - wall - bands;
  // Whatever the padding rounds to, it is the room's own padding twice over and
  // not padding plus an orphaned player strip.
  assert.ok(padding >= 0, 'the bands fit inside the room');
  assert.ok(
    padding < Math.round(58 * built.scale),
    'and there is no leftover strip the height of a player under them',
  );
});

test('the grouped height budget is a target the room may exceed, not a cap', () => {
  // `GROUPED_HEIGHT_RATIO` is what the scale aims for, and `snapScale` clamps at
  // `MIN_SCALE`. Past that point the scale stops shrinking and the room grows
  // instead - legible and scrollable beating fitted and unreadable. Documented
  // as a cap it would be simply false, so it is pinned here as a target.
  const zones: OfficeZone[] = Array.from({ length: 32 }, (_unused, z) => ({
    id: `dept:z${z}`,
    name: `部署${z}`,
    kind: 'department' as const,
    seats: true,
    desks: Array.from({ length: 3 }, (_unused2, i) => ({
      ...(selectOffice(client(['impl-1'])).desks as OfficeDesk[])[0]!,
      actor_key: `a${z}-${i}`,
      role_id: `r${z}-${i}`,
      roster_seat: i + 1,
      occupants: [`a${z}-${i}`],
      occupied: true,
    })),
  }));
  const viewport = { width: 320, height: 240, dpr: 1 };
  const built = buildWorld({ desks: zones.flatMap((zone) => zone.desks), zones, viewport });

  assert.equal(built.scale, MIN_SCALE, 'the scale has bottomed out');
  assert.ok(
    built.room.height > viewport.height * GROUPED_HEIGHT_RATIO,
    'and the room is taller than the budget, which is the documented trade',
  );
  // What stays bounded regardless: the backing store.
  assert.ok(built.canvas.device_width * built.canvas.device_height <= MAX_DEVICE_PIXELS);
  assert.ok(built.canvas.device_width <= MAX_DEVICE_SIDE && built.canvas.device_height <= MAX_DEVICE_SIDE);
});

test('96 frames is a single-room ceiling, not a promise every office reaches', () => {
  // `MAX_ROWS` is shared across zones and every seat-bearing zone takes at least
  // one row, so a grouped office can overflow far below 6x16. Seventeen
  // departments holding one desk each is seventeen desks in total, and the
  // seventeenth still cannot be drawn.
  const one = (key: string): OfficeDesk => ({
    ...(selectOffice(client(['impl-1'])).desks as OfficeDesk[])[0]!,
    actor_key: key,
    role_id: key,
    roster_seat: 1,
    occupants: [key],
    occupied: true,
  });
  const zones: OfficeZone[] = Array.from({ length: MAX_ROWS + 1 }, (_unused, z) => ({
    id: `dept:z${z}`,
    name: `部署${z}`,
    kind: 'department' as const,
    seats: true,
    desks: [one(`a${z}`)],
  }));
  const built = buildWorld({
    desks: zones.flatMap((zone) => zone.desks),
    zones,
    header: selectHeader(client(['impl-1'])),
    viewport: VIEWPORT,
  });

  assert.equal(built.overflow.total, MAX_ROWS + 1, 'seventeen desks in total');
  assert.ok(built.overflow.total < 96, 'far below the single-room ceiling');
  assert.equal(built.overflow.hidden, 1, 'and one of them still cannot be drawn');
  // Never silently: the notice says so.
  assert.notEqual(built.overflow_label.text, '');
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
