/**
 * Owner ARK browser glue: one SSE connection in, one compact management screen
 * out.
 *
 * The same boundaries the office screen keeps, kept here:
 * - read-only: the only requests made are the two documented SSE GETs. There is
 *   no other request in this file and no way to make one;
 * - one namespace at a time: switching closes the stream and rebuilds the client
 *   state, so LIVE and DEMO can never appear together;
 * - stream content reaches the DOM through `textContent` only, so a sanitized
 *   label is always rendered as text and never as markup;
 * - nothing is logged to the console.
 *
 * Everything that decides *what* is shown lives in `quest-view.js` and
 * `quest-ark.js` and is unit tested. This file places the result into cloned
 * <template> nodes and does nothing else.
 *
 * Rows are reused by key rather than rebuilt per frame, for the same reason the
 * office screen reuses desk nodes: a node that leaves the document takes the
 * focus with it, and here it would also close whichever Evidence drawer the
 * owner had just opened - several times a second on a busy stream.
 */

import {
  applyFrame,
  createClientState,
  describeFreshness,
  setConnectionPhase,
} from './quest-view.js';
import {
  ARK_OUTCOME_RESULTS,
  ARK_RUNTIME_CODES,
  ARK_SUMMARY_ROWS,
  buildCommandDraft,
  outcomeLabel,
  runtimeLabel,
  selectArk,
} from './quest-ark.js';

const NAMESPACES = ['live', 'demo'];

/** Frame names from the documented SSE control contract. */
const CONTROL_FRAMES = ['snapshot', 'replay_start', 'replay_end', 'stream_gap', 'fail_closed'];

/** Text for an attention level. Never a colour alone. */
const LEVEL_LABELS = { required: '要対応', advised: '要確認' };

/** Said in words wherever the screen is showing something it cannot confirm. */
const UNCONFIRMED_PREFIX = '未確認';

const dom = {
  modeButtons: Array.from(document.querySelectorAll('[data-mode]')),
  reconnect: document.querySelector('[data-action="reconnect"]'),
  commandBuild: document.querySelector('[data-action="build-command"]'),
  mode: document.getElementById('ark-mode'),
  connection: document.getElementById('ark-connection'),
  freshness: document.getElementById('ark-freshness'),
  seq: document.getElementById('ark-seq'),
  desks: document.getElementById('ark-desks'),
  attentionCount: document.getElementById('ark-attention-count'),
  banner: document.getElementById('ark-banner'),

  needList: document.getElementById('ark-need-list'),
  needEmpty: document.getElementById('ark-need-empty'),
  needCount: document.getElementById('ark-need-count'),

  nowCounts: document.getElementById('ark-now-counts'),
  nowUnconfirmed: document.getElementById('ark-now-unconfirmed'),
  nowList: document.getElementById('ark-now-list'),
  nowMore: document.getElementById('ark-now-more'),
  nowDrawer: document.getElementById('ark-now-drawer'),
  nowEmpty: document.getElementById('ark-now-empty'),
  nowExternal: document.getElementById('ark-now-external'),

  nextNote: document.getElementById('ark-next-note'),
  nextList: document.getElementById('ark-next-list'),
  nextEmpty: document.getElementById('ark-next-empty'),
  nextFields: document.getElementById('ark-next-fields'),

  outcomeCounts: document.getElementById('ark-outcome-counts'),
  outcomeList: document.getElementById('ark-outcome-list'),
  outcomeMore: document.getElementById('ark-outcome-more'),
  outcomeDrawer: document.getElementById('ark-outcome-drawer'),
  outcomeEmpty: document.getElementById('ark-outcome-empty'),
  outcomeArtifacts: document.getElementById('ark-outcome-artifacts'),

  commandSubmission: document.getElementById('ark-command-submission'),
  commandInput: document.getElementById('ark-command-input'),
  commandCount: document.getElementById('ark-command-count'),
  commandStatus: document.getElementById('ark-command-status'),
  commandSubmit: document.getElementById('ark-command-submit'),
  commandPreview: document.getElementById('ark-command-preview'),

  needTemplate: document.getElementById('ark-need-template'),
  rowTemplate: document.getElementById('ark-row-template'),
  evidenceTemplate: document.getElementById('ark-evidence-template'),
  countTemplate: document.getElementById('ark-count-template'),
  fieldTemplate: document.getElementById('ark-field-template'),
};

