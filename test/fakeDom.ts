/**
 * The smallest DOM the shipped `quest-app.js` can actually run against.
 *
 * `quest-app.js` is a browser module with side effects - importing it renders
 * the page and opens the stream - so the only way to hold its behaviour is to
 * give it a document. This one implements exactly the surface the app touches
 * and nothing more, and it models the two browser rules the app depends on:
 *
 * 1. every `textContent` assignment is counted, unchanged text included, which
 *    is what makes "one status change, one announcement" testable at all;
 * 2. a node that leaves the tree takes the focus with it, which is what makes
 *    "a re-render does not drop the keyboard out of a desk button" testable.
 *
 * `node --test` runs each test file in its own process, so several suites can
 * each install their own globals and import the app once.
 */

/** A DOM node that remembers how often it was written to. */
export class FakeElement {
  className: string;
  tagName: string;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  hidden = false;
  childNodes: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  writes = 0;
  /** Set when this element is the document's `activeElement`. */
  owner: FakeDocument | null = null;
  #text = '';
  #listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(className = '', childNodes: FakeElement[] = [], tagName = 'div') {
    this.className = className;
    this.tagName = tagName;
    for (const child of childNodes) this.append(child);
  }

  get textContent(): string {
    return this.#text;
  }

  set textContent(value: string) {
    this.#text = String(value);
    this.writes += 1;
  }

  /** Live child list, as `Element.children` is. */
  get children(): FakeElement[] {
    return this.childNodes;
  }

  descendants(): FakeElement[] {
    return this.childNodes.flatMap((child) => [child, ...child.descendants()]);
  }

  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.className === selector.slice(1);
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute === null) return false;
    const name = String(attribute[1]);
    const key = name.startsWith('data-')
      ? name.slice(5).replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase())
      : name;
    const value = name.startsWith('data-') ? this.dataset[key] : this.attributes[name];
    if (value === undefined) return false;
    return attribute[2] === undefined || value === attribute[2];
  }

  querySelector(selector: string): FakeElement | null {
    return this.descendants().find((node) => node.matches(selector)) ?? null;
  }

  /** Walks up from this node, as `Element.closest` does - self included. */
  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node !== null) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  /**
   * Detaches this node. A focused node that leaves the tree loses the focus,
   * exactly as a browser drops it to the body.
   */
  remove(): void {
    // Resolved before detaching: once the parent link is cut there is no way
    // back up to the document that holds the focus.
    const document_ = this.#document();
    const parent = this.parentNode;
    if (parent !== null) {
      parent.childNodes = parent.childNodes.filter((child) => child !== this);
      this.parentNode = null;
    }
    if (document_ === null) return;
    const active = document_.activeElement;
    if (active !== null && (active === this || this.descendants().includes(active))) {
      document_.activeElement = null;
    }
  }

  #document(): FakeDocument | null {
    let node: FakeElement | null = this;
    while (node !== null) {
      if (node.owner !== null) return node.owner;
      node = node.parentNode;
    }
    return this.owner;
  }

  insertBefore(node: FakeElement, reference: FakeElement | null): FakeElement {
    // Inserting a node that is already placed moves it, and a move is a
    // detach: the browser blurs it too. That is deliberate - it is what lets a
    // test prove an ordinary re-render moves nothing.
    node.remove();
    node.parentNode = this;
    const at = reference === null ? -1 : this.childNodes.indexOf(reference);
    if (at < 0) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    return node;
  }

  append(node: FakeElement): void {
    this.insertBefore(node, null);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of [...this.childNodes]) child.remove();
    for (const node of nodes) this.append(node);
  }

  addEventListener(name: string, listener: (event: unknown) => void): void {
    const existing = this.#listeners.get(name) ?? [];
    existing.push(listener);
    this.#listeners.set(name, existing);
  }

  /** Delivers an event to this node's own listeners. */
  dispatch(name: string, event: unknown): void {
    for (const listener of this.#listeners.get(name) ?? []) listener(event);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  /** Only a test calls this: the app itself never moves the focus. */
  focus(): void {
    const document_ = this.#document();
    if (document_ !== null) document_.activeElement = this;
  }
}

/**
 * A `<template>`: every clone is a fresh node tree with the root and the slots
 * the app fills, so `root.querySelector('.slot')` resolves the way it does in
 * the page.
 */
export class FakeTemplate {
  #root: string;
  #slots: readonly FakeSlot[];

  constructor(root: string, slots: readonly FakeSlot[] = []) {
    this.#root = root;
    this.#slots = slots;
  }

  get content(): { cloneNode: () => FakeElement } {
    return {
      cloneNode: () =>
        new FakeElement('fragment', [
          new FakeElement(
            this.#root,
            this.#slots.map((slot) => {
              const spec = typeof slot === 'string' ? { class: slot } : slot;
              const node = new FakeElement(spec.class);
              Object.assign(node.dataset, spec.dataset ?? {});
              return node;
            }),
          ),
        ]),
    };
  }
}

