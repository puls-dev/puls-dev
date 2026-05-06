# Core Concepts

## Eager discovery

Every resource starts an API lookup the moment it is declared — before `deploy()` is called.

```typescript
class MyStack extends Stack {
  // discoverVm("ix-sto1-app01") fires here, in the constructor
  app = Proxmox.VM("ix-sto1-app01").cores(4).memory(8192);
}
```

By the time the decorator triggers `deploy()`, the discovery promise is already in flight (or done). OpsDSL awaits it, checks the result, and either creates, skips, or updates the resource.

## Idempotency

Every provider implements the same contract:

- **Resource exists and matches intent** → log and return, no API write
- **Resource exists but differs** → update only what changed
- **Resource does not exist** → create it

Running the same stack twice never produces duplicates or errors.

## Stack

A `Stack` is a plain class that holds resource declarations as properties. The `@Deploy` decorator instantiates it and calls `deploy()`, which iterates over every `BaseBuilder` property in order.

```typescript
@Deploy({ proxmox: CONFIG.STAGING })
class MyStack extends Stack {
  vm1 = Proxmox.VM("host-01")...;  // deployed first
  vm2 = Proxmox.VM("host-02")...;  // deployed second
}
```

`destroy()` tears down in reverse order.

## Sidecars

Some methods automatically create and wire up additional resources. Sidecars are deployed after their parent and destroyed before it.

```typescript
DO.Droplet("web").allowPublicWeb()   // creates + attaches a Firewall sidecar
DO.Domain("x.com").withSSL()         // creates a Certificate sidecar
AWS.Route53().withWildcardSSL()      // creates an ACM certificate sidecar
```

## Dry run

Setting `dryRun: true` makes every resource print what it *would* do without touching any API. Async waits (boot, DNS propagation, cloud-init) are skipped entirely in dry-run mode.

```typescript
@Deploy({ dryRun: true, proxmox: CONFIG.STAGING })
class MyStack extends Stack { ... }
```

The `@DryRun` decorator is a shorthand for the above.

## CONFIG pattern

Credentials are defined once as typed constants and referenced everywhere:

```typescript
// src/types/proxmox.ts
export const CONFIG = {
  STAGING: {
    url: process.env.PROXMOX_URL!,
    user: process.env.PROXMOX_USER!,
    tokenName: process.env.PROXMOX_TOKEN_NAME!,
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET!,
    nodes: process.env.PROXMOX_NODES?.split(','),
    dnsDomain: process.env.PROXMOX_DNS_DOMAIN,
    dnsServers: process.env.PROXMOX_DNS_SERVERS?.split(','),
    verifySsl: false,
  },
};

// any stack file
@Deploy({ proxmox: CONFIG.STAGING })
@Destroy({ proxmox: CONFIG.STAGING })
```