let source = null;
let state = createClientState(readNamespaceFromHash());

/** The banner last written to the live region, so it is not re-announced. */
let announced = null;

function readNamespaceFromHash() {
  const requested = window.location.hash.replace('#', '');
  return NAMESPACES.includes(requested) ? requested : 'live';
}

function setState(next) {
  state = next;
  render();
}

function closeStream() {
  if (source !== null) {
    source.close();
    source = null;
  }
}

function connect(namespace) {
  closeStream();
  state = setConnectionPhase(createClientState(namespace), 'connecting', Date.now());
  render();

  const stream = new EventSource(`/events/${namespace}`);
  source = stream;

  stream.addEventListener('open', () => {
    if (source !== stream) return;
    setState(setConnectionPhase(state, 'open', Date.now()));
  });

  stream.addEventListener('error', () => {
    if (source !== stream) return;
    const phase = stream.readyState === EventSource.CONNECTING ? 'reconnecting' : 'error';
    setState(setConnectionPhase(state, phase, Date.now()));
  });

  stream.addEventListener('quest_event', (event) => {
    if (source !== stream) return;
    handleFrame('event', event.data);
  });

  for (const name of CONTROL_FRAMES) {
    stream.addEventListener(name, (event) => {
      if (source !== stream) return;
      handleFrame(name, event.data);
    });
  }
}

function handleFrame(kind, raw) {
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    setState(applyFrame(state, { kind: 'unparseable', at_ms: Date.now() }));
    return;
  }
  setState(applyFrame(state, { kind, payload, at_ms: Date.now() }));
}

function text(node, selector, value) {
  const target = node.querySelector(selector);
  if (target !== null) target.textContent = value;
}

function setText(node, value) {
  if (node !== null) node.textContent = value;
}

/** Root element of a freshly cloned template. */
function clone(template, selector) {
  const fragment = template.content.cloneNode(true);
  return fragment.querySelector(selector);
}

/**
 * Places one list of nodes inside one parent, moving only what has to move.
 *
 * The ordinary frame - same rows, same order, new text - performs zero DOM
 * moves, so an open Evidence drawer stays open and a focused summary keeps the
 * keyboard.
 */
function place(parent, nodes) {
  nodes.forEach((node, index) => {
    const current = parent.children[index] ?? null;
    if (current !== node) parent.insertBefore(node, current);
  });
}

/**
 * A keyed list renderer shared by Need You, Now, Next and Outcome.
 *
 * `primary` holds the first `ARK_SUMMARY_ROWS` rows and the drawer holds the
 * rest, which is what keeps every panel a fixed height on a laptop screen no
 * matter how large the office gets. A panel with no drawer passes `more` and
 * `drawer` as null and simply renders everything.
 */
function keyedList({ primary, more, drawer, empty, template, root, fill, key }) {
  let nodes = new Map();
  return (rows) => {
    const next = new Map();
    const order = [];
    for (const row of rows) {
      const id = key(row);
      const node = nodes.get(id) ?? clone(template, root);
      fill(node, row);
      next.set(id, node);
      order.push(node);
    }
    for (const [id, node] of nodes) {
      if (!next.has(id)) node.remove();
    }
    nodes = next;

    if (more === null || drawer === null) {
      place(primary, order);
    } else {
      const head = order.slice(0, ARK_SUMMARY_ROWS);
      const tail = order.slice(ARK_SUMMARY_ROWS);
      place(primary, head);
      place(more, tail);
      // A drawer with nothing behind it is noise, so it is removed rather than
      // left as an empty control.
      drawer.hidden = tail.length === 0;
      setText(drawer.querySelector('.ark-drawer__summary'), `残り ${tail.length} 件`);
    }
    if (empty !== null) empty.hidden = rows.length > 0;
  };
}

