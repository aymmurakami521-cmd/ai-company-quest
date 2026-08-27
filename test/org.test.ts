/**
 * The organisation snapshot boundary (`docs/org-snapshot-design.md` PR-2).
 *
 * What these tests hold:
 *
 * - the floor plan is *operator input*, never stream content: no event can
 *   install, replace or invalidate it, and `reduce` carries it through untouched;
 * - acceptance is all-or-nothing - one bad entry rejects the whole document,
 *   because a partial roster misreports *who is missing*;
 * - the state is exactly three closed values (`absent` / `accepted` / `rejected`)
 *   so a silent degradation is impossible;
 * - rejection details name a field path and a rule and never leak a value, an
 *   employee name, a department name or a filesystem path;
 * - the same content scan the event path uses also guards this input;
 * - the ceilings reject the document rather than halting ingest.
 *
 * The fixtures here are generic on purpose. The real organisation lives in the
 * `ai-company` repository, and this repository is the reusable core, so no real
 * department or employee name is committed here. The shape - six departments,
 * fifteen roles, seven shared facilities - mirrors the observed contract without
 * copying its content, and the counts are asserted against the fixture rather
 * than baked in as constants (design record section 4.3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ORG_LIMITS,
  ORG_ABSENT,
  SUPPORTED_ORG_SCHEMA_VERSION,
  orgStateFrom,
  orgStatusDetail,
  validateOrgSnapshot,
  type OrgSnapshot,
} from '../src/domain/org.ts';
import { loadOrgState } from '../src/collector/orgLoader.ts';
import { createInitialState, reduce } from '../src/domain/reducer.ts';
import { NamespaceStore } from '../src/collector/store.ts';
import { loadConfig } from '../src/config.ts';
import { makeEvent, makeIngested } from './helpers.ts';

// -- fixtures ---------------------------------------------------------------

const DEPARTMENT_COUNT = 6;
const ROLE_COUNT = 15;
const FACILITY_COUNT = 7;

function department(index: number): Record<string, unknown> {
  return { id: `dept-${index}`, name: `Department ${index}`, display_order: index * 10 };
}

/**
 * Fifteen roles in the observed shape: four executives, one staff, six that own
 * a department, four unassigned assistants.
 */
function roles(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 1; i <= 4; i += 1) {
    out.push({
      id: `exec-${i}`, name: `Executive ${i}`, kind: 'executive',
      department_id: null, agent_ref: `exec-${i}`,
      runtime_agent_type: `exec-${i}`, display_order: i * 10,
    });
  }
  out.push({
    id: 'staff-1', name: 'Staff 1', kind: 'staff',
    department_id: null, agent_ref: 'staff-1',
    runtime_agent_type: 'staff-1', display_order: 50,
  });
  for (let i = 1; i <= 6; i += 1) {
    out.push({
      id: `lead-${i}`, name: `Lead ${i}`, kind: 'department',
      department_id: `dept-${i}`, agent_ref: `lead-${i}`,
      runtime_agent_type: `lead-${i}`, display_order: 50 + i * 10,
    });
  }
  for (let i = 1; i <= 4; i += 1) {
    out.push({
      id: `helper-${i}`, name: `Helper ${i}`, kind: 'assistant',
      department_id: null, agent_ref: `helper-${i}`,
      runtime_agent_type: `helper-${i}`, display_order: 200 + i * 10,
    });
  }
  return out;
}

function validDocument(): Record<string, unknown> {
  const departments: Record<string, unknown>[] = [];
  for (let i = 1; i <= DEPARTMENT_COUNT; i += 1) departments.push(department(i));
  const facilities: Record<string, unknown>[] = [];
  for (let i = 1; i <= FACILITY_COUNT; i += 1) {
    facilities.push({ id: `shared-${i}`, name: `Shared ${i}`, type: 'shared', display_order: i * 10 });
  }
  return {
    schema_version: SUPPORTED_ORG_SCHEMA_VERSION,
    company: { id: 'example-co', name: 'Example Co' },
    departments,
    roles: roles(),
    facilities,
  };
}

/** Deep clone so a mutation in one test cannot leak into another. */
function doc(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validDocument())) as Record<string, unknown>;
}

function accept(document: unknown): OrgSnapshot {
  const result = validateOrgSnapshot(document);
  assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.snapshot;
}

function rejection(document: unknown): { field: string; rule: string } {
  const result = validateOrgSnapshot(document);
  assert.equal(result.ok, false, 'expected rejection');
  if (result.ok) throw new Error('unreachable');
  return { field: result.field, rule: result.rule };
}

// -- acceptance -------------------------------------------------------------

