# Astrogate — working rules

Event-driven orchestration of Pi coding sessions in herdr, driven by a GitHub
Project board. pnpm workspace, TypeScript strict ESM, Node 24. Three packages:
`protocol` (shared types), `controller` (the `astrogate` command and service),
`companion` (the Pi extension).

The design document and diagrams are private and kept outside version control
(`docs/` is ignored). They are the authority. When code and design disagree, fix
both in the same change.

## Commands

| Command | What |
|---|---|
| `pnpm check` | build protocol, typecheck, lint, test. Run after every change. |
| `pnpm build` | bundle controller and companion into `dist/`. |
| `node scripts/pack.mjs` | assemble the release tarball the way CI does. |
| `pnpm release:patch\|minor\|major` | The only way to release. Tags, waits for the GitHub Actions run, which publishes the Release and bumps the Homebrew formula. |

## Rules

**This repository is public.** No credentials, addresses, or internal
procedures in code or in this file. Design notes stay in the ignored `docs/`.

**No workarounds.** No `any`, no `eslint-disable`, no rule overrides, no casts
to silence the compiler. If the clean fix is out of reach, say so and stop.

**package.json through pnpm only.** Use the pnpm CLI to add, remove, or move a
dependency. Edit the file by hand only when the CLI cannot express the change.

**No environment variable fallbacks.** A missing variable is an error, never a
default.

**Nothing is deployed from a laptop.** A tag push builds in GitHub Actions,
publishes a GitHub Release tarball, and bumps `monadeo/homebrew-tap`. Hosts
install and upgrade with `brew`.

**Only the controller talks to GitHub.** Sessions reach GitHub through
controller handlers, never with their own credentials.

**herdr and Pi are dependencies, not embedded.** The controller drives herdr
through its CLI and socket API; the companion is loaded into Pi with `-e`.
