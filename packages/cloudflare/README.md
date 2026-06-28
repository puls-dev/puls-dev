# @puls-dev/cloudflare

**Cloudflare Provider for Puls IaC. Configure DNS records, edge Workers, Pages, and R2 storage buckets.**

---

## What is @puls-dev/cloudflare?

This package is the official Cloudflare provider plug-in for Puls. It configures and deploys edge resources, scripts, and domains using Cloudflare's HTTP APIs.

## Available Builders

* **`Cloudflare.Zone`**: Managed custom domains.
* **`Cloudflare.Worker`**: Serverless edge function scripts.
* **`Cloudflare.R2`**: S3-compatible zero-egress object storage.
* **`Cloudflare.Pages`**: Static web app hosting and git triggers.
* **`Cloudflare.KV`**: Key-Value edge storage namespaces.

## Installation

```bash
npm install @puls-dev/core @puls-dev/cloudflare
```

## Quick Example

```typescript
import { Stack, Deploy } from "@puls-dev/core";
import { Cloudflare } from "@puls-dev/cloudflare";

@Deploy()
class EdgeStack extends Stack {
  bucket = Cloudflare.R2("assets-bucket");
  
  script = Cloudflare.Worker("api-router")
    .code("./dist/worker.js")
    .bind(this.bucket);
}
```

## Authentication

Set your account credentials in your `.env` file:
```bash
CLOUDFLARE_TOKEN=your-api-token
CLOUDFLARE_ACCOUNT_ID=your-account-id
```

Learn more at **[pulsdev.io/providers/cloudflare](https://pulsdev.io/providers/cloudflare.md)**.
