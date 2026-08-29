# Ensemble — build rules for agents

1. Read `docs/SPEC.md` FIRST and follow it exactly — the event envelope and message shapes are shared contracts between components built in parallel. Do not rename fields or invent new event types.
2. You are assigned ONE top-level component directory. Create/modify files only there. You may read `docs/` and other dirs, never write outside your assignment.
3. Node is v22 (`node`/`npm` on PATH). Plain npm, no pnpm/yarn/bun. Keep dependencies minimal.
4. NO git commands (no commit, no init, no branch). The orchestrator handles version control.
5. Test what you build: each component's spec names its test/verification. Run it and make it pass before finishing.
6. This ships to a live demo in hours: working and polished beats clever. No TODOs, no placeholder copy.
