# AI Company Quest — Claude Code instructions

This repository implements the AI Company Quest runtime visualization application.

Before changing code, read:

- `README.md` for the current architecture and operating contract;
- `docs/development/oss-reuse-first.md` for the mandatory Reuse Before Build gate.

## Permanent implementation rule

Every implementation must classify the Reuse Gate as `REUSE`, `BUILD`, `N/A`, or `BLOCKED` before non-trivial custom code is started.

Prefer platform-native capability, existing ARK code/contracts, official features, and maintained OSS when they reduce total ownership cost without weakening safety, licensing, portability, performance, or architecture.

Quest intentionally keeps a zero-dependency browser/Node architecture today. Preserve that property unless a concrete comparison shows that adding a dependency is a net benefit. The existence of an OSS package alone is not sufficient justification.

For non-trivial `BUILD`, briefly state what existing options were considered and why custom code is still preferable.

Do not bypass security boundaries, tests, review, CI, Human Gate, or license/attribution requirements in order to reuse software.
