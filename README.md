# Astrogate

Orchestrates [Pi](https://pi.dev) coding sessions in [herdr](https://herdr.dev)
from a GitHub Project board. You write tickets; a controller routes them,
starts a Pi session per ticket in its own worktree, runs review, deploys through
your GitHub Actions workflows, and asks you on Discord when a decision or an
acceptance is needed. Only the controller talks to GitHub.

Status: early development. Nothing beyond `astrogate version` works yet.

## Install

```
brew install monadeo/tap/astrogate
```

Requires herdr and Pi installed separately.

## License

MIT
