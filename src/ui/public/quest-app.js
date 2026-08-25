/**
 * Browser glue: one SSE connection in, DOM out.
 *
 * Everything that decides *what* is shown lives in `quest-view.js` and is unit
 * tested. This file only wires `EventSource` frames into that view model and
 * writes the result into cloned <template> nodes.
 *
 * Boundaries kept here:
 * - read-only: the only requests made are the two documented SSE GETs;
 * - one namespace at a time: switching closes the stream and starts a brand new
 *   client state, so LIVE and DEMO can never appear on the screen together;
 * - stream content reaches the DOM through `textContent` only, never through a
 *   markup-parsing assignment, so a sanitized label is always rendered as text;
 * - nothing is logged to the console, so no stream content lands there either.
 *
 * The canvas layer added on top of this is deliberately thin: it turns the same
 * two projections into a `World` and paints it. It is additive - if the canvas
 * or its 2D context is missing, every part of the DOM screen still works.
 */

import { drawWorld } from './quest-canvas.js';
import { buildWorld, measureCanvasViewport } from './quest-world.js';
import {
  ACTOR_VISUAL_STATES,
  applyFrame,
  createClientState,
  describeFreshness,
  selectBanner,
  selectDesks,
  selectHeader,
  setConnectionPhase,
  visualForState,
} from './quest-view.js';

const NAMESPACES = ['live', 'demo'];

/** Frame names that come from the documented SSE control contract. */
const CONTROL_FRAMES = ['snapshot', 'replay_start', 'replay_end', 'stream_gap', 'fail_closed'];

const dom = {
  modeButtons: Array.from(document.querySelectorAll('[data-mode]')),
  reconnect: document.querySelector('[data-action="reconnect"]'),
  statMode: document.getElementById('stat-mode'),
  statConnection: document.getElementById('stat-connection'),
  statFreshness: document.getElementById('stat-freshness'),
  statSeq: document.getElementById('stat-seq'),
  statDesks: document.getElementById('stat-desks'),
  banner: document.getElementById('banner'),
  desks: document.getElementById('desks'),
  emptyState: document.getElementById('empty-state'),
  legend: document.getElementById('legend'),
  log: document.getElementById('log'),
  logEmpty: document.getElementById('log-empty'),
  deskTemplate: document.getElementById('desk-template'),
  logTemplate: document.getElementById('log-template'),
  legendTemplate: document.getElementById('legend-template'),
  canvas: document.getElementById('office-canvas'),
  canvasFrame: document.getElementById('office-canvas-frame'),
};

let source = null;
let state = createClientState(readNamespaceFromHash());

/** The banner last written to the live region, so an unchanged one is not re-announced. */
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

/**
 * Opens the stream for one namespace. Any previous connection is closed and the
 * client state is rebuilt from scratch, so no frame from the previous namespace
 * can survive the switch.
 */
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
    // A frame we cannot parse is counted, never guessed at.
    setState(applyFrame(state, { kind: 'unparseable', at_ms: Date.now() }));
    return;
  }
  setState(applyFrame(state, { kind, payload, at_ms: Date.now() }));
}

function text(node, selector, value) {
  const target = node.querySelector(selector);
  if (target !== null) target.textContent = value;
}

function renderLegend() {
  dom.legend.replaceChildren();
  for (const name of ACTOR_VISUAL_STATES) {
    const visual = visualForState(name);
    const row = dom.legendTemplate.content.cloneNode(true);
    const item = row.querySelector('.legend__row');
    item.dataset.state = name;
    text(row, '.legend__symbol', visual.symbol);
    text(row, '.legend__label', visual.label);
    text(row, '.legend__code', visual.code);
    dom.legend.append(row);
  }
}

function renderDesks(desks) {
  dom.desks.replaceChildren();
  for (const desk of desks) {
    const node = dom.deskTemplate.content.cloneNode(true);
    const item = node.querySelector('.desk');
    item.dataset.state = desk.visual.state;
    text(node, '.desk__seat', `#${desk.seat}`);
    text(node, '.desk__agent', desk.display_name);
    const badge = node.querySelector('.desk__badge');
    badge.hidden = !desk.is_main_orchestrator;
    text(node, '.desk__symbol', desk.visual.symbol);
    text(node, '.desk__state-label', `${desk.visual.label} (${desk.visual.code})`);
    // `role` is already null unless the collector resolved one.
    text(node, '.desk__role', desk.role ?? '未解決');
    text(node, '.desk__raw-status', desk.status_label ?? '—');
    text(node, '.desk__tool', desk.last_tool ?? '—');
    text(node, '.desk__session', desk.session_id);
    text(node, '.desk__ts', desk.last_event_ts ?? '—');
    dom.desks.append(node);
  }
}

function renderLog(entries) {
  dom.log.replaceChildren();
  for (const entry of entries) {
    const node = dom.logTemplate.content.cloneNode(true);
    const row = node.querySelector('.log__row');
    row.dataset.state = entry.state;
    text(node, '.log__symbol', visualForState(entry.state).symbol);
    text(node, '.log__seq', `#${entry.ingest_seq}`);
    text(node, '.log__ts', entry.ts);
    text(node, '.log__actor', entry.actor);
    text(node, '.log__type', entry.event_type);
    const detail = [entry.status, entry.tool_name, entry.summary].filter((value) => value !== null && value !== '');
    text(node, '.log__detail', detail.join(' · '));
    dom.log.append(node);
  }
  dom.logEmpty.hidden = entries.length > 0;
}

