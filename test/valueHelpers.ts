/** Shared fixtures for the hourly-rate and value suites. Not a test file itself. */

import type { HourlyRateEntry, HourlyRatePolicy } from '../src/domain/rate.ts';
import type { ValueRecord } from '../src/domain/value.ts';

export const COMPANY = 'acme';

export function makeRateEntry(overrides: Partial<HourlyRateEntry> = {}): HourlyRateEntry {
  return {
    scope: 'company',
    scope_id: COMPANY,
    effective_from: '2026-01-01T00:00:00Z',
    currency: 'JPY',
    basis: 'employee_cost',
    input_method: 'direct',
    hourly_rate_minor: 4000,
    source: 'operator',
    ...overrides,
  };
}

export function makePolicy(
  entries: readonly HourlyRateEntry[],
  policyVersion = 'v1',
): HourlyRatePolicy {
  return { policy_version: policyVersion, entries };
}

/** A `time_saved` observation: 120 minutes saved against a 180-minute baseline. */
export function makeTimeSaved(overrides: Partial<ValueRecord> = {}): ValueRecord {
  return {
    record_id: 'ts-1',
    value_metric_type: 'time_saved',
    value_kind: 'non_monetary',
    realization_status: 'estimated',
    unit: 'minute',
    quantity: 120,
    baseline: { kind: 'manual_process_measurement', quantity: 180 },
    measurement_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-31T23:59:59Z' },
    attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
    attribution_method: 'operator_declared',
    confidence: 'medium',
    methodology_version: 'v1',
    evidence_ref: null,
    derived_from: null,
    rate_evidence: null,
    ...overrides,
  };
}

/** A monetary record of any type; the caller states the type and the status. */
export function makeMonetary(overrides: Partial<ValueRecord> = {}): ValueRecord {
  return {
    record_id: 'm-1',
    value_metric_type: 'realized_cost_saving',
    value_kind: 'monetary',
    realization_status: 'realized',
    unit: 'JPY',
    quantity: 100000,
    baseline: { kind: 'contract_baseline', quantity: 300000 },
    measurement_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-31T23:59:59Z' },
    attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
    attribution_method: 'measured_before_after',
    confidence: 'high',
    methodology_version: 'v1',
    evidence_ref: null,
    derived_from: null,
    rate_evidence: null,
    ...overrides,
  };
}

/** One admissible ledger document, as an operator would write it. */
export function makeLedgerDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    policy_version: '2026-08',
    company_id: COMPANY,
    reporting_currency: 'JPY',
    hourly_rates: [
      {
        scope: 'company',
        scope_id: COMPANY,
        effective_from: '2026-01-01T00:00:00Z',
        currency: 'JPY',
        basis: 'employee_cost',
        input_method: 'calculated_monthly_cost',
        monthly_employer_cost_minor: 640000,
        monthly_working_hours: 160,
        source: 'operator',
      },
    ],
    value_records: [
      {
        record_id: 'ts-1',
        value_metric_type: 'time_saved',
        value_kind: 'non_monetary',
        realization_status: 'estimated',
        unit: 'minute',
        quantity: 120,
        baseline: { kind: 'manual_process_measurement', quantity: 180 },
        measurement_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-31T23:59:59Z' },
        attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
        attribution_method: 'operator_declared',
        confidence: 'medium',
        methodology_version: 'v1',
        evidence_ref: null,
        derived_from: null,
        rate_evidence: null,
      },
    ],
    ai_cost: {
      cost_status: 'finalized',
      amount_minor: 12000,
      currency: 'JPY',
      pricing_source: 'provider_invoice',
      pricing_version: '2026-08',
    },
    ark_fee: null,
    ...overrides,
  };
}
