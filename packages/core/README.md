# @puls-dev/core

**The core execution engine for Puls: State-free, eager-discovery Infrastructure-as-Code for TypeScript.**

---

## What is @puls-dev/core?

This package contains the central orchestrator and stack engine for Pulsdev.io. It handles stack dependency resolution (DAG), asynchronous background resource discovery, drift detection, policy-as-code enforcement, and CLI commands.

It is designed to be completely decoupled from specific cloud SDKs, giving you a zero-overhead runner that resolves and applies stacks.

## Key APIs

* **`Stack`**: The base class for defining your infrastructure stacks.
* **`@Deploy(opts)` / `@Destroy(opts)`**: Decorators that register stack execution boundaries, credentials, and multi-region triggers.
* **`Secret`**: Safe, lazy wrapper for retrieving credentials at deploy-time (GCP, AWS Secrets Manager, SSM, or Environment variables).
* **`Output<T>`**: Typings for referencing parameters resolved asynchronously at deploy time.
* **`Policy`**: Guardrail engine to validate resources pre-flight.

## Installation

```bash
npm install @puls-dev/core
```

## Quick Start Example

```typescript
import "dotenv/config";
import "reflect-metadata";
import { Stack, Deploy } from "@puls-dev/core";

@Deploy({ dryRun: true })
class MyStack extends Stack {
  // Define resources here by importing provider packages
}
```

Learn more at **[pulsdev.io](https://pulsdev.io/)**.
