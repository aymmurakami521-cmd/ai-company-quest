/**
 * Org snapshot reading and validation.
 *
 * The snapshot is the one input that is neither an event nor a hard-coded
 * fixture, so these tests hold the boundary in both directions:
 *
 * - **Nothing malformed gets in.** Shape, value ranges, referential integrity,
 *   duplicates, ceilings and forbidden content are all refused, and a single
 *   bad entry refuses the whole document. There is no partial roster, because a
 *   partial roster misreports who is missing.
 * - **Nothing gets out.** A refusal carries a rule name and a structural field
 *   path, both from closed sets. No value, no file content, no path, no index.
 *
 * The document used here is invented for the test on purpose: the observed
 * department, role and facility counts are deliberately not constants of this
 * repository (docs/org-snapshot-design.md §4.3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOrgSnapshotFile } from '../src/collector/orgLoader.ts';
import type { OrgLimits, OrgValidation } from '../src/domain/orgSnapshot.ts';
import {
  DEFAULT_ORG_LIMITS,
  ORG_REJECT_FIELDS,
  ORG_REJECT_RULES,
  parseOrgSnapshot,
  validateOrgSnapshot,
} from '../src/domain/orgSnapshot.ts';

type Doc = Record<string, unknown>;

/** A minimal but complete document: two departments, two roles, one facility. */
function validDocument(): Doc {
  return {
    org_definition_hash: 'sha256:0123456789abcdef',
    agent_definitions_hash: 'sha256:fedcba9876543210',
    validation_warnings: [],
    departments: [
      { id: 'dept-alpha', displayName: '第一部', display_order: 10 },
      { id: 'dept-beta', displayName: '第二部', display_order: 20 },
    ],
    roles: [
      {
        id: 'role-lead',
        displayName: 'リード',
        kind: 'department',
        department_id: 'dept-alpha',
        runtime_agent_type: 'lead-agent',
      },
      {
        id: 'role-exec',
        displayName: '執行役員',
        kind: 'executive',
        department_id: null,
        runtime_agent_type: 'exec-agent',
      },
    ],
    facilities: [{ id: 'zone-workshop', displayName: '工房', type: 'shared' }],
  };
}

/** `validDocument()` with one surgical change applied to a clone. */
function mutated(change: (doc: Doc) => void): Doc {
  const doc = structuredClone(validDocument());
  change(doc);
  return doc;
}

function departments(doc: Doc): Doc[] {
  return doc['departments'] as Doc[];
}

function roles(doc: Doc): Doc[] {
  return doc['roles'] as Doc[];
}

function facilities(doc: Doc): Doc[] {
  return doc['facilities'] as Doc[];
}

/** Asserts a refusal and returns it, having checked it is in the closed sets. */
function rejection(result: OrgValidation, rule: string, field: string): void {
  assert.equal(result.ok, false, `expected a refusal, got an accepted snapshot`);
  if (result.ok) return;
  assert.equal(result.rejection.rule, rule);
  assert.equal(result.rejection.field, field);
  assert.ok((ORG_REJECT_RULES as readonly string[]).includes(result.rejection.rule));
  assert.ok((ORG_REJECT_FIELDS as readonly string[]).includes(result.rejection.field));
  // The refusal has exactly two keys: there is nowhere for content to ride along.
  assert.deepEqual(Object.keys(result.rejection).sort(), ['field', 'rule']);
}

function limitsWith(overrides: Partial<OrgLimits>): OrgLimits {
  return { ...DEFAULT_ORG_LIMITS, ...overrides };
}

// ---------------------------------------------------------------- adoption ---