/**
 * Writes the one status banner.
 *
 * Which situation is showing is decided by `selectBanner` in the tested view
 * model, not here, and it always returns one - the screen is never silent about
 * its connection. This is also the screen's only live region: the header stats
 * repeat the same facts as plain text, so a change is announced exactly once.
 *
 * The code and the symbol are written as text next to the message, so the tone
 * (a colour) never carries meaning that is not already readable.
 *
 * A live region announces itself whenever its descendants are rewritten, even
 * when the new text is the character-for-character same. Most frames leave the
 * status exactly as it was - a heartbeat or a tool call on a seat that is
 * already taken says nothing new about the connection - so the banner is
 * written only when it actually changed. That is what keeps one change to one
 * announcement instead of one per frame.
 */
function renderBanner(header) {
  const banner = selectBanner(header);
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
  const symbol = dom.banner.querySelector('.banner__symbol');
  if (symbol !== null) symbol.textContent = banner.symbol;
  const code = dom.banner.querySelector('.banner__code');
  if (code !== null) code.textContent = banner.code;
  const message = dom.banner.querySelector('.banner__message');
  if (message !== null) message.textContent = banner.message;
}

// ------------------------------------------------------- canvas layer ---

const canvasContext =
  dom.canvas === null || typeof dom.canvas.getContext !== 'function' ? null : dom.canvas.getContext('2d');

/** The last projections painted, so a resize can repaint without new events. */
let painted = null;

/** The viewport those projections were painted at, so a resize can be a no-op. */
let paintedViewport = null;

/**
 * Repaints the office.
 *
 * Called on every state change and on every viewport change - never on a timer
 * and never from an animation-frame callback, so the canvas holds still unless
 * something actually changed. That is what makes `prefers-reduced-motion`
 * a non-issue here rather than a special case.
 */
function currentViewport() {
  return measureCanvasViewport({
    // The canvas' own content box, never the padded frame around it: the buffer
    // is displayed in this box, so this is the width it has to be built for.
    surface_width: dom.canvas === null ? 0 : dom.canvas.clientWidth,
    // Only reached when the canvas has no layout box to report.
    frame_width: dom.canvasFrame === null ? 0 : dom.canvasFrame.clientWidth,
    window_height: window.innerHeight,
    dpr: window.devicePixelRatio,
  });
}

function paintCanvas() {
  if (canvasContext === null || painted === null) return;
  const viewport = currentViewport();
  const world = buildWorld({ desks: painted.desks, header: painted.header, viewport });
  paintedViewport = viewport;
  // Setting the buffer size also clears it; CSS keeps the displayed box at the
  // element's intrinsic ratio, so no inline style is ever written.
  dom.canvas.width = world.canvas.device_width;
  dom.canvas.height = world.canvas.device_height;
  drawWorld(canvasContext, world);
}

/**
 * Repaint only if the box really changed.
 *
 * Painting resizes the canvas, which resizes the frame, which notifies the
 * observer again: without this guard that is a repaint that feeds itself.
 */
function repaintIfResized() {
  if (paintedViewport === null) return;
  const viewport = currentViewport();
  if (
    viewport.width === paintedViewport.width &&
    viewport.height === paintedViewport.height &&
    viewport.dpr === paintedViewport.dpr
  ) {
    return;
  }
  paintCanvas();
}

function renderCanvas(header, desks) {
  painted = { header, desks };
  paintCanvas();
}

if (canvasContext !== null) {
  if (typeof window.ResizeObserver === 'function' && dom.canvasFrame !== null) {
    new window.ResizeObserver(repaintIfResized).observe(dom.canvasFrame);
  }
  // Covers the case a ResizeObserver does not: the same box on a screen whose
  // device pixel ratio just changed.
  window.addEventListener('resize', repaintIfResized);
}

function render() {
  const header = selectHeader(state);
  const desks = selectDesks(state);

  dom.statMode.textContent = header.mode;
  dom.statConnection.textContent = `${header.connection.symbol} ${header.connection.label}`;
  dom.statSeq.textContent = String(header.last_ingest_seq);
  dom.statDesks.textContent = String(header.desk_count);
  dom.statFreshness.textContent = describeFreshness(state, Date.now());

  for (const button of dom.modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === header.namespace));
  }

  renderBanner(header);
  renderDesks(desks);
  renderLog(state.log);
  dom.emptyState.hidden = !header.empty;
  renderCanvas(header, desks);
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

window.addEventListener('hashchange', () => {
  const namespace = readNamespaceFromHash();
  if (namespace !== state.namespace) connect(namespace);
});

// Only the freshness readout is on a timer; nothing else polls.
window.setInterval(() => {
  dom.statFreshness.textContent = describeFreshness(state, Date.now());
}, 1000);

renderLegend();
connect(state.namespace);
