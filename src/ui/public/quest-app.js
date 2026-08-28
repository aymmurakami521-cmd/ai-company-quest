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
  ACTOR_LEGEND_STATES,
  NOT_REPORTED,
  NO_EVIDENCE_IN_CONTRACT,
  applyFrame,
  createClientState,
  describeFreshness,
  selectBanner,
  selectDesks,
  selectDetail,
  selectHeader,
  selectOffice,
  selectPlayer,
  selectSecondaryStatus,
  setConnectionPhase,
  setSelectedActor,
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
  orgStatus: document.getElementById('org-status'),
  desks: document.getElementById('desks'),
  player: document.getElementById('player'),
  playerName: document.getElementById('player-name'),
  emptyState: document.getElementById('empty-state'),
  legend: document.getElementById('legend'),
  log: document.getElementById('log'),
  logEmpty: document.getElementById('log-empty'),
  deskTemplate: document.getElementById('desk-template'),
  zoneTemplate: document.getElementById('zone-template'),
  logTemplate: document.getElementById('log-template'),
  legendTemplate: document.getElementById('legend-template'),
  canvas: document.getElementById('office-canvas'),
  canvasFrame: document.getElementById('office-canvas-frame'),
  detail: document.getElementById('detail'),
  detailEmpty: document.getElementById('detail-empty'),
  detailRecent: document.getElementById('detail-recent'),
  detailRecentEmpty: document.getElementById('detail-recent-empty'),
  detailRecentTemplate: document.getElementById('detail-recent-template'),
  detailMain: document.getElementById('detail-main'),
  detailFrozen: document.getElementById('detail-frozen'),
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

/** Writes one detail row by id. Text only - nothing off the stream becomes markup. */
function detailText(id, value) {
  const node = document.getElementById(id);
  if (node !== null) node.textContent = value;
}

/** One line describing a log row, in the same shape the activity log uses. */
function describeLogEntry(entry) {
  const parts = [entry.status, entry.tool_name, entry.summary].filter(
    (part) => typeof part === 'string' && part.length > 0,
  );
  return parts.length === 0 ? '—' : parts.join(' · ');
}

/**
 * The selected colleague.
 *
 * Every row the event contract cannot fill says so in words. A blank row would
 * read as "there was nothing", which is a different claim from "this stream does
 * not carry that".
 */
function renderDetail(detail) {
  const hasSelection = detail !== null;
  dom.detail.hidden = !hasSelection;
  dom.detailEmpty.hidden = hasSelection;
  if (!hasSelection) {
    dom.detailRecent.replaceChildren();
    return;
  }

  detailText('detail-name', detail.display_name);
  dom.detailMain.hidden = !detail.is_main_orchestrator;
  detailText('detail-symbol', detail.visual.symbol);
  detailText('detail-state', `${detail.visual.label} (${detail.visual.code})`);

  // While the stream is not confirming this desk, the state above reads 状態不明
  // and this line carries what was last actually observed.
  dom.detailFrozen.hidden = !detail.stale;
  dom.detailFrozen.textContent = detail.stale
    ? `凍結 · 停止時点: ${detail.last_known_visual.symbol} ${detail.last_known_visual.label}`
    : '';

  // A business task and an event summary are different things, and the contract
  // carries only the second. They are never printed into the same row.
  detailText('detail-task', detail.task ?? NOT_REPORTED);
  detailText('detail-summary', detail.latest_summary ?? NOT_REPORTED);
  detailText('detail-next', detail.next_action ?? NOT_REPORTED);
  detailText('detail-human', detail.human_action);
  detailText('detail-evidence', detail.evidence ?? NO_EVIDENCE_IN_CONTRACT);
  detailText(
    'detail-last-ok',
    detail.last_non_error === null
      ? NOT_REPORTED
      : `${detail.last_non_error.ts} · ${describeLogEntry(detail.last_non_error)}`,
  );
  detailText('detail-recovery', detail.recovery ?? NOT_REPORTED);

  detailText('detail-role', detail.role ?? '未解決');
  detailText('detail-runtime', detail.runtime_agent_type ?? NOT_REPORTED);
  detailText('detail-raw', detail.status_label ?? '—');
  detailText('detail-tool', detail.last_tool ?? '—');
  detailText('detail-event-type', detail.last_event_type ?? '—');
  detailText('detail-ts', detail.last_event_ts ?? '—');
  detailText(
    'detail-session',
    detail.session_ended_at === null
      ? `${detail.session_id}（進行中）`
      : `${detail.session_id}（終了: ${detail.session_ended_at}）`,
  );
  detailText('detail-count', String(detail.event_count));
  detailText('detail-key', detail.actor_key);

  dom.detailRecent.replaceChildren();
  for (const entry of detail.recent) {
    const row = dom.detailRecentTemplate.content.cloneNode(true);
    text(row, '.detail__recent-symbol', visualForState(entry.state).symbol);
    text(row, '.detail__recent-ts', entry.ts);
    text(row, '.detail__recent-type', entry.event_type);
    text(row, '.detail__recent-detail', describeLogEntry(entry));
    dom.detailRecent.append(row);
  }
  dom.detailRecentEmpty.hidden = detail.recent.length > 0;
}