test('a well-formed snapshot is adopted, built key by key from a whitelist', () => {
  const result = validateOrgSnapshot(validDocument());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.snapshot, {
    departments: [
      { id: 'dept-alpha', display_name: '第一部', display_order: 10 },
      { id: 'dept-beta', display_name: '第二部', display_order: 20 },
    ],
    roles: [
      {
        id: 'role-lead',
        display_name: 'リード',
        kind: 'department',
        department_id: 'dept-alpha',
        runtime_agent_type: 'lead-agent',
        display_order: null,
      },
      {
        id: 'role-exec',
        display_name: '執行役員',
        kind: 'executive',
        department_id: null,
        runtime_agent_type: 'exec-agent',
        display_order: null,
      },
    ],
    facilities: [{ id: 'zone-workshop', display_name: '工房', facility_type: 'shared', display_order: null }],
  });

  // Declaration order is the only order this reader preserves (design §3.1).
  assert.deepEqual(
    result.snapshot.departments.map((entry) => entry.id),
    ['dept-alpha', 'dept-beta'],
  );

  // Provenance is shape-checked and then dropped: no observed hash is retained,
  // let alone baked in as a constant (design §4.3).
  const serialised = JSON.stringify(result.snapshot);
  assert.ok(!serialised.includes('sha256'));
  assert.ok(!serialised.includes('validation_warnings'));
});

test('the optional provenance keys may be absent without changing the outcome', () => {
  const without = mutated((doc) => {
    delete doc['org_definition_hash'];
    delete doc['agent_definitions_hash'];
    delete doc['validation_warnings'];
  });
  const bare = validateOrgSnapshot(without);
  const full = validateOrgSnapshot(validDocument());
  assert.equal(bare.ok, true);
  assert.equal(full.ok, true);
  if (!bare.ok || !full.ok) return;
  assert.deepEqual(bare.snapshot, full.snapshot);
});

test('an empty organisation is a valid organisation, not an error', () => {
  const empty = validateOrgSnapshot({ departments: [], roles: [], facilities: [] });
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.deepEqual(empty.snapshot, { departments: [], roles: [], facilities: [] });
});

// -------------------------------------------------------------- shape gate ---

test('a non-object document is refused before anything is read out of it', () => {
  rejection(validateOrgSnapshot([]), 'not_object', 'root');
  rejection(validateOrgSnapshot(null), 'not_object', 'root');
  rejection(validateOrgSnapshot('{}'), 'not_object', 'root');
  rejection(validateOrgSnapshot(42), 'not_object', 'root');
});

test('malformed JSON is refused with no trace of what failed to parse', () => {
  const result = parseOrgSnapshot('{"departments": [');
  rejection(result, 'not_json', 'file');
  assert.ok(!JSON.stringify(result).includes('departments'));
});

test('a missing required key names the key and nothing else', () => {
  rejection(validateOrgSnapshot(mutated((doc) => delete doc['roles'])), 'missing_key', 'root.roles');
  rejection(
    validateOrgSnapshot(mutated((doc) => delete departments(doc)[0]?.['id'])),
    'missing_key',
    'departments[].id',
  );
  rejection(validateOrgSnapshot(mutated((doc) => delete roles(doc)[0]?.['kind'])), 'missing_key', 'roles[].kind');
  rejection(
    validateOrgSnapshot(mutated((doc) => delete roles(doc)[1]?.['runtime_agent_type'])),
    'missing_key',
    'roles[].runtime_agent_type',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => delete facilities(doc)[0]?.['type'])),
    'missing_key',
    'facilities[].type',
  );
});

test('an unknown key is refused, not dropped, and its own name never escapes', () => {
  const extraRoot = validateOrgSnapshot(mutated((doc) => (doc['floor_plan'] = {})));
  rejection(extraRoot, 'unknown_key', 'root');
  assert.ok(!JSON.stringify(extraRoot).includes('floor_plan'));

  rejection(
    validateOrgSnapshot(mutated((doc) => Object.assign(departments(doc)[0] ?? {}, { seat_x: 3 }))),
    'unknown_key',
    'departments[]',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => Object.assign(roles(doc)[0] ?? {}, { salary: 1 }))),
    'unknown_key',
    'roles[]',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => Object.assign(facilities(doc)[0] ?? {}, { colour: 'red' }))),
    'unknown_key',
    'facilities[]',
  );
});