/** Fills one Evidence drawer. Trace rows first, then what the contract lacks. */
function fillEvidence(node, evidence) {
  const list = node.querySelector('.ark-evidence');
  if (list === null) return;
  list.replaceChildren();
  for (const entry of evidence.trace) {
    const row = clone(dom.evidenceTemplate, '.ark-evidence__row');
    text(row, '.ark-evidence__label', entry.label);
    text(row, '.ark-evidence__value', entry.value);
    list.append(row);
  }
}

// ------------------------------------------------------------ Need You ---

const renderNeed = keyedList({
  primary: dom.needList,
  more: null,
  drawer: null,
  empty: dom.needEmpty,
  template: dom.needTemplate,
  root: '.ark-need-item',
  key: (item) => item.id,
  fill: (node, item) => {
    node.dataset.level = item.level;
    node.dataset.reason = item.reason_code;
    node.dataset.confirmed = String(item.confirmed);
    // The level is text, the state is text, the symbol is text. Nothing about
    // how loudly this item is asking depends on the palette.
    text(node, '.ark-need-item__level', LEVEL_LABELS[item.level] ?? item.level);
    text(node, '.ark-need-item__symbol', item.visual === null ? '‼' : item.visual.symbol);
    text(node, '.ark-need-item__title', item.title);
    text(
      node,
      '.ark-need-item__state',
      item.visual === null ? item.reason_code : `${item.visual.label} (${item.visual.code})`,
    );
    text(node, '.ark-need-item__reason', item.reason);
    text(node, '.ark-need-item__recommended', item.recommended);
    // Descriptions of the decision, not controls: this screen sends nothing.
    text(node, '.ark-need-item__options', item.options.join(' / '));
    text(node, '.ark-need-item__inaction', item.inaction);
    text(node, '.ark-need-item__updated', item.last_update ?? '—');

    // An item raised from a state nothing is currently confirming says so, and
    // names what was last actually observed instead of implying it still holds.
    const unconfirmed = node.querySelector('.ark-need-item__unconfirmed');
    if (unconfirmed !== null) {
      unconfirmed.hidden = item.confirmed;
      unconfirmed.textContent = item.confirmed
        ? ''
        : item.last_known_visual === null
          ? `${UNCONFIRMED_PREFIX} · ストリームが状態を確認できていません`
          : `${UNCONFIRMED_PREFIX} · 停止時点: ${item.last_known_visual.symbol} ${item.last_known_visual.label}`;
    }

    fillEvidence(node, item.evidence);
    text(node, '.ark-need-item__artifacts', item.evidence.artifacts.note);
  },
});

// ----------------------------------------------------------------- rows ---

/**
 * One row shape for Now, Next and Outcome.
 *
 * `tag` is the row's class in that panel's own vocabulary - a runtime code, 計画中,
 * or an outcome result - and is always written as text.
 */
function fillRow(node, row, { tag, work, note, evidence }) {
  node.dataset.tag = tag.code;
  node.dataset.confirmed = String(row.confirmed);
  node.dataset.state = row.visual.state;
  text(node, '.ark-row__tag', tag.label);
  text(node, '.ark-row__symbol', row.visual.symbol);
  text(node, '.ark-row__name', row.display_name);
  text(node, '.ark-row__updated', row.updated_at ?? row.ended_at ?? '—');
  text(node, '.ark-row__work', work);
  text(node, '.ark-row__note', note);

  const frozen = node.querySelector('.ark-row__frozen');
  if (frozen !== null) {
    frozen.hidden = row.confirmed;
    frozen.textContent = row.confirmed
      ? ''
      : `${UNCONFIRMED_PREFIX} · 停止時点: ${row.last_known_visual.symbol} ${row.last_known_visual.label}`;
  }

  const drawer = node.querySelector('.ark-row__evidence');
  if (drawer !== null) {
    drawer.hidden = evidence === null;
    if (evidence !== null) {
      fillEvidence(node, evidence);
      text(node, '.ark-row__artifacts', evidence.artifacts.note);
    }
  }
}

