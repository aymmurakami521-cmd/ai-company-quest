/**
 * The ROI panel the browser actually loads.
 *
 * `quest-value.js` is shipped as-is, so these tests import the same file the
 * page does. Nothing here touches the DOM: `selectValuePanel` is a pure
 * function from the published payload to rows of text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AMOUNT_WITHHELD,
  MAX_RATE_TRACE_ROWS,
  MINOR_UNIT_EXPONENTS,
  NOT_PRICED,
  NO_RECORDS,
  formatMinor,
  formatMinutes,
  selectValuePanel,
} from '../src/ui/public/quest-value.js';
import type { ValuePanel, ValueRow } from '../src/ui/public/quest-value.js';
import {
  MINOR_UNIT_EXPONENTS as DOMAIN_MINOR_UNIT_EXPONENTS,
  minorUnitExponent,
} from '../src/domain/rate.ts';
import { buildValueSummary } from '../src/domain/valueDashboard.ts';
import { DEMO_VALUE_LEDGER } from '../src/demo/valueFixture.ts';
import { UI_ASSET_PATHS, uiAsset } from '../src/ui/assets.ts';

const AT = '2026-09-01T00:00:00Z';

function assetText(pathname: string): string {
  const asset = uiAsset(pathname);
  assert.ok(asset !== null, `${pathname} is served`);
  return asset.body.toString('utf8');
}

const HTML = assetText('/');
const APP = assetText('/ui/quest-app.js');

function panelFor(disclosure: 'restricted' | 'full'): ValuePanel {
  // The demo fixture belongs to the DEMO tab, so that is where it is read.
  return selectValuePanel(buildValueSummary(DEMO_VALUE_LEDGER, disclosure, AT, 'demo_fixture'), 'demo');
}

function rowFor(panel: ValuePanel, prefix: string): ValueRow {
  const found = panel.rows.find((row) => row.code.startsWith(prefix));
  assert.ok(found !== undefined, `a row for ${prefix}`);
  return found;
}

// ------------------------------------------------------------ formatting ---

test('amounts are grouped without ICU, so the same payload renders identically anywhere', () => {
  assert.equal(formatMinor(188600, 'JPY'), '188,600 JPY');
  assert.equal(formatMinor(0, 'JPY'), '0 JPY');
  assert.equal(formatMinor(1, 'JPY'), '1 JPY');
  assert.equal(formatMinor(1234567890, 'JPY'), '1,234,567,890 JPY');
  // Two-decimal currencies keep their minor unit rather than being rounded away.
  assert.equal(formatMinor(8500, 'USD'), '85.00 USD');
  assert.equal(formatMinor(5, 'USD'), '0.05 USD');
  assert.equal(formatMinor(-250, 'USD'), '-2.50 USD');
  assert.equal(formatMinor(1000, 'KWD'), '1.000 KWD');
});

test('a malformed amount produces no text rather than NaN on the screen', () => {
  assert.equal(formatMinor(1.5, 'JPY'), null);
  assert.equal(formatMinor(Number.NaN, 'JPY'), null);
  assert.equal(formatMinor(undefined, 'JPY'), null);
  assert.equal(formatMinor(100, ''), null);
});

test('minutes are shown as time, never as money', () => {
  assert.equal(formatMinutes(45), '45分');
  assert.equal(formatMinutes(60), '1時間');
  assert.equal(formatMinutes(1140), '19時間');
  assert.equal(formatMinutes(125), '2時間5分');
  assert.equal(formatMinutes(-1), null);
});

test('the browser copy of the minor-unit table agrees with the domain, both ways', () => {
  // Both directions on purpose. Walking only the browser table would miss a
  // currency added to the domain and not here, which would then render with the
  // wrong number of decimals and no test would notice.
  assert.deepEqual(
    { ...MINOR_UNIT_EXPONENTS },
    { ...DOMAIN_MINOR_UNIT_EXPONENTS },
    'the two copies are the same table',
  );
  for (const [currency, exponent] of Object.entries(MINOR_UNIT_EXPONENTS)) {
    assert.equal(minorUnitExponent(currency), exponent, currency);
  }
  // And the shared default for everything else.
  assert.equal(minorUnitExponent('EUR'), 2);
  assert.equal(Object.prototype.hasOwnProperty.call(MINOR_UNIT_EXPONENTS, 'EUR'), false);
});

// ----------------------------------------------------------- panel states ---

test('a read model that could not be fetched is a state, not an empty panel', () => {
  const panel = selectValuePanel(null, 'live');
  assert.equal(panel.code, 'unreachable');
  assert.ok(panel.headline.length > 0);
  assert.deepEqual(panel.rows, []);
});

test('an unsupported schema is refused rather than partly rendered', () => {
  const panel = selectValuePanel({ schema_version: 2, status: 'accepted' }, 'live');
  assert.equal(panel.code, 'unsupported');
  assert.deepEqual(panel.rows, []);
});

test('an absent ledger says so and explains how to configure one', () => {
  const panel = selectValuePanel(buildValueSummary({ status: 'absent' }, 'restricted', AT), 'live');
  assert.equal(panel.code, 'absent');
  assert.ok(panel.headline.includes('未設定'));
  assert.ok(panel.visibility_label.includes('制限中'));
});

test('a rejected ledger shows a field path and a rule, and nothing from the document', () => {
  const panel = selectValuePanel({
    schema_version: 1,
    status: 'rejected',
    amount_visibility: 'full',
    ledger_source: 'operator',
    field: 'hourly_rates[2].hourly_rate_minor',
    rule: 'invalid_format',
  }, 'live');
  assert.equal(panel.code, 'rejected');
  assert.equal(panel.detail, 'hourly_rates[2].hourly_rate_minor / invalid_format');
  assert.deepEqual(panel.rows, []);
});

// ------------------------------------------------------------- the values ---

test('the proxy row is labelled 推定 and never as a realized saving', () => {
  const panel = panelFor('full');
  const proxy = rowFor(panel, 'value-time_value_proxy');
  assert.equal(proxy.label, '創出時間価値（推定）');
  assert.equal(proxy.status_label, '推定');
  assert.equal(proxy.value_text, '188,600 JPY');

  const realized = rowFor(panel, 'value-realized_cost_saving');
  assert.equal(realized.label, '実現削減額');
  assert.equal(realized.status_label, '実現');
  assert.equal(realized.value_text, '150,000 JPY');

  // Two rows, two amounts, never one sum.
  assert.notEqual(proxy.code, realized.code);
  assert.equal(
    panel.rows.some((row) => row.value_text === '338,600 JPY'),
    false,
    'no row adds the estimate to the realized saving',
  );
});

test('time saved is shown as time, in its own row', () => {
  const panel = panelFor('full');
  const saved = panel.rows.filter((row) => row.code.startsWith('value-time_saved'));
  assert.equal(saved.length, 2, 'realized and estimated observations stay apart');
  for (const row of saved) {
    assert.ok(row.value_text.includes('時間') || row.value_text.includes('分'), row.value_text);
  }
});

test('a withheld amount reads 非表示, never 0 and never a blank cell', () => {
  const panel = panelFor('restricted');
  const proxy = rowFor(panel, 'value-time_value_proxy');
  assert.equal(proxy.value_text, AMOUNT_WITHHELD);
  assert.equal(proxy.status_label, '推定', 'the structure is still legible');
  assert.ok(panel.visibility_label.includes('0円ではありません'));

  // Nothing anywhere in the rendered panel is a figure from the ledger.
  const text = JSON.stringify(panel);
  for (const amount of ['188,600', '150,000', '12,000', '3,400']) {
    assert.equal(text.includes(amount), false, amount);
  }
});

test('minutes stay visible while money is withheld', () => {
  const panel = panelFor('restricted');
  const saved = panel.rows.filter((row) => row.code.startsWith('value-time_saved'));
  assert.ok(saved.length > 0);
  for (const row of saved) assert.notEqual(row.value_text, AMOUNT_WITHHELD);
});

test('a metric with no records says 記録なし rather than showing a zero', () => {
  const panel = panelFor('full');
  const empty = rowFor(panel, 'value-quality_error_reduction');
  assert.equal(empty.value_text, NO_RECORDS);
});

test('cost rows keep their cost_status and are never mixed into value', () => {
  const panel = panelFor('full');
  const ai = rowFor(panel, 'cost-ai');
  assert.equal(ai.group, 'cost');
  assert.equal(ai.label, 'AI関連コスト');
  assert.equal(ai.status_label, '確定');
  assert.equal(ai.value_text, '42,000 JPY');

  const ark = rowFor(panel, 'cost-ark');
  assert.equal(ark.label, 'ARK利用料');
  assert.equal(ark.status_label, '見積');
  assert.equal(ark.value_text, '30,000 JPY');

  for (const row of panel.rows) {
    if (row.group !== 'value') continue;
    assert.notEqual(row.label, 'AI関連コスト');
    assert.notEqual(row.label, 'ARK利用料');
  }
});

test('an unpriced cost reads 金額未確定, which is not zero', () => {
  const panel = selectValuePanel({
    schema_version: 1,
    status: 'accepted',
    amount_visibility: 'full',
    ledger_source: 'operator',
    dashboard: {
      schema_version: 1,
      generated_at: AT,
      policy_version: 'v1',
      company_id: 'acme',
      reporting_currency: 'JPY',
      amount_visibility: 'full',
      aggregation_mode: 'currency_partition',
      measurement_window: null,
      sections: [],
      costs: {
        ai_cost: {
          label: 'AI関連コスト',
          reported: true,
          cost_status: 'unpriced',
          currency: null,
          pricing_source: null,
          pricing_version: null,
        },
        ark_fee: {
          label: 'ARK利用料',
          reported: false,
          cost_status: null,
          currency: null,
          pricing_source: null,
          pricing_version: null,
        },
      },
      rate_trace: [],
      unavailable: [],
      derivation: { derived: 0, carried_forward: 0 },
      notes: [],
    },
  }, 'live');
  assert.equal(rowFor(panel, 'cost-ai').value_text, NOT_PRICED);
  assert.equal(rowFor(panel, 'cost-ark').value_text, NO_RECORDS);
});

test('the rate trace names the scope that won and the period it applied for', () => {
  const panel = panelFor('full');
  const rows = panel.rows.filter((row) => row.group === 'rate');
  assert.ok(rows.length > 0 && rows.length <= MAX_RATE_TRACE_ROWS + 1);
  const fallback = rows.find((row) => row.label === 'tv-legacy-2025');
  assert.ok(fallback !== undefined);
  assert.equal(fallback.status_label, 'ARK既定（fallback）');
  assert.ok(fallback.value_text.includes('3,400 JPY'));
  assert.ok(fallback.note.includes('適用期間'));

  const owner = rows.find((row) => row.label === 'tv-owner-june');
  assert.ok(owner !== undefined);
  assert.equal(owner.status_label, 'ユーザー単価');
  assert.ok(owner.note.includes('時間価値'), 'the basis is stated, not merged with payroll');
  assert.ok(owner.note.includes('2026-08-01T00:00:00Z'), 'and so is the end of the period');
});

test('under restriction the trace keeps the source and the period but not the rate', () => {
  const panel = panelFor('restricted');
  const rows = panel.rows.filter((row) => row.group === 'rate');
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(row.value_text.startsWith(AMOUNT_WITHHELD), row.value_text);
    assert.ok(row.status_label.length > 0, 'the scope that won is still named');
  }
});

test('the panel states where the figures came from', () => {
  assert.ok(panelFor('full').source_label.includes('デモ'));
  const operator = selectValuePanel(buildValueSummary(DEMO_VALUE_LEDGER, 'full', AT, 'operator'), 'live');
  assert.ok(operator.source_label.includes('運用者'));
});

test('the separation is stated in words, not left to the layout', () => {
  const panel = panelFor('full');
  assert.ok(panel.notes.some((note) => note.includes('実現削減額（realized）と同じ合計には入れません')));
});

// ----------------------------------------------------- the shipped page ---

test('the panel the browser loads is the one these tests exercise', () => {
  assert.ok(UI_ASSET_PATHS.includes('/ui/quest-value.js'));
  const shipped = assetText('/ui/quest-value.js');
  const source = readFileSync(new URL('../src/ui/public/quest-value.js', import.meta.url), 'utf8');
  assert.equal(shipped, source);
});

test('every slot the app writes exists in the shipped page', () => {
  for (const id of [
    'value-panel',
    'value-headline',
    'value-detail',
    'value-visibility',
    'value-source',
    'value-rows',
    'value-notes',
    'value-row-template',
    'value-note-template',
  ]) {
    assert.ok(HTML.includes(`id="${id}"`), `index.html has #${id}`);
    assert.ok(APP.includes(`'${id}'`), `quest-app.js looks up #${id}`);
  }
  for (const slot of ['value__label', 'value__status', 'value__value', 'value__note']) {
    assert.ok(HTML.includes(`class="${slot}"`), `the template carries .${slot}`);
    assert.ok(APP.includes(`'.${slot}'`), `quest-app.js fills .${slot}`);
  }
});

test('the ROI panel is not a second live region', () => {
  // The banner stays the only one: a value update must not interrupt a screen
  // reader mid-sentence.
  assert.equal((HTML.match(/aria-live=/g) ?? []).length, 1);
  assert.equal((HTML.match(/role="status"/g) ?? []).length, 1);
  assert.ok(HTML.includes('aria-labelledby="value-heading"'), 'the region is named by its heading');
});

test('the panel renders payload text as text, never as markup', () => {
  const shipped = assetText('/ui/quest-value.js');
  for (const forbidden of ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.']) {
    assert.equal(shipped.includes(forbidden), false, forbidden);
  }
});

test('a ledger belonging to the other tab is not rendered on this one', () => {
  // LIVE and DEMO never share a screen, and money is no exception: the demo
  // fixture belongs to DEMO, an operator's ledger belongs to LIVE.
  const demoPayload = buildValueSummary(DEMO_VALUE_LEDGER, 'full', AT, 'demo_fixture');
  const onLive = selectValuePanel(demoPayload, 'live');
  assert.equal(onLive.code, 'other_namespace');
  assert.deepEqual(onLive.rows, []);
  assert.equal(
    JSON.stringify(onLive).includes('188,600'),
    false,
    'and no figure from the other tab leaks into this one',
  );

  const operatorPayload = buildValueSummary(DEMO_VALUE_LEDGER, 'full', AT, 'operator');
  assert.equal(selectValuePanel(operatorPayload, 'demo').code, 'other_namespace');
  assert.equal(selectValuePanel(operatorPayload, 'live').code, 'accepted');
});

test('an unconfigured ledger is reported on both tabs, because it is true of both', () => {
  const payload = buildValueSummary({ status: 'absent' }, 'restricted', AT);
  assert.equal(selectValuePanel(payload, 'live').code, 'absent');
  assert.equal(selectValuePanel(payload, 'demo').code, 'absent');
});

test('a label table indexed by payload content cannot resolve to a prototype member', () => {
  const panel = selectValuePanel(
    {
      schema_version: 1,
      status: 'accepted',
      amount_visibility: 'full',
      ledger_source: 'constructor',
      dashboard: {
        schema_version: 1,
        generated_at: AT,
        policy_version: 'v1',
        company_id: 'acme',
        reporting_currency: 'JPY',
        amount_visibility: 'full',
        aggregation_mode: 'currency_partition',
        measurement_window: null,
        sections: [
          {
            value_metric_type: 'time_saved',
            label: '削減時間',
            value_kind: 'non_monetary',
            record_count: 1,
            subtotals: [{ realization_status: '__proto__', unit: 'minute', record_count: 1, total: 60 }],
          },
        ],
        costs: {
          ai_cost: {
            label: 'AI関連コスト',
            reported: true,
            cost_status: 'toString',
            currency: 'JPY',
            pricing_source: null,
            pricing_version: null,
            amount_minor: 100,
          },
          ark_fee: {
            label: 'ARK利用料',
            reported: false,
            cost_status: null,
            currency: null,
            pricing_source: null,
            pricing_version: null,
          },
        },
        rate_trace: [],
        unavailable: [],
        derivation: { derived: 0, carried_forward: 0 },
        notes: [],
      },
    },
    'live',
  );
  // `MAP[key] ?? fallback` would have resolved these to inherited members and
  // rendered a function body into the cell.
  for (const row of panel.rows) {
    assert.equal(typeof row.status_label, 'string', row.code);
    assert.equal(row.status_label.includes('function'), false, row.code);
    assert.equal(row.status_label.includes('[object'), false, row.code);
  }
  assert.equal(typeof panel.source_label, 'string');
  assert.equal(panel.source_label, '', 'an unknown ledger source has no label, not a prototype member');
});
