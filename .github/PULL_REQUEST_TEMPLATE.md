<!--
Celiums Memory PR template — implements ADR-026 §"Decision tagging
convention" + ADR-018 §"Pipeline structure".

Fill in every section. PRs that don't are returned without review.
-->

## Track tag (required)

Pick exactly one:

- [ ] `[T1]` Track 1 — Celiums MCP horizontal infrastructure
- [ ] `[T2]` Track 2 — Agents v2 + MARS-UI vertical product
- [ ] `[shared]` Shared MCP layer (subject to ADR-026 §"Shared MCP Layer Rule")
- [ ] `[hosted]` Paid hosted services backing both tracks

> If `[shared]`, confirm: changes to the shared MCP layer go through
> Track 1 first. Track 2 consumes via the public interface. Any
> Track-2-specific need is filed as a Track 1 feature request first.

## What does this PR do?

<!-- One paragraph. The "why", not just the "what". -->

## Related issue / ADR

Closes #
Implements / references: ADR-

## Type of change

- [ ] Bug fix (no behavioural change beyond the fix)
- [ ] New feature (MINOR bump per ADR-001)
- [ ] Refactor (no functional change, internal only)
- [ ] Breaking change (MAJOR bump, deprecation window per ADR-001)
- [ ] Documentation only
- [ ] CI / infrastructure
- [ ] Tests only

## Security review

- [ ] No new auth/RBAC/AAL/Ethics paths touched **OR** 2 maintainer
      reviews requested (see CODEOWNERS for security-sensitive paths)
- [ ] No new dependencies **OR** entry added to `dependencies-rationale.md`
      with license + alternative considered
- [ ] No secrets committed (gitleaks CI gate enforces; double-check
      manually)
- [ ] License headers on every new source file (`// SPDX-License-
      Identifier: Apache-2.0` + copyright)

## Checklist

- [ ] Tests added/updated for the changed behaviour
- [ ] `pnpm --filter @celiums/memory test` passes locally
- [ ] `pnpm --filter @celiums/memory build` passes locally
- [ ] Docs updated where relevant (README, ADRs, runbooks)
- [ ] CHANGELOG.md entry under `## Unreleased`
- [ ] DCO sign-off **OR** CLA signed via cla-assistant (per ADR-019)

## How was this tested?

<!-- Describe the manual testing OR cite the test files added/changed. -->

## Rollout considerations

<!-- For non-trivial PRs: feature flag? backwards-compat shim?
     migration script? Documented in this PR or filed as follow-up? -->

---

🤖 PR template v2 — post-ADR-018 hardening