const renderNow = keyedList({
  primary: dom.nowList,
  more: dom.nowMore,
  drawer: dom.nowDrawer,
  empty: dom.nowEmpty,
  template: dom.rowTemplate,
  root: '.ark-row',
  key: (row) => row.actor_key,
  fill: (node, row) =>
    fillRow(node, row, {
      tag: { code: row.runtime, label: row.runtime_label },
      // The producer's label for the latest event. Never called a task.
      work: row.work ?? '概要の報告なし',
      note: row.last_tool === null ? '' : `最後のツール: ${row.last_tool}`,
      evidence: null,
    }),
});

const renderNext = keyedList({
  primary: dom.nextList,
  more: null,
  drawer: null,
  empty: dom.nextEmpty,
  template: dom.rowTemplate,
  root: '.ark-row',
  key: (row) => `next:${row.actor_key}`,
  fill: (node, row) =>
    fillRow(node, row, {
      tag: { code: 'PLANNING', label: '計画中' },
      work: row.latest_summary ?? '概要の報告なし',
      // `next_action` is null by contract, and this row says so rather than
      // presenting the latest summary as if it were a plan.
      note: '次の具体的な手順は報告されていません',
      evidence: null,
    }),
});

const renderOutcome = keyedList({
  primary: dom.outcomeList,
  more: dom.outcomeMore,
  drawer: dom.outcomeDrawer,
  empty: dom.outcomeEmpty,
  template: dom.rowTemplate,
  root: '.ark-row',
  key: (row) => `outcome:${row.actor_key}`,
  fill: (node, row) =>
    fillRow(node, row, {
      tag: { code: row.result, label: row.result_label },
      work: row.summary ?? '概要の報告なし',
      note: row.follow_up ?? '未解決の残りはありません',
      evidence: row.evidence,
    }),
});

/**
 * A row of counts. The code is a data attribute and the label is text, so a
 * bucket is readable without the palette and machine-checkable with it.
 */
function renderCounts(parent, entries) {
  parent.replaceChildren();
  for (const entry of entries) {
    const row = clone(dom.countTemplate, '.ark-count');
    row.dataset.code = entry.code;
    text(row, '.ark-count__label', entry.label);
    text(row, '.ark-count__value', String(entry.count));
    parent.append(row);
  }
}

function renderFields(fields) {
  dom.nextFields.replaceChildren();
  for (const field of fields) {
    const row = clone(dom.fieldTemplate, '.ark-field');
    row.dataset.key = field.key;
    text(row, '.ark-field__label', field.label);
    text(row, '.ark-field__value', field.value);
    dom.nextFields.append(row);
  }
}

/**
 * The one status banner, written only when it actually changed so one change
 * costs one announcement instead of one per frame.
 */
function renderBanner(banner) {
  if (
    announced !== null &&
    announced.code === banner.code &&
    announced.tone === banner.tone &&
    announced.symbol === banner.symbol &&
    announced.message === banner.message
  ) {
    return;
  }
  announced = banner;
  dom.banner.dataset.tone = banner.tone;
  dom.banner.dataset.code = banner.code;
  text(dom.banner, '.ark-banner__symbol', banner.symbol);
  text(dom.banner, '.ark-banner__code', banner.code);
  text(dom.banner, '.ark-banner__message', banner.message);
}

// ------------------------------------------------------ command surface ---

/**
 * Rebuilds the draft from what is in the field.
 *
 * Builds a payload and shows it. Sends nothing: there is no authenticated
 * Control boundary to send it to, `ARK_SUBMISSION` says so on screen, and the
 * payload itself carries `dispatch: 'none'`.
 */
