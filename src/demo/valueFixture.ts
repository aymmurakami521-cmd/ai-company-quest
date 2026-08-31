/**
 * The DEMO value ledger.
 *
 * DEMO reads no files, so the ledger it shows is static data here rather than a
 * path - the same rule `orgFixture.ts` follows. LIVE keeps reading the
 * operator-configured document and never sees this object.
 *
 * The document is written as a raw object and put through the real validator at
 * module load, so the fixture cannot drift away from the contract it is meant
 * to demonstrate: if it ever stops being admissible, the demo shows a rejected
 * ledger instead of silently showing a ledger the validator would refuse.
 *
 * The shape is chosen so `npm run demo` alone exercises every branch of the
 * resolution chain rather than only the happy one:
 *
 * - `tv-owner-june` has a user rate, so the user scope wins over the department
 *   and the company;
 * - the same user has a *later* rate as well, and June's estimate is resolved
 *   at the end of June, so the August rate cannot reach back into it;
 * - `tv-dev-aug` has no user rate, so the department wins;
 * - `tv-plan-aug` has no user and no department rate, so the company wins;
 * - `tv-legacy-2025` sits before the company rate starts, so nothing in the
 *   policy applies and the ARK default (3,400 JPY/hour) answers - visibly, with
 *   `resolved_source: ark_default`;
 * - `tv-carried` already has its `time_value_proxy` on file at a rate nobody
 *   would resolve today, and it is carried forward untouched;
 * - `realized_cost_saving`, `revenue_contribution` and
 *   `gross_profit_contribution` are present so the screen has a realized column
 *   that the estimated proxy is visibly *not* part of;
 * - the ledger reports in JPY but holds one USD figure, and declares the
 *   operator-supplied rate that converts it, so `npm run demo` shows aggregation
 *   mode B (§7.3.1) with its conversion evidence rather than only the partition;
 * - `ai_cost` states the period it covers, which is what makes a benefit-cost
 *   ratio admissible at all (§8.2). Two ratios appear, one realized and one
 *   estimated, and they are visibly different numbers - which is the point of
 *   never summing the two.
 */

import { validateValueLedger, valueLedgerStateFrom, type ValueLedgerState } from '../domain/valueLedger.ts';

const COMPANY = 'demo-company';

