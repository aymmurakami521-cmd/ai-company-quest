/**
 * The value read model over HTTP.
 *
 * The boundary being tested is not "does the route work" but "what can reach
 * it, and what can it disclose": Quest holds no identity, so the safety of the
 * money surface rests on the route being read-only, loopback-only, withheld by
 * default, and entirely absent from the event stream.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { QuestServer, VALUE_SUMMARY_PATH } from '../src/server/server.ts';
import { validateValueLedger, valueLedgerStateFrom } from '../src/domain/valueLedger.ts';
import type { ValueLedgerState } from '../src/domain/valueLedger.ts';
import type { ValueDisclosure } from '../src/domain/valueDashboard.ts';
import { httpGet, makeLine, openSse } from './helpers.ts';
import { COMPANY, makeLedgerDocument } from './valueHelpers.ts';

type Harness = {
  server: QuestServer;
  port: number;
  live: NamespaceStore;
  close: () => Promise<void>;
};

function ledgerState(document: unknown = makeLedgerDocument()): ValueLedgerState {
  return valueLedgerStateFrom(validateValueLedger(document));
}

async function startServer(
  value?: { ledger: ValueLedgerState; disclosure: ValueDisclosure; source?: 'operator' | 'demo_fixture' },
): Promise<Harness> {
  const live = new NamespaceStore({ namespace: 'live' });
  const demo = new NamespaceStore({ namespace: 'demo' });
  const server = new QuestServer({ stores: { live, demo }, heartbeatMs: 60_000, value });
  const address = await server.listen(0);
  return {
    server,
    port: address.port,
    live,
    close: async () => {
      await server.close();
    },
  };
}

test('the value read model is served on loopback, read-only, with no CORS header', async () => {
  const h = await startServer({ ledger: ledgerState(), disclosure: 'full' });
  try {
    const response = await httpGet(h.port, VALUE_SUMMARY_PATH);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['access-control-allow-origin'], undefined);

    const payload = JSON.parse(response.body) as Record<string, unknown>;
    assert.equal(payload['status'], 'accepted');
    assert.equal(payload['amount_visibility'], 'full');
  } finally {
    await h.close();
  }
});

test('nothing but GET reaches it: there is no write surface for a rate', async () => {
  const h = await startServer({ ledger: ledgerState(), disclosure: 'full' });
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await httpGet(h.port, VALUE_SUMMARY_PATH, {}, method);
      assert.equal(response.status, 405, method);
      assert.equal(response.headers['allow'], 'GET', method);
      assert.deepEqual(JSON.parse(response.body), { error: 'method_not_allowed' }, method);
    }
  } finally {
    await h.close();
  }
});

test('a foreign Host cannot reach it either (DNS rebinding guard)', async () => {
  const h = await startServer({ ledger: ledgerState(), disclosure: 'full' });
  try {
    const response = await httpGet(h.port, VALUE_SUMMARY_PATH, { Host: 'evil.example' });
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), { error: 'host_not_allowed' });
  } finally {
    await h.close();
  }
});

test('restricted is what a server configured with nothing publishes', async () => {
  const h = await startServer();
  try {
    const response = await httpGet(h.port, VALUE_SUMMARY_PATH);
    assert.deepEqual(JSON.parse(response.body), {
      schema_version: 1,
      status: 'absent',
      amount_visibility: 'restricted',
      ledger_source: 'none',
    });
  } finally {
    await h.close();
  }
});

test('a restricted server publishes the structure without any amount in it', async () => {
  const h = await startServer({ ledger: ledgerState(), disclosure: 'restricted' });
  try {
    const response = await httpGet(h.port, VALUE_SUMMARY_PATH);
    const body = response.body;
    assert.ok(body.includes('"amount_withheld":true'));
    assert.ok(body.includes('創出時間価値（推定）'), 'the structure is still published');
    // The fixture's figures: the hourly rate, the derived proxy and the AI cost.
    assert.equal(body.includes('4000'), false);
    assert.equal(body.includes('8000'), false);
    assert.equal(body.includes('12000'), false);
  } finally {
    await h.close();
  }
});

test('a rejected ledger answers with a field path and a rule, and no content', async () => {
  const h = await startServer({
    // Assembled at runtime: a literal credential shape here would trip secret
    // scanners on a file whose point is that the validator refuses one.
    ledger: ledgerState(makeLedgerDocument({ policy_version: ['sk', 'ant', 'abcdefghijklmnop'].join('-') })),
    disclosure: 'full',
  });
  try {
    const response = await httpGet(h.port, VALUE_SUMMARY_PATH);
    assert.equal(response.status, 200, 'a rejected ledger is a state, not a 404');
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    assert.equal(payload['status'], 'rejected');
    assert.equal(payload['field'], 'policy_version');
    assert.equal(payload['rule'], 'unsafe_content');
    assert.equal(response.body.includes(['sk', 'ant-'].join('-')), false, 'nothing from the document is echoed');
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'dashboard'), false);
  } finally {
    await h.close();
  }
});

test('money never travels on the event stream', async () => {
  const h = await startServer({ ledger: ledgerState(), disclosure: 'full' });
  try {
    h.live.ingestLine(makeLine());
    const client = await openSse(h.port, '/events/live');
    await client.waitFor((text) => text.includes('event: snapshot'));
    const text = client.text();
    client.close();

    // The SSE snapshot is `QuestState`, which carries no rate and no value. A
    // reader on the unauthenticated stream learns nothing about money.
    for (const token of [
      'hourly_rate',
      'rate_evidence',
      'time_value_proxy',
      'realized_cost_saving',
      'amount_minor',
      'ark_fee',
      'ai_cost',
      'policy_version',
    ]) {
      assert.equal(text.includes(token), false, `the stream must not carry ${token}`);
    }
  } finally {
    await h.close();
  }
});

/** Every key name appearing anywhere in a JSON payload, at any depth. */
function keyNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keyNames(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keyNames(child, into);
    }
  }
  return into;
}

