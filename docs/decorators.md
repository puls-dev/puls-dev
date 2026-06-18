# Decorators

Decorators are the entry point for every Puls stack. They wire up credentials, trigger execution, and control lifecycle.

## @Deploy

Instantiates the stack and calls `deploy()` on every resource.

```typescript
// Bare - uses ambient env config
@Deploy()
class MyStack extends Stack { ... }

// With provider credentials
@Deploy({ proxmox: CONFIG.STAGING })
class MyStack extends Stack { ... }

// Dry run - prints plan, makes no API calls
@Deploy({ dryRun: true, proxmox: CONFIG.STAGING })
class MyStack extends Stack { ... }
```

**Options**

| Key | Type | Description |
|-----|------|-------------|
| `dryRun` | `boolean` | Print plan without applying changes |
| `token` | `string` | DigitalOcean API token |
| `region` | `string` | AWS region |
| `proxmox` | `ProxmoxConfig` | Full Proxmox connection config |
| `firebase` | `string` | Path to service account JSON key file |
| `cloudflare` | `CloudflareConfig` | Cloudflare token & account ID config |
| `azure` | `AzureConfig` | Azure Service Principal connection config |
| `aws` | `AwsConfig` | Context-scoped AWS profile & region config |
| `gcp` | `GcpConfig` | Context-scoped GCP project, region, and service account config |

## Multi-Account & Multi-Tenant Support

Puls supports deploying different Stacks to different cloud accounts/profiles or projects concurrently by supplying `aws` or `gcp` options inside `@Deploy` or `@Destroy`. 

A clean pattern is to define these configurations in a shared file (e.g. `types/accounts.ts`) and reference them in your decorators:

```typescript
// types/accounts.ts
import { ProviderOpts } from "puls-dev";

export const AWS_ACCOUNT: Record<string, ProviderOpts["aws"]> = {
  PRODUCTION: {
    profile: "aws-prod-profile",
    region: "eu-west-1",
  },
  DEVELOPMENT: {
    profile: "aws-dev-profile",
    region: "us-east-1",
  }
};
```

Then, import and reference them inside your stack definitions:

```typescript
import { Deploy, Stack } from "puls-dev";
import { AWS } from "puls-dev/aws";
import { AWS_ACCOUNT } from "../../types/accounts.js";

@Deploy({ aws: AWS_ACCOUNT.PRODUCTION })
class ProdStack extends Stack {
  secret = AWS.Secret("DB_PASSWORD");
  // Resolves S3 bucket within the prod account context
  bucket = AWS.S3("prod-backups");
}
```

## @DryRun

Shorthand for `@Deploy({ dryRun: true })`. Accepts the same options.

```typescript
@DryRun({ proxmox: CONFIG.STAGING })
class MyStack extends Stack { ... }
```

## @Destroy

Instantiates the stack and calls `destroy()` on every resource in reverse order.

```typescript
// Bare class decorator
@Destroy
class MyStack extends Stack { ... }

// With credentials
@Destroy({ proxmox: CONFIG.STAGING })
class MyStack extends Stack { ... }

// Property decorator - destroys one resource during a deploy
@Deploy({ proxmox: CONFIG.STAGING })
class MyStack extends Stack {
  @Destroy
  old = Proxmox.VM("ix-sto1-old01");

  new = Proxmox.VM("ix-sto1-new01")...;
}
```

`@Protected` resources are skipped during teardown - no API call is made.

## @Protected

Marks a property so it cannot be modified or destroyed.

```typescript
@Deploy({ proxmox: CONFIG.STAGING })
class MyStack extends Stack {
  @Protected
  db = Proxmox.VM("ix-sto1-db01")...;   // never touched by Destroy

  app = Proxmox.VM("ix-sto1-app01")...;  // normal lifecycle
}
```

When `@Destroy` runs the stack, protected resources are skipped with a log line:
```
   🔒 Skipping protected resource "db"
```

During `@Deploy`, protected resources are still discovered and reported - they just refuse destructive changes.
