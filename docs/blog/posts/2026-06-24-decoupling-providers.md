---
date: 2026-06-24
authors:
  - bia
categories:
  - Releases
  - Architecture
---

# Decoupling Cloud Providers: Introducing the Puls Plugin API

Today, we are excited to release Puls `v0.4.9`! This release marks a significant architectural milestone for Puls as we decouple the core infrastructure engine from individual cloud provider implementations. We have also added complete support for local E2E testing against **Firebase Local Emulators**.

<!-- more -->

Puls was built on a simple premise: describe the infrastructure you want, and let Puls figure out how to safely create, update, or skip resources without state files or manual configuration drifts. 

As we expand support for more cloud systems, keeping provider-specific configurations, list APIs, and console visualizers inside the core framework code was becoming a bottleneck. Today's release introduces the **Provider Plugin API**, moving Puls closer to a pluggable community-driven ecosystem.

---

## The Decoupled Provider Plugin API

Previously, core framework files like the CLI `Checker` and configuration decorator `applyConfig` contained hardcoded mappings for `aws`, `do` (DigitalOcean), `gcp`, `firebase`, and `proxmox`. 

With `v0.4.9`, we've introduced the `ProviderPlugin` interface and a global `providerRegistry`:

```typescript
export interface ProviderPlugin {
  name: string;
  isConfigured: (config: any) => boolean;
  list?: (config: any) => Promise<any>;
  render?: (inventory: any) => void;
  configure?: (opts: any) => void;
}
```

### Key Benefits:
1. **Zero-Configuration Auto-Registration**: Provider plugins register themselves dynamically on import. When you import resources (e.g. `import { AWS } from "puls-dev/aws"`), the provider registers its configure, list, and visual rendering hooks automatically.
2. **Simplified Core Engine**: The CLI visual checker now dynamically queries the registry to parse configuration files and display inventory tables, allowing it to remain completely agnostic of specific cloud providers.
3. **Paving the Way for Community Providers**: Developers can now call `registerProvider(myPlugin)` to write first-class custom providers (like Cloudflare, Hetzner, or Vultr) without modifying any core framework files.

---

## Firebase Local Emulator Suite Integration

As part of our commitment to local-first development, we have also shipped E2E testing capabilities for the Firebase provider utilizing the local **Firebase Emulator Suite** (specifically targeting **Firebase Auth** and **Cloud Firestore**).

When the standard emulator host environment variables are set:

```bash
export FIRESTORE_EMULATOR_HOST=localhost:8080
export FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
```

Puls automatically redirects its GCP and Identity Toolkit API calls:

* **Service Account Bypass**: Bypasses production service account configuration checks and executes authenticated resources locally using mock credentials.
* **Emulator Rules Translation**: Intercepts GCP ruleset updates and automatically posts them to the Firestore emulator rules evaluation engine.
* **Graceful No-ops**: Mock-succeeds Firestore composite index management and Auth provider config (which are not supported or needed by local emulators), allowing you to run deployment pipelines locally without errors.

---

## What's Next?

With the provider decoupling API completed, our next major milestone is **splitting `puls-dev` into monorepo sub-packages** (e.g., `@puls-dev/core`, `@puls-dev/aws`, `@puls-dev/firebase`) to dramatically reduce dependency bloat, ensuring developers only download the SDKs and providers they actively use.

Stay tuned for more updates, and happy coding!
