# Pulsdev.io

**Intent-driven infrastructure-as-code. Describe what you want- Puls figures out create, update, or skip.**

[Live Documentation](https://pulsdev.io/) | [GitHub Actions](docs/github-actions.md) | Matrix|Gitter: **pulsdev.io** ([Join](https://matrix.to/#/#pulsdevio:gitter.im))

> [!IMPORTANT]
> **Active Pre-1.0 Development**
> `pulsdev.io` is under active development. APIs and features are evolving- we welcome feedback, bug reports, and contributions!

```typescript
@Deploy({ proxmox: CONFIG.STAGING })
class GameInfra extends Stack {
  server = Proxmox.VM("ix-app01")
    .image(OS.UBUNTU_24_04)
    .cores(4).memory(8192)
    .ip("10.8.10.51").vlan(2010)
    .sshKey(KEYS)
    .provision("config/default.yaml");
}
```

No state files. No plan step. Runs against real APIs- idempotent by default.

---

## How it works

Puls uses **eager discovery**: the moment you declare a resource, it checks the real API in the background. By the time `deploy()` runs, it already knows the current state.

```
Declare resource  →  Discovery fires immediately (async)
                  →  You chain config (.cores(), .ip(), ...)
                  →  deploy() awaits discovery, diffs, acts
```

Running the same stack twice is always safe- existing resources are detected and skipped or updated in place.

---

## Install

```bash
npm install puls-dev
```

**One-time shell setup**- so you never have to type `npx puls` again:

```bash
npx puls install-shell
```

This adds a `puls` launcher to `~/.puls/bin` and wires it into your shell config (`~/.zshrc`, `~/.bashrc`, or Fish). Open a new terminal and `puls` works everywhere.

---

## CLI

```bash
puls plan    infra/stack.ts          # dry-run- prints what would change, no API writes
puls deploy  infra/stack.ts          # apply the stack
puls destroy infra/stack.ts          # tear down the stack
puls diff    infra/stack.ts          # compare declared intent vs live cloud state
puls diff    infra/stack.ts --fail-on-drift   # exit 1 if anything has drifted

puls install-shell                   # one-time shell setup
puls uninstall-shell                 # remove shell integration
```

Always run `plan` before `deploy`- it activates dry-run mode automatically.

---

## Providers

| Provider | Resources |
|----------|-----------|
| **AWS** | EC2, RDS, Lambda, ECS/Fargate, API Gateway, S3, CloudFront, Route53, ACM, SQS, SNS, IAM, CloudWatch, SecretsManager |
| **DigitalOcean** | Droplet, Domain (full DNS), Firewall, Certificate, LoadBalancer, Database, App Platform, VPC, Spaces |
| **GCP** | Compute VM, Cloud Run, Cloud SQL, Secret Manager, Pub/Sub, Cloud DNS, IAM |
| **Firebase** | Hosting, Functions, Firestore, Storage, Auth, RemoteConfig, App Check |
| **Proxmox** | VM (clone, cloud-init, provision, cluster-aware scheduling), Templates (golden images) |

---

## Quick examples

### DigitalOcean

```typescript
import "dotenv/config";
import { Stack, Deploy } from "puls-dev";
import { DO, SIZE, REGION } from "puls-dev/do";

@Deploy({ token: process.env.DO_TOKEN! })
class Production extends Stack {
  db  = DO.Database("prod-db").engine("pg").size("db-s-2vcpu-2gb").nodes(2);
  web = DO.Droplet("prod-web").size(SIZE.MEDIUM).region(REGION.FRA).allowPublicWeb();
  dns = DO.Domain("example.com").pointer("@", this.web).withSSL();
}
```

### AWS

```typescript
import "dotenv/config";
import { Stack, Deploy } from "puls-dev";
import { AWS, REGION, RUNTIME, DB } from "puls-dev/aws";

@Deploy({ region: REGION.EU_CENTRAL_1 })
class AppStack extends Stack {
  db  = AWS.RDS("app-db").engine(DB.POSTGRES_16).size("db.t3.micro");
  api = AWS.Lambda("app-api").code("./functions/api").runtime(RUNTIME.NODEJS_20);
  cdn = AWS.S3("app-assets").staticSite().allowFrom(this.api);
}
```

### GCP

```typescript
import "dotenv/config";
import { Stack, Deploy } from "puls-dev";
import { GCP } from "puls-dev/gcp";

@Deploy({})
class CloudStack extends Stack {
  secret = GCP.Secret("db-password").value(process.env.DB_PASS!);
  api    = GCP.CloudRun("app-api").image("gcr.io/my-project/api:latest").port(8080).public();
  db     = GCP.CloudSQL("app-db").engine("postgres").version("16").tier("db-f1-micro");
}
```

### Proxmox

```typescript
import "dotenv/config";
import { Stack, Deploy, Protected } from "puls-dev";
import { Proxmox, CONFIG, OS, KEYS } from "puls-dev/proxmox";

@Deploy({ proxmox: CONFIG.STAGING })
class StagingInfra extends Stack {
  @Protected
  db = Proxmox.VM("ix-db01").image(OS.UBUNTU_24_04).cores(2).memory(4096)
        .ip("10.8.10.50").vlan(2010).sshKey(KEYS);

  app = Proxmox.VM("ix-app01").image(OS.UBUNTU_24_04).cores(4).memory(8192)
         .ip("10.8.10.51").vlan(2010).sshKey(KEYS)
         .provision("config/default.yaml");
}
```

---

## Key features

### Drift detection

`Stack.diff()` compares every declared resource against its live cloud state- no API writes, structured output:

```bash
puls diff infra/production.ts
```

```
🔍 Diff: Production

   db   prod-db   ⚠️  drift
        └─ size      db-s-1vcpu-1gb  →  db-s-2vcpu-2gb
        └─ nodes     1  →  2
   web  prod-web  ✅ in-sync
   dns  example.com  ✅ in-sync

   ⚠️  1 drifted out of 3 resources.
```

### Resource adoption

Bring existing cloud infrastructure under Puls management without recreating it:

```typescript
db = DO.Database("prod-db")
  .adoptId("existing-cluster-uuid")
  .adoptOutput("host", "db.internal.example.com")
  .adoptOutput("uri", "postgres://...");
```

### GitHub Actions integration

Post plan output as a PR comment automatically. Add to your repo:

```yaml
# .github/workflows/puls-plan.yml
- uses: puls-dev/puls-dev@v1
  with:
    command: plan
    stack-file: infra/production.ts
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    DO_TOKEN: ${{ secrets.DO_TOKEN }}
```

Every PR that touches infra files gets a comment showing exactly what would change. See [docs/github-actions.md](docs/github-actions.md) for deploy and drift-check workflows.

### Stack outputs & cross-stack wiring

```typescript
@Deploy({ proxmox: CONFIG.STAGING, token: process.env.DO_TOKEN })
class Infra extends Stack {
  vm  = Proxmox.VM("ix-app01").cores(4).memory(8192).ip("10.8.10.51").vlan(2010);
  dns = DO.Domain("example.com").pointer("app", this.vm.out.ip); // Output<string>
}
```

Outputs resolve lazily- downstream resources unblock the moment their dependency finishes deploying.

### Dry run / plan

```typescript
@Deploy({ dryRun: true, proxmox: CONFIG.STAGING })
class MyStack extends Stack { ... }
```

Or via the CLI: `puls plan infra/stack.ts`- no config change required.

### Protected resources

```typescript
@Protected
db = Proxmox.VM("ix-db01")...;  // Puls will refuse to modify or destroy this
```

---

## Decorators

| Decorator | Effect |
|-----------|--------|
| `@Deploy({ ... })` | Deploy all resources in the stack |
| `@Deploy({ dryRun: true })` | Print plan without making changes |
| `@Destroy` | Tear down all resources in the stack |
| `@DryRun` | Shorthand for `@Deploy({ dryRun: true })` |
| `@Protected` | Block changes/destruction of that resource |
| `@Check` | Inventory query- lists all live resources across providers |

---

## .env

```bash
# DigitalOcean
DO_TOKEN=

# AWS
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1

# Proxmox
PROXMOX_URL=https://pve.example.com:8006
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=puls
PROXMOX_TOKEN_SECRET=
PROXMOX_NODES=pve1,pve2

# GCP / Firebase
GCP_SA=./service-account.json
```

Requires Node 20+.
