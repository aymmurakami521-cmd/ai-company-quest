/**
 * Strict, fail-closed validation for the organisation snapshot.
 *
 * The snapshot is *not* an event. It is a validated artefact produced elsewhere
 * (`company/org.snapshot.json` in the `ai-company` repository) and handed to
 * Quest through configuration only. This module is pure: no I/O, no clock, no
 * globals - exactly like `domain/validate.ts`, and for the same reason.
 *
 * Guarantees provided to every downstream consumer:
 * - The returned snapshot is built key by key from a whitelist. Unknown keys
 *   are not dropped silently: they reject the whole document (see below).
 * - Every retained string has passed the same content scan the event path uses
 *   (`scanUnsafe` / `hasControlChars`): absolute paths, shell fragments and
 *   credential-shaped substrings never reach the state.
 * - One invalid entry rejects the entire org snapshot. There is no partial
 *   adoption: a partial roster would misreport *who is missing*, which is worse
 *   than reporting no roster at all.
 * - Rejection details are content-free by construction: a rule name from a
 *   closed set plus a structural field path from a closed set. No value, no
 *   file content, no path, no index.
 *
 * Nothing here decides anything about layout, seats or the screen. Reading and
 * validating is the whole responsibility of this module.
 */

import { hasControlChars, scanUnsafe } from './validate.ts';

/** Why an org snapshot was refused. Closed vocabulary, machine-readable. */
export const ORG_REJECT_RULES = [
  'read_error',
  'oversized',
  'not_json',
  'not_object',
  'missing_key',
  'unknown_key',
  'type_error',
  'invalid_format',
  'field_too_long',
  'duplicate_id',
  'unknown_reference',
  'limit_exceeded',
  'unsafe_content',
] as const;

export type OrgRejectRule = (typeof ORG_REJECT_RULES)[number];

/**
 * Where it was refused. Structural paths only: a container name and a key name,
 * never an array index and never a value. `file` covers everything that fails
 * before the document is parsed.
 */
export const ORG_REJECT_FIELDS = [
  'file',
  'root',
  'root.departments',
  'root.roles',
  'root.facilities',
  'root.org_definition_hash',
  'root.agent_definitions_hash',
  'root.validation_warnings',
  'root.validation_warnings[]',
  'departments[]',
  'departments[].id',
  'departments[].displayName',
  'departments[].display_order',
  'roles[]',
  'roles[].id',
  'roles[].displayName',
  'roles[].kind',
  'roles[].department_id',
  'roles[].runtime_agent_type',
  'roles[].display_order',
  'facilities[]',
  'facilities[].id',
  'facilities[].displayName',
  'facilities[].type',
  'facilities[].display_order',
] as const;

export type OrgRejectField = (typeof ORG_REJECT_FIELDS)[number];

/** Content-free by construction: two closed enums and nothing else. */
export type OrgRejection = { rule: OrgRejectRule; field: OrgRejectField };