test('a well-formed snapshot is accepted with its declared shape', () => {
  const snapshot = accept(doc());
  assert.equal(snapshot.departments.length, DEPARTMENT_COUNT);
  assert.equal(snapshot.roles.length, ROLE_COUNT);
  assert.equal(snapshot.facilities.length, FACILITY_COUNT);
  assert.equal(snapshot.company.id, 'example-co');
});

test('the fifteen-seat shape is a property of the fixture, not a constant', () => {
  // Design record section 4.3: the count is the roster's result. A fourteen-role
  // document is just as valid, and nothing in the validator says otherwise.
  const smaller = doc();
  (smaller['roles'] as unknown[]).pop();
  const snapshot = accept(smaller);
  assert.equal(snapshot.roles.length, ROLE_COUNT - 1);
});

test('roles keep their department link and their unassigned members', () => {
  const snapshot = accept(doc());
  const assigned = snapshot.roles.filter((role) => role.department_id !== null);
  const unassigned = snapshot.roles.filter((role) => role.department_id === null);
  assert.equal(assigned.length, DEPARTMENT_COUNT);
  // executives + staff + assistants: the "unassigned" bucket the projection fills.
  assert.equal(unassigned.length, ROLE_COUNT - DEPARTMENT_COUNT);
  for (const role of assigned) {
    assert.ok(snapshot.departments.some((d) => d.id === role.department_id));
  }
});

test('unknown top-level keys are dropped, not rejected and not forwarded', () => {
  // The upstream artefact legitimately carries bookkeeping keys.
  const withExtras = doc();
  withExtras['org_definition_hash'] = 'sha256:' + 'a'.repeat(64);
  withExtras['agent_definitions_hash'] = 'sha256:' + 'b'.repeat(64);
  withExtras['validation_warnings'] = [];
  const result = validateOrgSnapshot(withExtras);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(
    result.dropped_keys.slice().sort(),
    ['agent_definitions_hash', 'org_definition_hash', 'validation_warnings'],
  );
  assert.equal(Object.hasOwn(result.snapshot, 'org_definition_hash'), false);
  assert.equal(Object.hasOwn(result.snapshot, 'validation_warnings'), false);
});

test('a display_order of zero survives', () => {
  // `0` is falsy; a presence check that used truthiness would drop it.
  const zeroed = doc();
  (zeroed['departments'] as Record<string, unknown>[])[0]!['display_order'] = 0;
  const snapshot = accept(zeroed);
  assert.equal(snapshot.departments[0]!.display_order, 0);
});

test('a nullable role field may be absent as well as null', () => {
  const sparse = doc();
  const role = (sparse['roles'] as Record<string, unknown>[])[0]!;
  delete role['department_id'];
  delete role['agent_ref'];
  delete role['runtime_agent_type'];
  const snapshot = accept(sparse);
  assert.equal(snapshot.roles[0]!.department_id, null);
  assert.equal(snapshot.roles[0]!.agent_ref, null);
  assert.equal(snapshot.roles[0]!.runtime_agent_type, null);
});

// -- all-or-nothing ---------------------------------------------------------

test('one malformed entry rejects the entire document', () => {
  const broken = doc();
  (broken['roles'] as Record<string, unknown>[])[7]!['kind'] = 'director';
  const result = validateOrgSnapshot(broken);
  assert.equal(result.ok, false);
  // No partial snapshot is reachable: the failed result carries no roster at all.
  assert.equal(Object.hasOwn(result, 'snapshot'), false);
});

