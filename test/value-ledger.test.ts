/**
 * The value-ledger document boundary.
 *
 * The ledger is the *only* way rates and value records enter this process, so
 * these tests are about admission: what a document may say, what it may not,
 * and what a rejection is allowed to reveal about a document that carried
 * money.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VALUE_LEDGER_LIMITS,
  SUPPORTED_VALUE_LEDGER_SCHEMA_VERSION,
  validateValueLedger,
  valueLedgerStateFrom,
  valueLedgerStatusDetail,
  VALUE_LEDGER_ABSENT,
} from '../src/domain/valueLedger.ts';
import { loadValueLedgerState } from '../src/collector/valueLedgerLoader.ts';
import { COMPANY, makeLedgerDocument } from './valueHelpers.ts';

function accept(document: unknown) {
  const result = validateValueLedger(document);
  assert.ok(result.ok, `expected acceptance, got ${JSON.stringify(result)}`);
  return result;
}

function refuse(document: unknown): { field: string; rule: string } {
  const result = validateValueLedger(document);
  assert.equal(result.ok, false, 'expected refusal');
  if (result.ok) throw new Error('unreachable');
  return { field: result.field, rule: result.rule };
}

test('a well-formed ledger is accepted and unknown keys are dropped, not forwarded', () => {
  const result = accept(makeLedgerDocument({ org_definition_hash: 'sha256:abc', notes: 'ignored' }));
  assert.deepEqual([...result.dropped_keys].sort(), ['notes', 'org_definition_hash']);
  assert.equal(result.ledger.company_id, COMPANY);
  assert.equal(result.ledger.policy_version, '2026-08');
  assert.equal(result.ledger.rate_policy.policy_version, '2026-08');
  assert.equal(Object.prototype.hasOwnProperty.call(result.ledger, 'notes'), false);
});

test('only the supported schema version is interpreted at all', () => {
  assert.equal(SUPPORTED_VALUE_LEDGER_SCHEMA_VERSION, 1);
  assert.deepEqual(refuse(makeLedgerDocument({ schema_version: 2 })), {
    field: 'schema_version',
    rule: 'unsupported_schema',
  });
  assert.deepEqual(refuse('a ledger'), { field: '(root)', rule: 'not_object' });
});

// ----------------------------------------------------------- rate entries ---

test('a direct entry states the rate and a calculated one states the monthly cost', () => {
  const direct = accept(
    makeLedgerDocument({
      hourly_rates: [
        {
          scope: 'company',
          scope_id: COMPANY,
          effective_from: '2026-01-01T00:00:00Z',
          currency: 'JPY',
          basis: 'employee_cost',
          input_method: 'direct',
          hourly_rate_minor: 4200,
          source: 'operator',
        },
      ],
    }),
  );
  const directEntry = direct.ledger.rate_policy.entries[0];
  assert.ok(directEntry !== undefined);
  assert.equal(directEntry.hourly_rate_minor, 4200);
  assert.equal(directEntry.input_method, 'direct');

  // The default fixture is the calculated form: 640,000 over 160 hours.
  const calculated = accept(makeLedgerDocument());
  const entry = calculated.ledger.rate_policy.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.hourly_rate_minor, 4000);
  assert.equal(entry.input_method, 'calculated_monthly_cost');
  // The employer-borne monthly figure produced the rate and is then dropped:
  // holding it would keep a more sensitive number than the one it produced.
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'calculation'), false);
  assert.equal(JSON.stringify(calculated.ledger).includes('640000'), false);
});

test('the owner basis is time value, and it is stored apart from employee cost', () => {
  const result = accept(
    makeLedgerDocument({
      hourly_rates: [
        {
          scope: 'user',
          scope_id: 'owner',
          effective_from: '2026-01-01T00:00:00Z',
          currency: 'JPY',
          basis: 'time_value',
          input_method: 'direct',
          hourly_rate_minor: 12000,
          source: 'operator',
        },
      ],
    }),
  );
  const entry = result.ledger.rate_policy.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.basis, 'time_value');
});

test('an operator cannot claim the fallback basis or the fallback input method', () => {
  const withBasis = makeLedgerDocument({
    hourly_rates: [
      {
        scope: 'company',
        scope_id: COMPANY,
        effective_from: '2026-01-01T00:00:00Z',
        currency: 'JPY',
        basis: 'fallback_proxy',
        input_method: 'direct',
        hourly_rate_minor: 4000,
        source: 'operator',
      },
    ],
  });
  assert.deepEqual(refuse(withBasis), { field: 'hourly_rates[0].basis', rule: 'invalid_format' });

  const withMethod = makeLedgerDocument({
    hourly_rates: [
      {
        scope: 'company',
        scope_id: COMPANY,
        effective_from: '2026-01-01T00:00:00Z',
        currency: 'JPY',
        basis: 'employee_cost',
        input_method: 'ark_default',
        hourly_rate_minor: 4000,
        source: 'operator',
      },
    ],
  });
  assert.deepEqual(refuse(withMethod), {
    field: 'hourly_rates[0].input_method',
    rule: 'invalid_format',
  });
});

test('mixing the two input methods is refused rather than partly honoured', () => {
  const mixed = makeLedgerDocument({
    hourly_rates: [
      {
        scope: 'company',
        scope_id: COMPANY,
        effective_from: '2026-01-01T00:00:00Z',
        currency: 'JPY',
        basis: 'employee_cost',
        input_method: 'direct',
        hourly_rate_minor: 4000,
        monthly_employer_cost_minor: 640000,
        monthly_working_hours: 160,
        source: 'operator',
      },
    ],
  });
  assert.deepEqual(refuse(mixed), {
    field: 'hourly_rates[0].input_method',
    rule: 'contract_violation',
  });
});

test('zero, negative, NaN and non-integer rates are all refused, never stored as 0', () => {
  for (const value of [0, -1, 1.5]) {
    const document = makeLedgerDocument({
      hourly_rates: [
        {
          scope: 'company',
          scope_id: COMPANY,
          effective_from: '2026-01-01T00:00:00Z',
          currency: 'JPY',
          basis: 'employee_cost',
          input_method: 'direct',
          hourly_rate_minor: value,
          source: 'operator',
        },
      ],
    });
    assert.deepEqual(refuse(document), {
      field: 'hourly_rates[0].hourly_rate_minor',
      rule: 'invalid_format',
    });
  }
  // NaN cannot survive JSON, so it is checked through the object path.
  const nan = makeLedgerDocument({
    hourly_rates: [
      {
        scope: 'company',
        scope_id: COMPANY,
        effective_from: '2026-01-01T00:00:00Z',
        currency: 'JPY',
        basis: 'employee_cost',
        input_method: 'direct',
        hourly_rate_minor: Number.NaN,
        source: 'operator',
      },
    ],
  });
  assert.equal(refuse(nan).rule, 'invalid_format');
});

test('a bad ISO 4217 currency is refused', () => {
  const document = makeLedgerDocument({
    hourly_rates: [
      {
        scope: 'company',
        scope_id: COMPANY,
        effective_from: '2026-01-01T00:00:00Z',
        currency: 'yen',
        basis: 'employee_cost',
        input_method: 'direct',
        hourly_rate_minor: 4000,
        source: 'operator',
      },
    ],
  });
  assert.deepEqual(refuse(document), { field: 'hourly_rates[0].currency', rule: 'invalid_format' });
});

test('two entries starting at the same instant for one scope are ambiguous, so refused', () => {
  const entry = {
    scope: 'company',
    scope_id: COMPANY,
    effective_from: '2026-01-01T00:00:00Z',
    currency: 'JPY',
    basis: 'employee_cost',
    input_method: 'direct',
    hourly_rate_minor: 4000,
    source: 'operator',
  };
  assert.deepEqual(refuse(makeLedgerDocument({ hourly_rates: [entry, { ...entry, hourly_rate_minor: 5000 }] })), {
    field: 'hourly_rates[1].effective_from',
    rule: 'duplicate_id',
  });

  // The same instant written with a different offset is the same instant.
  // Comparing the text would admit both and leave `matchScope` deciding by
  // array position, so the pair is refused in either order.
  const shifted = { ...entry, effective_from: '2026-01-01T09:00:00+09:00', hourly_rate_minor: 9000 };
  assert.deepEqual(refuse(makeLedgerDocument({ hourly_rates: [entry, shifted] })), {
    field: 'hourly_rates[1].effective_from',
    rule: 'duplicate_id',
  });
  assert.deepEqual(refuse(makeLedgerDocument({ hourly_rates: [shifted, entry] })), {
    field: 'hourly_rates[1].effective_from',
    rule: 'duplicate_id',
  });
});

test('a company-scoped rate for a different company is refused', () => {
  const document = makeLedgerDocument({
    hourly_rates: [
      {
        scope: 'company',
        scope_id: 'someone-else',
        effective_from: '2026-01-01T00:00:00Z',
        currency: 'JPY',
        basis: 'employee_cost',
        input_method: 'direct',
        hourly_rate_minor: 4000,
        source: 'operator',
      },
    ],
  });
  assert.deepEqual(refuse(document), { field: 'hourly_rates[0].scope_id', rule: 'unknown_reference' });
});

// ---------------------------------------------------------- value records ---

function withRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  const base = makeLedgerDocument();
  const records = base['value_records'] as Record<string, unknown>[];
  const first = records[0] as Record<string, unknown>;
  return makeLedgerDocument({ value_records: [{ ...first, ...overrides }] });
}

test('a record booked to another company is refused', () => {
  assert.deepEqual(
    refuse(
      withRecord({
        attribution_scope: { company_id: 'other', department_id: null, user_id: null },
      }),
    ),
    { field: 'value_records[0].attribution_scope.company_id', rule: 'unknown_reference' },
  );
});

test('the cross-field contract is enforced on the document, not only in code', () => {
  const refused = refuse(withRecord({ value_metric_type: 'time_value_proxy', value_kind: 'monetary' }));
  assert.equal(refused.rule, 'contract_violation');
  assert.ok(refused.field.startsWith('value_records[0].'), 'the failing rule is named by path');
});

test('two proxies for one observation would double the subtotal, so are refused', () => {
  const base = makeLedgerDocument();
  const records = base['value_records'] as Record<string, unknown>[];
  const source = records[0] as Record<string, unknown>;
  const proxy = {
    ...source,
    record_id: 'p-1',
    value_metric_type: 'time_value_proxy',
    value_kind: 'monetary',
    realization_status: 'estimated',
    unit: 'JPY',
    quantity: 8000,
    baseline: { kind: 'derived_from_time_saved', quantity: 12000 },
    attribution_method: 'derived_from_time_saved',
    derived_from: 'ts-1',
    rate_evidence: {
      resolved_source: 'company',
      entry_source: 'operator',
      scope: 'company',
      scope_id: COMPANY,
      hourly_rate_minor: 4000,
      currency: 'JPY',
      basis: 'employee_cost',
      input_method: 'direct',
      effective_from: '2026-01-01T00:00:00Z',
      effective_to: null,
      resolved_at: '2026-05-31T23:59:59Z',
      policy_version: '2026-08',
    },
  };
  accept(makeLedgerDocument({ value_records: [source, proxy] }));
  assert.deepEqual(
    refuse(makeLedgerDocument({ value_records: [source, proxy, { ...proxy, record_id: 'p-2' }] })),
    { field: 'value_records[2].derived_from', rule: 'duplicate_id' },
  );
});

test('a proxy pointing at a record that does not exist is refused', () => {
  const base = makeLedgerDocument();
  const records = base['value_records'] as Record<string, unknown>[];
  const source = records[0] as Record<string, unknown>;
  const orphan = {
    ...source,
    record_id: 'p-1',
    value_metric_type: 'time_value_proxy',
    value_kind: 'monetary',
    realization_status: 'estimated',
    unit: 'JPY',
    quantity: 8000,
    baseline: { kind: 'derived_from_time_saved', quantity: 12000 },
    attribution_method: 'derived_from_time_saved',
    derived_from: 'nothing-here',
    rate_evidence: {
      resolved_source: 'ark_default',
      entry_source: null,
      scope: null,
      scope_id: null,
      hourly_rate_minor: 3400,
      currency: 'JPY',
      basis: 'fallback_proxy',
      input_method: 'ark_default',
      effective_from: null,
      effective_to: null,
      resolved_at: '2026-05-31T23:59:59Z',
      policy_version: '2026-08',
    },
  };
  assert.deepEqual(refuse(makeLedgerDocument({ value_records: [source, orphan] })), {
    field: 'value_records[1].derived_from',
    rule: 'unknown_reference',
  });
});

test('stored rate evidence has to be internally consistent to be trusted', () => {
  const base = makeLedgerDocument();
  const records = base['value_records'] as Record<string, unknown>[];
  const source = records[0] as Record<string, unknown>;
  const proxy = {
    ...source,
    record_id: 'p-1',
    value_metric_type: 'time_value_proxy',
    value_kind: 'monetary',
    realization_status: 'estimated',
    unit: 'JPY',
    quantity: 8000,
    baseline: { kind: 'derived_from_time_saved', quantity: 12000 },
    attribution_method: 'derived_from_time_saved',
    derived_from: 'ts-1',
    rate_evidence: {
      // The fallback belongs to no scope; claiming one would fake a provenance.
      resolved_source: 'ark_default',
      entry_source: null,
      scope: 'company',
      scope_id: COMPANY,
      hourly_rate_minor: 3400,
      currency: 'JPY',
      basis: 'fallback_proxy',
      input_method: 'ark_default',
      effective_from: null,
      effective_to: null,
      resolved_at: '2026-05-31T23:59:59Z',
      policy_version: '2026-08',
    },
  };
  assert.deepEqual(refuse(makeLedgerDocument({ value_records: [source, proxy] })), {
    field: 'value_records[1].rate_evidence.scope',
    rule: 'contract_violation',
  });
});

// ------------------------------------------------------------ cost buckets ---

test('unpriced is not zero: it may carry no amount, and a finalized one must', () => {
  accept(
    makeLedgerDocument({
      ai_cost: { cost_status: 'unpriced', amount_minor: null, currency: null, pricing_source: null },
    }),
  );
  assert.equal(
    refuse(
      makeLedgerDocument({
        ai_cost: {
          cost_status: 'unpriced',
          amount_minor: 0,
          currency: 'JPY',
          pricing_source: 'provider_invoice',
        },
      }),
    ).rule,
    'contract_violation',
  );
  assert.equal(
    refuse(
      makeLedgerDocument({
        ai_cost: { cost_status: 'finalized', amount_minor: null, currency: 'JPY', pricing_source: 'price_list' },
      }),
    ).rule,
    'contract_violation',
  );
  // A confirmed zero really is a finalized amount of zero.
  accept(
    makeLedgerDocument({
      ai_cost: {
        cost_status: 'finalized',
        amount_minor: 0,
        currency: 'JPY',
        pricing_source: 'provider_invoice',
      },
    }),
  );
});

// ------------------------------------------------------- what a refusal says ---

test('a refusal names a field path and a rule, and never a value from the document', () => {
  // Assembled at runtime: a literal here matches this repo's own `anthropic_key`
  // rule and would trip secret scanners on a file whose point is that the
  // validator refuses such a string.
  const secret = ['sk', 'ant', 'abcdefghijklmnop'].join('-');
  const refused = refuse(makeLedgerDocument({ policy_version: secret }));
  assert.equal(refused.rule, 'unsafe_content');
  assert.equal(refused.field, 'policy_version');
  const text = JSON.stringify(refused);
  assert.equal(text.includes(secret), false, 'nothing from the document is echoed back');
  assert.equal(text.includes('4000'), false, 'and no amount either');
});

test('an absolute path in an identifier is refused like it is on the event path', () => {
  assert.equal(refuse(makeLedgerDocument({ company_id: '/Users/someone/ledger' })).rule, 'invalid_format');
});

test('limits reject an oversized document rather than truncating it', () => {
  const entry = {
    scope: 'user',
    scope_id: 'u-1',
    effective_from: '2026-01-01T00:00:00Z',
    currency: 'JPY',
    basis: 'employee_cost',
    input_method: 'direct',
    hourly_rate_minor: 4000,
    source: 'operator',
  };
  const many = Array.from({ length: DEFAULT_VALUE_LEDGER_LIMITS.max_rate_entries + 1 }, () => entry);
  assert.deepEqual(refuse(makeLedgerDocument({ hourly_rates: many })), {
    field: 'hourly_rates',
    rule: 'limit_exceeded',
  });
});

test('the three-state vocabulary is reported distinctly, and absent is not a failure', () => {
  assert.deepEqual(VALUE_LEDGER_ABSENT, { status: 'absent' });
  assert.equal(valueLedgerStatusDetail(VALUE_LEDGER_ABSENT), 'absent');
  assert.equal(valueLedgerStatusDetail(valueLedgerStateFrom(validateValueLedger(makeLedgerDocument()))), 'accepted');
  assert.equal(
    valueLedgerStatusDetail(valueLedgerStateFrom(validateValueLedger({ schema_version: 9 }))),
    'rejected:schema_version:unsupported_schema',
  );
});

// ------------------------------------------------------------------ loader ---

test('no configured path is absent, which is a supported mode', async () => {
  assert.deepEqual(await loadValueLedgerState({ path: null }), { status: 'absent' });
});

test('an unreadable or unparseable file is rejected without naming the path', async () => {
  const failing = await loadValueLedgerState({
    path: '/nowhere/ledger.json',
    readForTest: () => Promise.reject(new Error('ENOENT: /nowhere/ledger.json')),
  });
  assert.deepEqual(failing, { status: 'rejected', field: '(file)', rule: 'unreadable' });

  const garbage = await loadValueLedgerState({
    path: '/nowhere/ledger.json',
    readForTest: () => Promise.resolve(new TextEncoder().encode('{ not json')),
  });
  assert.deepEqual(garbage, { status: 'rejected', field: '(file)', rule: 'not_object' });
});

test('the byte ceiling is a limit, not a report', async () => {
  const oversized = await loadValueLedgerState({
    path: '/nowhere/ledger.json',
    maxBytes: 16,
    readForTest: (_path, maxBytes) => Promise.resolve(new Uint8Array(maxBytes + 1)),
  });
  assert.deepEqual(oversized, { status: 'rejected', field: '(file)', rule: 'limit_exceeded' });
});

test('a valid document read from bytes becomes an accepted ledger', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(makeLedgerDocument()));
  const state = await loadValueLedgerState({
    path: '/nowhere/ledger.json',
    readForTest: () => Promise.resolve(bytes),
  });
  assert.equal(state.status, 'accepted');
});

test('malformed UTF-8 is a rejected document, not one repaired with U+FFFD', async () => {
  const state = await loadValueLedgerState({
    path: '/nowhere/ledger.json',
    readForTest: () => Promise.resolve(new Uint8Array([0x7b, 0xff, 0x7d])),
  });
  assert.deepEqual(state, { status: 'rejected', field: '(file)', rule: 'not_object' });
});

test('a stored proxy is checked against the observation and the rate it claims', () => {
  const base = makeLedgerDocument();
  const records = base['value_records'] as Record<string, unknown>[];
  const source = records[0] as Record<string, unknown>;
  const evidence = {
    resolved_source: 'company',
    entry_source: 'operator',
    scope: 'company',
    scope_id: COMPANY,
    hourly_rate_minor: 4000,
    currency: 'JPY',
    basis: 'employee_cost',
    input_method: 'direct',
    effective_from: '2026-01-01T00:00:00Z',
    effective_to: null,
    resolved_at: '2026-05-31T23:59:59Z',
    policy_version: '2026-08',
  };
  // 120 minutes at 4,000/hour is 8,000; the 180-minute baseline is 12,000.
  const proxy = {
    ...source,
    record_id: 'p-1',
    value_metric_type: 'time_value_proxy',
    value_kind: 'monetary',
    realization_status: 'estimated',
    unit: 'JPY',
    quantity: 8000,
    baseline: { kind: 'derived_from_time_saved', quantity: 12000 },
    attribution_method: 'derived_from_time_saved',
    derived_from: 'ts-1',
    rate_evidence: evidence,
  };
  accept(makeLedgerDocument({ value_records: [source, proxy] }));

  // The whole point of carrying a proxy forward untouched is that it was
  // computed from the rate it names. An amount that does not follow from that
  // rate would otherwise be sheltered by "we already computed this".
  // 9,000 is individually admissible - under the baseline, an integer, in JPY -
  // and is still not what 120 minutes at 4,000/hour comes to.
  assert.deepEqual(refuse(makeLedgerDocument({ value_records: [source, { ...proxy, quantity: 9000 }] })), {
    field: 'value_records[1].quantity',
    rule: 'contract_violation',
  });
  assert.deepEqual(
    refuse(
      makeLedgerDocument({
        value_records: [source, { ...proxy, baseline: { kind: 'derived_from_time_saved', quantity: 20000 } }],
      }),
    ),
    { field: 'value_records[1].baseline.quantity', rule: 'contract_violation' },
  );
  assert.deepEqual(
    refuse(
      makeLedgerDocument({
        value_records: [
          source,
          {
            ...proxy,
            measurement_window: { start: '2026-04-01T00:00:00Z', end: '2026-04-30T23:59:59Z' },
          },
        ],
      }),
    ),
    { field: 'value_records[1].measurement_window', rule: 'contract_violation' },
  );
  assert.deepEqual(
    refuse(
      makeLedgerDocument({
        value_records: [
          source,
          {
            ...proxy,
            attribution_scope: { company_id: COMPANY, department_id: 'dev', user_id: null },
          },
        ],
      }),
    ),
    { field: 'value_records[1].attribution_scope', rule: 'contract_violation' },
  );
});

test('stored evidence must name who supplied it, and the fallback must not', () => {
  const base = makeLedgerDocument();
  const records = base['value_records'] as Record<string, unknown>[];
  const source = records[0] as Record<string, unknown>;
  const proxy = {
    ...source,
    record_id: 'p-1',
    value_metric_type: 'time_value_proxy',
    value_kind: 'monetary',
    realization_status: 'estimated',
    unit: 'JPY',
    quantity: 8000,
    baseline: { kind: 'derived_from_time_saved', quantity: 12000 },
    attribution_method: 'derived_from_time_saved',
    derived_from: 'ts-1',
    rate_evidence: {
      resolved_source: 'company',
      scope: 'company',
      scope_id: COMPANY,
      hourly_rate_minor: 4000,
      currency: 'JPY',
      basis: 'employee_cost',
      input_method: 'direct',
      effective_from: '2026-01-01T00:00:00Z',
      effective_to: null,
      resolved_at: '2026-05-31T23:59:59Z',
      policy_version: '2026-08',
    },
  };
  // A scoped entry always came from somebody.
  assert.deepEqual(refuse(makeLedgerDocument({ value_records: [source, proxy] })), {
    field: 'value_records[1].rate_evidence.entry_source',
    rule: 'contract_violation',
  });
});

test('a calculated entry whose quotient is unusable names the entry, not a banned key', () => {
  // `hourly_rate_minor` is a key a `calculated_monthly_cost` entry is refused
  // for *having*, so a rejection may not name it as the failing field.
  const document = makeLedgerDocument({
    hourly_rates: [
      {
        scope: 'company',
        scope_id: COMPANY,
        effective_from: '2026-01-01T00:00:00Z',
        currency: 'JPY',
        basis: 'employee_cost',
        input_method: 'calculated_monthly_cost',
        monthly_employer_cost_minor: 1,
        monthly_working_hours: 744,
        source: 'operator',
      },
    ],
  });
  assert.deepEqual(refuse(document), { field: 'hourly_rates[0]', rule: 'contract_violation' });
});

test('an unreadable file and a malformed document are told apart', async () => {
  const unreadable = await loadValueLedgerState({
    path: '/nowhere/ledger.json',
    readForTest: () => Promise.reject(new Error('ENOENT')),
  });
  const malformed = await loadValueLedgerState({
    path: '/nowhere/ledger.json',
    readForTest: () => Promise.resolve(new TextEncoder().encode('{ not json')),
  });
  assert.equal(unreadable.status, 'rejected');
  assert.equal(malformed.status, 'rejected');
  if (unreadable.status !== 'rejected' || malformed.status !== 'rejected') return;
  assert.notEqual(
    unreadable.rule,
    malformed.rule,
    'a typo in the path and a broken ledger must not produce the same line',
  );
  assert.equal(valueLedgerStatusDetail(unreadable), 'rejected:(file):unreadable');
  assert.equal(valueLedgerStatusDetail(malformed), 'rejected:(file):not_object');
});
