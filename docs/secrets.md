# Secrets at Deploy Time

In Puls, managing sensitive credentials (like API keys, private tokens, and database passwords) should be secure and friction-free. Rather than hardcoding credentials into committed git files or managing complex, out-of-sync local `.env` files, Puls supports **Secrets at Deploy Time**.

With this feature, you can dynamically retrieve secrets from secure cloud vaults *during the deployment phase* and pass them directly into resource parameters.

---

## The `Secret` API

Puls provides a universal `Secret` class that acts as a secure, lazy wrapper. It supports multiple secret stores out of the box:

```typescript
import { Secret } from "puls-dev";

// 1. Local environment variable (with optional fallback)
const stripeKey = Secret.env("STRIPE_API_KEY", "fallback-key");

// 2. AWS Secrets Manager
const dbPassword = Secret.aws("prod/database/password", { region: "us-east-1" });

// 3. AWS SSM Parameter Store
const apiKey = Secret.ssm("/prod/api/token");

// 4. GCP Secret Manager
const jwtSecret = Secret.gcp("jwt-private-key");
```

---

## How to Use Secrets in Stacks

You can pass a `Secret` directly into any resource builder input that expects a string, an Output, or a Secret. The framework handles dynamic dependency resolving automatically under the hood.

### Example 1: Database Credentials (GCP Cloud SQL)

In the following example, the PostgreSQL database root credentials are dynamically retrieved from GCP Secret Manager during deployment:

```typescript
import { Stack, Deploy, Secret } from "puls-dev";
import { GCP } from "puls-dev/gcp";

// Retrieve database credentials securely at deploy time
const dbUser = "db_admin";
const dbPassword = Secret.gcp("prod-database-password");

@Deploy()
class DatabaseStack extends Stack {
  db = GCP.CloudSQL("prod-postgres")
    .engine({ engine: "postgres", version: "16" })
    .size("db-f1-micro")
    .credentials(dbUser, dbPassword); // Secret is resolved and passed automatically
}
```

### Example 2: Container Environment Variables (GCP Cloud Run)

In the following example, a Stripe API key is fetched and injected into the container environment variables for a Cloud Run service:

```typescript
import { Stack, Deploy, Secret } from "puls-dev";
import { GCP } from "puls-dev/gcp";

// Fetch Stripe API Key from GCP Secrets Manager
const stripeApiKey = Secret.gcp("stripe-api-key");

@Deploy()
class AppStack extends Stack {
  apiServer = GCP.CloudRun("api-service")
    .image("gcr.io/my-project/api-server:latest")
    .env({
      STRIPE_API_KEY: stripeApiKey, // Automatically resolved & injected into environment
      NODE_ENV: "production"
    });
}
```

---

## Injecting Secrets into VMs/Provisioners (.env)

When deploying virtual machines (using Proxmox or GCP) and running provisioning tools (Ansible playbooks or Puppet manifests), you often need to inject sensitive credentials as environment variables.

Puls provides a first-class `.env()` configuration method on VM and Template builders. This method accepts a record of environment variables, automatically resolves any dynamic secrets or values, and injects them into the provisioning process:

```typescript
import { Stack, Deploy, Secret } from "puls-dev";
import { Proxmox } from "puls-dev/proxmox";

const dbPassword = Secret.aws("prod/database/password");

@Deploy()
class AppStack extends Stack {
  server = Proxmox.VM("web-server")
    .cores(2)
    .memory(4096)
    .ip("10.8.10.90")
    .sshKey("~/.ssh/id_rsa.pub")
    .provision("playbooks/site.yaml")
    // Secrets are automatically resolved and injected into the Ansible environment
    .env({
      DB_PASSWORD: dbPassword,
      APP_ENV: "production",
    });
}
```

### Local Environment File (.env.puls)

Additionally, upon successful deployment, Puls merges and writes all resolved environment variables into a local `.env.puls` file at your workspace root. 

This enables you to run local scripts, tests, or application servers directly using the same secrets without manually fetching them from cloud APIs:

```bash
# Generated in .env.puls
DB_PASSWORD=my-super-secret-db-password
APP_ENV=production
```

---

## How Secrets Behave in Dry-Run

Testing your infrastructure shouldn't require configuring real cloud credentials locally. Puls respects your `.dryRun` configurations completely:

* When `dryRun: true` is active, the dynamic secret fetcher **intercepts any API calls** and immediately resolves to a secure placeholder string:
  ```typescript
  `[SECRET:name]`
  ```
* No network requests are made, no cloud SDKs are initialized, and no billing tokens are consumed. This allows developers to test full stacks in their local terminal with zero friction:

```bash
🔍 [DRY RUN] Finalizing GCP VM "my-gcp-vm"...
   └─ Environment:
      └─ STRIPE_API_KEY: [SECRET:STRIPE_API_KEY]
      └─ DB_PASSWORD: [SECRET:prod/database/password]
```

---

## Running Multiple Stacks in One Process

When you run more than one `Stack.deploy()` call sequentially inside the same Node.js process, Puls carries resolved secret values forward into each subsequent run's console-redaction filter by default. This is usually safe, but if you want a clean slate between runs you can clear the accumulated secret set:

```typescript
import { clearResolvedSecrets } from "puls-dev";

await StackA.deploy();
clearResolvedSecrets(); // wipe resolved values before the next stack

await StackB.deploy();
```

This is only relevant when sequentially deploying multiple stacks in a single script. Individual stack runs are always isolated - each deployment creates its own redaction context so secrets from one stack can never leak into another stack's logs.

---

## Zero-Dependency Architecture

To keep the Puls core package ultra-lightweight and prevent startup crashes, **dynamic imports are used under the hood**. 

The heavy AWS SDK or GCP credentials library is *only* imported if and when you explicitly call `Secret.aws()`, `Secret.ssm()`, or `Secret.gcp()`. If you are only deploying to DigitalOcean or Proxmox, you do not need to install AWS or Google packages!