test('under restriction no amount-bearing key exists anywhere in the payload', async () => {
  const h = await startServer({ ledger: ledgerState(), disclosure: 'restricted' });
  try {
    const response = await httpGet(h.port, VALUE_SUMMARY_PATH);
    const payload = JSON.parse(response.body) as {
      dashboard: {
        sections: { value_kind: string; subtotals: Record<string, unknown>[] }[];
        costs: Record<string, Record<string, unknown>>;
        rate_trace: Record<string, unknown>[];
      };
    };
    const keys = keyNames(payload);

    // Structural rather than a substring hunt for the fixture's own numbers: a
    // newly added amount field would slip straight past a value-based check.
    for (const key of ['amount_minor', 'hourly_rate_minor', 'monthly_employer_cost_minor']) {
      assert.equal(keys.has(key), false, `${key} must not be published under restriction`);
    }
    // `total` is legitimate on a non-monetary row - minutes are not money - so
    // it is checked per section rather than banned outright.
    for (const section of payload.dashboard.sections) {
      if (section.value_kind !== 'monetary') continue;
      for (const subtotal of section.subtotals) {
        assert.equal(Object.prototype.hasOwnProperty.call(subtotal, 'total'), false);
        assert.equal(subtotal['amount_withheld'], true);
      }
    }
    for (const bucket of Object.values(payload.dashboard.costs)) {
      if (bucket['reported'] !== true) continue;
      if (bucket['cost_status'] === 'unpriced') continue;
      assert.equal(bucket['amount_withheld'], true);
    }
    for (const row of payload.dashboard.rate_trace) {
      assert.equal(row['amount_withheld'], true);
      // The audit trail itself stays readable: which scope won, in what
      // currency, for what period. None of those is an amount.
      assert.equal(typeof row['resolved_source'], 'string');
      assert.equal(typeof row['currency'], 'string');
    }
    assert.ok(keys.has('record_count'), 'the structure stays legible');
  } finally {
    await h.close();
  }
});

test('the payload is built once, so two reads are byte-identical', async () => {
  const h = await startServer({ ledger: ledgerState(), disclosure: 'full' });
  try {
    const first = await httpGet(h.port, VALUE_SUMMARY_PATH);
    const second = await httpGet(h.port, VALUE_SUMMARY_PATH);
    assert.equal(first.body, second.body);
  } finally {
    await h.close();
  }
});

test('the route is exact: no sibling path is readable', async () => {
  const h = await startServer({ ledger: ledgerState(), disclosure: 'full' });
  try {
    for (const path of ['/value', '/value/', '/value/summary/', '/value/summary/../health', '/Value/Summary']) {
      const response = await httpGet(h.port, path);
      assert.notEqual(response.status, 200, path);
    }
  } finally {
    await h.close();
  }
});

test('the disclosure level comes from configuration, never from the request', async () => {
  const h = await startServer({ ledger: ledgerState(), disclosure: 'restricted' });
  try {
    for (const query of ['?amount_visibility=full', '?disclosure=full', '?full=1']) {
      const response = await httpGet(h.port, `${VALUE_SUMMARY_PATH}${query}`);
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      assert.equal(payload['amount_visibility'], 'restricted', query);
      assert.equal(response.body.includes('4000'), false, query);
    }
  } finally {
    await h.close();
  }
});

