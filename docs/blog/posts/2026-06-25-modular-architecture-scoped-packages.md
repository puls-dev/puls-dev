---
date: 2026-06-25
authors:
  - bia
categories:
  - Releases
  - Architecture
---

# Modular IaC: Announcing Scoped Workspace Packages

Puls is taking its next major step toward modularity and zero dependency-bloat. We have split the monolithic `puls-dev` codebase into separate, scoped sub-packages within an npm workspace monorepo layout: `@puls-dev/core` and individual provider packages like `@puls-dev/aws`, `@puls-dev/gcp`, `@puls-dev/do`, and `@puls-dev/firebase`.

<!-- more -->

Previously, installing `puls-dev` meant downloading the entire cloud landscape: AWS SDKs, Google Auth libraries, Azure Vault credentials, and Undici clients. Whether you only wanted to manage a single DigitalOcean Droplet or deploy a Firebase web application, the dependency footprint was unnecessarily large.

Starting today, we have partitioned the project to give you complete control over your installation footprint.

---

## The New Monorepo Topology

Puls is now organized as a set of scoped packages under the `@puls-dev` namespace:

* **`@puls-dev/core`**: The central engine containing CLI commands, stack decorators (`@Deploy`, `@Destroy`), dependency resolution, cost estimation, and the resource execution lifecycle.
* **Provider Packages**: Separate modules containing resource declarations, API configurations, and discovery lists for each provider:
  * `@puls-dev/aws`
  * `@puls-dev/do`
  * `@puls-dev/gcp`
  * `@puls-dev/firebase`
  * `@puls-dev/proxmox`
  * `@puls-dev/azure`
  * `@puls-dev/cloudflare`

---

## How to Use Scoped Packages

In your project's `package.json`, you now declare only the core engine and the specific providers you need:

```json
{
  "dependencies": {
    "@puls-dev/core": "^0.5.0",
    "@puls-dev/firebase": "^0.5.0"
  }
}
```

In your stack code, you import the stack decorators from `@puls-dev/core` and the resource builders from their respective provider modules:

```typescript
import { Firebase } from "@puls-dev/firebase";
import { Deploy, Stack } from "@puls-dev/core";

@Deploy()
class WebStack extends Stack {
  site = Firebase.Hosting("my-site")
    .source("./dist")
    .domain("example.com");
}
```

---

## Under the Hood: Dynamic Resolution

Splitting the packages required ensuring that `@puls-dev/core` remained completely decoupled from the provider SDKs while still allowing standard discovery.

To achieve this:
1. Core features dynamic plugin discovery. When running `puls plan`, core attempts to dynamically import registered providers. If a provider is not installed, it fails gracefully without stopping other operations.
2. Credentials and low-level REST wrappers are cleanly encapsulated inside their respective provider directories.
3. Common playbooks/metadata utilities have been promoted to core, eliminating any dependency loop between providers.

This layout paves the way for developers to publish third-party, custom provider packages (e.g. `@my-org/puls-kubernetes`) that integrate seamlessly with the `@puls-dev/core` stack runner.
