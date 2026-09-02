/**
 * The smallest DOM the shipped `quest-ark-app.js` can actually run against.
 *
 * Same machinery as `test/fakeDom.ts` - and the same two browser rules it
 * models - with the Owner ARK page's own ids and templates. Kept in its own
 * file so the office screen's harness is untouched by anything the console
 * needs.
 *
 * One addition over the office harness: `querySelector` memoises by selector,
 * so a suite can reach the two controls the console looks up that way (再接続
 * and 下書きを組み立てる) and press them.
 */

import { FakeDocument, FakeElement, FakeEventSource, FakeTemplate } from './fakeDom.ts';
import type { FakeSlot } from './fakeDom.ts';

export { FakeEventSource, currentStream, onlyStream } from './fakeDom.ts';

/** A document whose `querySelector` returns the same node for the same selector. */
export class ArkDocument extends FakeDocument {
  selected = new Map<string, FakeElement>();

  override querySelector = (selector: string): FakeElement => {
    const existing = this.selected.get(selector);
    if (existing !== undefined) return existing;
    const made = new FakeElement(selector);
    made.owner = this;
    this.selected.set(selector, made);
    return made;
  };

  /** The node the app took for a selector, or a thrown error. */
  control(selector: string): FakeElement {
    const found = this.selected.get(selector);
    if (found === undefined) throw new Error(`the app never looked up ${selector}`);
    return found;
  }
}

/**
 * Every slot `quest-ark-app.js` fills, per template.
 *
 * The page nests `.ark-evidence` inside the row's <details>; the fake keeps the
 * slots flat, which is fine because the app only ever reaches them from the row
 * root with `querySelector`. `test/ui-ark-dom.test.ts` pins the two lists
 * against each other so they cannot drift apart.
 */
const NEED_SLOTS: readonly FakeSlot[] = [
  'ark-need-item__level',
  'ark-need-item__symbol',
  'ark-need-item__title',
  'ark-need-item__state',
  'ark-need-item__unconfirmed',
  'ark-need-item__reason',
  'ark-need-item__recommended',
  'ark-need-item__options',
  'ark-need-item__inaction',
  'ark-need-item__updated',
  'ark-need-item__artifacts',
  'ark-evidence',
];

const ROW_SLOTS: readonly FakeSlot[] = [
  'ark-row__tag',
  'ark-row__symbol',
  'ark-row__name',
  'ark-row__updated',
  'ark-row__work',
  'ark-row__note',
  'ark-row__frozen',
  'ark-row__evidence',
  'ark-row__artifacts',
  'ark-evidence',
];

/** The parts of the console that have inner structure, plus its templates. */
export function arkPageNodes(): [string, FakeElement | FakeTemplate][] {
  return [
    [
      'ark-banner',
      new FakeElement('ark-banner', [
        new FakeElement('ark-banner__symbol'),
        new FakeElement('ark-banner__code'),
        new FakeElement('ark-banner__message'),
      ]),
    ],
    ['ark-need-template', new FakeTemplate('ark-need-item', NEED_SLOTS)],
    ['ark-row-template', new FakeTemplate('ark-row', ROW_SLOTS)],
    [
      'ark-evidence-template',
      new FakeTemplate('ark-evidence__row', ['ark-evidence__label', 'ark-evidence__value']),
    ],
    ['ark-count-template', new FakeTemplate('ark-count', ['ark-count__label', 'ark-count__value'])],
    ['ark-field-template', new FakeTemplate('ark-field', ['ark-field__label', 'ark-field__value'])],
  ];
}

/**
 * Installs a document, a window and an `EventSource` on the global object, so
 * the next `import` of `quest-ark-app.js` runs against them.
 */
export function installFakeArkDom(): { document: ArkDocument; window: Record<string, unknown> } {
  const document_ = new ArkDocument(arkPageNodes());
  const window_ = {
    location: { hash: '' },
    addEventListener: () => {},
    // Nothing here depends on the clock, and a live timer would keep the test
    // process alive.
    setInterval: () => 0,
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = document_;
  globals.window = window_;
  globals.EventSource = FakeEventSource;
  return { document: document_, window: window_ };
}