test('every structural defect is refused, each naming its own field path', () => {
  const cases: [string, (d: Record<string, unknown>) => void, string, string][] = [
    ['missing company', (d) => { delete d['company']; }, 'company', 'missing_key'],
    ['missing departments', (d) => { delete d['departments']; }, 'departments', 'missing_key'],
    ['missing roles', (d) => { delete d['roles']; }, 'roles', 'missing_key'],
    ['missing facilities', (d) => { delete d['facilities']; }, 'facilities', 'missing_key'],
    ['departments not an array', (d) => { d['departments'] = {}; }, 'departments', 'type_error'],
    ['role not an object', (d) => { (d['roles'] as unknown[])[2] = 'lead'; }, 'roles[2]', 'type_error'],
    [
      'bad identifier',
      (d) => { (d['roles'] as Record<string, unknown>[])[0]!['id'] = 'Exec_1'; },
      'roles[0].id', 'invalid_format',
    ],
    [
      'unknown department reference',
      (d) => { (d['roles'] as Record<string, unknown>[])[5]!['department_id'] = 'dept-99'; },
      'roles[5].department_id', 'unknown_reference',
    ],
    [
      'duplicate role id',
      (d) => { (d['roles'] as Record<string, unknown>[])[1]!['id'] = 'exec-1'; },
      'roles[1].id', 'duplicate_id',
    ],
    [
      'duplicate comparison key',
      (d) => { (d['roles'] as Record<string, unknown>[])[1]!['runtime_agent_type'] = 'exec-1'; },
      'roles[1].runtime_agent_type', 'duplicate_id',
    ],
    [
      'duplicate department id',
      (d) => { (d['departments'] as Record<string, unknown>[])[3]!['id'] = 'dept-1'; },
      'departments[3].id', 'duplicate_id',
    ],
    [
      'facility of another type',
      (d) => { (d['facilities'] as Record<string, unknown>[])[0]!['type'] = 'private'; },
      'facilities[0].type', 'invalid_format',
    ],
    [
      'empty display name',
      (d) => { (d['departments'] as Record<string, unknown>[])[0]!['name'] = ''; },
      'departments[0].name', 'invalid_format',
    ],
    [
      'over-long display name',
      (d) => { (d['departments'] as Record<string, unknown>[])[0]!['name'] = 'x'.repeat(101); },
      'departments[0].name', 'field_too_long',
    ],
    [
      'control character in a name',
      (d) => { (d['roles'] as Record<string, unknown>[])[0]!['name'] = 'Exec\u0007One'; },
      'roles[0].name', 'control_chars',
    ],
    [
      'tab in a name',
      (d) => { (d['roles'] as Record<string, unknown>[])[0]!['name'] = 'Exec\tOne'; },
      'roles[0].name', 'control_chars',
    ],
    [
      'non-integer display order',
      (d) => { (d['facilities'] as Record<string, unknown>[])[1]!['display_order'] = 1.5; },
      'facilities[1].display_order', 'invalid_format',
    ],
  ];
  for (const [label, mutate, field, rule] of cases) {
    const broken = doc();
    mutate(broken);
    const got = rejection(broken);
    assert.deepEqual(got, { field, rule }, `${label}: got ${JSON.stringify(got)}`);
  }
});

test('the schema version is the only compatibility gate', () => {
  const older = doc();
  older['schema_version'] = SUPPORTED_ORG_SCHEMA_VERSION + 1;
  assert.deepEqual(rejection(older), { field: 'schema_version', rule: 'unsupported_schema' });

  const missing = doc();
  delete missing['schema_version'];
  assert.deepEqual(rejection(missing), { field: 'schema_version', rule: 'missing_key' });

  assert.deepEqual(rejection('a document'), { field: '(root)', rule: 'not_object' });
  assert.deepEqual(rejection(null), { field: '(root)', rule: 'not_object' });
  assert.deepEqual(rejection([]), { field: '(root)', rule: 'not_object' });
});

// -- content boundary -------------------------------------------------------

test('unsafe content in an organisation name is refused, not carried', () => {
  const unsafe: string[] = [
    '/Users/someone/office',
    '~/office',
    'file:///etc/passwd',
    'token: abcdef123456',
    'sudo rm -rf',
  ];
  for (const value of unsafe) {
    const broken = doc();
    (broken['departments'] as Record<string, unknown>[])[0]!['name'] = value;
    assert.deepEqual(
      rejection(broken),
      { field: 'departments[0].name', rule: 'unsafe_content' },
      `expected refusal for ${value.slice(0, 12)}`,
    );
  }
});

test('a comparison key the wire could never carry is refused at admission', () => {
  // A roster seat whose key cannot appear on the wire is a permanently
  // unmatchable seat, so it is refused rather than kept (design record 4.2).
  const broken = doc();
  (broken['roles'] as Record<string, unknown>[])[0]!['runtime_agent_type'] = 'exec/one';
  assert.deepEqual(rejection(broken), { field: 'roles[0].runtime_agent_type', rule: 'invalid_format' });
});

test('a rejection detail never leaks a value or a name', () => {
  const broken = doc();
  (broken['departments'] as Record<string, unknown>[])[2]!['name'] = '/Users/someone/secret-project';
  const result = validateOrgSnapshot(broken);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  const detail = `${result.field}:${result.rule}`;
  assert.equal(detail.includes('secret-project'), false);
  assert.equal(detail.includes('/Users/'), false);
  assert.equal(detail, 'departments[2].name:unsafe_content');
});

test('an inherited member is never mistaken for a declared field', () => {
  const hostile = JSON.parse(
    '{"schema_version":1,"company":{"id":"c","name":"C"},' +
      '"departments":[],"roles":[],"facilities":[],"__proto__":{"roles":"injected"}}',
  ) as unknown;
  const snapshot = accept(hostile);
  assert.deepEqual(snapshot.roles, []);
});

// -- ceilings ---------------------------------------------------------------

test('each collection has its own ceiling and rejects the document at it', () => {
  const tooManyRoles = doc();
  const many: Record<string, unknown>[] = [];
  for (let i = 0; i <= DEFAULT_ORG_LIMITS.max_roles; i += 1) {
    many.push({
      id: `r-${i}`, name: `R ${i}`, kind: 'assistant',
      department_id: null, agent_ref: null, runtime_agent_type: null, display_order: 0,
    });
  }
  tooManyRoles['roles'] = many;
  assert.equal(many.length, DEFAULT_ORG_LIMITS.max_roles + 1);
  assert.deepEqual(rejection(tooManyRoles), { field: 'roles', rule: 'limit_exceeded' });
});

