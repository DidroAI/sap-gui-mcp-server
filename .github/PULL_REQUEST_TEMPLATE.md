## What and why

<!-- What this changes, and the problem it solves. Link the issue: Fixes #123 -->

## How it was checked

- [ ] `bun run typecheck`, `bun run test` and `bun run build` pass
- [ ] `bun run docs:build` passes (for changes in `docs/`)
- [ ] New or changed behaviour has tests (a fake or a synthetic page; no real SAP data)
- [ ] Checked on a real system: surface, SAP_BASIS release, front-end version: <!-- or "not run on a real system" -->

## Safety

- [ ] This does not change what the guard allows, **or** it does and a test shows the actions that must stay refused are still refused
- [ ] No business data, host names, user names or personal data in the code, tests, fixtures or this description

## Docs

- [ ] README or docs updated where users see a change
- [ ] A line in `CHANGELOG.md` under "Unreleased" for a user-visible change
