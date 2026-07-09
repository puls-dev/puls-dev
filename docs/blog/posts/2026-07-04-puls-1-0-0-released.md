---
date: 2026-07-04
authors:
  - bia
categories:
  - Releases
  - Releases-1.0
---

# Puls 1.0.0 Released: General Availability

Today, we are thrilled to announce the official release of **Puls 1.0.0** - the first stable, production-ready version of our TypeScript-native cloud infrastructure framework.

Puls is not a configuration language and it is not a wrapper around Terraform. It is a framework: you write real TypeScript, import the providers you need, and Puls handles the gap between your declared intent and live cloud state on every run. Instead of state files and plan stages, Puls uses **eager discovery** - each deployment starts by reading the live cloud, computes the diff in memory, and reconciles immediately, in a single step. No lock files. No apply confirmation prompts. No drift between what the plan said and what actually happened.

<!-- more -->

---

## What’s New in 1.0.0

Puls 1.0.0 brings a suite of powerful features designed to make legacy cloud migrations and resource management simple, safe, and intuitive.

### Visual Interactive Importer Wizard
The headline feature of v1.0.0 is the **Puls Importer** (run via `puls import`).

* **Collapsible Connection Tree**: Visualizes your existing cloud resources and their dependencies (e.g., firewall rules mapped under VMs, or Route53 records connected to CloudFront distributions).
* **Cascading Selections**: Adopting a parent resource automatically selects all of its connected dependencies.
* **Transitive Root Grouping**: Generated files are automatically partitioned into nested directories based on their dependency tree roots (e.g., `infra/puls-web/`), with compute files separated from network files (`network/network-stack.ts`).
* **Cross-Tier Linking**: Automatically links stack declarations together in output code (e.g., using relative TS imports and generating `.attachTo("vm-name")` configuration calls across stacks).

For details, read our dedicated blog post: [Introducing Puls Importer: The Visual Interactive Cloud Migration Engine](./2026-07-02-introducing-puls-importer-visual-wizard.md).

### Native Proxmox & DigitalOcean Discovery
* **Proxmox Virtual Environment**: Fully supports discovering cluster VMs and VM templates, node-based grouping (e.g. `Node: pve1`), and automatically mapping cores, memory, and node selections to typescript builders.
* **DigitalOcean Firewalls**: Automatically maps droplet ID relationships, parsing and grouping firewalls as sub-dependencies of droplets in the visual tree and stacking them correctly in code.

### Zero-Configuration SSL Bypass
Developing locally against private IP endpoints (like private Proxmox hypervisors or local Kubernetes clusters) often involves self-signed SSL certificates. Puls 1.0.0 registers an early TLS bypass module in the CLI:
* Honors `NODE_TLS_REJECT_UNAUTHORIZED=0` and `PROXMOX_VERIFY_SSL=false` defined in your local `.env`.
* Executes at the absolute beginning of the CLI bootstrap to guarantee Node's TLS subsystem ignores SSL verification issues for these dev endpoints.

### Type-Safe Dependency Chaining with `Output<T>`
At the heart of Puls is `Output<T>` - a typed, lazy reference that lets resources depend on each other without manual `await` calls or explicit ordering. When one builder produces an output (like a network ID or server IP), another builder can consume it directly at declaration time:

```typescript
const network = new NetworkBuilder("prod-net").ipRange("10.0.0.0/16");
const server  = new ServerBuilder("web-01").network(network.out.id);
```

Puls resolves the dependency graph automatically during deployment. `Output<T>` is also composable - `.apply()` transforms a value lazily, so you can derive new outputs from existing ones without breaking the graph.

### Secret Management with Automatic Redaction
`Secret` is a first-class primitive for handling credentials. Secrets are fetched lazily at deploy time (never at construction), deduplicated across resources via an internal cache, and automatically registered for global redaction:

```typescript
const dbPassword = Secret.aws("prod/db-password");        // AWS Secrets Manager
const apiToken   = new Secret("stripe-key", fetchFromVault); // custom fetcher

// Any console.log or deployment table output that contains the resolved value
// is automatically replaced with ******** - no manual scrubbing required.
```

Secrets support `.jsonKey("field")` to extract a single key from a JSON secret, and resolve to a placeholder string in dry-run mode so pipelines never touch live credentials.

### Policy & Compliance Engine
`Policy` lets platform teams encode compliance rules that run before every deployment and abort with a structured error if violated:

```typescript
import { Policy } from "@puls-dev/core";

Policy.register({
  name: "require-ssh-key",
  validate: (resource) => {
    if (resource.name.startsWith("vm-") && !(resource as any).sshKey) {
      return `Resource "${resource.name}" must have an SSH key configured`;
    }
  },
});
```

Rules receive every resource in the stack and can return a string (violation message), `false`, or throw. All violations are collected and printed together before the deployment is blocked - no silent partial failures.

### Multi-Cloud Package Suite
Puls 1.0.0 ships as nine independently installable scoped packages so you only pull in what you need:

| Package | Cloud / Platform |
|---|---|
| `@puls-dev/core` | Core runtime, CLI, `Stack`, `Output`, `Secret`, `Policy` |
| `@puls-dev/aws` | EC2, RDS, S3, Route53, API Gateway, Secrets Manager, Lambda |
| `@puls-dev/gcp` | Compute Engine, Cloud DNS, Cloud Run |
| `@puls-dev/firebase` | Firestore rules & indexes, Remote Config, Hosting |
| `@puls-dev/hcloud` | Hetzner Cloud servers, networks, firewalls |
| `@puls-dev/do` | DigitalOcean Droplets, Spaces, DNS, Firewalls |
| `@puls-dev/cloudflare` | DNS records, pages, workers |
| `@puls-dev/proxmox` | Proxmox VE VMs and templates |
| `@puls-dev/azure` | Azure VMs, Key Vault, DNS |

All packages peer-depend on `@puls-dev/core` and integrate natively with the `Output<T>`, `Secret`, and `Policy` primitives.

### Deployment Notifications
`SLACK.notify()` and `DISCORD.notify()` are built-in lifecycle hooks that post a rich embed to a webhook URL whenever a resource is deployed or destroyed - no third-party library required:

```typescript
import { SLACK } from "@puls-dev/core";

class ProdStack extends Stack {
  server = new ServerBuilder("web-01")
    .onDeployed(SLACK.notify(process.env.SLACK_WEBHOOK_URL!));
}
```

In dry-run mode the notification is printed to the terminal instead of sent, keeping CI pipelines safe.

---

## Getting Started

To get started with Puls 1.0.0, install the core CLI package:

```bash
npm install @puls-dev/core
```

Configure your credentials in `.env` (see our [Getting Started](https://pulsdev.io/getting-started) guide for templates), and run the importer:

```bash
puls import
```

---

## Thank You

A huge thank you to everyone in our community who is downloading and using Puls. This is merely the beginning and further development is always in motion. 

Happy deploying!