test('a wrong type is refused wherever it appears', () => {
  rejection(validateOrgSnapshot(mutated((doc) => (doc['roles'] = {}))), 'type_error', 'root.roles');
  rejection(validateOrgSnapshot(mutated((doc) => (doc['departments'] = 'six'))), 'type_error', 'root.departments');
  rejection(validateOrgSnapshot(mutated((doc) => (doc['facilities'] = null))), 'type_error', 'root.facilities');
  rejection(validateOrgSnapshot(mutated((doc) => (roles(doc)[0] = 'role-lead' as unknown as Doc))), 'type_error', 'roles[]');
  rejection(validateOrgSnapshot(mutated((doc) => (departments(doc)[1] = [] as unknown as Doc))), 'type_error', 'departments[]');
  rejection(validateOrgSnapshot(mutated((doc) => ((departments(doc)[0] as Doc)['id'] = 7))), 'type_error', 'departments[].id');
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['displayName'] = null))),
    'type_error',
    'roles[].displayName',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['department_id'] = 3))),
    'type_error',
    'roles[].department_id',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['runtime_agent_type'] = null))),
    'type_error',
    'roles[].runtime_agent_type',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['display_order'] = '10'))),
    'type_error',
    'roles[].display_order',
  );
  rejection(validateOrgSnapshot(mutated((doc) => (doc['validation_warnings'] = 'none'))), 'type_error', 'root.validation_warnings');
  rejection(validateOrgSnapshot(mutated((doc) => (doc['org_definition_hash'] = 1))), 'type_error', 'root.org_definition_hash');
});

// ------------------------------------------------------------- value ranges ---

test('identifiers outside the published grammar are refused', () => {
  for (const bad of ['Dept-Alpha', 'dept alpha', '-dept', 'dept_alpha', '', 'd'.repeat(65)]) {
    rejection(
      validateOrgSnapshot(mutated((doc) => ((departments(doc)[0] as Doc)['id'] = bad))),
      'invalid_format',
      'departments[].id',
    );
  }
  // 64 characters is the last accepted length, not the first refused one.
  const atLimit = validateOrgSnapshot(
    mutated((doc) => {
      (departments(doc)[0] as Doc)['id'] = 'd'.repeat(64);
      (roles(doc)[0] as Doc)['department_id'] = 'd'.repeat(64);
    }),
  );
  assert.equal(atLimit.ok, true);
});

test('display names are bounded, non-empty and free of control characters', () => {
  const limits = DEFAULT_ORG_LIMITS;
  const atLimit = validateOrgSnapshot(
    mutated((doc) => ((departments(doc)[0] as Doc)['displayName'] = 'あ'.repeat(limits.max_display_name_chars))),
  );
  assert.equal(atLimit.ok, true, 'the bound itself is usable');

  rejection(
    validateOrgSnapshot(
      mutated((doc) => ((departments(doc)[0] as Doc)['displayName'] = 'あ'.repeat(limits.max_display_name_chars + 1))),
    ),
    'field_too_long',
    'departments[].displayName',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => ((departments(doc)[0] as Doc)['displayName'] = ''))),
    'invalid_format',
    'departments[].displayName',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['displayName'] = 'lead\nagent'))),
    'invalid_format',
    'roles[].displayName',
  );
});

test('the closed enums are closed', () => {
  rejection(validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['kind'] = 'intern'))), 'invalid_format', 'roles[].kind');
  rejection(validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['kind'] = 'Executive'))), 'invalid_format', 'roles[].kind');
  rejection(
    validateOrgSnapshot(mutated((doc) => ((facilities(doc)[0] as Doc)['type'] = 'private'))),
    'invalid_format',
    'facilities[].type',
  );
});

test('a sort hint must be a non-negative integer', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = validateOrgSnapshot(mutated((doc) => ((departments(doc)[0] as Doc)['display_order'] = bad)));
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.rejection.field, 'departments[].display_order');
  }
  const zero = validateOrgSnapshot(mutated((doc) => ((departments(doc)[0] as Doc)['display_order'] = 0)));
  assert.equal(zero.ok, true, '0 is a legitimate sort hint');
});

test('the matching key must satisfy the same label grammar the wire applies', () => {
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['runtime_agent_type'] = 'lead/agent'))),
    'invalid_format',
    'roles[].runtime_agent_type',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['runtime_agent_type'] = ''))),
    'invalid_format',
    'roles[].runtime_agent_type',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['runtime_agent_type'] = 'a'.repeat(129)))),
    'invalid_format',
    'roles[].runtime_agent_type',
  );
});

// ---------------------------------------------- duplicates and references ---