/** Whether an org snapshot was adopted, never configured, or refused. */
export const ORG_STATUSES = ['absent', 'accepted', 'rejected'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

/** Closed enum observed on `roles[].kind` (org-snapshot-design.md §4.1). */
export const ORG_ROLE_KINDS = ['executive', 'department', 'staff', 'assistant'] as const;
export type OrgRoleKind = (typeof ORG_ROLE_KINDS)[number];

/** Closed enum observed on `facilities[].type` (org-snapshot-design.md §4.1). */
export const ORG_FACILITY_TYPES = ['shared'] as const;
export type OrgFacilityType = (typeof ORG_FACILITY_TYPES)[number];

export type OrgDepartment = {
  id: string;
  display_name: string;
  display_order: number | null;
};

export type OrgRole = {
  id: string;
  display_name: string;
  kind: OrgRoleKind;
  /** `null` means "not attached to a department", not "unknown". */
  department_id: string | null;
  /** The matching key against runtime actors (design §4.2). Never `agent_id`. */
  runtime_agent_type: string;
  display_order: number | null;
};

export type OrgFacility = {
  id: string;
  display_name: string;
  facility_type: OrgFacilityType;
  display_order: number | null;
};

/**
 * What Quest retains from the snapshot: identifiers, display names, the kind
 * enums, the department reference and the matching key. Ordering is the
 * declaration order of these arrays (design §3.1) - no coordinate, no pixel,
 * no colour, and no provenance hash is retained.
 */
export type OrgSnapshot = {
  departments: OrgDepartment[];
  roles: OrgRole[];
  facilities: OrgFacility[];
};

/**
 * Ceilings on everything the org state retains, held by the state itself, the
 * same way `StateLimits` is (design §2.4). Exceeding one rejects the snapshot;
 * nothing is ever truncated silently.
 *
 * Derived from constants that already exist in this repository rather than from
 * the observed counts, which are deliberately not constants here (design §4.3):
 * - `max_departments` / `max_facilities` reuse the existing ceiling for a small
 *   closed category set, `DEFAULT_STATE_LIMITS.max_event_types` (64).
 * - `max_roles` reuses the existing ceiling for "people inside one container",
 *   `DEFAULT_STATE_LIMITS.max_actors_per_session` (256).
 * - `max_display_name_chars` is the `displayName` bound of the producing schema
 *   (`org.schema.json`, 1..100 - design §4.1).
 * - `max_bytes` is `max_roles` entries at 1 KiB each, i.e. a whole-document
 *   ceiling far above any plausible roster and far below anything that could
 *   strain a read.
 */
export type OrgLimits = {
  max_departments: number;
  max_roles: number;
  max_facilities: number;
  max_warnings: number;
  max_display_name_chars: number;
  max_bytes: number;
};

export const DEFAULT_ORG_LIMITS: OrgLimits = {
  max_departments: 64,
  max_roles: 256,
  max_facilities: 64,
  max_warnings: 64,
  max_display_name_chars: 100,
  max_bytes: 256 * 1024,
};

/**
 * The org slot on `QuestState`. Independent of the event state: `reduce` carries
 * it by reference and no event can create, change or remove it.
 *
 * The shape is uniform across all three statuses so that a consumer reads one
 * closed `status` enum and never has to sniff which variant it holds.
 */
export type OrgState = {
  status: OrgStatus;
  limits: OrgLimits;
  /** Non-null only when `status === 'accepted'`. */
  snapshot: OrgSnapshot | null;
  /** Non-null only when `status === 'rejected'`. */
  reject: OrgRejection | null;
};

/** The normal, unconfigured state: org features are simply not present. */
export const ORG_ABSENT: OrgState = {
  status: 'absent',
  limits: DEFAULT_ORG_LIMITS,
  snapshot: null,
  reject: null,
};

export function orgAbsent(limits: OrgLimits = DEFAULT_ORG_LIMITS): OrgState {
  return { status: 'absent', limits: { ...limits }, snapshot: null, reject: null };
}

export function orgAccepted(snapshot: OrgSnapshot, limits: OrgLimits = DEFAULT_ORG_LIMITS): OrgState {
  return { status: 'accepted', limits: { ...limits }, snapshot, reject: null };
}

export function orgRejected(rejection: OrgRejection, limits: OrgLimits = DEFAULT_ORG_LIMITS): OrgState {
  return { status: 'rejected', limits: { ...limits }, snapshot: null, reject: rejection };
}

export type OrgValidation = { ok: true; snapshot: OrgSnapshot } | { ok: false; rejection: OrgRejection };

/** `^[a-z0-9][a-z0-9-]{0,63}$` - the producing schema's identifier (design §4.1). */
const ORG_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The same label grammar the event path applies to `runtime_agent_type` (design §4.2). */
const LABEL_SLUG = /^[A-Za-z0-9_.:@#| -]{1,128}$/;
/** Provenance strings are recorded nowhere; they are only shape-checked. */
const HASH_SHAPE = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_WARNING_CHARS = 256;
/** `display_order` is a sort hint, not a coordinate: any non-negative int32. */
const MAX_DISPLAY_ORDER = 2_147_483_647;

const ROOT_REQUIRED = ['departments', 'roles', 'facilities'] as const;
const ROOT_OPTIONAL = ['org_definition_hash', 'agent_definitions_hash', 'validation_warnings'] as const;

const DEPARTMENT_REQUIRED = ['id', 'displayName'] as const;
const DEPARTMENT_OPTIONAL = ['display_order'] as const;

const ROLE_REQUIRED = ['id', 'displayName', 'kind', 'department_id', 'runtime_agent_type'] as const;
const ROLE_OPTIONAL = ['display_order'] as const;

const FACILITY_REQUIRED = ['id', 'displayName', 'type'] as const;
const FACILITY_OPTIONAL = ['display_order'] as const;

function fail(rule: OrgRejectRule, field: OrgRejectField): OrgValidation {
  return { ok: false, rejection: { rule, field } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

/**
 * Required keys must be present and no other key may be. Extra keys are refused
 * rather than dropped: the producer and this reader must agree on the whole
 * document, otherwise "the key I rely on moved" reads as "the value is absent".
 *
 * `missing_key` names the key; `unknown_key` can only name the container,
 * because an unknown key's own name is producer content.
 */
function checkKeys<C extends OrgRejectField, R extends string>(
  raw: Record<string, unknown>,
  container: C,
  required: readonly R[],
  optional: readonly string[],
): { rule: OrgRejectRule; field: `${C}.${R}` | C } | null {
  for (const key of required) {
    if (!hasOwn(raw, key)) return { rule: 'missing_key', field: `${container}.${key}` };
  }
  const known = new Set<string>([...required, ...optional]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return { rule: 'unknown_key', field: container };
  }
  return null;
}

/** A bounded, control-character-free, content-scanned display name. */
function checkDisplayName(
  raw: Record<string, unknown>,
  field: OrgRejectField,
  limits: OrgLimits,
): { ok: true; value: string } | { ok: false; rejection: OrgRejection } {
  const value = raw['displayName'];
  if (typeof value !== 'string') return { ok: false, rejection: { rule: 'type_error', field } };
  if (value.length === 0) return { ok: false, rejection: { rule: 'invalid_format', field } };
  if (value.length > limits.max_display_name_chars) {
    return { ok: false, rejection: { rule: 'field_too_long', field } };
  }
  if (hasControlChars(value)) return { ok: false, rejection: { rule: 'invalid_format', field } };
  if (scanUnsafe(value) !== null) return { ok: false, rejection: { rule: 'unsafe_content', field } };
  return { ok: true, value };
}

function checkOptionalOrder(
  raw: Record<string, unknown>,
  field: OrgRejectField,
): { ok: true; value: number | null } | { ok: false; rejection: OrgRejection } {
  if (!hasOwn(raw, 'display_order')) return { ok: true, value: null };
  const value = raw['display_order'];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, rejection: { rule: 'type_error', field } };
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_DISPLAY_ORDER) {
    return { ok: false, rejection: { rule: 'invalid_format', field } };
  }
  return { ok: true, value };
}

function checkId(
  raw: Record<string, unknown>,
  field: OrgRejectField,
): { ok: true; value: string } | { ok: false; rejection: OrgRejection } {
  const value = raw['id'];
  if (typeof value !== 'string') return { ok: false, rejection: { rule: 'type_error', field } };
  if (!ORG_ID.test(value)) return { ok: false, rejection: { rule: 'invalid_format', field } };
  return { ok: true, value };
}

/** Shape-only check on the provenance fields. Their values are never retained. */
function checkProvenance(raw: Record<string, unknown>, key: 'org_definition_hash' | 'agent_definitions_hash'): OrgRejection | null {
  if (!hasOwn(raw, key)) return null;
  const field: OrgRejectField = key === 'org_definition_hash' ? 'root.org_definition_hash' : 'root.agent_definitions_hash';
  const value = raw[key];
  if (typeof value !== 'string') return { rule: 'type_error', field };
  if (!HASH_SHAPE.test(value)) return { rule: 'invalid_format', field };
  return null;
}

function checkWarnings(raw: Record<string, unknown>, limits: OrgLimits): OrgRejection | null {
  if (!hasOwn(raw, 'validation_warnings')) return null;
  const value = raw['validation_warnings'];
  if (!Array.isArray(value)) return { rule: 'type_error', field: 'root.validation_warnings' };
  if (value.length > limits.max_warnings) return { rule: 'limit_exceeded', field: 'root.validation_warnings' };
  for (const entry of value) {
    if (typeof entry !== 'string') return { rule: 'type_error', field: 'root.validation_warnings[]' };
    if (entry.length > MAX_WARNING_CHARS) return { rule: 'field_too_long', field: 'root.validation_warnings[]' };
    if (hasControlChars(entry)) return { rule: 'invalid_format', field: 'root.validation_warnings[]' };
    if (scanUnsafe(entry) !== null) return { rule: 'unsafe_content', field: 'root.validation_warnings[]' };
  }
  return null;
}

function checkArray(
  raw: Record<string, unknown>,
  key: 'departments' | 'roles' | 'facilities',
  field: 'root.departments' | 'root.roles' | 'root.facilities',
  max: number,
): { ok: true; value: unknown[] } | { ok: false; rejection: OrgRejection } {
  const value = raw[key];
  if (!Array.isArray(value)) return { ok: false, rejection: { rule: 'type_error', field } };
  if (value.length > max) return { ok: false, rejection: { rule: 'limit_exceeded', field } };
  return { ok: true, value };
}

/**
 * Validates an already-parsed org snapshot document.
 *
 * The order is: root shape, then departments, then facilities, then roles -
 * roles last because their `department_id` is checked against the department
 * identifiers, and a reference can only be checked once the referents are known.
 */
export function validateOrgSnapshot(raw: unknown, limits: OrgLimits = DEFAULT_ORG_LIMITS): OrgValidation {
  if (!isPlainObject(raw)) return fail('not_object', 'root');

  const rootKeys = checkKeys(raw, 'root', ROOT_REQUIRED, ROOT_OPTIONAL);
  if (rootKeys !== null) return fail(rootKeys.rule, rootKeys.field);

  for (const key of ['org_definition_hash', 'agent_definitions_hash'] as const) {
    const rejection = checkProvenance(raw, key);
    if (rejection !== null) return fail(rejection.rule, rejection.field);
  }
  const warnings = checkWarnings(raw, limits);
  if (warnings !== null) return fail(warnings.rule, warnings.field);

  const rawDepartments = checkArray(raw, 'departments', 'root.departments', limits.max_departments);
  if (!rawDepartments.ok) return { ok: false, rejection: rawDepartments.rejection };
  const rawFacilities = checkArray(raw, 'facilities', 'root.facilities', limits.max_facilities);
  if (!rawFacilities.ok) return { ok: false, rejection: rawFacilities.rejection };
  const rawRoles = checkArray(raw, 'roles', 'root.roles', limits.max_roles);
  if (!rawRoles.ok) return { ok: false, rejection: rawRoles.rejection };

  // Departments and facilities are both "区画" (zones) downstream, so their
  // identifiers share one namespace: a collision between the two would make a
  // zone reference ambiguous.
  const zoneIds = new Set<string>();
  const departmentIds = new Set<string>();

  const departments: OrgDepartment[] = [];
  for (const entry of rawDepartments.value) {
    if (!isPlainObject(entry)) return fail('type_error', 'departments[]');
    const keys = checkKeys(entry, 'departments[]', DEPARTMENT_REQUIRED, DEPARTMENT_OPTIONAL);
    if (keys !== null) return fail(keys.rule, keys.field);

    const id = checkId(entry, 'departments[].id');
    if (!id.ok) return { ok: false, rejection: id.rejection };
    if (zoneIds.has(id.value)) return fail('duplicate_id', 'departments[].id');

    const displayName = checkDisplayName(entry, 'departments[].displayName', limits);
    if (!displayName.ok) return { ok: false, rejection: displayName.rejection };

    const order = checkOptionalOrder(entry, 'departments[].display_order');
    if (!order.ok) return { ok: false, rejection: order.rejection };

    zoneIds.add(id.value);
    departmentIds.add(id.value);
    departments.push({ id: id.value, display_name: displayName.value, display_order: order.value });
  }

  const facilities: OrgFacility[] = [];
  for (const entry of rawFacilities.value) {
    if (!isPlainObject(entry)) return fail('type_error', 'facilities[]');
    const keys = checkKeys(entry, 'facilities[]', FACILITY_REQUIRED, FACILITY_OPTIONAL);
    if (keys !== null) return fail(keys.rule, keys.field);

    const id = checkId(entry, 'facilities[].id');
    if (!id.ok) return { ok: false, rejection: id.rejection };
    if (zoneIds.has(id.value)) return fail('duplicate_id', 'facilities[].id');

    const displayName = checkDisplayName(entry, 'facilities[].displayName', limits);
    if (!displayName.ok) return { ok: false, rejection: displayName.rejection };

    const facilityType = entry['type'];
    if (typeof facilityType !== 'string') return fail('type_error', 'facilities[].type');
    if (!(ORG_FACILITY_TYPES as readonly string[]).includes(facilityType)) {
      return fail('invalid_format', 'facilities[].type');
    }

    const order = checkOptionalOrder(entry, 'facilities[].display_order');
    if (!order.ok) return { ok: false, rejection: order.rejection };

    zoneIds.add(id.value);
    facilities.push({
      id: id.value,
      display_name: displayName.value,
      facility_type: facilityType as OrgFacilityType,
      display_order: order.value,
    });
  }

  const roleIds = new Set<string>();
  // The matching key must stay unique: two roles claiming the same runtime type
  // would make one runtime actor belong to two seats (design §4.2).
  const runtimeTypes = new Set<string>();

  const roles: OrgRole[] = [];
  for (const entry of rawRoles.value) {
    if (!isPlainObject(entry)) return fail('type_error', 'roles[]');
    const keys = checkKeys(entry, 'roles[]', ROLE_REQUIRED, ROLE_OPTIONAL);
    if (keys !== null) return fail(keys.rule, keys.field);

    const id = checkId(entry, 'roles[].id');
    if (!id.ok) return { ok: false, rejection: id.rejection };
    if (roleIds.has(id.value)) return fail('duplicate_id', 'roles[].id');

    const displayName = checkDisplayName(entry, 'roles[].displayName', limits);
    if (!displayName.ok) return { ok: false, rejection: displayName.rejection };

    const kind = entry['kind'];
    if (typeof kind !== 'string') return fail('type_error', 'roles[].kind');
    if (!(ORG_ROLE_KINDS as readonly string[]).includes(kind)) return fail('invalid_format', 'roles[].kind');

    const departmentId = entry['department_id'];
    let resolvedDepartmentId: string | null = null;
    if (departmentId !== null) {
      if (typeof departmentId !== 'string') return fail('type_error', 'roles[].department_id');
      if (!ORG_ID.test(departmentId)) return fail('invalid_format', 'roles[].department_id');
      // Referential integrity: a dangling reference is refused, never repaired
      // and never reinterpreted as "no department".
      if (!departmentIds.has(departmentId)) return fail('unknown_reference', 'roles[].department_id');
      resolvedDepartmentId = departmentId;
    }

    const runtimeAgentType = entry['runtime_agent_type'];
    if (typeof runtimeAgentType !== 'string') return fail('type_error', 'roles[].runtime_agent_type');
    if (!LABEL_SLUG.test(runtimeAgentType)) return fail('invalid_format', 'roles[].runtime_agent_type');
    if (scanUnsafe(runtimeAgentType) !== null) return fail('unsafe_content', 'roles[].runtime_agent_type');
    if (runtimeTypes.has(runtimeAgentType)) return fail('duplicate_id', 'roles[].runtime_agent_type');

    const order = checkOptionalOrder(entry, 'roles[].display_order');
    if (!order.ok) return { ok: false, rejection: order.rejection };

    roleIds.add(id.value);
    runtimeTypes.add(runtimeAgentType);
    roles.push({
      id: id.value,
      display_name: displayName.value,
      kind: kind as OrgRoleKind,
      department_id: resolvedDepartmentId,
      runtime_agent_type: runtimeAgentType,
      display_order: order.value,
    });
  }

  return { ok: true, snapshot: { departments, roles, facilities } };
}

/**
 * Validates one raw snapshot document. Oversized documents are refused before
 * parsing, the same way an oversized JSONL line is.
 */
export function parseOrgSnapshot(text: string, limits: OrgLimits = DEFAULT_ORG_LIMITS): OrgValidation {
  if (Buffer.byteLength(text, 'utf8') > limits.max_bytes) return fail('oversized', 'file');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message quotes the offending input, so it is discarded here.
    return fail('not_json', 'file');
  }
  return validateOrgSnapshot(parsed, limits);
}
