# Codex instructions — AI Company Quest

Read `README.md` and `docs/development/oss-reuse-first.md` before reviewing or proposing implementation.

## Reuse Before Build

For every implementation/review, require a proportional Reuse Gate:

- `REUSE`: existing capability is adopted/adapted;
- `BUILD`: custom implementation is justified;
- `N/A`: trivial/mechanical change;
- `BLOCKED`: research could not be completed.

For non-trivial work, check native browser/Node capabilities, existing Quest/ARK code, official features, and maintained OSS before accepting a new custom subsystem.

Quest currently intentionally uses a zero-dependency browser/Node architecture. Do not recommend adding dependencies simply because an OSS option exists. Compare total ownership cost, license, security, transitive dependencies, bundle/runtime footprint, compatibility, maintenance, testability, rollback, and exit path.

When reviewing substantial custom infrastructure, flag missing reuse analysis when it materially increases implementation or maintenance burden. Do not flag a small native solution merely for not using OSS when it is simpler and safer.

Reuse never overrides security boundaries, Human Gate, tests, CI, independent review, or license/attribution obligations.
