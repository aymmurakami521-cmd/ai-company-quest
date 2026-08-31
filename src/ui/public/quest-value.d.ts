/**
 * Types for the browser-native ROI panel in `quest-value.js`.
 *
 * The implementation has to stay plain JS because the browser loads it as-is,
 * so its contract is declared here and exercised by `test/ui-value.test.ts`.
 */

export type ValueRowGroup = 'value' | 'cost' | 'rate' | 'unavailable';

export type ValueRow = {
  /** Stable machine-readable key, also usable as a CSS hook and a test anchor. */
  code: string;
  group: ValueRowGroup;
  label: string;
  /** 実現 / 推定 / 確定 / 見積 etc. Empty when the row has no such axis. */
  status_label: string;
  /** Already formatted. `非表示` when an amount exists but may not be shown. */
  value_text: string;
  note: string;
};

/**
 * Every state the panel can be in. `unreachable` is a failed request, not an
 * empty ledger, and `other_namespace` is a ledger that belongs to the tab the
 * viewer is not on - LIVE and DEMO figures never share a screen.
 */
export type ValuePanelCode =
  | 'unreachable'
  | 'unsupported'
  | 'absent'
  | 'rejected'
  | 'accepted'
  | 'other_namespace';

export type ValuePanel = {
  code: ValuePanelCode;
  headline: string;
  detail: string;
  visibility_label: string;
  source_label: string;
  rows: ValueRow[];
  notes: string[];
};

export declare const AMOUNT_WITHHELD: string;
export declare const NO_RECORDS: string;
export declare const NOT_PRICED: string;
export declare const MAX_RATE_TRACE_ROWS: number;
export declare const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>>;

export declare function formatMinor(amountMinor: unknown, currency: unknown): string | null;
export declare function formatMinutes(minutes: unknown): string | null;
/** `namespace` is the tab the viewer is on: `'live'` or `'demo'`. */
export declare function selectValuePanel(payload: unknown, namespace: string): ValuePanel;
