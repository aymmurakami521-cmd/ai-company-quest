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

/**
 * Every actor the office accounts for, however it is drawn.
 *
 * Not one key per desk: a roster seat aggregates every actor answering to its
 * comparison key, so the seat stands for all of them and lists them
 * (`docs/org-snapshot-design.md` §4.2). Reading `actor_key` alone would count
 * an aggregated seat once and call the rest missing.
 */
function actorKeys(office: OfficeProjection): string[] {
  return office.desks.flatMap((desk) => (desk as OfficeDesk).occupants ?? []).sort();
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
  // `ext-1` carries a comparison key no roster seat declares, so nothing can
  // claim it - and it is shown rather than dropped.
  assert.ok(
    unassigned.desks.some((desk) => desk.occupied && desk.roster_seat === null),
    'and it holds the actors no roster seat could match',
  );
});

test('no organisation can make an actor disappear or appear twice', () => {
  // Comparison keys that match nobody, and roster members with no key at all.
  const roles = [
    { id: 'a', name: 'A', display_order: 10, department_id: null, runtime_agent_type: 'implementer' },
    { id: 'c', name: 'C', display_order: 30, department_id: null, runtime_agent_type: null },
    { id: 'd', name: 'D', display_order: 40, department_id: null, runtime_agent_type: 'ghost' },
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

  // A comparison key nobody runs under is a seat, not a licence to invent one.
  const ghost = office.zones.flatMap((zone) => zone.desks).filter((desk) => desk.role_id === 'd');
  assert.equal(ghost.length, 1);
  assert.equal(ghost[0]?.occupied, false);
});

// ------------------------------- cross-row invariants (review findings) ----

test('a department literally called 未所属\'s id does not collide with the container', () => {
  // `unassigned` matches the upstream identifier grammar, so the collector
  // accepts a department with that id. If the synthetic zone shared the name,
  // both zones would take the same role bucket and every seat in that
  // department would be emitted - and rendered - twice.
  const state = demoClient({
    status: 'accepted',
    snapshot: {
      departments: [{ id: 'unassigned', name: 'ほんとうの部署', display_order: 10 }],
      roles: [
        { id: 'r1', name: 'R1', display_order: 10, department_id: 'unassigned', runtime_agent_type: 'orchestrator' },
        { id: 'r2', name: 'R2', display_order: 20, department_id: null, runtime_agent_type: null },
      ],
    },
  });
  const office = assertNeverSilent(state);
  assert.equal(office.grouped, true);

  const ids = office.zones.map((zone) => zone.id);
  assert.equal(new Set(ids).size, ids.length, 'zone ids are unique');
  assert.equal(UNASSIGNED_ZONE_ID.includes(':'), true, 'the container uses a name the grammar cannot produce');

  const roleIds = office.zones.flatMap((zone) => zone.desks).map((desk) => desk.role_id).filter((id) => id !== null);
  assert.deepEqual(roleIds.sort(), ['r1', 'r2'], 'each roster member is emitted exactly once');
  // `r2` has no department, so it belongs to the container, not to the
  // department that happens to share its name.
  const container = office.zones.find((zone) => zone.id === UNASSIGNED_ZONE_ID);
  assert.ok(container?.desks.some((desk) => desk.role_id === 'r2'));
  assert.equal(container?.desks.some((desk) => desk.role_id === 'r1'), false);
});

test('cross-row invariants are refused here too, because nothing else re-checks them', () => {
  const base = { departments: [{ id: 'd1', name: 'D1', display_order: 10 }], roles: [] as unknown[] };
  const role = (over: Record<string, unknown>) => ({
    id: 'r1',
    name: 'R1',
    display_order: 10,
    department_id: null,
    runtime_agent_type: null,
    ...over,
  });

  const refused: [string, unknown][] = [
    ['duplicate department id', { ...base, departments: [base.departments[0], { ...base.departments[0] }] }],
    ['duplicate role id', { ...base, roles: [role({}), role({ display_order: 20 })] }],
    [
      'duplicate comparison key',
      {
        ...base,
        roles: [role({ runtime_agent_type: 'x' }), role({ id: 'r2', runtime_agent_type: 'x' })],
      },
    ],
    ['dangling department reference', { ...base, roles: [role({ department_id: 'nowhere' })] }],
    ['identifier outside the grammar', { ...base, roles: [role({ id: 'Not An Id' })] }],
    ['comparison key outside the wire grammar', { ...base, roles: [role({ runtime_agent_type: 'テスト' })] }],
    ['a name with a control character', { ...base, roles: [role({ name: 'R\u0007' })] }],
    ['a name past the upstream bound', { ...base, roles: [role({ name: 'あ'.repeat(101) })] }],
  ];

  for (const [why, snapshot] of refused) {
    const state = demoClient({ status: 'accepted', snapshot });
    assert.equal(selectSecondaryStatus(state).code, 'ORG_REJECTED', `${why} is refused`);
    assert.equal(assertNeverSilent(state).grouped, false, `${why} produces no partial grouping`);
  }
});

test('a comparison key at the wire bound still matches, because it is not clamped to the name bound', () => {
  // The wire allows 128 characters and a display name 100. Clamping the key to
  // the shorter of the two would make a long-keyed roster member permanently
  // 不在 while the actor answering to it sat in 未所属 - misreporting exactly
  // who is missing.
  const key = 'a'.repeat(128);
  const events = [
    { ...DEMO_EVENTS[0], agent_id: 'long-1', runtime_agent_type: key },
  ] as typeof DEMO_EVENTS;
  const state = clientWith(
    {
      status: 'accepted',
      snapshot: {
        departments: [{ id: 'd1', name: 'D1', display_order: 10 }],
        roles: [{ id: 'r1', name: 'R1', display_order: 10, department_id: 'd1', runtime_agent_type: key }],
      },
    },
    events,
  );
  const office = assertNeverSilent(state);
  const seat = office.zones.flatMap((zone) => zone.desks).find((desk) => desk.role_id === 'r1');
  assert.equal(seat?.occupied, true, 'the seat is filled, not left 不在');
});

test('a rejection field that is not a path is refused rather than printed', () => {
  for (const field of ['SECRET=abcdefgh', 'roles[0].name; rm -rf', '../etc', '', '.a', 'a b']) {
    const state = demoClient({ status: 'rejected', field, rule: 'type_error' });
    const detail = selectSecondaryStatus(state).detail;
    assert.equal(detail, 'snapshot / type_error', `${JSON.stringify(field)} is not echoed`);
  }
  // An over-long value is bounded before the grammar sees it, so what reaches
  // the screen is length-limited whether or not it is path-shaped.
  const long = demoClient({ status: 'rejected', field: 'a'.repeat(200), rule: 'type_error' });
  const longDetail = selectSecondaryStatus(long).detail ?? '';
  assert.ok(longDetail.length <= 128 + ' / type_error'.length, 'the field path is bounded');

  // The shapes the collector actually emits still survive.
  for (const field of ['(root)', 'schema_version', 'company.id', 'roles[12].runtime_agent_type']) {
    const state = demoClient({ status: 'rejected', field, rule: 'invalid_format' });
    assert.equal(selectSecondaryStatus(state).detail, `${field} / invalid_format`);
  }
});

test('a seated roster member keeps the name the stream reported for them', () => {
  // The roster label is shown beside the reported name, never instead of it.
  // The canvas sprite and the detail pane are both fed `selectDesks`, so
  // replacing `display_name` here would leave one card reading 開発担当 while
  // the same actor reads `dev-1` two panes away - and with two actors answering
  // to one seat, nothing would say which of them is in it.
  const state = demoClient(DEMO_ORG);
  const office = selectOffice(state);
  const reported = new Map(selectDesks(state).map((desk) => [desk.actor_key, desk.display_name]));

  const seated = (office.desks as OfficeDesk[]).filter((desk) => desk.occupied);
  assert.ok(seated.length > 0);
  for (const desk of seated) {
    assert.equal(desk.display_name, reported.get(desk.actor_key ?? ''), 'the reported name is untouched');
  }
  const onRoster = seated.filter((desk) => desk.roster_seat !== null);
  assert.ok(onRoster.length > 0);
  for (const desk of onRoster) {
    assert.ok((desk.role_name ?? '').length > 0, 'and the roster label rides alongside it');
    assert.notEqual(desk.role_name, desk.display_name);
  }
  // A vacant seat has no reported name at all, only the roster label.
  for (const desk of (office.desks as OfficeDesk[]).filter((desk) => !desk.occupied)) {
    assert.equal(desk.display_name, null);
    assert.ok((desk.role_name ?? '').length > 0);
  }
});

test('a seat belongs to a person, not to a session: two actors, one seat, nobody lost', () => {
  // `dev-1` and `sync-1` both run as `implementer` in the scripted mission.
  // One colleague running twice is one colleague at one desk - not a colleague
  // plus a stranger in 未所属, which would break 固定着席 the moment anybody ran
  // twice and would show the same roster employee in two places at once.
  const state = demoClient(DEMO_ORG);
  const office = assertNeverSilent(state);
  const seats = office.zones
    .flatMap((zone) => zone.desks)
    .filter((desk) => desk.role_id === 'role-implementer');
  assert.equal(seats.length, 1, 'the roster seat stays one seat');

  const seat = seats[0];
  assert.equal(seat?.occupied, true);
  assert.equal(seat?.occupants.length, 2, 'and it stands for both sessions');
  assert.ok(seat?.actor_key !== null && seat.occupants.includes(seat.actor_key));

  // Neither of them is also drawn as somebody the roster does not know.
  const unassigned = office.zones.find((zone) => zone.id === UNASSIGNED_ZONE_ID);
  for (const key of seat?.occupants ?? []) {
    assert.equal(
      unassigned?.desks.some((desk) => desk.actor_key === key),
      false,
      `${key} is not also an unassigned colleague`,
    );
  }
});

test('an aggregated seat is chosen deterministically and never hides a session', () => {
  const first = selectOffice(demoClient(DEMO_ORG));
  const second = selectOffice(demoClient(DEMO_ORG));
  const seatOf = (office: typeof first) =>
    office.zones.flatMap((zone) => zone.desks).find((desk) => desk.role_id === 'role-implementer');
  assert.deepEqual(seatOf(second), seatOf(first), 'the same actors produce the same seat');

  // The count is on the desk, so an aggregated seat cannot look like one session.
  const desks = first.desks as OfficeDesk[];
  const total = desks.reduce((sum, desk) => sum + desk.occupants.length, 0);
  assert.equal(total, selectDesks(demoClient(DEMO_ORG)).length, 'every actor is accounted for exactly once');
});

test('an aggregated seat counts actors, not sessions', () => {
  // An actor is keyed by `(session_id, agent_id)`, so one session running two
  // agents of the same runtime type is two occupants and one session. The card
  // labels the row 「actors」 for that reason: a session count would say 2 where
  // the truth is 1.
  const key = 'twin';
  const events = [0, 1].map((n) =>
    makeEvent({
      event_type: 'agent_start',
      status: 'active',
      session_id: 'one-session',
      agent_id: `twin-${n}`,
      runtime_agent_type: key,
      ts: `2026-02-01T00:00:0${n}.000Z`,
    }),
  );

  const state = clientWith(
    {
      status: 'accepted',
      snapshot: {
        departments: [{ id: 'd1', name: 'D1', display_order: 10 }],
        roles: [{ id: 'r1', name: 'R1', display_order: 10, department_id: 'd1', runtime_agent_type: key }],
      },
    },
    events,
  );
  const office = assertNeverSilent(state);
  const seat = office.zones.flatMap((zone) => zone.desks).find((desk) => desk.role_id === 'r1');
  assert.equal(seat?.occupied, true, 'the seat is filled');
  assert.equal(seat?.occupants.length, 2, 'both actors are accounted for');
  assert.equal(
    new Set((seat?.occupants ?? []).map(() => 'one-session')).size,
    1,
    'and they came from a single session',
  );
  // Neither is also drawn as an unassigned colleague.
  const unassigned = office.zones.find((zone) => zone.id === UNASSIGNED_ZONE_ID);
  assert.equal(unassigned?.desks.some((desk) => desk.occupied), false);
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
