# OSS / Standard Reuse First — Quest implementation gate

Owner-approved permanent ARK development rule.

Before implementing **any change**, decide whether the need is already solved by a platform-native capability, existing ARK code, official framework/provider feature, maintained OSS/library, or an appropriate service.

The objective is to avoid rebuilding solved problems while preserving Quest's current architectural strengths.

## Required outcome

Every implementation records one of:

- `REUSE`: adopt/adapt existing capability;
- `BUILD`: custom implementation is justified;
- `N/A`: trivial/mechanical change where reuse research is irrelevant;
- `BLOCKED`: research cannot be completed with available evidence/tools.

For non-trivial changes, check in order:

1. browser/Node/runtime-native capability;
2. existing Quest or ai-company implementation/contract;
3. official framework/provider feature;
4. maintained OSS/library;
5. managed service only when policy allows and it reduces total ownership cost;
6. custom code only after comparison.

## Quest-specific dependency rule

Quest currently has an intentional zero-dependency browser/Node architecture. Do **not** add a package merely because a relevant OSS exists.

A new dependency must show a concrete net benefit after comparing:

- implementation removed vs integration added;
- transitive/supply-chain surface;
- bundle/runtime footprint;
- browser/Node compatibility;
- security and data boundary;
- license/commercial use;
- maintenance health;
- testability and observability;
- migration/rollback/exit path;
- long-term ownership burden.

When native code remains smaller, clearer, safer, and cheaper to own, `BUILD` is valid.

## Build justification

For a non-trivial `BUILD`, record candidates considered, why they were rejected/deferred, and the seam that permits future replacement.

Never copy or fork third-party code without license and attribution review. Unknown license/maintenance/security claims remain unknown.

## Research depth

- typo/copy/fixture/obvious one-line correction: `N/A` is enough;
- ordinary feature/bugfix: quick native/existing/OSS check;
- UI engines, state, streaming, persistence, orchestration, observability, auth/security, evaluation, data stores: deeper comparison is mandatory.

## Agent enforcement

Claude Code implementers and Codex reviewers must enforce this gate. It is an engineering-quality requirement, not permission to bypass Human Gate, security boundaries, tests, CI, review, or licensing obligations.
