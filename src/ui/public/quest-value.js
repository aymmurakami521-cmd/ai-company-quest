/**
 * The ROI panel view model.
 *
 * Nothing here touches the DOM, a socket or the clock: `selectValuePanel` is a
 * pure function from the `/value/summary` payload to rows of text, so the suite
 * is deterministic and cannot flake.
 *
 * Two display rules are load-bearing rather than cosmetic:
 *
 * - A withheld amount renders as 非表示, never as 0 or as an empty cell. The
 *   server already omits the number; the screen has to say *why* it is missing,
 *   or a reader concludes the company created no value.
 * - 創出時間価値（推定）and 実現削減額 are separate rows with their own
 *   実現／推定 labels, and no row anywhere adds them together. That is the
 *   whole point of the separation in `docs/cost-governance-roi-design.md` §7.3.
 *
 * Amounts are formatted by hand rather than through `Intl`: the same payload
 * has to render identically in a browser and in the test process, and an
 * ICU-dependent separator would make that a property of the environment.
 */

/** Rendered where a monetary amount would be if the viewer could see it. */
export const AMOUNT_WITHHELD = '非表示';
/** Rendered for a section the ledger has no records for. Not the same as 0. */
export const NO_RECORDS = '記録なし';
/** Rendered where a cost has no amount because it is not priced yet. */
export const NOT_PRICED = '金額未確定';
/**
 * Rendered where a subtotal exists but has no total, because some of its money
 * never reached the reporting currency. Deliberately different from both 非表示
 * ("there is a total, you may not see it") and 0.
 */
export const NOT_CONVERTIBLE = '換算できません';
/** How many individual rate-trace lines the panel lists before summarising. */
export const MAX_RATE_TRACE_ROWS = 8;
/** The same cap for FX conversion lines. The full list stays on `/value/summary`. */
export const MAX_FX_TRACE_ROWS = 8;

/**
 * Minor-unit exponents, mirroring `src/domain/rate.ts`.
 *
 * Duplicated on purpose: this file is loaded by the browser as-is and cannot
 * import the TypeScript domain. `test/ui-value.test.ts` holds the two copies
 * together by checking them against each other.
 */
export const MINOR_UNIT_EXPONENTS = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
};

/**
 * Own-property lookup with a fallback.
 *
 * `MAP[value] ?? fallback` is wrong here: for `constructor`, `toString` or
 * `__proto__` it resolves to an inherited `Object.prototype` member, which is
 * not nullish, so the fallback never fires and a function body renders into the
 * cell. Every one of these tables is indexed by a value that arrived in a
 * payload, so all of them go through this.
 */
function lookup(map, key, fallback) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key)
    ? map[key]
    : fallback;
}

const REALIZATION_LABELS = { realized: '実現', estimated: '推定' };

const RATE_SOURCE_LABELS = {
  user: 'ユーザー単価',
  department: '部署単価',
  company: '会社単価',
  ark_default: 'ARK既定（fallback）',
};

const RATE_BASIS_LABELS = {
  employee_cost: '会社負担人件費',
  time_value: '時間価値・機会費用',
  fallback_proxy: '既定の代理単価',
};

const RATE_ENTRY_SOURCE_LABELS = {
  operator: '運用者入力',
  company_brain: 'Company Brain',
};

const FX_SOURCE_LABELS = {
  operator_declared: '運用者が宣言',
  contract_rate: '契約レート',
  published_reference: '公表レートの転記',
};

/**
 * Why an amount stayed in its own currency. Read by a person, so it is written
 * in the language the rest of the panel is written in - and it says what the
 * operator would have to *do*, since every one of these is fixed by adding a
 * rate to the ledger.
 */
const FX_UNCONVERTED_REASON_LABELS = {
  no_applicable_rate: 'この期間に適用できる換算率がありません',
  invalid_request: '換算の基準時点が定まりません',
  amount_out_of_range: '換算結果が扱える金額の範囲を超えます',
};

/**
 * Why a figure has no ratio. Every one of these is a *reason*, never a number:
 * §8.4 forbids showing 0 or ∞ where a ratio could not be computed, because both
 * read as an answer.
 */