test('health is unchanged by the value surface', async () => {
  const h = await startServer({ ledger: ledgerState(), disclosure: 'full' });
  try {
    const response = await httpGet(h.port, '/health');
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ['bind', 'namespaces', 'status', 'ui', 'uptime_ms']);
    assert.equal(response.body.includes('4000'), false, 'and it discloses no rate');
  } finally {
    await h.close();
  }
});

/**
 * A ledger that exercises everything the ratio and FX layers can publish: a
 * conversion, a converted subtotal, and two computed ratios.
 */
const AUGUST = { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' };

const CONVERTED_LEDGER = makeLedgerDocument({
  aggregation_mode: 'reporting_currency_normalized',
  fx_rates: [
    {
      from_currency: 'USD',
      to_currency: 'JPY',
      effective_from: '2026-01-01T00:00:00Z',
      from_amount_minor: 10000,
      to_amount_minor: 14825,
      fx_source: 'contract_rate',
      fx_rate_version: '2026-08',
    },
  ],
  value_records: [
    {
      record_id: 'rev-usd',
      value_metric_type: 'revenue_contribution',
      value_kind: 'monetary',
      realization_status: 'realized',
      unit: 'USD',
      quantity: 250000,
      baseline: { kind: 'prior_period', quantity: 0 },
      measurement_window: { ...AUGUST },
      attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
      attribution_method: 'operator_declared',
      confidence: 'high',
      methodology_version: 'v1',
      evidence_ref: null,
      derived_from: null,
      rate_evidence: null,
    },
  ],
  ai_cost: {
    cost_status: 'finalized',
    amount_minor: 37000,
    currency: 'JPY',
    pricing_source: 'provider_invoice',
    pricing_version: '2026-08',
    period: { ...AUGUST },
  },
});

test('a converted, ratio-bearing payload discloses no figure under restriction either', async () => {
  const h = await startServer({ ledger: ledgerState(CONVERTED_LEDGER), disclosure: 'restricted' });
  try {
    const response = await httpGet(h.port, VALUE_SUMMARY_PATH);
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    const keys = keyNames(payload);

    // Structural, like the check above: a figure added to the ratio or FX layer
    // later must be named here before it can be published.
    for (const key of [
      'amount_minor',
      'hourly_rate_minor',
      'value_minor',
      'cost_minor',
      'benefit_cost_ratio',
      'net_roi',
      'original_amount_minor',
      'converted_amount_minor',
    ]) {
      assert.equal(keys.has(key), false, `${key} must not be published under restriction`);
    }

    // The reasons and the provenance stay: without them the panel could not say
    // *why* a ratio is missing, which is the whole of §8.4.
    assert.ok(keys.has('ratio_status'), 'the reason survives');
    assert.ok(keys.has('fx_rate'), 'and so does the rate that was applied');

    // ...but a reason that *is* a figure does not. `undefined_zero_denominator`
    // states that the AI cost is exactly 0, and `computed` states that it is
    // not, so publishing either of them to this reader discloses the amount by
    // elimination. Over the wire, the served body must contain neither name.
    assert.ok(response.body.includes('withheld_by_disclosure'), 'the restriction is named');
    for (const leak of ['undefined_zero_denominator', '"computed"']) {
      assert.equal(response.body.includes(leak), false, leak);
    }

    // 250,000 USD-minor and its 370,625 JPY conversion; the 37,000 JPY cost.
    for (const amount of ['250000', '370625', '37000']) {
      assert.equal(response.body.includes(amount), false, amount);
    }
  } finally {
    await h.close();
  }
});

test('the converted payload still computes both ratios, separately, when disclosed', async () => {
  const h = await startServer({ ledger: ledgerState(CONVERTED_LEDGER), disclosure: 'full' });
  try {
    const response = await httpGet(h.port, VALUE_SUMMARY_PATH);
    const payload = JSON.parse(response.body) as {
      dashboard: {
        aggregation_mode: string;
        ratios: { realization_status: string; ratio_status: string; value_minor?: number }[];
      };
    };
    assert.equal(payload.dashboard.aggregation_mode, 'reporting_currency_normalized');
    const realized = payload.dashboard.ratios.find((row) => row.realization_status === 'realized');
    assert.ok(realized !== undefined);
    assert.equal(realized.ratio_status, 'computed');
    assert.equal(realized.value_minor, 370625, 'the converted figure, not the USD one');

    const estimated = payload.dashboard.ratios.find((row) => row.realization_status === 'estimated');
    assert.ok(estimated !== undefined);
    // The ledger's own `time_saved` sits in May, outside the August cost period.
    assert.equal(estimated.ratio_status, 'blocked_absent_value');
  } finally {
    await h.close();
  }
});
