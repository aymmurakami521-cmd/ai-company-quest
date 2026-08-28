/**
 * The organisation-backed office, and above all the ways it is allowed to fail.
 *
 * The organisation is the first input this screen takes that the event stream
 * does not produce, and `docs/org-snapshot-design.md` §2.4 puts one rule above
 * the rest: **the degradation must be visible.** A screen that quietly stops
 * grouping, or that fills a roster seat with a state nobody reported, is worse
 * than a screen with no roster at all - it is a screen that lies about the
 * company.
 *
 * So this suite is written from the failure side. Every case below feeds a
 * broken, missing or unusable organisation into the same `applySnapshot` path a
 * browser uses, and asserts that the office lands on the documented degraded
 * state and *says so* - never that the case is merely hard to reach.
 *
 * The three failure families, from the plan:
 *
 * 1. **absent** - no organisation was configured at all;
 * 2. **rejected / invalid** - one was, and it was refused (by the collector, or
 *    here by the screen's own re-check);
 * 3. **projection impossible** - the organisation is fine, but it cannot be
 *    matched to the stream: no actors, no comparison keys, keys that match
 *    nothing, or keys that match too much.
 *
 * Nothing here touches the DOM, a socket or the clock: every case is a pure
 * function over data. What the *page* does with these states is pinned next
 * door in `test/ui-org-dom.test.ts`, which drives the shipped `quest-app.js`
 * against `test/fakeDom.ts` - a degradation the projection reports into a
 * surface nobody renders would still be a silent one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { DEMO_ORG } from '../src/demo/orgFixture.ts';
import { DEMO_TIMELINE } from '../src/demo/timeline.ts';
import { validateOrgSnapshot, type OrgSnapshot } from '../src/domain/org.ts';
import type { QuestState } from '../src/domain/reducer.ts';
import { makeEvent } from './helpers.ts';

import type { ClientState, OfficeDesk, OfficeProjection } from '../src/ui/public/quest-view.js';
import {
  ACTOR_LEGEND_STATES,
  ORG_LIMITS,
  ORG_REJECT_RULES,
  SECONDARY_STATUS_CODES,
  UNASSIGNED_ZONE_ID,
  applySnapshot,
  createClientState,
  normalizeOrg,
  selectDesks,
  selectHeader,
  selectOffice,
  selectPlayer,
  selectSecondaryStatus,
} from '../src/ui/public/quest-view.js';

// ------------------------------------------------------------------ setup ---

/** The accepted organisation, as JSON would carry it. */
const SNAPSHOT = DEMO_ORG.status === 'accepted' ? DEMO_ORG.snapshot : null;
if (SNAPSHOT === null) throw new Error('the DEMO organisation fixture is not accepted');

/**
 * A client state built the way a browser builds one: a real store, folded, then
 * serialised to JSON and handed to `applySnapshot`. `org` is substituted here
 * rather than in the store so a single set of actors can be run against every
 * failure case.
 */
function clientWith(org: unknown, events: readonly ReturnType<typeof makeEvent>[] = []): ClientState {
  const store = new NamespaceStore({ namespace: 'demo', inputContract: 'internal_normalized' });
  for (const event of events) store.ingestObject(event);
  const state = JSON.parse(JSON.stringify(store.state)) as QuestState;
  return applySnapshot(createClientState('demo'), {
    namespace: 'demo',
    halted: false,
    halt_reason: null,
    last_ingest_seq: store.stats.last_ingest_seq,
    state: { ...state, org },
  });
}

/**
 * The scripted DEMO mission, which is what the shipped fixture is tuned to.
 *
 * `DemoPlayer` stamps `ts` when it ingests a beat, so the same is done here -
 * with a fixed clock, because this suite must not depend on one.
 */
const DEMO_EVENTS = DEMO_TIMELINE.map((beat, index) => ({
  ...beat,
  ts: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
}));

function demoClient(org: unknown): ClientState {
  return clientWith(org, DEMO_EVENTS);
}

function actorKeys(office: OfficeProjection): string[] {
  return office.desks
    .map((desk) => (desk as OfficeDesk).actor_key)
    .filter((key): key is string => key !== null && key !== undefined)
    .sort();
}

/**
 * The invariant the whole feature rests on: the office is grouped exactly when
 * the second status surface says it is not degraded. One can never be true
 * without the other, which is what makes a silent degradation unrepresentable
 * rather than merely unlikely.
 */