const RATIO_STATUS_LABELS = {
  computed: '算出済み',
  undefined_zero_denominator: 'AI関連コストが0のため未定義',
  blocked_unpriced_cost: 'AI関連コストが金額未確定',
  blocked_unresolved_cost: 'AI関連コストが未解決',
  blocked_non_monetary_operand: '分子が金額ではありません',
  blocked_currency_mismatch: '通貨が揃っていません',
  blocked_scope_mismatch: '期間・範囲が一致しません',
  blocked_methodology_mismatch: '算定方法が比較できません',
  blocked_absent_value: '対象期間の金額記録がありません',
  blocked_absent_cost: 'AI関連コストの記録がありません',
};

const COST_STATUS_LABELS = {
  estimated: '見積',
  finalized: '確定',
  unpriced: '未確定',
};

const LEDGER_SOURCE_LABELS = {
  none: '台帳は未設定です',
  operator: '出所: 運用者が設定した台帳',
  demo_fixture: '出所: デモ用の固定データ（実データではありません）',
};

/**
 * Which tab each kind of ledger belongs to. `none` is in neither: "nothing is
 * configured" is true of both namespaces, so it is shown on both.
 */
const LEDGER_NAMESPACE = { operator: 'live', demo_fixture: 'demo' };

function exponentFor(currency) {
  return lookup(MINOR_UNIT_EXPONENTS, currency, 2);
}

