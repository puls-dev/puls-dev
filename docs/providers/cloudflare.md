# Cloudflare Provider

The Cloudflare provider (`puls-dev/cloudflare`) allows you to declaratively configure edge DNS routing, serverless compute (Workers), KV namespaces, and S3-compatible object storage (R2).

## Setup

Authentication uses a **Cloudflare API Token** and an optional **Account ID** (Account ID is required for Workers, KV namespaces, and R2 buckets).

### Environment Configuration
The provider will automatically pick up `CLOUDFLARE_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from your environment (e.g. your `.env` file):

```bash
CLOUDFLARE_TOKEN=your-api-token
CLOUDFLARE_ACCOUNT_ID=your-account-id
```

### Decorator Setup
Alternatively, you can provide configuration settings explicitly within the `@Deploy` decorator:

```typescript
@Deploy({
  cloudflare: {
    token: process.env.CLOUDFLARE_TOKEN!,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!
  }
})
class AppStack extends Stack {}
```

---

## DNS Zones & Records

Manage DNS Zones and reconcile individual records. 

```typescript
CF.Zone("example.com")
  .pointer("www", "1.2.3.4", true) // A record with Cloudflare Proxy enabled
  .cname("blog", "gh-pages.github.com") // CNAME record
  .aaaa("ipv6", "2001:db8::1") // AAAA record
  .txt("txt-record", "some-text-value") // TXT record
  .mx("mail", "mx.mail-server.com", 10) // MX record with priority
  .srv("_sip._udp", "sip.server.com", 5060, 10, 10) // SRV record (port, priority, weight)
  .caa("@", "issue", "letsencrypt.org", 0); // CAA record (tag, value, flags)
```

### Record Normalization
Record names are normalized to Fully Qualified Domain Names (FQDNs). The following names are treated equivalently:

* `@` or `""` (empty string) → `example.com`
* `www` → `www.example.com`
* `www.example.com` → `www.example.com`

### Reconciliation & Purging
Puls compares your declared records with existing zone records:

* **Skipping**: Records matching the declared type, name, content, proxy state, and configuration are skipped.
* **Updating**: Existing records with the same name and type but different values (e.g. IP or priority) are updated in-place (retaining their record IDs).
* **Purging**: Duplicate or stale records matching a declared type and name but having different values (and not matched to any active definition) are automatically purged. Other unmanaged record types/names are left untouched.

### YAML/JSON File Records
You can also import DNS records from a local file (`.yaml`, `.yml`, or `.json` format):

```typescript
CF.Zone("example.com")
  .record("dns/records.yaml");
```

Format example (`records.yaml`):
```yaml
- name: www
  type: A
  value: 1.2.3.4
  proxied: true
- name: blog
  type: CNAME
  value: blog-host.com
- name: mail
  type: MX
  value: mx-host.com
  priority: 10
```

---

## KV Namespace

Create and manage Workers KV key-value namespaces.

```typescript
const kvStore = CF.KV("my-app-cache");
```

On deploy, Puls resolves the namespace ID and exposes it as an Output, which can be linked directly to a Worker:

```typescript
const kvId = kvStore.out.id;
```

---

## R2 Bucket

Manage Cloudflare R2 object storage buckets.

```typescript
const mediaBucket = CF.R2("app-media");
```

---

## Serverless Workers

Deploy serverless Workers scripts with environment variables, KV bindings, and R2 bucket bindings, and map them to routing patterns.

```typescript
const cache = CF.KV("session-cache");
const uploads = CF.R2("user-uploads");

CF.Worker("my-api-worker")
  .script("./dist/worker.js")
  .kv("SESSIONS", cache) // Bind KV namespace
  .r2("UPLOADS", uploads) // Bind R2 bucket
  .env("API_URL", "https://api.mycompany.com") // Bind env variable
  .route("api.example.com/*") // Map route to zone
  .route("example.com/api/*");
```

### Route Reconciliation
Puls parses target route patterns to automatically detect the parent DNS zone (e.g., matching `api.example.com/*` or `example.com/api/*` against `example.com`). It then reconciles the worker routes on those zones on every deployment.

---

## Cloudflare Pages

Deploy static sites and single-page applications (SPAs) with custom domains and branch configurations:

```typescript
CF.Pages("my-frontend-app")
  .source("./dist") // Local directory containing built assets
  .branch("main") // Production branch (default: "main")
  .domain("my-cool-app.com") // Associated custom domains
  .domain("www.my-cool-app.com");
```

### Direct Asset Uploads
Puls utilizes the official Wrangler CLI under the hood to perform direct asset uploads. When the stack is deployed:
1. Puls verifies the project exists (creating it via the Cloudflare REST API if it is missing).
2. It hashes and uploads your static files to Cloudflare Pages.
3. It maps and reconciles custom domains (adding new ones and removing obsolete ones).

---

## Full Example

Below is a complete Puls stack using Cloudflare:

```typescript
import "dotenv/config";
import { Stack, Deploy } from "@puls-dev/core";
import { CF } from "@puls-dev/cloudflare";

@Deploy({ dryRun: false })
class CloudflareInfra extends Stack {
  // 1. Storage & Databases
  cache = CF.KV("prod-cache");
  bucket = CF.R2("prod-assets");

  // 2. DNS Zone and Records
  zone = CF.Zone("my-cool-app.com")
    .pointer("www", "185.199.108.153", true) // GitHub Pages IP
    .txt("_github-pages-challenge", "challenge-value");

  // 3. Worker Application
  api = CF.Worker("main-api")
    .script("./build/index.js")
    .kv("CACHE", this.cache)
    .r2("ASSETS", this.bucket)
    .env("ENVIRONMENT", "production")
    .route("api.my-cool-app.com/*");
}
```

---

## Teardown (destroy)

Running a stack teardown (`puls destroy`) for Cloudflare:

1. Reverts and deletes matching Worker routes.
2. Deletes the uploaded Worker scripts.
3. Deletes the KV namespaces and R2 buckets.
4. Deletes the DNS Zones (including all managed records).
