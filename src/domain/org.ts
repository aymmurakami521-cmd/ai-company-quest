/**
 * Organisation snapshot boundary.
 *
 * The office floor plan and the fixed employee roster are *not* stream content.
 * They are a separate, operator-supplied input: the verified snapshot that the
 * `ai-company` repository produces (`company/org.snapshot.json`, emitted by its
 * own `validate_org.py`). Quest reads that artefact and never the YAML source,
 * so no YAML parser enters this repository and no organisational meaning is
 * invented here (`docs/org-snapshot-design.md` §2.1, §4.5).
 *
 * Guarantees provided to every downstream consumer:
 * - The accepted snapshot is built key by key from a whitelist. Unknown keys
 *   from the producer are dropped, never forwarded. The upstream artefact
 *   legitimately carries extra bookkeeping keys (`org_definition_hash`,
 *   `agent_definitions_hash`, `validation_warnings`); dropping them is the
 *   documented behaviour, not a silent tolerance of malformed input.
 * - Every string that survives has passed the same content scan the event
 *   validator applies (`scanUnsafe`), so an absolute path, a shell command or a
 *   credential-shaped substring can never reach the floor plan.
 * - Acceptance is all-or-nothing. One bad entry rejects the whole snapshot: a
 *   partial roster would misreport *who is missing*, which is worse than having
 *   no roster at all (`docs/org-snapshot-design.md` §3.2).
 * - Rejection details are content free. They name the failing field path and
 *   the rule, never the offending text, never an employee or department name.
 *
 * This module performs no I/O and reads no environment. It is a pure validator.
 */

import { hasControlChars, scanUnsafe } from './validate.ts';
import { emptyRecord, ownProperty } from './record.ts';

/** The only snapshot contract this build understands. */
export const SUPPORTED_ORG_SCHEMA_VERSION = 1;

/**
 * Ceilings for the organisation input. Deliberately separate from the reducer's
 * `max_actors`: that one bounds *stream* growth, this one bounds a single
 * operator-supplied document. Reaching a ceiling rejects the org snapshot only -
 * it never halts ingest, because an oversized org file says nothing about the
 * health of the event stream (`docs/org-snapshot-design.md` §4.5).
 */
export type OrgLimits = {
  max_departments: number;
  max_roles: number;
  max_facilities: number;
};

export const DEFAULT_ORG_LIMITS: OrgLimits = {
  max_departments: 64,
  max_roles: 512,
  max_facilities: 64,
};

/** Identifier grammar of the upstream org definition (`org.schema.json`). */
const ORG_IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Comparison key against the event stream. It must additionally satisfy the
 * wire's own label grammar, because this value is compared for equality with
 * `WireEvent.runtime_agent_type`. A roster entry that the wire could never
 * carry is a roster entry that can never match, so it is refused at admission
 * rather than kept as a permanently unmatchable seat
 * (`docs/org-snapshot-design.md` §4.2).
 */