function renderLegend() {
  dom.legend.replaceChildren();
  for (const name of ACTOR_LEGEND_STATES) {
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

/**
 * The desk projection currently in the DOM.
 *
 * A rendered select button carries only its position in this array, never an
 * `actor_key`: identifiers off the wire reach the DOM as `textContent` and
 * nothing else, and the two are always updated together, so the position cannot
 * go stale.
 */
let renderedDesks = [];

/**
 * The <li> in the DOM for each seated `actor_key`.
 *
 * One colleague keeps one element for as long as they are seated, and the map
 * is the only place their key is held - it never reaches an attribute.
 *
 * This exists for the keyboard. A busy LIVE stream re-renders on every frame,
 * and an element removed from the document takes the focus with it: rebuilding
 * the list wholesale would drop focus out of a desk button several times a
 * second, which is exactly the case "select any colleague with a keyboard
 * alone" has to survive. Reusing the element means the common re-render - the
 * same colleagues, in the same order, with new status text - does not touch the
 * focused node at all, so nothing has to give focus back and the script still
 * never calls `focus()` on anything.
 */
let renderedNodes = new Map();

/**
 * The <li> in the DOM for each zone, for the same reason `renderedNodes` exists:
 * re-creating a zone would re-create the desks inside it and take the focus with
 * them. Zones change only when a snapshot brings a different organisation.
 */
let renderedZones = new Map();

function buildDeskNode() {
  const fragment = dom.deskTemplate.content.cloneNode(true);
  const item = fragment.querySelector('.desk');
  return {
    item,
    select: item.querySelector('.desk__select'),
    badge: item.querySelector('.desk__badge'),
    frozen: item.querySelector('.desk__frozen'),
    vacant: item.querySelector('.desk__vacant'),
  };
}

function fillDeskNode(node, desk, index) {
  const { item, select, badge, frozen, vacant } = node;
  // Vacant on a desk that carries `occupied: false`; every desk built by
  // `selectDesks` alone has no such field and is occupied by construction.
  const empty = desk.occupied === false;
  item.dataset.state = desk.visual.state;
  item.dataset.selected = String(desk.selected);
  item.dataset.stale = String(desk.stale);
  item.dataset.occupied = String(!empty);
  select.dataset.deskIndex = String(index);
  // A seat nobody is at opens nothing, so its button leaves the tab order
  // rather than offering a selection that would immediately clear itself.
  select.disabled = empty;
  // The state is exposed as `aria-pressed`, so it is never carried by the
  // border colour alone.
  select.setAttribute('aria-pressed', String(desk.selected));
  if (vacant !== null) vacant.hidden = !empty;
  // The roster seat when the roster placed this desk, the dynamic one
  // otherwise. Never one standing in for the other: a desk with neither is not
  // produced (`docs/org-snapshot-design.md` §4.4).
  const seatNumber = desk.roster_seat ?? desk.seat;
  text(item, '.desk__seat', seatNumber === null || seatNumber === undefined ? '—' : `#${seatNumber}`);
  // The reported name when there is one; a vacant seat has only its roster
  // label. The two are never merged into one another.
  text(item, '.desk__agent', desk.display_name ?? desk.role_name ?? '—');
  text(item, '.desk__roster', desk.role_name ?? '—');
  badge.hidden = !desk.is_main_orchestrator;
  text(item, '.desk__symbol', desk.visual.symbol);
  text(item, '.desk__state-label', `${desk.visual.label} (${desk.visual.code})`);
  // While stale, the state above reads 状態不明 and this line carries the last
  // observation. Hidden entirely otherwise, so a healthy office says nothing
  // about a freeze that is not happening.
  frozen.hidden = !desk.stale;
  text(
    item,
    '.desk__frozen-text',
    `停止時点: ${desk.last_known_visual.symbol} ${desk.last_known_visual.label}`,
  );
  // `role` is already null unless the collector resolved one.
  text(item, '.desk__role', desk.role ?? '未解決');
  text(item, '.desk__raw-status', desk.status_label ?? '—');
  text(item, '.desk__tool', desk.last_tool ?? '—');
  text(item, '.desk__session', desk.session_id ?? '—');
  text(item, '.desk__ts', desk.last_event_ts ?? '—');
}

function buildZoneNode() {
  const fragment = dom.zoneTemplate.content.cloneNode(true);
  const item = fragment.querySelector('.zone');
  return { item, name: item.querySelector('.zone__name'), list: item.querySelector('.zone__desks') };
}

/**
 * A stable identity per desk element.
 *
 * An occupied desk is identified by its actor, a vacant roster seat by the role
 * whose seat it is. Both are needed: a seat that is empty on one frame and
 * filled on the next must keep its element, or the roster would flicker its way
 * through the focus.
 */
function deskNodeKey(desk) {
  if (desk.actor_key !== null && desk.actor_key !== undefined) return `actor:${desk.actor_key}`;
  return `roster:${desk.role_id}`;
}

/**
 * Places one list of desks inside one parent, moving only what has to move.
 *
 * For the ordinary frame - same colleagues, same order, new status text - that
 * is zero DOM moves, so a focused button is never removed and re-inserted.
 */
function placeDesks(parent, desks, nodes, offset) {
  desks.forEach((desk, index) => {
    const node = nodes.get(deskNodeKey(desk));
    const current = parent.children[index + offset] ?? null;
    if (current !== node.item) parent.insertBefore(node.item, current);
  });
}

function renderDesks(office) {
  const desks = office.desks;
  const next = new Map();
  desks.forEach((desk, index) => {
    const key = deskNodeKey(desk);
    const node = renderedNodes.get(key) ?? buildDeskNode();
    fillDeskNode(node, desk, index);
    next.set(key, node);
  });

  // Colleagues who left go first, so nothing stale is in the list while the
  // rest is placed - and so focus that was on a departing desk is released
  // rather than moved onto somebody else's button.
  for (const [key, node] of renderedNodes) {
    if (!next.has(key)) node.item.remove();
  }

  const nextZones = new Map();
  if (office.grouped) {
    office.zones.forEach((zone, index) => {
      const node = renderedZones.get(zone.id) ?? buildZoneNode();
      node.name.textContent = zone.name;
      node.item.dataset.kind = zone.kind;
      // A department with nobody in it is still a department. An empty 未所属 is
      // not news, so it is the one zone that hides when it holds nothing.
      node.item.hidden = zone.kind === 'unassigned' && zone.desks.length === 0;
      nextZones.set(zone.id, node);
      const current = dom.desks.children[index] ?? null;
      if (current !== node.item) dom.desks.insertBefore(node.item, current);
      placeDesks(node.list, zone.desks, next, 0);
    });
  } else {
    // No organisation: the desks are children of `#desks` itself, exactly as
    // they were before the roster existed.
    placeDesks(dom.desks, desks, next, 0);
  }

  for (const [id, node] of renderedZones) {
    if (!nextZones.has(id)) node.item.remove();
  }

  renderedZones = nextZones;
  renderedNodes = next;
  renderedDesks = desks;
}

/**
 * The human player.
 *
 * Rendered outside the colleague list and with no control of its own: the
 * player is not selectable, is not a seat, and is not something the operator
 * acts on from here. `selectPlayer` returns null until a snapshot names one, and
 * the whole figure is hidden until then rather than showing a placeholder
 * person.
 */
function renderPlayer(player) {
  dom.player.hidden = player === null;
  if (player === null) return;
  dom.playerName.textContent = player.display_name;
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
 * Writes the second status surface.
 *
 * Unconditional: this element always carries a code, because a screen that
 * quietly stops grouping is the one failure the organisation contract rules out
 * (`docs/org-snapshot-design.md` §2.4). Not a live region, so writing it every
 * frame costs an announcement to nobody.
 */
function renderSecondaryStatus(status) {
  dom.orgStatus.dataset.code = status.code;
  dom.orgStatus.dataset.tone = status.tone;
  dom.orgStatus.dataset.degraded = String(status.degraded);
  text(dom.orgStatus, '.orgstatus__code', status.code);
  text(dom.orgStatus, '.orgstatus__message', status.message);
  // Field path and rule name only. No employee name, department name or path.
  text(dom.orgStatus, '.orgstatus__detail', status.detail ?? '');
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
  const world = buildWorld({ desks: painted.desks, player: painted.player, header: painted.header, viewport });
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

function renderCanvas(header, desks, player) {
  painted = { header, desks, player };
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
  // Two projections of the same state, on purpose. The canvas and the header
  // counts stay on the actor-only list: a vacant roster seat is not somebody at
  // work, so it is not in 在席数, and the floor plan that would place it is the
  // deterministic layout still to come (§5 PR-4).
  const desks = selectDesks(state);
  const office = selectOffice(state);
  const player = selectPlayer(state);

  dom.statMode.textContent = header.mode;
  dom.statConnection.textContent = `${header.connection.symbol} ${header.connection.label}`;
  dom.statSeq.textContent = String(header.last_ingest_seq);
  dom.statDesks.textContent = String(header.desk_count);
  dom.statFreshness.textContent = describeFreshness(state, Date.now());

  for (const button of dom.modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === header.namespace));
  }

  renderBanner(header);
  renderSecondaryStatus(selectSecondaryStatus(state));
  renderPlayer(player);
  renderDesks(office);
  renderDetail(selectDetail(state));
  renderLog(state.log);
  dom.emptyState.hidden = !header.empty;
  renderCanvas(header, desks, player);
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

/**
 * Selecting a colleague.
 *
 * One listener on the list rather than one per seat, so an office of any size
 * costs the same. The event is a `click`, which a native <button> also fires for
 * Enter and Space - that is what makes every desk selectable with the keyboard
 * alone, with no key handler and no focus management of our own.
 *
 * Selecting the selected desk again clears it, which is what `aria-pressed`
 * already promises a toggle button does.
 */
dom.desks.addEventListener('click', (event) => {
  // A click inside the button lands on one of its spans, so the control is
  // found by walking up rather than by comparing the target.
  const button = event.target.closest('[data-action="select-desk"]');
  if (button === null) return;
  const desk = renderedDesks[Number(button.dataset.deskIndex)];
  if (desk === undefined) return;
  // A vacant roster seat has no actor to open. `setSelectedActor` would refuse
  // the null anyway; returning here means the click does not clear a selection
  // the operator made on somebody else.
  if (desk.actor_key === null || desk.actor_key === undefined) return;
  setState(setSelectedActor(state, desk.selected ? null : desk.actor_key));
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
