# Astrogate

Event-driven orchestration of Pi coding sessions in herdr, driven by a GitHub
Project board. A deterministic controller receives GitHub webhooks, applies
policy, starts and monitors Pi sessions in herdr panes, and writes results back
to GitHub. Judgment stays with model sessions: a foreman for triage and
exceptions, workers for tickets, a reviewer for pull requests.

Status: design complete, implementation starting. Nothing is installed or
tested yet.

## Install

```
brew install monadeo/tap/astrogate
```

Requires [herdr](https://herdr.dev) and [Pi](https://pi.dev) installed
separately.

## Develop

```
pnpm install
pnpm check
pnpm build
```

Releases: `pnpm release:patch|minor|major`. See `AGENTS.md`.

## License

MIT
