/**
 * The DEMO organisation.
 *
 * DEMO reads no files (`README.md` 「DEMO」, `docs/org-snapshot-design.md` §4.6):
 * the scripted mission has to stay a fixed sequence with no timer, no randomness
 * and no external I/O, so the organisation it is grouped by is static data here
 * rather than a path. LIVE keeps reading the operator-configured snapshot and
 * never sees this object.
 *
 * The shape is chosen so `npm run demo` alone exercises every rule in
 * `docs/org-snapshot-design.md` §2.3 rather than only the happy one:
 *
 * - `orchestrator` / `implementer` / `verifier` / `reviewer` are the comparison
 *   keys the scripted timeline actually emits, so those seats fill;
 * - `designer` / `analyst` / `assistant` are emitted by nobody, so their seats
 *   stay and show 不在 - the roster says the desk exists, never that somebody
 *   is at it;
 * - `dept-planning` fills with nobody at all, so a department with no reported
 *   activity still appears;
 * - `role-assistant` has no department, which is the roster half of 未所属;
 * - the timeline gives `dev-1` and `sync-1` the same `implementer` key, so one
 *   seat takes one of them and the other is placed in 未所属 - a seat belongs to
 *   a person, not to a session (§4.2);
 * - `demo-session-01`'s `main` carries no `runtime_agent_type` at all, so it is
 *   an actor the roster cannot know and lands in 未所属 too. It is never dropped.
 *
 * The identifiers and labels obey the upstream grammar, and `test/ui-org.test.ts`
 * holds that by running this snapshot through the real `validateOrgSnapshot`.
 */

import { SUPPORTED_ORG_SCHEMA_VERSION, type OrgState } from '../domain/org.ts';

export const DEMO_ORG: OrgState = {
  status: 'accepted',
  snapshot: {
    schema_version: SUPPORTED_ORG_SCHEMA_VERSION,
    company: { id: 'demo-company', name: 'デモ株式会社' },
    departments: [
      { id: 'dept-development', name: '開発部', display_order: 10 },
      { id: 'dept-quality', name: '品質管理部', display_order: 20 },
      { id: 'dept-planning', name: '経営企画部', display_order: 30 },
    ],
    roles: [
      {
        id: 'role-orchestrator',
        name: '統括ディレクター',
        kind: 'department',
        department_id: 'dept-development',
        agent_ref: null,
        runtime_agent_type: 'orchestrator',
        display_order: 10,
      },
      {
        id: 'role-implementer',
        name: '開発担当',
        kind: 'staff',
        department_id: 'dept-development',
        agent_ref: null,
        runtime_agent_type: 'implementer',
        display_order: 20,
      },
      {
        id: 'role-designer',
        name: '設計担当',
        kind: 'staff',
        department_id: 'dept-development',
        agent_ref: null,
        runtime_agent_type: 'designer',
        display_order: 30,
      },
      {
        id: 'role-verifier',
        name: '検証担当',
        kind: 'staff',
        department_id: 'dept-quality',
        agent_ref: null,
        runtime_agent_type: 'verifier',
        display_order: 10,
      },
      {
        id: 'role-reviewer',
        name: 'レビュー担当',
        kind: 'staff',
        department_id: 'dept-quality',
        agent_ref: null,
        runtime_agent_type: 'reviewer',
        display_order: 20,
      },
      {
        id: 'role-analyst',
        name: '分析担当',
        kind: 'staff',
        department_id: 'dept-planning',
        agent_ref: null,
        runtime_agent_type: 'analyst',
        display_order: 10,
      },
      {
        id: 'role-assistant',
        name: '業務アシスタント',
        kind: 'assistant',
        department_id: null,
        agent_ref: null,
        runtime_agent_type: 'assistant',
        display_order: 10,
      },
    ],
    facilities: [
      { id: 'meeting-room', name: '会議室', type: 'shared', display_order: 10 },
      { id: 'skill-workshop', name: 'Skill工房', type: 'shared', display_order: 20 },
    ],
  },
};