function renderCommand() {
  const draft = buildCommandDraft(dom.commandInput.value, {
    namespace: state.namespace,
    target_actor_key: state.selected_actor_key,
    at: new Date().toISOString(),
  });
  setText(dom.commandCount, `${draft.length} / ${draft.max} 文字`);
  setText(
    dom.commandStatus,
    draft.status === 'ready' ? '下書きとして組み立て可能です。' : (draft.message ?? ''),
  );
  dom.commandStatus.dataset.status = draft.status;
  setText(
    dom.commandPreview,
    draft.payload === null ? '（未入力、または入力を受け付けられません）' : JSON.stringify(draft.payload, null, 2),
  );
  // Stated unconditionally, in every state of the field: this screen never sends.
  setText(dom.commandSubmission, `${draft.submission.code} — ${draft.submission.message}`);
  dom.commandSubmission.dataset.available = String(draft.submission.available);
  dom.commandSubmit.disabled = true;
  dom.commandSubmit.setAttribute('aria-disabled', 'true');
  return draft;
}

// ---------------------------------------------------------------- render ---

function render() {
  const ark = selectArk(state);
  const header = ark.header;

  setText(dom.mode, header.mode);
  setText(dom.connection, `${header.connection.symbol} ${header.connection.label}`);
  setText(dom.seq, String(header.last_ingest_seq));
  setText(dom.desks, String(header.desk_count));
  setText(dom.freshness, describeFreshness(state, Date.now()));

  for (const button of dom.modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === header.namespace));
  }

  renderBanner(ark.banner);

  // Need You, first and loudest. The count is repeated in the top bar so it is
  // readable even before the panel itself is looked at.
  setText(dom.attentionCount, String(ark.attention.count));
  setText(dom.needCount, String(ark.attention.count));
  dom.needCount.dataset.required = String(ark.attention.required);
  renderNeed(ark.attention.items);

  renderCounts(
    dom.nowCounts,
    ARK_RUNTIME_CODES.map((code) => ({
      code,
      label: runtimeLabel(code),
      count: ark.now.counts[code],
    })),
  );
  dom.nowUnconfirmed.hidden = ark.now.confirmed;
  setText(
    dom.nowUnconfirmed,
    ark.now.confirmed
      ? ''
      : `${UNCONFIRMED_PREFIX} · ストリームが状態を確認していないため、全員を状態不明として扱っています。`,
  );
  renderNow(ark.now.rows);
  setText(dom.nowExternal, ark.now.external_wait.note);

  setText(dom.nextNote, ark.next.note);
  renderNext(ark.next.rows);
  renderFields(ark.next.fields);

  renderCounts(
    dom.outcomeCounts,
    ARK_OUTCOME_RESULTS.map((result) => ({
      code: result,
      label: outcomeLabel(result),
      count: ark.outcome.counts[result],
    })),
  );
  renderOutcome(ark.outcome.rows);
  setText(dom.outcomeArtifacts, ark.outcome.artifacts.note);

  renderCommand();
}

for (const button of dom.modeButtons) {
  button.addEventListener('click', () => {
    const namespace = button.dataset.mode;
    if (!NAMESPACES.includes(namespace) || namespace === state.namespace) return;
    window.location.hash = namespace;
    connect(namespace);
  });
}

dom.reconnect.addEventListener('click', () => {
  connect(state.namespace);
});

dom.commandInput.addEventListener('input', renderCommand);
// Rebuilds the preview. Named 「組み立てる」 and not 「送信」 because building is
// the only thing it can do.
dom.commandBuild.addEventListener('click', renderCommand);

window.addEventListener('hashchange', () => {
  const namespace = readNamespaceFromHash();
  if (namespace !== state.namespace) connect(namespace);
});

// Only the freshness readout is on a timer; nothing else polls.
window.setInterval(() => {
  setText(dom.freshness, describeFreshness(state, Date.now()));
}, 1000);

connect(state.namespace);