test('duplicate identifiers are refused in every namespace that must stay unique', () => {
  rejection(
    validateOrgSnapshot(mutated((doc) => ((departments(doc)[1] as Doc)['id'] = 'dept-alpha'))),
    'duplicate_id',
    'departments[].id',
  );
  rejection(validateOrgSnapshot(mutated((doc) => ((roles(doc)[1] as Doc)['id'] = 'role-lead'))), 'duplicate_id', 'roles[].id');
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[1] as Doc)['runtime_agent_type'] = 'lead-agent'))),
    'duplicate_id',
    'roles[].runtime_agent_type',
  );
  // Departments and facilities are both zones downstream, so one collision
  // between the two would make a zone reference ambiguous.
  rejection(
    validateOrgSnapshot(mutated((doc) => ((facilities(doc)[0] as Doc)['id'] = 'dept-beta'))),
    'duplicate_id',
    'facilities[].id',
  );
});

test('a broken department reference is refused, never repaired and never read as null', () => {
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['department_id'] = 'dept-gamma'))),
    'unknown_reference',
    'roles[].department_id',
  );
  // A department that exists only *after* the role still resolves: the check is
  // against the whole set, not a prefix of it.
  const backwards = validateOrgSnapshot(mutated((doc) => ((roles(doc)[1] as Doc)['department_id'] = 'dept-beta')));
  assert.equal(backwards.ok, true);
});

// ------------------------------------------------------------------ limits ---

test('every retained collection has a ceiling, and the ceiling itself is usable', () => {
  const entries = (count: number): Doc[] =>
    Array.from({ length: count }, (_unused, index) => ({
      id: `dept-${index}`,
      displayName: `部署${index}`,
    }));

  const limits = limitsWith({ max_departments: 3 });
  const atLimit = validateOrgSnapshot({ departments: entries(3), roles: [], facilities: [] }, limits);
  assert.equal(atLimit.ok, true, 'exactly at the ceiling is accepted');

  rejection(
    validateOrgSnapshot({ departments: entries(4), roles: [], facilities: [] }, limits),
    'limit_exceeded',
    'root.departments',
  );
  rejection(
    validateOrgSnapshot(
      { departments: [], roles: [], facilities: entries(4).map((entry) => ({ ...entry, type: 'shared' })) },
      limitsWith({ max_facilities: 3 }),
    ),
    'limit_exceeded',
    'root.facilities',
  );
  rejection(
    validateOrgSnapshot(
      {
        departments: [],
        facilities: [],
        roles: entries(4).map((entry, index) => ({
          id: `role-${index}`,
          displayName: entry['displayName'],
          kind: 'staff',
          department_id: null,
          runtime_agent_type: `agent-${index}`,
        })),
      },
      limitsWith({ max_roles: 3 }),
    ),
    'limit_exceeded',
    'root.roles',
  );
  rejection(
    validateOrgSnapshot(
      { departments: [], roles: [], facilities: [], validation_warnings: ['a', 'b'] },
      limitsWith({ max_warnings: 1 }),
    ),
    'limit_exceeded',
    'root.validation_warnings',
  );
});

test('an oversized document is refused before it is parsed', () => {
  const text = JSON.stringify(validDocument());
  const limits = limitsWith({ max_bytes: Buffer.byteLength(text, 'utf8') });
  assert.equal(parseOrgSnapshot(text, limits).ok, true, 'exactly at the ceiling is accepted');
  rejection(parseOrgSnapshot(text, limitsWith({ max_bytes: text.length - 1 })), 'oversized', 'file');
});

// -------------------------------------------------------- forbidden content ---

test('forbidden content is refused wherever a string is retained', () => {
  rejection(
    validateOrgSnapshot(mutated((doc) => ((departments(doc)[0] as Doc)['displayName'] = '/home/operator/company'))),
    'unsafe_content',
    'departments[].displayName',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => ((facilities(doc)[0] as Doc)['displayName'] = 'token: hunter2secret'))),
    'unsafe_content',
    'facilities[].displayName',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['displayName'] = 'sk-ant-abcdefghijkl'))),
    'unsafe_content',
    'roles[].displayName',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['runtime_agent_type'] = 'password:supersecret'))),
    'unsafe_content',
    'roles[].runtime_agent_type',
  );
  rejection(
    validateOrgSnapshot(mutated((doc) => (doc['validation_warnings'] = ['see ~/notes.txt']))),
    'unsafe_content',
    'root.validation_warnings[]',
  );
});