test('the exact ceiling is accepted and one past it is not', () => {
  const limits = { max_departments: 2, max_roles: 2, max_facilities: 2 };
  const exact = {
    schema_version: 1,
    company: { id: 'c', name: 'C' },
    departments: [department(1), department(2)],
    roles: [],
    facilities: [],
  };
  assert.equal(validateOrgSnapshot(exact, limits).ok, true);

  const over = { ...exact, departments: [department(1), department(2), department(3)] };
  const result = validateOrgSnapshot(over, limits);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.rule, 'limit_exceeded');
});

// -- the three-state vocabulary ---------------------------------------------

test('the state is exactly three closed values and always readable', () => {
  assert.equal(ORG_ABSENT.status, 'absent');
  assert.equal(orgStatusDetail(ORG_ABSENT), 'absent');

  const accepted = orgStateFrom(validateOrgSnapshot(doc()));
  assert.equal(accepted.status, 'accepted');
  assert.equal(orgStatusDetail(accepted), 'accepted');

  const broken = doc();
  delete broken['roles'];
  const rejected = orgStateFrom(validateOrgSnapshot(broken));
  assert.equal(rejected.status, 'rejected');
  assert.equal(orgStatusDetail(rejected), 'rejected:roles:missing_key');
});

// -- the loader -------------------------------------------------------------

test('no configured path is absent, which is a supported mode', async () => {
  assert.deepEqual(await loadOrgState({ path: null }), ORG_ABSENT);
});

test('an unreadable file is rejected without echoing the path', async () => {
  const state = await loadOrgState({
    path: '/Users/someone/private/org.snapshot.json',
    read: async () => { throw new Error('ENOENT'); },
  });
  assert.equal(state.status, 'rejected');
  const detail = orgStatusDetail(state);
  assert.equal(detail.includes('/Users/'), false);
  assert.equal(detail.includes('someone'), false);
  assert.equal(detail, 'rejected:(file):not_object');
});

test('unparseable and oversized documents are rejected, never thrown', async () => {
  const bad = await loadOrgState({ path: 'org.json', read: async () => 'not json' });
  assert.equal(bad.status, 'rejected');

  const huge = await loadOrgState({
    path: 'org.json',
    maxBytes: 16,
    read: async () => JSON.stringify(validDocument()),
  });
  assert.equal(orgStatusDetail(huge), 'rejected:(file):limit_exceeded');
});

test('a valid file loads into the accepted state', async () => {
  const state = await loadOrgState({
    path: 'org.json',
    read: async () => JSON.stringify(validDocument()),
  });
  assert.equal(state.status, 'accepted');
  if (state.status !== 'accepted') throw new Error('unreachable');
  assert.equal(state.snapshot.roles.length, ROLE_COUNT);
});

// -- the stream cannot touch it ---------------------------------------------

test('the configuration reads the path from its own environment variable only', () => {
  const withPath = loadConfig({ QUEST_ORG_SNAPSHOT_PATH: ' /tmp/org.json ' });
  assert.equal(withPath.orgSnapshotPath, '/tmp/org.json');
  assert.equal(loadConfig({}).orgSnapshotPath, null);
  assert.equal(loadConfig({ QUEST_ORG_SNAPSHOT_PATH: '   ' }).orgSnapshotPath, null);
});

test('an initial state defaults to absent and keeps a supplied organisation', () => {
  assert.deepEqual(createInitialState('live').org, ORG_ABSENT);
  const accepted = orgStateFrom(validateOrgSnapshot(doc()));
  const state = createInitialState('live', undefined, undefined, accepted);
  assert.equal(state.org.status, 'accepted');
});

test('reduce carries the organisation through untouched', () => {
  const accepted = orgStateFrom(validateOrgSnapshot(doc()));
  const state = createInitialState('live', undefined, undefined, accepted);
  const next = reduce(state, makeIngested(makeEvent(), 1));
  // Same reference: no event can install, replace or invalidate an organisation.
  assert.equal(next.org, state.org);
  assert.equal(next.org.status, 'accepted');
});

test('a store keeps the organisation across ingestion', () => {
  const accepted = orgStateFrom(validateOrgSnapshot(doc()));
  const store = new NamespaceStore({
    namespace: 'live',
    inputContract: 'internal_normalized',
    failClosedOnUnsupportedSchema: false,
    org: accepted,
  });
  assert.equal(store.state.org.status, 'accepted');
  store.accept(makeEvent());
  assert.equal(store.state.org.status, 'accepted');
});
