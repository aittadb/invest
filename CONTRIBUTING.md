# Contributing

Read `AGENTS.md` before changing code. Every implementation change should include the contract, implementation, automated tests, documentation, validation evidence, and any necessary `AGENTS.md`, architecture, configuration, security, or operational updates in the same task.

Use `PLAN.md` for the dependency graph of accepted unfinished implementation work, `CHANGELOG.md` for completed task history, `ROADMAP.md` for stable future product direction, and `BACKLOG.md` for ideas with no delivery commitment.

Before implementation, create a complete unchecked PLAN task using the next stable identifier. Keep tasks small: one primitive, route group, security control, UI flow, storage contract, or narrowly bounded proof per task. Record only direct dependencies. Every unblocked task whose dependencies are complete may proceed concurrently in its own branch and worktree; the one-task focus applies per worktree, not to the repository as a whole. After the definition of done passes, move the unchanged task description and evidence from PLAN into the changelog.

Run `npm run validate` before requesting review. It includes the `AGENTS.md` size guard. Keep root `AGENTS.md` under 32,000 bytes so Codex can load the complete instruction set by default.

Use feature branches. Do not push directly to `main`, merge without review, deploy, publish, save a production checkpoint, rotate secrets, or change Sites access settings without explicit approval.