test('a refusal never carries the value, the content or the path that caused it', () => {
  const marker = 'sk-ant-DEADBEEFCAFE01';
  const result = validateOrgSnapshot(mutated((doc) => ((roles(doc)[0] as Doc)['displayName'] = marker)));
  assert.equal(result.ok, false);
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(marker), 'the offending value must not be echoed');
  assert.ok(!serialised.includes('role-lead'), 'no identifier from the document either');
  assert.ok(!serialised.includes('0'), 'not even the index of the entry that failed');
});

// --------------------------------------------------- all-or-nothing refusal ---

test('one bad entry refuses the whole organisation, never a partial one', () => {
  const doc = mutated((doc_) => {
    roles(doc_).push({
      id: 'role-extra',
      displayName: 'その他',
      kind: 'assistant',
      department_id: 'dept-nowhere',
      runtime_agent_type: 'extra-agent',
    });
  });

  // Every other entry in the document is individually valid…
  const withoutTheBadOne = structuredClone(doc);
  roles(withoutTheBadOne).pop();
  assert.equal(validateOrgSnapshot(withoutTheBadOne).ok, true);

  // …and the document is still refused in full.
  const result = validateOrgSnapshot(doc);
  rejection(result, 'unknown_reference', 'roles[].department_id');
  assert.equal(result.ok === false && 'snapshot' in result, false, 'no partial snapshot is returned');
});

// ------------------------------------------------------------- the file read ---

test('an unset path is a healthy absence, not a refusal', () => {
  const state = loadOrgSnapshotFile(null);
  assert.equal(state.status, 'absent');
  assert.equal(state.snapshot, null);
  assert.equal(state.reject, null);
});

test('a readable snapshot on disk is adopted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quest-org-'));
  const path = join(dir, 'org.snapshot.json');
  writeFileSync(path, JSON.stringify(validDocument()), 'utf8');

  const state = loadOrgSnapshotFile(path);
  assert.equal(state.status, 'accepted');
  assert.equal(state.reject, null);
  assert.equal(state.snapshot?.roles.length, 2);
  // The configured path is not part of what is retained or served.
  assert.ok(!JSON.stringify(state).includes(dir));
});

test('an unreadable path is refused without leaking the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quest-org-'));
  const missing = join(dir, 'nowhere', 'org.snapshot.json');

  const state = loadOrgSnapshotFile(missing);
  assert.equal(state.status, 'rejected');
  assert.deepEqual(state.reject, { rule: 'read_error', field: 'file' });
  assert.equal(state.snapshot, null);
  assert.ok(!JSON.stringify(state).includes(dir), 'the refusal must not echo the configured path');

  // A directory is not a snapshot: refused, and never a thrown startup error.
  assert.deepEqual(loadOrgSnapshotFile(dir).reject, { rule: 'read_error', field: 'file' });
});

test('a malformed file on disk is refused with a content-free reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quest-org-'));
  const path = join(dir, 'org.snapshot.json');
  writeFileSync(path, '{"departments": [ }', 'utf8');

  const state = loadOrgSnapshotFile(path);
  assert.equal(state.status, 'rejected');
  assert.deepEqual(state.reject, { rule: 'not_json', field: 'file' });
});

test('an oversized file is refused without being read into memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quest-org-'));
  const path = join(dir, 'org.snapshot.json');
  const text = JSON.stringify(validDocument());
  writeFileSync(path, text, 'utf8');

  const bytes = Buffer.byteLength(text, 'utf8');
  assert.equal(loadOrgSnapshotFile(path, limitsWith({ max_bytes: bytes })).status, 'accepted');
  assert.deepEqual(loadOrgSnapshotFile(path, limitsWith({ max_bytes: bytes - 1 })).reject, {
    rule: 'oversized',
    field: 'file',
  });
});

test('the loaded state carries its own ceilings, so what it holds is bounded', () => {
  const limits = limitsWith({ max_roles: 7 });
  assert.deepEqual(loadOrgSnapshotFile(null, limits).limits, limits);
  assert.deepEqual(loadOrgSnapshotFile(null).limits, DEFAULT_ORG_LIMITS);
});
