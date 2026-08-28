/**
 * The organisation degradation, as it actually reaches the screen.
 *
 * `test/ui-org.test.ts` holds the projection: given a broken organisation, the
 * view model degrades and reports it. That is necessary and not sufficient - a
 * projection that says `ORG_REJECTED` into a surface nobody renders is still a
 * silent failure to the person looking at the office.
 *
 * So this file drives the *shipped* `quest-app.js` against `test/fakeDom.ts`,
 * feeds real `snapshot` frames down a stream, and asserts what is written into
 * the page: the second status surface carries the code, and the desk list falls
 * back to the flat pre-roster list rather than a half-grouped one
 * (`docs/org-snapshot-design.md` §2.4, §3.1 検証③, §3.2 検証⑦).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { DEMO_ORG } from '../src/demo/orgFixture.ts';
import { makeEvent } from './helpers.ts';
import type { FakeElement } from './fakeDom.ts';
import { currentStream, installFakeDom } from './fakeDom.ts';

const { document: fakeDocument } = installFakeDom();

// The app is a module with side effects: importing it renders the page and
// opens the stream, so it is imported once, here, for the whole file.
await import(new URL('../src/ui/public/quest-app.js', import.meta.url).href);

const AGENTS = ['main', 'orch-1', 'impl-1'];

/** The comparison key each agent runs under, matching the DEMO fixture. */
const RUNTIME_TYPES: Record<string, string | null> = {
  main: null,
  'orch-1': 'orchestrator',
  'impl-1': 'implementer',
};

/** A snapshot from a real store, so the payload the app parses is a real one. */
function snapshot(org: unknown): unknown {
  const store = new NamespaceStore({ namespace: 'live' });
  AGENTS.forEach((agent, index) => {
    store.ingestObject(
      makeEvent({
        event_type: 'agent_start',
        agent_id: agent,
        status: 'active',
        runtime_agent_type: RUNTIME_TYPES[agent] ?? null,
        ts: `2026-01-01T00:00:0${index}.000Z`,
      }),
    );
  });
  return {
    namespace: 'live',
    halted: false,
    halt_reason: null,
    last_ingest_seq: store.stats.last_ingest_seq,
    state: { ...(JSON.parse(JSON.stringify(store.state)) as Record<string, unknown>), org },
  };
}

function orgStatus(): FakeElement {
  return fakeDocument.element('org-status');
}

function slot(selector: string): string {
  const found = orgStatus().querySelector(selector);
  if (found === null) throw new Error(`the second status surface has no ${selector}`);
  return found.textContent;
}

function deskList(): FakeElement {
  return fakeDocument.element('desks');
}

function classesInList(): string[] {
  return deskList().children.map((child) => child.className);
}

currentStream().emit('open', {});

// ------------------------------------------------------------------ cases ---

test('an absent organisation renders the flat list and names the degradation', () => {
  currentStream().emit('snapshot', snapshot({ status: 'absent' }));

  assert.equal(orgStatus().dataset.code, 'ORG_ABSENT');
  assert.equal(orgStatus().dataset.degraded, 'true');
  assert.equal(slot('.orgstatus__code'), 'ORG_ABSENT');
  assert.ok(slot('.orgstatus__message').length > 0, 'the surface is never blank');
  assert.equal(slot('.orgstatus__detail'), '', 'an absence has no rejection detail');

  // The pre-roster screen, exactly: desks are direct children, no zone wrapper.
  assert.deepEqual(new Set(classesInList()), new Set(['desk']));
  assert.equal(deskList().children.length, AGENTS.length);
});

test('a refused organisation is announced as refused, and never half-grouped', () => {
  currentStream().emit(
    'snapshot',
    snapshot({ status: 'rejected', field: 'roles[2].name', rule: 'unsafe_content' }),
  );

  assert.equal(orgStatus().dataset.code, 'ORG_REJECTED');
  assert.equal(orgStatus().dataset.degraded, 'true');
  assert.equal(slot('.orgstatus__detail'), 'roles[2].name / unsafe_content');
  // Field path and rule name only.
  assert.equal(slot('.orgstatus__message').includes('roles['), false);

  assert.deepEqual(new Set(classesInList()), new Set(['desk']), 'no zone survives a refusal');
  assert.equal(deskList().children.length, AGENTS.length, 'and no colleague is lost with it');
});

test('an accepted organisation groups the list and puts the department names in the DOM', () => {
  currentStream().emit('snapshot', snapshot(DEMO_ORG));

  assert.equal(orgStatus().dataset.code, 'ORG_ACCEPTED');
  assert.equal(orgStatus().dataset.degraded, 'false');
  assert.equal(slot('.orgstatus__detail'), '');

  assert.deepEqual(new Set(classesInList()), new Set(['zone']), 'the list is zones now');
  const names = deskList()
    .children.map((zone) => zone.querySelector('.zone__name')?.textContent)
    .filter((name): name is string => name !== undefined && name.length > 0);
  // §3.1 検証④: the zone names are in the DOM, not only on the decorative canvas.
  assert.ok(names.includes('開発部'), `department names reach the DOM: ${names.join(' / ')}`);
  assert.ok(names.includes('未所属'), 'including the container for everyone else');

  // Every actor is still on screen, and the roster seats nobody answers to are
  // there as well - drawn, and not given a state.
  const desks = deskList()
    .children.flatMap((zone) => zone.querySelector('.zone__desks')?.children ?? [])
    .filter((desk) => desk.className === 'desk');
  const vacant = desks.filter((desk) => desk.dataset.occupied === 'false');
  assert.ok(desks.length > AGENTS.length, 'roster seats are drawn alongside the actors');
  assert.ok(vacant.length > 0, 'and a seat with nobody at it is marked as such');
  for (const desk of vacant) {
    assert.equal(desk.dataset.state, 'vacant', 'a vacant seat never borrows a working state');
    assert.equal(desk.querySelector('.desk__vacant')?.hidden, false, 'and says so in words');
  }
});

test('going back to no organisation restores the flat list rather than freezing the last one', () => {
  currentStream().emit('snapshot', snapshot(DEMO_ORG));
  assert.deepEqual(new Set(classesInList()), new Set(['zone']));

  currentStream().emit('snapshot', snapshot({ status: 'absent' }));
  assert.equal(orgStatus().dataset.code, 'ORG_ABSENT');
  assert.deepEqual(new Set(classesInList()), new Set(['desk']), 'the stale grouping is gone');
  assert.equal(deskList().children.length, AGENTS.length);
});

test('the second status surface is not a live region, so it never interrupts a reader', () => {
  const element = orgStatus();
  assert.equal(element.attributes['aria-live'], undefined);
  assert.equal(element.attributes['role'], undefined);
});