/** `1234567` -> `1,234,567`. Hand-rolled so the output never depends on ICU. */
function group(digits) {
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

/**
 * Formats an integer amount of minor units in its own currency.
 *
 * Returns null for anything that is not a finite integer, so a malformed
 * payload produces "no amount" rather than `NaN` on the screen.
 */
export function formatMinor(amountMinor, currency) {
  if (typeof amountMinor !== 'number' || !Number.isInteger(amountMinor)) return null;
  if (typeof currency !== 'string' || currency.length === 0) return null;
  const exponent = exponentFor(currency);
  const negative = amountMinor < 0;
  const absolute = String(Math.abs(amountMinor)).padStart(exponent + 1, '0');
  const whole = exponent === 0 ? absolute : absolute.slice(0, absolute.length - exponent);
  const fraction = exponent === 0 ? '' : `.${absolute.slice(absolute.length - exponent)}`;
  return `${negative ? '-' : ''}${group(whole)}${fraction} ${currency}`;
}

/** Formats a whole number of minutes as hours and minutes, never as money. */
export function formatMinutes(minutes) {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}分`;
  return rest === 0 ? `${group(String(hours))}時間` : `${group(String(hours))}時間${rest}分`;
}

function row(code, groupName, label, statusLabel, valueText, note) {
  return {
    code,
    group: groupName,
    label,
    status_label: statusLabel,
    value_text: valueText,
    note,
  };
}

function subtotalText(subtotal, valueKind) {
  // Checked before withholding: under restriction both flags can be set, and
  // 非表示 would tell the reader a total exists when none was computed.
  if (subtotal.total_blocked === true) return NOT_CONVERTIBLE;
  if (subtotal.amount_withheld === true) return AMOUNT_WITHHELD;
  if (valueKind === 'monetary') return formatMinor(subtotal.total, subtotal.unit) ?? AMOUNT_WITHHELD;
  if (subtotal.unit === 'minute') return formatMinutes(subtotal.total) ?? `${subtotal.total}`;
  return `${subtotal.total} ${subtotal.unit}`;
}

function valueRows(dashboard) {
  const rows = [];
  for (const section of dashboard.sections) {
    if (section.record_count === 0) {
      rows.push(row(`value-${section.value_metric_type}`, 'value', section.label, '', NO_RECORDS, ''));
      continue;
    }
    for (const subtotal of section.subtotals) {
      const note =
        subtotal.total_blocked === true
          ? `${subtotal.record_count}件・0円ではありません`
          : `${subtotal.record_count}件`;
      rows.push(
        row(
          `value-${section.value_metric_type}-${subtotal.realization_status}-${subtotal.unit}`,
          'value',
          section.label,
          lookup(REALIZATION_LABELS, subtotal.realization_status, subtotal.realization_status),
          subtotalText(subtotal, section.value_kind),
          note,
        ),
      );
    }
  }
  return rows;
}

/** The conversion note for a cost bucket, or '' when none applies (mode A). */
function costFxNote(section) {
  const fx = section.fx;
  if (fx === null || fx === undefined || typeof fx !== 'object') return '';
  if (fx.status === 'converted') {
    // A converted bucket always carries its evidence, but this is payload from
    // the network like everything else here: a missing one renders as a plain
    // statement rather than throwing and blanking the whole panel.
    const evidence = fx.evidence;
    if (evidence === null || evidence === undefined || typeof evidence !== 'object') {
      return `${fx.original_currency} から換算`;
    }
    const source = lookup(FX_SOURCE_LABELS, evidence.fx_source, evidence.fx_source);
    return `${fx.original_currency} から換算（${evidence.fx_rate}・${source}・版 ${evidence.fx_rate_version}）`;
  }
  if (fx.status === 'unconverted') {
    // The original amount still stands - it is simply not comparable with the
    // rest of the screen, and saying so is the whole point.
    const reason = lookup(FX_UNCONVERTED_REASON_LABELS, fx.reason, fx.reason);
    return `${fx.original_currency} のまま・${reason}`;
  }
  return '';
}

function costRow(code, section) {
  if (section.reported !== true) {
    return row(code, 'cost', section.label, '', NO_RECORDS, '');
  }
  const status = lookup(COST_STATUS_LABELS, section.cost_status, section.cost_status ?? '');
  let text;
  if (section.amount_withheld === true) text = AMOUNT_WITHHELD;
  else if (typeof section.amount_minor === 'number') {
    text = formatMinor(section.amount_minor, section.currency) ?? AMOUNT_WITHHELD;
  } else text = NOT_PRICED;
  const parts = [];
  if (section.pricing_version !== null && section.pricing_version !== undefined) {
    parts.push(`価格版 ${section.pricing_version}`);
  }
  const fxNote = costFxNote(section);
  if (fxNote !== '') parts.push(fxNote);
  return row(code, 'cost', section.label, status, text, parts.join('・'));
}

/** Shared context line for a ratio row: what it covers and what it left out. */
function ratioNote(entry) {
  const parts = [`対象 ${entry.included_record_count}件`];
  if (entry.excluded_record_count > 0) parts.push(`期間外 ${entry.excluded_record_count}件`);
  if (entry.period !== null && entry.period !== undefined) {
    parts.push(`コスト期間 ${entry.period.start} 〜 ${entry.period.end}`);
  }
  if (entry.cost_status !== null && entry.cost_status !== undefined) {
    parts.push(`AI関連コスト ${lookup(COST_STATUS_LABELS, entry.cost_status, entry.cost_status)}`);
  }
  if (entry.methodology_version !== null && entry.methodology_version !== undefined) {
    parts.push(`算定方法 ${entry.methodology_version}`);
  }
  return parts.join('・');
}

/**
 * The ratio rows.
 *
 * A computed ratio becomes *two* rows, each naming its term: §8.5 forbids
 * writing "13倍" without saying which of the two figures it is, and the two are
 * different numbers for the same situation. A ratio that could not be computed
 * becomes one row carrying the reason - never a 0, a dash or an ∞.
 */
function ratioRows(dashboard) {
  const rows = [];
  const ratios = Array.isArray(dashboard.ratios) ? dashboard.ratios : [];
  for (const entry of ratios) {
    const statusLabel = lookup(REALIZATION_LABELS, entry.realization_status, entry.realization_status);
    const key = `${entry.realization_status}-${entry.currency}`;
    const note = ratioNote(entry);
    if (entry.ratio_status !== 'computed') {
      rows.push(
        row(
          `ratio-blocked-${key}`,
          'ratio',
          `費用対効果比（${entry.currency}）`,
          statusLabel,
          lookup(RATIO_STATUS_LABELS, entry.ratio_status, entry.ratio_status),
          note,
        ),
      );
      continue;
    }
    const withheld = entry.amount_withheld === true;
    rows.push(
      row(
        `ratio-bcr-${key}`,
        'ratio',
        `費用対効果比 benefit-cost ratio（${entry.currency}）`,
        statusLabel,
        withheld ? AMOUNT_WITHHELD : `${entry.benefit_cost_ratio}倍`,
        note,
      ),
    );
    rows.push(
      row(
        `ratio-net-${key}`,
        'ratio',
        `純ROI net ROI（${entry.currency}）`,
        statusLabel,
        withheld ? AMOUNT_WITHHELD : `${entry.net_roi}倍`,
        note,
      ),
    );
  }
  return rows;
}

/** One line per converted amount: which rate, from whom, and as of when. */
function fxRows(dashboard) {
  const rows = [];
  const trace = Array.isArray(dashboard.fx_trace) ? dashboard.fx_trace : [];
  const shown = trace.slice(0, MAX_FX_TRACE_ROWS);
  for (const entry of shown) {
    rows.push(
      row(
        `fx-${entry.record_id}`,
        'fx',
        entry.record_id,
        `${entry.from_currency} → ${entry.to_currency}`,
        entry.fx_rate,
        `${lookup(FX_SOURCE_LABELS, entry.fx_source, entry.fx_source)}・版 ${
          entry.fx_rate_version
        }・適用時点 ${entry.fx_effective_at}`,
      ),
    );
  }
  const remainder = trace.length - shown.length;
  if (remainder > 0) {
    rows.push(row('fx-remainder', 'fx', '他の換算', '', `他 ${remainder} 件`, ''));
  }
  return rows;
}

function unconvertedRows(dashboard) {
  const list = Array.isArray(dashboard.fx_unconverted) ? dashboard.fx_unconverted : [];
  return list.map((entry) =>
    row(
      `unconverted-${entry.record_id}`,
      'unconverted',
      entry.record_id,
      '未換算',
      '0円ではありません',
      `${entry.from_currency} → ${entry.to_currency}・${lookup(
        FX_UNCONVERTED_REASON_LABELS,
        entry.reason,
        entry.reason,
      )}`,
    ),
  );
}

/**
 * One line per estimate, saying which rate produced it and when that rate was
 * in force. Capped, with the remainder summarised: the full list stays on
 * `/value/summary`, which is the audit surface.
 */
function rateRows(dashboard) {
  const rows = [];
  const shown = dashboard.rate_trace.slice(0, MAX_RATE_TRACE_ROWS);
  for (const trace of shown) {
    const sourceLabel = lookup(RATE_SOURCE_LABELS, trace.resolved_source, trace.resolved_source);
    const rate =
      trace.amount_withheld === true
        ? AMOUNT_WITHHELD
        : (formatMinor(trace.hourly_rate_minor, trace.currency) ?? AMOUNT_WITHHELD);
    const from = trace.effective_from === null ? '適用開始なし' : trace.effective_from;
    const to = trace.effective_to === null ? '継続中' : trace.effective_to;
    const basis = lookup(RATE_BASIS_LABELS, trace.basis, trace.basis);
    const entrySource = lookup(RATE_ENTRY_SOURCE_LABELS, trace.entry_source, '既定値');
    rows.push(
      row(
        `rate-${trace.record_id}`,
        'rate',
        trace.derived_from,
        sourceLabel,
        `${rate} / 時`,
        `${basis}・${entrySource}・適用期間 ${from} 〜 ${to}`,
      ),
    );
  }
  const remainder = dashboard.rate_trace.length - shown.length;
  if (remainder > 0) {
    rows.push(row('rate-remainder', 'rate', '他の推定', '', `他 ${remainder} 件`, ''));
  }
  return rows;
}

function unavailableRows(dashboard) {
  return dashboard.unavailable.map((entry) =>
    row(
      `unavailable-${entry.source_record_id}`,
      'unavailable',
      entry.source_record_id,
      '未算出',
      '0円ではありません',
      entry.reason,
    ),
  );
}

/**
 * Builds the panel.
 *
 * `payload` is whatever `/value/summary` returned, or null when the request
 * could not be made at all. Every branch produces a headline: a panel that
 * silently shows nothing is indistinguishable from a company with no value.
 */
export function selectValuePanel(payload, namespace) {
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return {
      code: 'unreachable',
      headline: 'ROIの読み取りモデルを取得できませんでした',
      detail: '再接続すると再取得します。',
      visibility_label: '',
      source_label: '',
      rows: [],
      notes: [],
    };
  }
  if (payload.schema_version !== 1) {
    return {
      code: 'unsupported',
      headline: '対応していないROI schemaです',
      detail: 'この画面は schema_version 1 のみ表示します。',
      visibility_label: '',
      source_label: '',
      rows: [],
      notes: [],
    };
  }

  const visibility =
    payload.amount_visibility === 'full' ? '金額表示: 全表示' : '金額表示: 制限中（0円ではありません）';
  const sourceLabel = lookup(LEDGER_SOURCE_LABELS, payload.ledger_source, '');

  // LIVE and DEMO never appear on the screen together, and money is no
  // exception: an operator's real ledger belongs to the LIVE tab and the demo
  // fixture belongs to the DEMO tab. Without this the DEMO tab would show a
  // company's actual figures, and `npm run demo` would show fabricated money
  // beside the LIVE stream - with only a small source line to distinguish them.
  const belongsTo = lookup(LEDGER_NAMESPACE, payload.ledger_source, undefined);
  if (belongsTo !== undefined && namespace !== belongsTo) {
    return {
      code: 'other_namespace',
      headline: belongsTo === 'demo' ? 'ROIはDEMOタブに表示します' : 'ROIはLIVEタブに表示します',
      detail:
        belongsTo === 'demo'
          ? '読み込まれているのはデモ用の固定データです。LIVEの数字ではないため、ここには出しません。'
          : '読み込まれているのは運用者が設定した台帳です。DEMOの数字ではないため、ここには出しません。',
      visibility_label: visibility,
      source_label: sourceLabel,
      rows: [],
      notes: [],
    };
  }

  if (payload.status === 'absent') {
    return {
      code: 'absent',
      headline: '時間単価と価値台帳は未設定です',
      detail: 'QUEST_VALUE_LEDGER_PATH を設定すると、この画面に推定と実現が分かれて表示されます。',
      visibility_label: visibility,
      source_label: sourceLabel,
      rows: [],
      notes: [],
    };
  }
  if (payload.status === 'rejected') {
    return {
      code: 'rejected',
      headline: '価値台帳は受け付けられませんでした',
      // Field path and rule only. The rejected document held rates and amounts,
      // so nothing from it is echoed back onto the screen.
      detail: `${payload.field} / ${payload.rule}`,
      visibility_label: visibility,
      source_label: sourceLabel,
      rows: [],
      notes: [],
    };
  }

  const dashboard = payload.dashboard;
  // §8.5: the aggregation mode is reported beside the figures, always. A reader
  // who cannot tell a currency partition from a converted total cannot tell
  // what a subtotal means.
  const aggregation =
    dashboard.aggregation_mode === 'reporting_currency_normalized'
      ? `${dashboard.reporting_currency} へ換算して小計`
      : '通貨別に小計';
  const window =
    dashboard.measurement_window === null
      ? '測定期間の記録がありません'
      : `測定期間 ${dashboard.measurement_window.start} 〜 ${dashboard.measurement_window.end}`;

  return {
    code: 'accepted',
    headline: `台帳を読み込みました（推定の内訳 ${dashboard.rate_trace.length} 件・未算出 ${dashboard.unavailable.length} 件）`,
    detail: `${window}・方針版 ${dashboard.policy_version}・${aggregation}`,
    visibility_label: visibility,
    source_label: sourceLabel,
    rows: [
      ...valueRows(dashboard),
      costRow('cost-ai', dashboard.costs.ai_cost),
      costRow('cost-ark', dashboard.costs.ark_fee),
      ...ratioRows(dashboard),
      ...rateRows(dashboard),
      ...fxRows(dashboard),
      ...unavailableRows(dashboard),
      ...unconvertedRows(dashboard),
    ],
    notes: [...dashboard.notes],
  };
}
