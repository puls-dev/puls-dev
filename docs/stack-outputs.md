# Stack Outputs

Stack outputs let resources share deployed values - within a single stack or across multiple stacks.

---

## How it works

Every provider resource exposes typed `Output<T>` fields. An `Output<T>` is a lazy promise: it resolves the moment the resource finishes deploying, and anything awaiting it unblocks automatically.

```
Resource A deploys  →  output.resolve("10.8.10.50")
                    →  Resource B (awaiting that output) unblocks and continues
```

---

## Within a stack

Resources in the same stack deploy sequentially in declaration order, so earlier outputs are always resolved by the time a later resource needs them.

```typescript
@Deploy({ proxmox: CONFIG.STAGING, token: process.env.DO_TOKEN })
class Infra extends Stack {
  server = Proxmox.VM("ix-app01")
    .cores(4)
    .memory(8192)
    .ip("1.1.1.1")
    .vlan(2010);

  // server.out.ip is an Output<string> - resolves once the VM is up
  dns = DO.Domain("example.com").pointer("app", this.server.out.ip);
}
```

---

## Across stacks

Use `Stack.from(TargetStack)` to get a reference to another stack's instance and access its resource outputs. The target stack must be decorated with `@Deploy` and its module must be imported first.

```typescript
// infra-stack.ts
@Deploy({ proxmox: CONFIG.STAGING })
export class InfraStack extends Stack {
  db  = Proxmox.VM("ix-db01").cores(2).memory(4096).ip("1.1.1.1").vlan(2010);
  app = Proxmox.VM("ix-app01").cores(4).memory(8192).ip("2.2.2.2").vlan(2010);
}
```

```typescript
// dns-stack.ts
import "./infra-stack.ts"; // ensure InfraStack is registered first
import { InfraStack } from "./infra-stack.ts";

@Deploy({ token: process.env.DO_TOKEN })
class DNSStack extends Stack {
  private infra = Stack.from(InfraStack);

  dns = DO.Domain("example.com")
    .pointer("db",  this.infra.db.out.ip)   // Output<string>
    .pointer("app", this.infra.app.out.ip); // Output<string>
}
```

Both stacks deploy concurrently. `DNSStack` will wait for each `Output<string>` to resolve before creating the DNS records - no manual coordination needed.

---

## Output fields by provider

All outputs live under `.out` on each builder - this avoids conflicts with the builder's own configuration methods.

| Provider       | Builder         | Output            | Type                                   |
|----------------|-----------------|-------------------|----------------------------------------|
| Proxmox        | `VMBuilder`     | `.out.ip`         | `Output<string>`                       |
| Proxmox        | `VMBuilder`     | `.out.vmid`       | `Output<number>`                       |
| DigitalOcean   | `DropletBuilder`| `.out.ip`         | `Output<string>`                       |
| DigitalOcean   | `DropletBuilder`| `.out.id`         | `Output<number>`                       |
| AWS            | `Route53Builder`| `.out.zone`       | `Output<{ name: string; id: string }>` |
| GCP            | `VMBuilder`     | `.out.ip`         | `Output<string>`                       |
| GCP            | `VMBuilder`     | `.out.id`         | `Output<string>`                       |
| Azure          | `AzureVMBuilder`| `.out.ip`         | `Output<string>`                       |
| Azure          | `AzureVMBuilder`| `.out.id`         | `Output<string>`                       |

---

## Transforming outputs

Use `.apply()` to derive a new `Output<U>` from an existing one without awaiting it yourself:

```typescript
const host = this.server.out.ip.apply(ip => `https://${ip}`);
```

---

## Contributing new providers

Every provider that creates a cloud resource should expose an `out` object with `Output<T>` fields for its primary identifiers (ARN, ID, IP, hostname). Resolve each field in **every** code path of `deploy()` - including existing-resource and dry-run branches - so downstream resources never hang.

```typescript
import { Output } from '../../core/output.ts';

export class MyBuilder extends BaseBuilder {
  readonly out = {
    id: new Output<string>(),
  };

  async deploy() {
    if (existing) {
      this.out.id.resolve(existing.id);
      return existing;
    }
    if (dryRun) {
      this.out.id.resolve('PENDING');
      return { ... };
    }
    const result = await createResource();
    this.out.id.resolve(result.id);
    return result;
  }
}
```