/** A slot in a template: a class name, or one that carries `data-` attributes. */
export type FakeSlot = string | { class: string; dataset?: Record<string, string> };

export class FakeDocument {
  activeElement: FakeElement | null = null;
  #elements = new Map<string, FakeElement | FakeTemplate>();
  #queried: FakeElement[] = [];

  constructor(prebuilt: Iterable<[string, FakeElement | FakeTemplate]> = []) {
    for (const [id, node] of prebuilt) {
      if (node instanceof FakeElement) node.owner = this;
      this.#elements.set(id, node);
    }
  }

  /** Anything the app looks up becomes an ordinary element it may write to. */
  getElementById = (id: string): FakeElement | FakeTemplate => {
    const known = this.#elements.get(id);
    if (known !== undefined) return known;
    const made = new FakeElement(id);
    made.owner = this;
    this.#elements.set(id, made);
    return made;
  };

  /** The element for an id, or a thrown error - never a template. */
  element(id: string): FakeElement {
    const found = this.getElementById(id);
    if (!(found instanceof FakeElement)) throw new Error(`${id} is a template, not an element`);
    return found;
  }

  querySelector = (selector: string): FakeElement => {
    const made = new FakeElement(selector);
    made.owner = this;
    this.#queried.push(made);
    return made;
  };

  querySelectorAll = (selector: string): FakeElement[] => {
    if (selector !== '[data-mode]') return [];
    return this.modeButtons;
  };

  modeButtons: FakeElement[] = (() => {
    const live = new FakeElement('mode-button');
    const demo = new FakeElement('mode-button');
    live.dataset.mode = 'live';
    demo.dataset.mode = 'demo';
    return [live, demo];
  })();
}

/** The `EventSource` the app opens, held so a suite can push frames into it. */
export class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static opened: FakeEventSource[] = [];

  readyState = FakeEventSource.OPEN;
  listeners = new Map<string, ((event: { data: string }) => void)[]>();

  constructor(_url: string) {
    FakeEventSource.opened.push(this);
  }

  addEventListener(name: string, listener: (event: { data: string }) => void): void {
    const existing = this.listeners.get(name) ?? [];
    existing.push(listener);
    this.listeners.set(name, existing);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(name: string, payload: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(payload) });
  }
}

/** The parts of the page that have inner structure, plus its templates. */
export function pageNodes(): [string, FakeElement | FakeTemplate][] {
  return [
    [
      'banner',
      new FakeElement('banner', [
        new FakeElement('banner__symbol'),
        new FakeElement('banner__code'),
        new FakeElement('banner__message'),
      ]),
    ],
    [
      'desk-template',
      new FakeTemplate('desk', [
        // Carries the marker the app's one delegated listener finds by
        // `closest`, exactly as the page's <button> does.
        { class: 'desk__select', dataset: { action: 'select-desk' } },
        'desk__badge',
        'desk__seat',
        'desk__agent',
        'desk__symbol',
        'desk__state-label',
        'desk__role',
        'desk__raw-status',
        'desk__tool',
        'desk__session',
        'desk__ts',
        'desk__frozen',
        'desk__frozen-text',
      ]),
    ],
    [
      'detail-recent-template',
      new FakeTemplate('detail__recent-row', [
        'detail__recent-symbol',
        'detail__recent-ts',
        'detail__recent-type',
        'detail__recent-detail',
      ]),
    ],
    ['log-template', new FakeTemplate('log__row', ['log__symbol', 'log__seq', 'log__ts', 'log__actor', 'log__type', 'log__detail'])],
    ['legend-template', new FakeTemplate('legend__row', ['legend__symbol', 'legend__label', 'legend__code'])],
  ];
}

/**
 * Installs a document, a window and an `EventSource` on the global object, so
 * the next `import` of `quest-app.js` runs against them.
 */
export function installFakeDom(): { document: FakeDocument; window: Record<string, unknown> } {
  const document_ = new FakeDocument(pageNodes());
  const window_ = {
    location: { hash: '' },
    innerHeight: 800,
    devicePixelRatio: 1,
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

/** The one stream importing the app opened. */
export function onlyStream(): FakeEventSource {
  const [first] = FakeEventSource.opened;
  if (first === undefined || FakeEventSource.opened.length !== 1) {
    throw new Error(`the app opened ${FakeEventSource.opened.length} streams`);
  }
  return first;
}

/**
 * The stream the app is currently listening to. Switching namespace closes one
 * and opens another, and the app ignores frames from any but the newest.
 */
export function currentStream(): FakeEventSource {
  const latest = FakeEventSource.opened[FakeEventSource.opened.length - 1];
  if (latest === undefined) throw new Error('the app opened no stream');
  return latest;
}
