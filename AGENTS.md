# Astrogate

Orchestrates Pi coding sessions in herdr from a GitHub Project board. A
deterministic controller handles webhooks, policy, sessions, and every GitHub
write. Model sessions handle judgment: a foreman for triage and exceptions,
workers for tickets, a reviewer for pull requests.

pnpm workspace, TypeScript strict ESM, Node 24.

- `packages/protocol`: types shared by controller and companion.
- `packages/controller`: the `astrogate` command and service.
- `packages/companion`: the Pi extension loaded into every session.

## Commands

- `pnpm check`: build protocol, typecheck, lint, test. Run after every change.
- `pnpm build`: bundle controller and companion.
- `pnpm release:patch|minor|major`: tag and wait for the release workflow. It
  publishes the tarball and bumps the Homebrew formula.

## Rules

- Design docs live in the ignored `docs/` folder. They are the authority.
- No `any`, no eslint-disable, no env var fallbacks.
- Change package.json through pnpm.
- Only the controller talks to GitHub. Sessions go through controller handlers.
- herdr and Pi are dependencies, driven through their CLI, socket API, and `-e`.
