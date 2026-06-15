# GitHub Actions Integration

Puls ships a composite GitHub Action that brings the standard IaC workflow to any repo:

- **Plan on PR**- runs `puls plan` and posts the output as a comment on every pull request that touches your infra files
- **Deploy on merge**- runs `puls deploy` automatically when changes land on `main`
- **Drift detection**- runs `puls diff` on a schedule or in CI, fails the build if live state has drifted from declared intent

No third-party SaaS required. Just add a workflow file and your provider secrets.

---

## Quick start

### 1. Add your provider secrets

In your GitHub repo go to **Settings → Secrets and variables → Actions** and add the credentials your stack needs:

| Provider | Secret name(s) |
|----------|---------------|
| DigitalOcean | `DO_TOKEN` |
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Proxmox | `PROXMOX_URL`, `PROXMOX_USER`, `PROXMOX_TOKEN_NAME`, `PROXMOX_TOKEN_SECRET` |
| GCP / Firebase | `GCP_SA` (path or JSON content of service account file) |
| Cloudflare | `CLOUDFLARE_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Azure | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` |

### 2. Add the workflow files

Create `.github/workflows/puls-plan.yml` and `.github/workflows/puls-deploy.yml` from the templates below.

---

## Workflow templates

### Plan on pull request

Posts the full plan output as a PR comment every time infra files change. The comment is updated in place on subsequent pushes- one comment per stack file per PR.

```yaml
# .github/workflows/puls-plan.yml
name: Puls Plan

on:
  pull_request:
    paths:
      - 'infra/**'      # adjust to wherever your stack files live
      - 'config/**'

jobs:
  plan:
    name: Plan
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write   # needed to post the PR comment
      contents: read

    steps:
      - uses: actions/checkout@v4

      - uses: puls-dev/puls-dev@v1
        with:
          command: plan
          stack-file: infra/production.ts   # path to your stack file
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # Add your provider credentials:
          DO_TOKEN: ${{ secrets.DO_TOKEN }}
          # AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          # AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

The comment looks like this on your PR:

```
## Puls `plan`- `infra/production.ts`

🌐 Finalizing DNS for "example.com"...
   ✅ A  app.example.com is up to date (→ 1.2.3.4)
   📝 [PLAN] Create TXT _dmarc.example.com → v=DMARC1; p=none

🔌 Finalizing DigitalOcean Database Cluster "prod-db"...
   ✅ Database Cluster "prod-db" already exists (id=abc123, status=online)
```

### Deploy on merge

Deploys automatically when changes land on the main branch.

```yaml
# .github/workflows/puls-deploy.yml
name: Puls Deploy

on:
  push:
    branches:
      - main
    paths:
      - 'infra/**'
      - 'config/**'

jobs:
  deploy:
    name: Deploy
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      - uses: actions/checkout@v4

      - uses: puls-dev/puls-dev@v1
        with:
          command: deploy
          stack-file: infra/production.ts
        env:
          DO_TOKEN: ${{ secrets.DO_TOKEN }}
          # AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          # AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

### Drift detection on a schedule

Runs `puls diff` nightly and fails the workflow if any resource has drifted from declared intent- useful for catching manual console changes.

```yaml
# .github/workflows/puls-drift.yml
name: Puls Drift Check

on:
  schedule:
    - cron: '0 8 * * *'   # every day at 08:00 UTC
  workflow_dispatch:        # allow manual runs

jobs:
  drift:
    name: Drift Check
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      - uses: actions/checkout@v4

      - uses: puls-dev/puls-dev@v1
        with:
          command: diff
          stack-file: infra/production.ts
          fail-on-drift: 'true'      # exit 1 if any resource has drifted
          post-comment: 'false'      # no PR to comment on for scheduled runs
        env:
          DO_TOKEN: ${{ secrets.DO_TOKEN }}
```

---

## Action inputs

| Input | Default | Description |
|-------|---------|-------------|
| `command` | `plan` | `plan`, `deploy`, `destroy`, or `diff` |
| `stack-file` | *(required)* | Path to the stack `.ts` file relative to the repo root |
| `node-version` | `20` | Node.js version used to run the stack |
| `post-comment` | `true` | Post output as a PR comment (`plan` and `diff` only) |
| `fail-on-drift` | `false` | Exit with code 1 when drift is detected (`diff` only) |

## Action outputs

| Output | Description |
|--------|-------------|
| `has-drift` | `"true"` if drift was detected, `"false"` otherwise (`diff` only) |

---

## Multiple stacks

Run the action multiple times in the same workflow- each stack file gets its own PR comment (keyed by the `stack-file` path):

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: puls-dev/puls-dev@v1
    with:
      command: plan
      stack-file: infra/networking.ts
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      DO_TOKEN: ${{ secrets.DO_TOKEN }}

  - uses: puls-dev/puls-dev@v1
    with:
      command: plan
      stack-file: infra/app.ts
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      DO_TOKEN: ${{ secrets.DO_TOKEN }}
```

---

## Using `puls diff` locally

The same `diff` command is available from the CLI without GitHub:

```bash
puls diff infra/production.ts

# Exit 1 if drift detected (useful in pre-push hooks)
puls diff infra/production.ts --fail-on-drift
```
