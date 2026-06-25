---
date: 2026-06-24
authors:
  - bia
categories:
  - Architecture
  - Philosophy
---

# Infrastructure as Code Without State Files (and Without the Headaches)

If you've managed cloud resources over the last decade, you've likely had a run-in with a **state file**. 

Whether it's Terraform's `.tfstate` or Pulumi's stack state, traditional Infrastructure-as-Code (IaC) tools rely on a centralized ledger. This file is their source of truth-a mapping of declared resource names to physical cloud IDs, tracking metadata and dependencies.

While state files solved a major problem in the early days of cloud automation, they introduced a host of operational challenges that teams spend hundreds of engineering hours managing.

Puls is built around a different philosophy: **what if we didn't need state files at all?**

<!-- more -->

---

## The Headaches of State-Based IaC

State files are brittle. In any active development team, they frequently cause friction:

1. **State Desync (Drift)**: If an engineer makes a quick fix in the AWS Console, the state file doesn't know. The next runner might overwrite the manual fix or crash because the cloud state and the state file disagree.
2. **State Locking & Merge Conflicts**: Only one person or pipeline can run a deploy at a time. If a pipeline fails midway or a lock gets stuck, someone has to manually force-unlock the state.
3. **Secret Leakage**: State files store every resource property in plain text. If a database is provisioned, its root password is often saved directly inside the state file, necessitating complex encryption keys, KMS permissions, and private state buckets.
4. **Operations Overhead**: Teams must set up secure backend storage (e.g., S3 + DynamoDB for locking), configure state access controls, and manage backups.

Traditional tools ask: *"How do you want to build this step-by-step, according to this file?"*
Puls asks a simpler question: *"What is in your cloud right now, and what do you want it to look like?"*

---

## The Puls Alternative: Eager Discovery

Puls eliminates state files entirely by using a concept we call **Eager Discovery**.

Instead of reading a local JSON file that represents the past, Puls asks the cloud provider APIs directly for the present. The moment you instantiate a resource in TypeScript, Puls fires off an asynchronous API lookup in the background.

Here is how a Puls deployment workflow differs:

```
[Traditional IaC]
Read local state file ──> Compare with code ──> Compute dry-run plan ──> Apply changes ──> Save updated state file

[Puls State-Free IaC]
Instantiate resource ──> Asynchronous API discovery queries live cloud state in parallel
                     └──> Stack awaits discovery ──> Diffs live vs code ──> Creates/Updates only if needed
```

Because discovery runs asynchronously in the background while your code executes, you don't pay a performance penalty. By the time `Stack.deploy()` is called, Puls already knows exactly what exists.

---

## Drift Detection as a Core Primitive

Without a state file, drift detection is no longer a separate command or a manual auditing chore. It is the core primitive of every operation.

When you call `Stack.diff()`, Puls queries the live API and returns a structured comparison of what is declared vs what is actually running:

```typescript
@Deploy({ region: REGION.US_EAST_1 })
class AppStack extends Stack {
  db = AWS.RDS("prod-db")
    .engine("postgres")
    .instanceClass("db.t3.medium")
    .storage(50);
}

const diff = await Stack.from(AppStack).diff();
```

If an engineer manually scaled up the database class to `db.t3.large` in the AWS console, `diff()` outputs the live reality:

```text
🔍 Diff: AppStack

   db   prod-db      ⚠️  drift
        └─ instanceClass     db.t3.medium  →  db.t3.large

   ⚠️  1 drifted resource out of 1 resources.
```

If you deploy, Puls safely mutates only the drifted properties to restore compliance. If the live resource matches your declaration, Puls skips it completely. Running a Puls deployment twice is always idempotent and always safe.

---

## Simpler Code, Fewer Encumbrances

By dropping the state file, we also drop the HCL boilerplate. We don't need manual `terraform import` commands or resource adoption scripts. If you want Puls to manage a resource that was created manually, you simply declare it with the same name, or use `.adoptId()` to map it. Puls discovers it, updates it to match your code, and keeps going.

We built Puls so that engineers can focus on shipping products, not debugging lockfiles. By matching your declared code directly against live cloud APIs, we make infrastructure intuitive, robust, and truly state-free.

---

*Want to try it out? Read our [Getting Started](../../getting-started.md) guide and see how you can declare your first state-free stack.*
