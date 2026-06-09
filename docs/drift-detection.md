# Drift Detection & Diff

`Stack.diff()` compares every declared resource against its live cloud state and returns a structured report - without making any API writes.

---

## Usage

Call `.diff()` on a Stack instance the same way you would call `.deploy()`:

```typescript
@Deploy({ token: process.env.DO_TOKEN, proxmox: CONFIG.STAGING })
class Infra extends Stack {
  db  = DO.Database("prod-db").engine("pg").size("db-s-2vcpu-2gb").nodes(3);
  vm  = Proxmox.VM("ix-app01").cores(4).memory(8192);
  api = DO.App("api-service");
}

// diff without deploying
const result = await Stack.from(Infra).diff();
```

Or directly via `@Check`-style instantiation:

```typescript
const stack = new Infra();
const result = await stack.diff();
```

---

## Output

```
🔍 Diff: Infra

   db   prod-db      ⚠️  drift
        └─ size         db-s-2vcpu-2gb  →  db-s-1vcpu-1gb
        └─ nodes        3  →  1
   vm   ix-app01     ✅ in-sync
   api  api-service  ❌ missing  (will create)

   ⚠️  2 drifted, 1 missing out of 3 resources.
```

Status meanings:

| Status | Meaning |
|--------|---------|
| `in-sync` | Live state matches declared intent |
| `drift` | One or more fields differ from what is declared |
| `missing` | Resource not found in the cloud- deploy would create it |
| `adopted` | Resource was imported via `.adoptId()`- not expected to match |

---

## Return value

`diff()` returns a `StackDiff` object you can use programmatically:

```typescript
import type { StackDiff, ResourceDiff } from "puls-dev";

const diff: StackDiff = await stack.diff();

if (diff.hasDrift) {
  for (const r of diff.resources) {
    if (r.status === "drift") {
      console.log(`${r.resource} has ${r.changes.length} drifted fields:`);
      for (const c of r.changes) {
        console.log(`  ${c.field}: declared=${c.declared}  live=${c.live}`);
      }
    }
  }
}
```

### `StackDiff`

| Field | Type | Description |
|-------|------|-------------|
| `stackName` | `string` | Name of the stack class |
| `resources` | `ResourceDiff[]` | One entry per declared resource |
| `hasDrift` | `boolean` | `true` if any resource is `drift` or `missing` |

### `ResourceDiff`

| Field | Type | Description |
|-------|------|-------------|
| `prop` | `string` | Stack property name (e.g. `"db"`) |
| `resource` | `string` | Builder name passed to the constructor |
| `status` | `ResourceStatus` | `"in-sync"` \| `"drift"` \| `"missing"` \| `"adopted"` |
| `changes` | `FieldDiff[]` | Empty unless `status === "drift"` |

### `FieldDiff`

| Field | Type |
|-------|------|
| `field` | `string`- the property name that differs |
| `declared` | `any`- what the stack declares |
| `live` | `any`- what the cloud currently has |

---

## Field-level coverage

Providers that implement field-level diff:

| Provider | Builder | Fields compared |
|----------|---------|----------------|
| **Proxmox** | `VM` | `cores`, `memory`, `machine` |
| **DigitalOcean** | `Droplet` | `size`, `region` |
| **DigitalOcean** | `Database` | `engine`, `version`, `size`, `region`, `nodes` |
| **DigitalOcean** | `VPC` | `description` |
| **DigitalOcean** | `LoadBalancer` | `region` |
| **AWS** | `EC2` | `instanceType` |
| **AWS** | `RDS` | `engine`, `engineVersion`, `instanceClass`, `storage`, `publicAccess` |
| **AWS** | `Lambda` | `runtime`, `handler`, `memory`, `timeout`, `env` |
| **GCP** | `VM` | `machineType` |
| **GCP** | `CloudSQL` | `databaseVersion`, `tier`, `storage`, `publicAccess` |
| **GCP** | `CloudRun` | `image`, `port`, `cpu`, `memory`, `minInstances`, `maxInstances`, `public` |
| **Firebase** | `Functions` | `runtime`, `entryPoint`, `memory`, `timeout`, `maxInstances`, `minInstances` |

Providers not in the table (S3, Route53, CloudFront, Firestore, Firebase Auth, etc.) report `in-sync` or `missing` only - no field breakdown. Field-level diff can be added incrementally by overriding `getDiff(existing)` on any builder.

---

## Adding field-level diff to a custom builder

Override `getDiff(existing)` in your builder class. `existing` is whatever the builder's `discoveryPromise` resolved to- the raw API response.

```typescript
import { BaseBuilder } from "puls-dev";
import type { FieldDiff } from "puls-dev";

export class MyBuilder extends BaseBuilder {
  private _size: string = "small";
  private _region: string = "us-east";

  // ...

  getDiff(existing: any): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    if (existing.size !== this._size) {
      diffs.push({ field: "size", declared: this._size, live: existing.size });
    }
    if (existing.region !== this._region) {
      diffs.push({ field: "region", declared: this._region, live: existing.region });
    }
    return diffs;
  }
}
```

Return an empty array for any field that is immutable after creation (e.g. engine type, region)- the diff will skip it silently.
