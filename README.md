# Puls-dev

**Intent-driven infrastructure-as-code. Describe what you want - Puls figures out create, update, or skip.**

[Live Documentation](https://pulsdev.io/) | Discord: **pulsdev.io** ([Join](https://discord.gg/CjgRayuH))

```typescript
@Deploy({ proxmox: CONFIG.STAGING })
class GameInfra extends Stack {
  server = Proxmox.VM("example-vm")
    .image(OS.UBUNTU_24_04)
    .cores(4).memory(8192)
    .ip("1.1.1.1").vlan(2010)
    .sshKey(KEYS)
    .provision("config/default.yaml");
}
```

No state files. No plan step. Runs against real APIs - idempotent by default.

---

## How it works

Puls uses **eager discovery**: the moment you declare a resource, it checks the real API in the background. By the time `deploy()` runs, it already knows the current state.

```
Declare resource  →  Discovery fires immediately (async)
                  →  You chain config (.cores(), .ip(), ...)
                  →  deploy() awaits discovery, diffs, acts
```

Running the same stack twice is always safe - existing resources are detected and skipped.

---

## Providers

| Provider | Resources |
|----------|-----------|
| [DigitalOcean](docs/providers/digitalocean.md) | Droplet, Domain, Firewall, Certificate, LoadBalancer |
| [AWS](docs/providers/aws.md) | Route53, ACM (wildcard SSL), CloudFront, S3 |
| [Proxmox](docs/providers/proxmox.md) | VM (clone, cloud-init, provision, replace) |

---

## Quick examples

### DigitalOcean

```typescript
import { DO, DO_TYPES, Stack, Deploy } from "puls-dev";
const { SIZE, REGION } = DO_TYPES;

@Deploy({ token: process.env.DO_TOKEN! })
class Production extends Stack {
  web = DO.Droplet("prod-web").size(SIZE.MEDIUM).region(REGION.FRA).allowPublicWeb();
  dns = DO.Domain("example.com").pointer("@", this.web).withSSL();
}
```

### AWS

```typescript
import { AWS, AWS_TYPES, Stack, Deploy } from "puls-dev";
const { DISTRO, BUCKET, DOMAIN_REGISTER, REGION } = AWS_TYPES;

@Deploy({ region: REGION.US_EAST_1 })
class CDNStack extends Stack {
  domain = AWS.Route53().randomDomain().register(DOMAIN_REGISTER).withWildcardSSL();

  cdn = AWS.CloudFront(`CDN-${this.domain.zoneName.slice(0, 8)}`)
    .copyFrom(DISTRO.CDN)
    .forDomain(this.domain, ["ec", "nc"]);

  bucket = AWS.S3(BUCKET.NLC_GAMES_UREG)
    .allowFrom(this.cdn)
    .region(REGION.EU_WEST_1);
}
```

### Proxmox

```typescript
import { Proxmox, PROXMOX_TYPES, Stack, Deploy, Protected } from "puls-dev";
const { CONFIG, OS, KEYS } = PROXMOX_TYPES;

@Deploy({ proxmox: CONFIG.STAGING })
class StagingInfra extends Stack {
  @Protected
  db = Proxmox.VM("ix-sto1-db01")
    .image(OS.UBUNTU_24_04)
    .cores(2).memory(4096)
    .ip("1.1.1.1").vlan(2010)
    .sshKey(KEYS);

  app = Proxmox.VM("ix-sto1-app01")
    .image(OS.UBUNTU_24_04)
    .cores(4).memory(8192)
    .ip("1.1.1.1").vlan(2010)
    .sshKey(KEYS)
    .provision("config/default.yaml");
}
```

---

## Decorators

| Decorator | Effect |
|-----------|--------|
| `@Deploy({ ... })` | Deploy all resources in the stack |
| `@Deploy({ dryRun: true })` | Print plan without making changes |
| `@Destroy` | Tear down all resources in the stack |
| `@Destroy({ proxmox: CONFIG.STAGING })` | Tear down with provider credentials |
| `@DryRun` | Shorthand for `@Deploy({ dryRun: true })` |
| `@Protected` (property) | Block changes/destruction of that resource |

See [docs/decorators.md](docs/decorators.md) for full reference.

---

## Running

```bash
npm install puls-dev
npx tsx your-stack.ts
```

Requires Node 20+.

**.env**
```
# DigitalOcean
DO_TOKEN=

# AWS (standard SDK env vars)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1

# Proxmox
PROXMOX_URL=https://pve.example.com:8006
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=puls
PROXMOX_TOKEN_SECRET=some-super-secret
PROXMOX_NODES=pve1,pve2
PROXMOX_DNS_DOMAIN=nolimit.int
PROXMOX_DNS_SERVERS=1.1.1.1,2.2.2.2
```