function assertNeverSilent(state: ClientState): OfficeProjection {
  const office = selectOffice(state);
  const status = selectSecondaryStatus(state);
  assert.ok(SECONDARY_STATUS_CODES.includes(status.code), `${status.code} is in the closed vocabulary`);
  assert.equal(status.degraded, !office.grouped, 'degraded and ungrouped always agree');
  assert.ok(status.message.length > 0, 'the surface is never blank');
  if (!office.grouped) {
    assert.deepEqual(office.zones, [], 'a degraded office has no half-built zones');
    assert.deepEqual(office.desks, selectDesks(state), 'and falls back to the flat colleague list');
  }
  return office;
}

// ------------------------------------------------------- 1. absent --------

test('no organisation at all degrades to the flat list and says so', () => {
  for (const missing of [undefined, null, {}, 'nope', 42, { status: 'absent' }, { status: 'unheard-of' }]) {
    const state = clientWith(missing, DEMO_EVENTS);
    const office = assertNeverSilent(state);
    assert.equal(office.grouped, false, `${JSON.stringify(missing)} does not group`);
    assert.equal(selectSecondaryStatus(state).code, 'ORG_ABSENT');
    assert.equal(selectSecondaryStatus(state).detail, null, 'absence has no rejection detail');
  }
});

test('a state that never saw a snapshot is absent, not blank', () => {
  const fresh = createClientState('demo');
  assert.deepEqual(fresh.org, { status: 'absent' });
  const status = selectSecondaryStatus(fresh);
  assert.equal(status.code, 'ORG_ABSENT');
  assert.equal(status.degraded, true);
});

test('a snapshot that stops carrying an organisation drops the grouping, it does not keep a stale one', () => {
  const grouped = demoClient(DEMO_ORG);
  assert.equal(selectOffice(grouped).grouped, true, 'grouped to begin with');
  // Same client, a later snapshot with no organisation: the screen must not keep
  // showing a company the server no longer reports.
  const after = applySnapshot(grouped, {
    namespace: 'demo',
    halted: false,
    halt_reason: null,
    last_ingest_seq: 0,
    state: { actors: {}, sessions: {}, player: null },
  });
  assert.equal(selectSecondaryStatus(after).code, 'ORG_ABSENT');
  assertNeverSilent(after);
});

// -------------------------------------------- 2. rejected / invalid -------

test('a refusal from the collector is reported as a refusal, never as an absence', () => {
  const state = demoClient({ status: 'rejected', field: 'roles[3].name', rule: 'unsafe_content' });
  const office = assertNeverSilent(state);
  assert.equal(office.grouped, false);
  const status = selectSecondaryStatus(state);
  assert.equal(status.code, 'ORG_REJECTED');
  assert.equal(status.detail, 'roles[3].name / unsafe_content');
  assert.notEqual(status.code, 'ORG_ABSENT', 'the two failures stay distinguishable');
});

test('every documented rejection rule renders, and an undocumented one is not echoed', () => {
  for (const rule of ORG_REJECT_RULES) {
    const state = demoClient({ status: 'rejected', field: 'roles[0].id', rule });
    assert.equal(selectSecondaryStatus(state).detail, `roles[0].id / ${rule}`);
  }
  // A rule this screen does not know is reported in the closed vocabulary
  // instead of being printed - the surface never repeats a string off the wire.
  const odd = demoClient({ status: 'rejected', field: 'roles[0].id', rule: 'because-i-said-so' });
  assert.equal(selectSecondaryStatus(odd).detail, 'roles[0].id / type_error');
});

test('a refusal never carries a name, a value or a path to the screen', () => {
  const state = demoClient({
    status: 'rejected',
    field: 'roles[2].runtime_agent_type',
    rule: 'invalid_format',
  });
  const rendered = JSON.stringify(selectSecondaryStatus(state));
  for (const leak of ['開発部', '統括ディレクター', '/Users/', 'C:\\', 'org.snapshot.json', 'secret']) {
    assert.equal(rendered.includes(leak), false, `no ${leak} reaches the screen`);
  }
});

test('an accepted organisation the screen cannot use is refused out loud, not silently forgotten', () => {
  // This is the case that would be easiest to get wrong: the collector said
  // `accepted`, so the tempting fallback is `absent`. That would tell the
  // operator "no organisation was configured" about an organisation that *was*
  // configured and then thrown away here.
  const unusable: unknown[] = [
    { status: 'accepted' },
    { status: 'accepted', snapshot: null },
    { status: 'accepted', snapshot: 'nope' },
    { status: 'accepted', snapshot: { departments: 'nope', roles: [] } },
    { status: 'accepted', snapshot: { departments: [], roles: 'nope' } },
    { status: 'accepted', snapshot: { departments: [{ id: 'a' }], roles: [] } },
    { status: 'accepted', snapshot: { departments: [], roles: [{ id: 'r', name: 'R' }] } },
  ];
  for (const org of unusable) {
    const state = demoClient(org);
    const office = assertNeverSilent(state);
    assert.equal(office.grouped, false, `${JSON.stringify(org)} does not group`);
    assert.equal(
      selectSecondaryStatus(state).code,
      'ORG_REJECTED',
      `${JSON.stringify(org)} is refused, not treated as absent`,
    );
  }
});

