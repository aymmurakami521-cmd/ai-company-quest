/**
 * The screen must not notice the org snapshot yet.
 *
 * This PR reads, validates and retains an organisation; it does not draw one.
 * The design record makes that ordering binding: org-backed UI may only be
 * switched on together with the display contract that shows a degraded state in
 * a closed vocabulary (docs/org-snapshot-design.md §2.4, §5 PR-3). Until then
 * the office must render *identically* whether the org slot is absent, adopted
 * or refused - otherwise the screen would already be leaking an org state it
 * cannot explain.
 *
 * "Identically" is checked twice: through the shipped app driven by a DOM, and
 * through the pure projections plus the canvas world model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import type { OrgState } from '../src/domain/orgSnapshot.ts';
import { ORG_ABSENT, orgAccepted, orgRejected, validateOrgSnapshot } from '../src/domain/orgSnapshot.ts';
import { makeEvent } from './helpers.ts';
import type { FakeElement } from './fakeDom.ts';
import { currentStream, installFakeDom } from './fakeDom.ts';

const { document: fakeDocument } = installFakeDom();

await import(new URL('../src/ui/public/quest-app.js', import.meta.url).href);

const { applyFrame, createClientState, selectBanner, selectDesks, selectHeader, selectPlayer } = await import(
  new URL('../src/ui/public/quest-view.js', import.meta.url).href
);
const { buildWorld } = await import(new URL('../src/ui/public/quest-world.js', import.meta.url).href);

/** Every element the shipped app writes to. */
const PAGE_IDS = [
  'banner',
  'desks',
  'empty-state',
  'legend',
  'log',
  'log-empty',
  'office-canvas',
  'office-canvas-frame',
  'player',
  'player-name',
  'stat-connection',
  'stat-desks',
  'stat-freshness',
  'stat-mode',
  'stat-seq',
];

/** A structural dump of one node and everything under it. */
function dump(node: FakeElement): unknown {
  return {
    tagName: node.tagName,
    className: node.className,
    textContent: node.textContent,
    hidden: node.hidden,
    dataset: { ...node.dataset },
    attributes: { ...node.attributes },
    children: node.children.map(dump),
  };
}

function renderedPage(): unknown {
  return PAGE_IDS.map((id) => [id, dump(fakeDocument.element(id))]);
}

function orgFixture(): OrgState {
  const result = validateOrgSnapshot({
    departments: [{ id: 'dept-alpha', displayName: '第一部', display_order: 10 }],
    roles: [
      {
        id: 'role-lead',
        displayName: 'リード',
        kind: 'department',
        department_id: 'dept-alpha',
        // Deliberately the matching key of a colleague that is also in the
        // stream below: even a *matching* roster must not change the screen yet.
        runtime_agent_type: 'lead-agent',
      },
    ],
    facilities: [{ id: 'zone-workshop', displayName: '工房', type: 'shared' }],
  });
  if (!result.ok) throw new Error('fixture must be valid');
  return orgAccepted(result.snapshot);
}

/** A real server snapshot for one office, parameterised only by its org slot. */
function snapshotFrame(org: OrgState): unknown {
  const store = new NamespaceStore({
    namespace: 'live',
    player: { kind: 'player', id: 'player', display_name: '歩' },
    org,
  });
  ['main', 'worker-1'].forEach((agent, index) => {
    store.ingestObject(
      makeEvent({
        event_id: `0000000${index}-0000-4000-8000-00000000000${index}`,
        event_type: 'agent_start',
        agent_id: agent,
        runtime_agent_type: 'lead-agent',
        status: 'active',
        ts: `2026-01-01T00:00:0${index}.000Z`,
      }),
    );
  });
  return {
    namespace: 'live',
    halted: false,
    halt_reason: null,
    last_ingest_seq: store.stats.last_ingest_seq,
    state: JSON.parse(JSON.stringify(store.state)) as unknown,
  };
}

const ORG_STATES: [string, OrgState][] = [
  ['absent', ORG_ABSENT],
  ['accepted', orgFixture()],
  ['rejected', orgRejected({ rule: 'duplicate_id', field: 'roles[].id' })],
];

test('the shipped office renders identically for every org state', () => {
  const renders = ORG_STATES.map(([name, org]) => {
    currentStream().emit('open', {});
    currentStream().emit('snapshot', snapshotFrame(org));
    return [name, JSON.stringify(renderedPage())] as const;
  });

  const [baseline] = renders;
  assert.ok(baseline !== undefined);
  // A guard on the guard: an empty page would make the comparison vacuous.
  assert.ok(baseline[1].includes('worker-1'), 'the baseline really rendered the office');

  for (const [name, rendered] of renders.slice(1)) {
    assert.equal(rendered, baseline[1], `the ${name} org state changed the rendered page`);
  }
});

test('the view model and the canvas world are unchanged by the org state', () => {
  const projections = ORG_STATES.map(([name, org]) => {
    let state = createClientState('live');
    state = applyFrame(state, { kind: 'snapshot', payload: snapshotFrame(org), at_ms: 0 });
    const desks = selectDesks(state);
    const header = selectHeader(state);
    return [
      name,
      JSON.stringify({
        desks,
        header,
        banner: selectBanner(header),
        player: selectPlayer(state),
        world: buildWorld({ desks, player: selectPlayer(state), viewport: { width: 960, height: 540, dpr: 1 } }),
      }),
    ] as const;
  });

  const [baseline] = projections;
  assert.ok(baseline !== undefined);
  assert.ok(baseline[1].includes('"seat":1'), 'the baseline really produced an office');
  assert.ok(!baseline[1].includes('dept-alpha'), 'no org identifier reaches the view model');

  for (const [name, projected] of projections.slice(1)) {
    assert.equal(projected, baseline[1], `the ${name} org state changed the projections`);
  }
});