const WIRE_LABEL = /^[A-Za-z0-9_.:@#| -]{1,128}$/;

/**
 * Upstream's `maxLength: 100` on a display name, in the units the upstream
 * schema means. JSON Schema counts *characters* - Unicode code points - so an
 * emoji or a rare CJK ideograph outside the BMP costs one, not the two UTF-16
 * code units JavaScript's `String.prototype.length` charges for. Counting code
 * units here would refuse names the producer's own `validate_org.py` accepts,
 * which turns a shared limit into two different limits.
 */
const MAX_DISPLAY_NAME_CHARS = 100;

/** Code points, not UTF-16 code units: the iterator pairs surrogates for us. */
function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

const ROLE_KINDS = ['executive', 'department', 'staff', 'assistant'] as const;
export type OrgRoleKind = (typeof ROLE_KINDS)[number];

export type OrgCompany = {
  id: string;
  name: string;
};

export type OrgDepartment = {
  id: string;
  name: string;
  display_order: number;
};

export type OrgRole = {
  id: string;
  name: string;
  kind: OrgRoleKind;
  /** `null` for every role that belongs to no department (executive/staff/assistant). */
  department_id: string | null;
  agent_ref: string | null;
  /** The comparison key against `WireEvent.runtime_agent_type`. May be null. */
  runtime_agent_type: string | null;
  display_order: number;
};

export type OrgFacility = {
  id: string;
  name: string;
  /** The upstream contract declares exactly one facility type. */
  type: 'shared';
  display_order: number;
};

export type OrgSnapshot = {
  schema_version: number;
  company: OrgCompany;
  departments: OrgDepartment[];
  roles: OrgRole[];
  facilities: OrgFacility[];
};

/**
 * Closed vocabulary for why a snapshot was refused. No free text, and no value
 * from the document ever appears here.
 */
export type OrgRejectRule =
  | 'not_object'
  | 'unsupported_schema'
  | 'missing_key'
  | 'type_error'
  | 'invalid_format'
  | 'field_too_long'
  | 'control_chars'
  | 'unsafe_content'
  | 'duplicate_id'
  | 'unknown_reference'
  | 'limit_exceeded';

/**
 * The three states the organisation input can be in, as a closed vocabulary.
 * `absent` is not a failure: it is the documented default when no path is
 * configured, and it is reported distinctly from `rejected` so a silent
 * degradation is impossible (`docs/org-snapshot-design.md` §2.4, §4.7).
 */
export type OrgStatus = 'absent' | 'accepted' | 'rejected';

export type OrgState =
  | { status: 'absent' }
  | { status: 'accepted'; snapshot: OrgSnapshot }
  /** `field` is a path such as `roles[3].name`; it carries indexes, never values. */
  | { status: 'rejected'; field: string; rule: OrgRejectRule };

export const ORG_ABSENT: OrgState = { status: 'absent' };

export type OrgValidationResult =
  | { ok: true; snapshot: OrgSnapshot; dropped_keys: string[] }
  | { ok: false; field: string; rule: OrgRejectRule };

function reject(field: string, rule: OrgRejectRule): OrgValidationResult {
  return { ok: false, field, rule };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One display string: bounded, control-character free, and clean under the same
 * content scan the event path uses. The blob rule stays off on purpose - the
 * upstream artefact carries `sha256:` digests, which are content addresses of a
 * public definition file, not opaque secrets.
 */
function checkDisplayName(value: unknown, field: string): OrgRejectRule | null {
  if (typeof value !== 'string') return 'type_error';
  if (value.length === 0) return 'invalid_format';
  if (codePointLength(value) > MAX_DISPLAY_NAME_CHARS) return 'field_too_long';
  if (hasControlChars(value)) return 'control_chars';
  if (scanUnsafe(value) !== null) return 'unsafe_content';
  return null;
}

function checkIdentifier(value: unknown): OrgRejectRule | null {
  if (typeof value !== 'string') return 'type_error';
  if (!ORG_IDENTIFIER.test(value)) return 'invalid_format';
  return null;
}

function checkDisplayOrder(value: unknown): OrgRejectRule | null {
  if (typeof value !== 'number') return 'type_error';
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) return 'invalid_format';
  return null;
}

/**
 * True when the document itself carries the key. `ownProperty` answers with the
 * *value*, which is indistinguishable from "absent" for `null`, `0`, `false` and
 * `''` - and `display_order: 0` is a legitimate value here.
 */
function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

/** Reads an own property only, so `__proto__` in the document cannot be inherited. */
function get(raw: Record<string, unknown>, key: string): unknown {
  return hasOwn(raw, key) ? raw[key] : undefined;
}

function requireArray(
  raw: Record<string, unknown>,
  key: string,
  max: number,
): { ok: true; items: unknown[] } | { ok: false; field: string; rule: OrgRejectRule } {
  const value = get(raw, key);
  if (value === undefined) return { ok: false, field: key, rule: 'missing_key' };
  if (!Array.isArray(value)) return { ok: false, field: key, rule: 'type_error' };
  if (value.length > max) return { ok: false, field: key, rule: 'limit_exceeded' };
  return { ok: true, items: value };
}

/**
 * Validates one organisation snapshot, all or nothing.
 *
 * Returns the accepted document rebuilt from a whitelist, plus the top-level
 * keys that were dropped so a caller can report *that* extras existed without
 * reporting *what* they were.
 */
export function validateOrgSnapshot(
  raw: unknown,
  limits: OrgLimits = DEFAULT_ORG_LIMITS,
): OrgValidationResult {
  if (!isPlainObject(raw)) return reject('(root)', 'not_object');

  const schemaVersion = get(raw, 'schema_version');
  if (schemaVersion === undefined) return reject('schema_version', 'missing_key');
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return reject('schema_version', 'type_error');
  }
  if (schemaVersion !== SUPPORTED_ORG_SCHEMA_VERSION) {
    return reject('schema_version', 'unsupported_schema');
  }

  // ── company ──────────────────────────────────────────────────────────────
  const rawCompany = get(raw, 'company');
  if (rawCompany === undefined) return reject('company', 'missing_key');
  if (!isPlainObject(rawCompany)) return reject('company', 'type_error');
  const companyIdRule = checkIdentifier(get(rawCompany, 'id'));
  if (companyIdRule !== null) return reject('company.id', companyIdRule);
  const companyNameRule = checkDisplayName(get(rawCompany, 'name'), 'company.name');
  if (companyNameRule !== null) return reject('company.name', companyNameRule);
  const company: OrgCompany = {
    id: get(rawCompany, 'id') as string,
    name: get(rawCompany, 'name') as string,
  };

  // ── departments ──────────────────────────────────────────────────────────
  const departmentsRaw = requireArray(raw, 'departments', limits.max_departments);
  if (!departmentsRaw.ok) return reject(departmentsRaw.field, departmentsRaw.rule);
  const departments: OrgDepartment[] = [];
  const departmentIds = emptyRecord<true>();
  for (let index = 0; index < departmentsRaw.items.length; index += 1) {
    const at = `departments[${index}]`;
    const item = departmentsRaw.items[index];
    if (!isPlainObject(item)) return reject(at, 'type_error');
    const idRule = checkIdentifier(get(item, 'id'));
    if (idRule !== null) return reject(`${at}.id`, idRule);
    const id = get(item, 'id') as string;
    if (ownProperty(departmentIds, id) !== undefined) return reject(`${at}.id`, 'duplicate_id');
    const nameRule = checkDisplayName(get(item, 'name'), `${at}.name`);
    if (nameRule !== null) return reject(`${at}.name`, nameRule);
    const orderRule = checkDisplayOrder(get(item, 'display_order'));
    if (orderRule !== null) return reject(`${at}.display_order`, orderRule);
    departmentIds[id] = true;
    departments.push({
      id,
      name: get(item, 'name') as string,
      display_order: get(item, 'display_order') as number,
    });
  }

  // ── roles ────────────────────────────────────────────────────────────────
  const rolesRaw = requireArray(raw, 'roles', limits.max_roles);
  if (!rolesRaw.ok) return reject(rolesRaw.field, rolesRaw.rule);
  const roles: OrgRole[] = [];
  const roleIds = emptyRecord<true>();
  const seenAgentTypes = emptyRecord<true>();
  for (let index = 0; index < rolesRaw.items.length; index += 1) {
    const at = `roles[${index}]`;
    const item = rolesRaw.items[index];
    if (!isPlainObject(item)) return reject(at, 'type_error');

    const idRule = checkIdentifier(get(item, 'id'));
    if (idRule !== null) return reject(`${at}.id`, idRule);
    const id = get(item, 'id') as string;
    if (ownProperty(roleIds, id) !== undefined) return reject(`${at}.id`, 'duplicate_id');

    const nameRule = checkDisplayName(get(item, 'name'), `${at}.name`);
    if (nameRule !== null) return reject(`${at}.name`, nameRule);

    const kind = get(item, 'kind');
    if (typeof kind !== 'string') return reject(`${at}.kind`, 'type_error');
    if (!(ROLE_KINDS as readonly string[]).includes(kind)) {
      return reject(`${at}.kind`, 'invalid_format');
    }

    const departmentId = get(item, 'department_id');
    let resolvedDepartmentId: string | null = null;
    if (departmentId !== null && departmentId !== undefined) {
      const depRule = checkIdentifier(departmentId);
      if (depRule !== null) return reject(`${at}.department_id`, depRule);
      if (ownProperty(departmentIds, departmentId as string) === undefined) {
        return reject(`${at}.department_id`, 'unknown_reference');
      }
      resolvedDepartmentId = departmentId as string;
    }

    const agentRef = get(item, 'agent_ref');
    let resolvedAgentRef: string | null = null;
    if (agentRef !== null && agentRef !== undefined) {
      const agentRule = checkIdentifier(agentRef);
      if (agentRule !== null) return reject(`${at}.agent_ref`, agentRule);
      resolvedAgentRef = agentRef as string;
    }

    const runtimeAgentType = get(item, 'runtime_agent_type');
    let resolvedRuntimeAgentType: string | null = null;
    if (runtimeAgentType !== null && runtimeAgentType !== undefined) {
      if (typeof runtimeAgentType !== 'string') {
        return reject(`${at}.runtime_agent_type`, 'type_error');
      }
      if (!WIRE_LABEL.test(runtimeAgentType)) {
        return reject(`${at}.runtime_agent_type`, 'invalid_format');
      }
      if (scanUnsafe(runtimeAgentType) !== null) {
        return reject(`${at}.runtime_agent_type`, 'unsafe_content');
      }
      // Two roster seats claiming one comparison key would make the match
      // ambiguous, and the roster is what decides where an actor sits.
      if (ownProperty(seenAgentTypes, runtimeAgentType) !== undefined) {
        return reject(`${at}.runtime_agent_type`, 'duplicate_id');
      }
      seenAgentTypes[runtimeAgentType] = true;
      resolvedRuntimeAgentType = runtimeAgentType;
    }

    const orderRule = checkDisplayOrder(get(item, 'display_order'));
    if (orderRule !== null) return reject(`${at}.display_order`, orderRule);

    roleIds[id] = true;
    roles.push({
      id,
      name: get(item, 'name') as string,
      kind: kind as OrgRoleKind,
      department_id: resolvedDepartmentId,
      agent_ref: resolvedAgentRef,
      runtime_agent_type: resolvedRuntimeAgentType,
      display_order: get(item, 'display_order') as number,
    });
  }

  // ── facilities ───────────────────────────────────────────────────────────
  const facilitiesRaw = requireArray(raw, 'facilities', limits.max_facilities);
  if (!facilitiesRaw.ok) return reject(facilitiesRaw.field, facilitiesRaw.rule);
  const facilities: OrgFacility[] = [];
  const facilityIds = emptyRecord<true>();
  for (let index = 0; index < facilitiesRaw.items.length; index += 1) {
    const at = `facilities[${index}]`;
    const item = facilitiesRaw.items[index];
    if (!isPlainObject(item)) return reject(at, 'type_error');
    const idRule = checkIdentifier(get(item, 'id'));
    if (idRule !== null) return reject(`${at}.id`, idRule);
    const id = get(item, 'id') as string;
    if (ownProperty(facilityIds, id) !== undefined) return reject(`${at}.id`, 'duplicate_id');
    const nameRule = checkDisplayName(get(item, 'name'), `${at}.name`);
    if (nameRule !== null) return reject(`${at}.name`, nameRule);
    if (get(item, 'type') !== 'shared') return reject(`${at}.type`, 'invalid_format');
    const orderRule = checkDisplayOrder(get(item, 'display_order'));
    if (orderRule !== null) return reject(`${at}.display_order`, orderRule);
    facilityIds[id] = true;
    facilities.push({
      id,
      name: get(item, 'name') as string,
      type: 'shared',
      display_order: get(item, 'display_order') as number,
    });
  }

  const known = new Set(['schema_version', 'company', 'departments', 'roles', 'facilities']);
  const dropped: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) dropped.push(key);
  }

  return {
    ok: true,
    snapshot: { schema_version: schemaVersion, company, departments, roles, facilities },
    dropped_keys: dropped,
  };
}

/** Folds a validation result into the closed three-state vocabulary. */
export function orgStateFrom(result: OrgValidationResult): OrgState {
  if (result.ok) return { status: 'accepted', snapshot: result.snapshot };
  return { status: 'rejected', field: result.field, rule: result.rule };
}

/**
 * Sanitized one-line detail for health output and logs: field path and rule
 * only, on the same terms as `StateLimitExceededError.detail`.
 */
export function orgStatusDetail(state: OrgState): string {
  if (state.status === 'accepted') return 'accepted';
  if (state.status === 'absent') return 'absent';
  return `rejected:${state.field}:${state.rule}`;
}
