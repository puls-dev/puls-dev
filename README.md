# Pulsdev.io

**State-free, eager-discovery Infrastructure-as-Code for TypeScript.**

[![Live Documentation](https://img.shields.io/badge/docs-pulsdev.io-blueviolet)](https://pulsdev.io/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## What is Puls?

Pulsdev.io is a modern, developer-centric Infrastructure-as-Code (IaC) framework. Instead of using complex configuration languages or managing centralized, brittle state files (`terraform.tfstate`), Puls allows you to define and manage cloud infrastructure as pure, strongly-typed TypeScript stacks.

### Key Philosophy
* **Zero State Files**: Puls queries your live cloud environment directly. There is no state file to get corrupted, desynchronized, or locked.
* **Eager Discovery**: Resource discovery queries execute in the background the moment you declare a builder. By the time deployment begins, the current infrastructure state is already resolved.
* **Idempotent by Default**: Running the same stack multiple times is always safe. Puls automatically detects existing resources, skipping them or applying in-place updates.

---

## What Puls Solves

### 1. Eliminates State Management Overhead
Traditional IaC tools require a shared state file stored in S3/GCS. If a deployment fails or state becomes desynchronized, developers must manually edit state files or run complex imports. Puls solves this by treating the cloud provider itself as the single source of truth.

### 2. Speeds Up Developer Feedback Loops
Puls executes resource discovery asynchronously in the background. Because compilation and discovery happen concurrently, dry-runs (`puls plan`) and state drift comparisons (`puls diff`) complete in seconds rather than minutes.

### 3. Native TypeScript Integration
No custom DSLs (like HCL) or YAML templates. Write stacks using standard TypeScript classes, decorators, and libraries. Share configuration, secrets, and utilities using standard npm modules and environment configs.

---

## Code Example

```typescript
import { Stack, Deploy } from "@puls-dev/core";
import { AWS, REGION, RUNTIME } from "@puls-dev/aws";

@Deploy({ region: REGION.US_EAST_1 })
class AppStack extends Stack {
  // 1. Declare database
  db = AWS.RDS("app-db").engine("postgres").size("db.t3.micro");

  // 2. Declare Lambda function referencing the database endpoint
  api = AWS.Lambda("app-api")
    .code("./dist/api")
    .runtime(RUNTIME.NODEJS_20)
    .env({
      DB_HOST: this.db.endpoint,
    });
}
```

---

## Quick Start

### Installation

```bash
npm install @puls-dev/core @puls-dev/aws
```

### Install CLI
Run the one-time launcher setup to invoke `puls` directly in your terminal:

```bash
npx puls install-shell
```

### Command Cheat Sheet

```bash
puls plan    infra/stack.ts   # Dry-run stack: view changes without making writes
puls deploy  infra/stack.ts   # Apply the declared stack to your cloud provider
puls diff    infra/stack.ts   # Check for drift against live cloud state
puls destroy infra/stack.ts   # Teardown the stack
```

---

## Key Capabilities

* **Governance (Policy-as-Code)**: Enforce declarative compliance policies pre-flight.
* **Drift Detection**: Run `puls diff --fail-on-drift` to identify external modifications instantly.
* **Resource Adoption**: Bring existing cloud resources under Puls management via `.adoptId()`.
* **Universal Provisioning**: Eagerly bake VM templates and run Ansible playbooks with change-aware metadata.
* **Parallel Execution**: Automatically resolves resource DAGs and deploys independent nodes concurrently.

---

## Documentation

For full guides, provider credentials setup, and API references, visit the **[Live Documentation](https://pulsdev.io/)**.
