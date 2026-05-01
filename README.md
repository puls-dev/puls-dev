# OpsDSL

Intent-driven infrastructure-as-code. Describe what you want — OpsDSL figures out create, update, or skip.

```typescript
@Deploy({ dryRun: true })
class StagingInfra extends Stack {
  web = DO.Droplet("staging-web").size(SIZE.SMALL).region(REGION.FRA);
}
```

That's it. Two lines spin up a droplet (or update it if it exists, or skip it if it's already correct).

---

## How it works

OpsDSL uses **eager discovery**: the moment you declare a resource, it starts checking the real API in the background. By the time `deploy()` runs, it already knows the current state — no separate `plan` step needed.

```
Declare resource → Discovery fires immediately (async)
                 → You chain config (.size(), .region(), ...)
                 → deploy() awaits discovery, diffs, acts
```

Resources are **idempotent** — running the same stack twice is always safe.

---

## Providers

### DigitalOcean

```typescript
import "dotenv/config";
import { DO } from "./src/providers/do/droplet.ts";
import { REGION, SIZE } from "./src/types/do.ts";
import { Stack } from "./src/core/stack.ts";
import { Deploy, Destroy } from "./src/core/decorators.ts";

DO.init({ token: process.env.DO_TOKEN! });

@Deploy()
class Production extends Stack {
  web = DO.Droplet("prod-web")
    .size(SIZE.MEDIUM)
    .region(REGION.FRA)
    .allowPublicWeb();

  db = DO.Droplet("prod-db")
    .size(SIZE.LARGE)
    .region(REGION.FRA);

  dns = DO.Domain("example.com")
    .pointer("@", this.web)      // resolves droplet IP automatically
    .withSSL();
}
```

**Supported resources:** Droplet, Domain, Firewall, Certificate, LoadBalancer

**`.env`**
```
DO_TOKEN=your_digitalocean_token
```

### AWS *(in progress)*

CloudFront, S3, Route53, ACM — stubbed, real API coming next.

---

## Decorators

| Decorator | Where | Effect |
|-----------|-------|--------|
| `@Deploy()` | Class | Deploy all resources in the stack |
| `@Deploy({ dryRun: true })` | Class | Show plan without making changes |
| `@Destroy` | Class | Tear down all resources in the stack |
| `@Destroy` | Property | Destroy that one resource within a deploy |
| `@Protected` | Property | Block changes to that resource |

---

## Sidecars

Some methods automatically create and manage related resources:

```typescript
DO.Droplet("web").allowPublicWeb()   // creates + attaches a Firewall
DO.Domain("x.com").withSSL()         // creates a Let's Encrypt Certificate
```

Sidecars deploy after their parent and tear down before it.

---

## Running

```bash
npm install
npx tsx demo.ts
```

Requires Node 18+ (native `fetch`).