test('one bad row refuses the whole roster: a partial roster misreports who is missing', () => {
  const roles = SNAPSHOT.roles.map((role) => ({ ...role }));
  const broken = [...roles.slice(0, -1), { ...roles[roles.length - 1], display_order: 'soon' }];
  const state = demoClient({
    status: 'accepted',
    snapshot: { ...SNAPSHOT, roles: broken },
  });
  assert.equal(selectSecondaryStatus(state).code, 'ORG_REJECTED');
  assert.equal(assertNeverSilent(state).grouped, false, 'no partial roster is ever shown');
});

test('an over-sized organisation is refused, never truncated', () => {
  const many = Array.from({ length: ORG_LIMITS.roles + 1 }, (_unused, index) => ({
    id: `role-${index}`,
    name: `役職${index}`,
    display_order: index,
    department_id: null,
    runtime_agent_type: null,
  }));
  const state = demoClient({ status: 'accepted', snapshot: { ...SNAPSHOT, roles: many } });
  assert.equal(selectSecondaryStatus(state).code, 'ORG_REJECTED');
  const office = assertNeverSilent(state);
  assert.equal(office.grouped, false);
  // The give-away for a silent truncation would be a grouped office holding
  // exactly the limit. There is none, because there is no grouped office.
  assert.equal(office.zones.length, 0);
});

