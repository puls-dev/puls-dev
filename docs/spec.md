# Puls 1.0: Core Behavioral Specification

This document defines the formal behavioral contract and execution guarantees of the Puls IaC engine. These guarantees form the stable runtime specification of the system. All provider plugins and core engine refactors must adhere strictly to these rules.

---

## 1. Idempotency & The Discovery Lifecycle

Puls is stateless: it does not use local or remote state files. The live cloud environment is the single source of truth.

### Eager Discovery
- **The Guarantee**: Declaring a resource immediately initiates discovery.
- **Mechanism**: The constructor of any `BaseBuilder` subclass must dispatch an asynchronous API read in the background, stored inside `discoveryPromise`. 
- **Rule**: Eager discovery must not perform any API writes or mutations. It is strictly read-only.

### Diffing & State Matching
Before any mutation is run:
1. `discoveryPromise` is awaited to obtain the live cloud resource state.
2. If no resource is found, the status is `missing`.
3. If a resource is found, the builder runs `getDiff()`.
   - If `getDiff()` returns an empty array, the status is `in-sync`.
   - If it returns field changes, the status is `drift`.

### Mutation Dispatch rules
- **`in-sync`**: `deploy()` is a no-op. No API write call is dispatched.
- **`missing`**: `deploy()` runs creation logic.
- **`drift`**: `deploy()` runs update or recreate logic.
- **`adopted`**: If `.adoptId()` is configured, creation is skipped.

---

## 2. DAG Execution & Determinism

Puls stacks represent directed acyclic graphs (DAGs) of resource builders.

```
[Resource A] ──(Output Resolution)──> [Resource B]
```

### Execution Lifecycles
- **Sequential Mode**: Stacks deploy resources sequentially in the exact order they are declared in the class definition.
- **Parallel Mode**: Stacks deploy independent branches concurrently. A node begins execution only when all nodes it depends on (via explicit `dependsOn()` or implicit Output interpolation) have resolved their `_deployPromise`.

### Dependency Resolution via Outputs
- **Implicit Dependency**: If property `B` references `A.out.someField`, an implicit dependency is established. `B` is blocked from deploying until `A.out.someField` resolves.
- **Eager Resolution**: Outputs can be adopted or resolved ahead of deployment (e.g. using `adoptOutput()`) to unblock parallel execution paths.

### Failure Boundaries & Abort Semantics
- If any node in the graph throws an error during `deploy()`:
  1. The global stack deployment is aborted.
  2. In parallel mode, any pending nodes that have not yet started are cancelled immediately (fail-fast).
  3. Already completed deployments are **not** automatically rolled back by the engine; they remain intact on the cloud.

---

## 3. Preflight Compliance (Policy Engine)

Compliance checks must run before the stack attempts to execute any resource deployment actions.

### Pre-Deployment Guarantee
- **The Contract**: Stacks compile the list of declared builders, evaluate them against configured `Policy` rules, and run validation **before** calling `deploy()` on any resource.
- **Behavior**: If validation fails, Puls prints the compliance report and exits immediately. Zero cloud writes are allowed.

---

## 4. Context Isolation

Puls supports running multiple deployments concurrently in the same Node process (e.g. multi-region or multi-tenant setups).

- **The Guarantee**: Configuration options, secrets, and provider credentials do not bleed across stack executions.
- **Mechanism**: All provider-specific options are bound to the execution thread using `resourceContextStorage` (leveraging `AsyncLocalStorage`).
- **Rule**: Global state modules must never hold configuration credentials. They must query the active context.

---

## 5. Secret Security & Lifetimes

Secrets are sensitive strings resolved dynamically during the stack run.

- **Lazy Evaluation**: Secrets are never resolved during stack compilation; they are fetched asynchronously only when stack execution is triggered.
- **Redaction Invariant**: Any value resolved from a `Secret` is automatically appended to the active run's redaction index. The console output interceptor must scrub these values, replacing them with `********`.
- **Instance Lifetime**: A `Secret` promise resolves once and holds the value. It remains in memory for the duration of the Node process run and is cleared when the process exits.