/** The document exactly as an operator would write it. */
export const DEMO_VALUE_LEDGER_DOCUMENT: unknown = {
  schema_version: 1,
  policy_version: '2026-08',
  company_id: COMPANY,
  reporting_currency: 'JPY',
  aggregation_mode: 'reporting_currency_normalized',
  // Operator-supplied, like every other figure in this document. $100.00 is
  // ¥14,825 from the start of 2026; nothing fetches this and nothing updates it.
  fx_rates: [
    {
      from_currency: 'USD',
      to_currency: 'JPY',
      effective_from: '2026-01-01T00:00:00Z',
      from_amount_minor: 10000,
      to_amount_minor: 14825,
      fx_source: 'published_reference',
      fx_rate_version: '2026-08',
    },
  ],
  hourly_rates: [
    {
      scope: 'company',
      scope_id: COMPANY,
      effective_from: '2026-01-01T00:00:00Z',
      currency: 'JPY',
      basis: 'employee_cost',
      // 640,000 JPY of employer-borne monthly cost over 160 hours = 4,000/hour.
      // No individual salary is entered, and none is stored.
      input_method: 'calculated_monthly_cost',
      monthly_employer_cost_minor: 640000,
      monthly_working_hours: 160,
      source: 'operator',
    },
    {
      scope: 'department',
      scope_id: 'dept-development',
      effective_from: '2026-04-01T00:00:00Z',
      currency: 'JPY',
      basis: 'employee_cost',
      input_method: 'direct',
      hourly_rate_minor: 5200,
      source: 'operator',
    },
    {
      scope: 'user',
      scope_id: 'user-owner',
      effective_from: '2026-01-01T00:00:00Z',
      currency: 'JPY',
      // The owner is a sole proprietor: this is opportunity cost, not payroll.
      basis: 'time_value',
      input_method: 'direct',
      hourly_rate_minor: 12000,
      source: 'operator',
    },
    {
      scope: 'user',
      scope_id: 'user-owner',
      effective_from: '2026-08-01T00:00:00Z',
      currency: 'JPY',
      basis: 'time_value',
      input_method: 'direct',
      hourly_rate_minor: 15000,
      source: 'operator',
    },
  ],
  value_records: [
    {
      record_id: 'tv-owner-june',
      value_metric_type: 'time_saved',
      value_kind: 'non_monetary',
      realization_status: 'estimated',
      unit: 'minute',
      quantity: 480,
      baseline: { kind: 'manual_process_measurement', quantity: 600 },
      measurement_window: { start: '2026-06-01T00:00:00Z', end: '2026-06-30T23:59:59Z' },
      attribution_scope: { company_id: COMPANY, department_id: null, user_id: 'user-owner' },
      attribution_method: 'operator_declared',
      confidence: 'medium',
      methodology_version: 'v1',
      evidence_ref: 'demo-evidence-01',
      derived_from: null,
      rate_evidence: null,
    },
    {
      record_id: 'tv-dev-aug',
      value_metric_type: 'time_saved',
      value_kind: 'non_monetary',
      realization_status: 'realized',
      unit: 'minute',
      quantity: 300,
      baseline: { kind: 'prior_period', quantity: 420 },
      measurement_window: { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' },
      attribution_scope: { company_id: COMPANY, department_id: 'dept-development', user_id: 'user-dev-1' },
      attribution_method: 'measured_before_after',
      confidence: 'high',
      methodology_version: 'v1',
      evidence_ref: 'demo-evidence-02',
      derived_from: null,
      rate_evidence: null,
    },
    {
      record_id: 'tv-plan-aug',
      value_metric_type: 'time_saved',
      value_kind: 'non_monetary',
      realization_status: 'estimated',
      unit: 'minute',
      quantity: 120,
      baseline: { kind: 'prior_period', quantity: 180 },
      measurement_window: { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' },
      attribution_scope: { company_id: COMPANY, department_id: 'dept-planning', user_id: null },
      attribution_method: 'operator_declared',
      confidence: 'low',
      methodology_version: 'v1',
      evidence_ref: null,
      derived_from: null,
      rate_evidence: null,
    },
    {
      record_id: 'tv-legacy-2025',
      value_metric_type: 'time_saved',
      value_kind: 'non_monetary',
      realization_status: 'estimated',
      unit: 'minute',
      quantity: 240,
      baseline: { kind: 'no_ai_counterfactual', quantity: 300 },
      measurement_window: { start: '2025-12-01T00:00:00Z', end: '2025-12-31T23:59:59Z' },
      attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
      attribution_method: 'operator_declared',
      confidence: 'low',
      methodology_version: 'v1',
      evidence_ref: null,
      derived_from: null,
      rate_evidence: null,
    },
    {
      record_id: 'tv-carried',
      value_metric_type: 'time_saved',
      value_kind: 'non_monetary',
      realization_status: 'estimated',
      unit: 'minute',
      quantity: 300,
      baseline: { kind: 'manual_process_measurement', quantity: 360 },
      measurement_window: { start: '2026-07-01T00:00:00Z', end: '2026-07-31T23:59:59Z' },
      attribution_scope: { company_id: COMPANY, department_id: null, user_id: 'user-owner' },
      attribution_method: 'operator_declared',
      confidence: 'medium',
      methodology_version: 'v1',
      evidence_ref: 'demo-evidence-03',
      derived_from: null,
      rate_evidence: null,
    },
    {
      // Already computed, at a rate the current policy would not produce. It is
      // carried forward exactly as it stands: a rate edited later never
      // restates a figure somebody has already read.
      record_id: 'tv-carried#time_value_proxy',
      value_metric_type: 'time_value_proxy',
      value_kind: 'monetary',
      realization_status: 'estimated',
      unit: 'JPY',
      quantity: 45000,
      baseline: { kind: 'derived_from_time_saved', quantity: 54000 },
      measurement_window: { start: '2026-07-01T00:00:00Z', end: '2026-07-31T23:59:59Z' },
      attribution_scope: { company_id: COMPANY, department_id: null, user_id: 'user-owner' },
      attribution_method: 'derived_from_time_saved',
      confidence: 'medium',
      methodology_version: 'v1',
      evidence_ref: 'demo-evidence-03',
      derived_from: 'tv-carried',
      rate_evidence: {
        resolved_source: 'user',
        entry_source: 'operator',
        scope: 'user',
        scope_id: 'user-owner',
        hourly_rate_minor: 9000,
        currency: 'JPY',
        basis: 'time_value',
        input_method: 'direct',
        effective_from: '2025-10-01T00:00:00Z',
        effective_to: '2026-01-01T00:00:00Z',
        resolved_at: '2026-07-31T23:59:59Z',
        policy_version: '2026-07',
      },
    },
    {
      record_id: 'rc-aug',
      value_metric_type: 'realized_cost_saving',
      value_kind: 'monetary',
      realization_status: 'realized',
      unit: 'JPY',
      quantity: 150000,
      baseline: { kind: 'contract_baseline', quantity: 400000 },
      measurement_window: { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' },
      attribution_scope: { company_id: COMPANY, department_id: 'dept-development', user_id: null },
      attribution_method: 'measured_before_after',
      confidence: 'high',
      methodology_version: 'v1',
      evidence_ref: 'demo-evidence-04',
      derived_from: null,
      rate_evidence: null,
    },
    {
      record_id: 'rev-aug',
      value_metric_type: 'revenue_contribution',
      value_kind: 'monetary',
      realization_status: 'realized',
      unit: 'JPY',
      quantity: 800000,
      baseline: { kind: 'prior_period', quantity: 0 },
      measurement_window: { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' },
      attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
      attribution_method: 'operator_declared',
      confidence: 'medium',
      methodology_version: 'v1',
      evidence_ref: 'demo-evidence-05',
      derived_from: null,
      rate_evidence: null,
    },
    {
      record_id: 'gp-aug',
      value_metric_type: 'gross_profit_contribution',
      value_kind: 'monetary',
      realization_status: 'estimated',
      unit: 'JPY',
      quantity: 240000,
      baseline: { kind: 'no_ai_counterfactual', quantity: 0 },
      measurement_window: { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' },
      attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
      attribution_method: 'operator_declared',
      confidence: 'low',
      methodology_version: 'v1',
      evidence_ref: null,
      derived_from: null,
      rate_evidence: null,
    },
    {
      // Stated in USD. The reporting currency is JPY, so this one is converted
      // - visibly, with the rate above named in the FX trace.
      record_id: 'rev-usd-aug',
      value_metric_type: 'revenue_contribution',
      value_kind: 'monetary',
      realization_status: 'realized',
      unit: 'USD',
      quantity: 200000,
      baseline: { kind: 'prior_period', quantity: 0 },
      measurement_window: { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' },
      attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
      attribution_method: 'operator_declared',
      confidence: 'medium',
      methodology_version: 'v1',
      evidence_ref: 'demo-evidence-06',
      derived_from: null,
      rate_evidence: null,
    },
  ],
  ai_cost: {
    cost_status: 'finalized',
    amount_minor: 42000,
    currency: 'JPY',
    pricing_source: 'provider_invoice',
    pricing_version: '2026-08',
    // The period the invoice covers. Without it no ratio is admissible (§8.2),
    // and the screen says `blocked_scope_mismatch` rather than guessing.
    period: { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' },
  },
  ark_fee: {
    cost_status: 'estimated',
    amount_minor: 30000,
    currency: 'JPY',
    pricing_source: 'contract_rate',
    pricing_version: 'v1',
  },
};

/**
 * The fixture as the rest of the process sees it: whatever the real validator
 * made of the document above. No shortcut, no hand-built accepted state.
 */
export const DEMO_VALUE_LEDGER: ValueLedgerState = valueLedgerStateFrom(
  validateValueLedger(DEMO_VALUE_LEDGER_DOCUMENT),
);