test('normalizeOrg keeps the three-value vocabulary closed', () => {
  assert.deepEqual(normalizeOrg(undefined), { status: 'absent' });
  assert.deepEqual(normalizeOrg({ status: 'accepted', snapshot: 1 }), {
    status: 'rejected',
    field: 'snapshot',
    rule: 'type_error',
  });
  const ok = normalizeOrg({ status: 'accepted', snapshot: SNAPSHOT });
  assert.equal(ok.status, 'accepted');
  // `__proto__` in the payload is data, never a prototype.
  const hostile = normalizeOrg({
    status: 'accepted',
    snapshot: { departments: [], roles: [], __proto__: { polluted: true } },
  });
  assert.equal(hostile.status, 'accepted');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

// ------------------------------------ 3. projection impossible ------------

test('a roster with nobody reported keeps every seat and invents no state', () => {
  // The organisation is valid and accepted; the stream simply never mentioned
  // anybody. This is the case where fabricating activity would be easiest and
  // most damaging.
  const state = clientWith(DEMO_ORG, []);
  const office = assertNeverSilent(state);
  assert.equal(office.grouped, true, 'a valid organisation still groups');

  const desks = office.desks as OfficeDesk[];
  assert.equal(desks.length, SNAPSHOT.roles.length, 'every roster seat is drawn');
  for (const desk of desks) {
    assert.equal(desk.occupied, false);
    assert.equal(desk.actor_key, null);
    assert.equal(desk.seat, null, 'a vacant seat has no dynamic seat number');
    assert.ok(desk.roster_seat !== null, 'but it does have a roster one');
    // Not one of these is a fact the stream reported.
    assert.equal(desk.status_label, null);
    assert.equal(desk.last_tool, null);
    assert.equal(desk.last_event_ts, null);
    assert.equal(desk.session_id, null);
    assert.equal(desk.role, null);
    assert.equal(desk.event_count, 0);
    assert.equal(desk.visual.state, 'vacant');
    assert.equal(desk.stale, false, 'nobody is frozen: nobody was ever moving');
  }
});

test('the vacant state is outside the actor vocabulary, so it is never counted as work', () => {
  const state = clientWith(DEMO_ORG, []);
  assert.equal(
    ACTOR_LEGEND_STATES.includes('vacant' as never),
    false,
    'vacant is not a state an event can produce',
  );
  // The header counts colleagues, and there are none: an empty office with a
  // full roster still reports zero at their desks.
  const header = selectHeader(state);
  assert.equal(header.desk_count, 0);
  assert.equal(header.empty, true);
});

test('an actor the roster does not know goes to 未所属 and is never dropped', () => {
  const state = demoClient(DEMO_ORG);
  const office = assertNeverSilent(state);
  const flat = actorKeys(office);
  const plain = selectDesks(state)
    .map((desk) => desk.actor_key)
    .sort();
  assert.deepEqual(flat, plain, 'every actor in the flat list is somewhere in the office');

  const unassigned = office.zones.find((zone) => zone.id === UNASSIGNED_ZONE_ID);
  assert.ok(unassigned !== undefined, 'the 未所属 container exists');
  // `main` carries no comparison key at all, so no seat can claim it.
  assert.ok(
    unassigned.desks.some((desk) => desk.occupied && desk.roster_seat === null),
    'and it holds the actors no roster seat could match',
  );
});

test('no organisation can make an actor disappear or appear twice', () => {
  // Comparison keys that match nothing, keys that are absent, and two roles
  // fighting over one key - the three ways matching can go wrong at once.
  const roles = [
    { id: 'a', name: 'A', display_order: 10, department_id: null, runtime_agent_type: 'implementer' },
    { id: 'b', name: 'B', display_order: 20, department_id: null, runtime_agent_type: 'implementer' },
    { id: 'c', name: 'C', display_order: 30, department_id: null, runtime_agent_type: null },
    { id: 'd', name: 'D', display_order: 40, department_id: 'nowhere', runtime_agent_type: 'ghost' },
  ];
  const state = demoClient({ status: 'accepted', snapshot: { departments: [], roles } });
  const office = assertNeverSilent(state);
  assert.equal(office.grouped, true);

  const keys = actorKeys(office);
  assert.deepEqual(
    keys,
    selectDesks(state)
      .map((desk) => desk.actor_key)
      .sort(),
    'every actor appears',
  );
  assert.equal(new Set(keys).size, keys.length, 'and no actor appears twice');

  // A role pointing at a department that does not exist is placed, not dropped.
  const placed = office.zones.flatMap((zone) => zone.desks).filter((desk) => desk.role_id === 'd');
  assert.equal(placed.length, 1, 'the dangling role still has its seat');
  assert.equal(placed[0]?.occupied, false, 'and nobody was invented to fill it');
});

test('a seat belongs to a person, not to a session: two actors, one seat, nobody lost', () => {
  // `dev-1` and `sync-1` both run as `implementer` in the scripted mission.
  const state = demoClient(DEMO_ORG);
  const office = assertNeverSilent(state);
  const seated = office.zones
    .flatMap((zone) => zone.desks)
    .filter((desk) => desk.role_id === 'role-implementer');
  assert.equal(seated.length, 1, 'the roster seat stays one seat');
  assert.equal(seated[0]?.occupied, true);
  // The other one is still on the screen, in 未所属.
  const unassigned = office.zones.find((zone) => zone.id === UNASSIGNED_ZONE_ID);
  assert.ok((unassigned?.desks.length ?? 0) > 0, 'the actor it did not seat is still shown');
});

test('the office is deterministic: same organisation, same actors, same result', () => {
  const first = selectOffice(demoClient(DEMO_ORG));
  const second = selectOffice(demoClient(DEMO_ORG));
  assert.deepEqual(second, first);
  // Zone order is the declared order, and nothing else decides it.
  const departments = [...SNAPSHOT.departments].sort((a, b) => a.display_order - b.display_order);
  assert.deepEqual(
    first.zones.map((zone) => zone.id),
    [...departments.map((department) => department.id), UNASSIGNED_ZONE_ID],
  );
});

test('the player is never a roster seat, a colleague count, or a selection', () => {
  const state = demoClient(DEMO_ORG);
  const withPlayer: ClientState = {
    ...state,
    player: { kind: 'player', id: 'player', display_name: '歩' },
  };
  const office = selectOffice(withPlayer);
  const rendered = JSON.stringify(office);
  assert.equal(rendered.includes('歩'), false, 'the player is not in any zone');
  assert.equal(selectPlayer(withPlayer)?.display_name, '歩', 'they are their own projection');
  assert.equal(selectHeader(withPlayer).desk_count, selectHeader(state).desk_count);
});

// ------------------------------------------------- the shipped fixture ----

test('the DEMO organisation obeys the same admission rules as a real one', () => {
  // The fixture bypasses the collector, so nothing else would catch a fixture
  // the LIVE validator would have refused.
  const result = validateOrgSnapshot(SNAPSHOT as OrgSnapshot);
  assert.equal(result.ok, true, result.ok ? '' : `${result.field} / ${result.rule}`);
});

test('the DEMO organisation exercises every matching rule, not only the happy one', () => {
  const office = selectOffice(demoClient(DEMO_ORG));
  const desks = office.desks as OfficeDesk[];
  assert.ok(
    desks.some((desk) => desk.occupied && desk.roster_seat !== null),
    'a roster member with an actor',
  );
  assert.ok(
    desks.some((desk) => !desk.occupied),
    'a roster member without one',
  );
  assert.ok(
    desks.some((desk) => desk.occupied && desk.roster_seat === null),
    'an actor without a roster member',
  );
  assert.ok(
    office.zones.some((zone) => zone.kind === 'department' && zone.desks.every((desk) => !desk.occupied)),
    'and a department nobody reported activity in',
  );
});
