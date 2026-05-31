# Parallel Resource Deployment

By default, Puls deploys resources sequentially in the order they are declared within a `Stack` class, and destroys them in reverse order. While sequential execution is highly predictable, it can limit deployment speed when stacks contain multiple independent resources (e.g., three separate virtual machines or independent databases).

Puls provides a high-performance **Parallel Resource Deployment** engine that automatically analyzes dependencies and schedules independent resources to execute concurrently, optimizing total execution times while maintaining strict topological safety.

---

## Enabling Parallel Deployment

Parallel execution is an opt-in stack feature configured via the `@Deploy` and `@Destroy` decorators.

### `@Deploy({ parallel: true })`

To enable concurrent resource creation and updates during stack deployment, pass `parallel: true` to the `@Deploy` decorator:

```typescript
import { Stack, Deploy, Proxmox } from "puls-dev";

@Deploy({ parallel: true, proxmox: CONFIG.PRODUCTION })
class AppStack extends Stack {
  web1 = Proxmox.VM("prod-web-01").cores(4).memory(4096);
  web2 = Proxmox.VM("prod-web-02").cores(4).memory(4096);
  db   = Proxmox.VM("prod-db-01").cores(8).memory(16384);
}
```

In this setup, `web1`, `web2`, and `db` will start provisioning concurrently. The total deployment time drops from the sum of all VM creations to the duration of the slowest single VM creation.

### `@Destroy({ parallel: true })`

To teardown resources concurrently during a stack destruction, pass `parallel: true` to the `@Destroy` decorator:

```typescript
@Destroy({ parallel: true, proxmox: CONFIG.PRODUCTION })
class AppStack extends Stack {
  web1 = Proxmox.VM("prod-web-01").cores(4).memory(4096);
  web2 = Proxmox.VM("prod-web-02").cores(4).memory(4096);
  db   = Proxmox.VM("prod-db-01").cores(8).memory(16384);
}
```

---

## Dependency Resolution

Concurrent execution requires a mechanism to ensure that resources with direct relationships are not created out of order. Puls supports both **explicit** and **implicit** dependency models to cleanly construct a reactive Directed Acyclic Graph (DAG) under the hood.

### 1. Explicit Dependencies (`dependsOn`)

If resources do not pass outputs to each other but still require an ordering constraint (for example, a web server shouldn't start before the database is fully booted and accepting connections), you can declare an explicit dependency chain using the fluent `.dependsOn()` method.

```typescript
@Deploy({ parallel: true, proxmox: CONFIG.PRODUCTION })
class AppStack extends Stack {
  db  = Proxmox.VM("prod-db-01").cores(8).memory(16384);
  app = Proxmox.VM("prod-app-01").cores(4).memory(4096);

  constructor() {
    super();
    // Enforces that 'db' is fully deployed before 'app' begins deployment
    this.app.dependsOn(this.db);
  }
}
```

Puls's parallel scheduler ensures that:
- `db` begins deploying immediately.
- `app` yields and waits until `db`'s deployment promise resolves successfully.
- Once `db` finishes, `app` begins deploying automatically.

### 2. Implicit Dependencies (`Output<T>`)

When one resource consumes an input parameter retrieved dynamically from the `Output<T>` of another resource, Puls **automatically infers the dependency relationship**. You do not need to call `.dependsOn()` in these scenarios.

```typescript
import { Stack, Deploy, DO } from "puls-dev";

@Deploy({ parallel: true, token: CONFIG.DO_TOKEN })
class WebStack extends Stack {
  // r1: Deploys first
  droplet = DO.Droplet("app-srv").image("ubuntu-24-04-x64").size("s-2vcpu-4gb");

  // r2: Awaits r1's public IP output automatically
  dns = DO.Domain("example.com").pointer("www", this.droplet.ip);
}
```

Under the hood, Puls's Promise-based `Output` resolution naturally schedules this:

1. `droplet` and `dns` are scheduled concurrently.
2. `dns` immediately begins its deployment function.
3. Inside `dns.deploy()`, it attempts to read `this.droplet.ip.get()`.
4. Because the `ip` output has not been resolved yet, the async execution yields control back to the Node.js event loop.
5. `droplet` completes its creation and resolves the dynamic IP output.
6. The `dns` resource automatically resumes and proceeds to create the DNS A record using the resolved IP.

---

## Concurrent Teardown Mechanics

When tearing down a stack via `@Destroy({ parallel: true })`, Puls automatically reverses the topological dependency order.

- Dependent resources (e.g., DNS records, web apps) are destroyed **first** and concurrently.
- Dependency resources (e.g., droplets, databases) await the completion of all their respective dependents' destruction promises before initiating their own teardown.

This prevents common teardown errors where a parent resource is deleted while dependents are still referencing it (e.g., trying to delete a VPC while active subnets or instances are running inside it).

---

## Error Propagation & Safety

If any resource fails to deploy (e.g., due to an API timeout, rate limits, or invalid configurations), Puls guarantees immediate safety:

1. **Halt Dependent Chains**: Any resource that depends on the failed resource (explicitly or implicitly) is immediately halted. Its deployment hook, provider action, and post-deployment callbacks will **not** be executed.
2. **Continue Independent Chains**: Independent branches in the DAG will continue attempting to deploy to maximize progress.
3. **Propagate Failures**: The stack's main `deploy()` promise will reject with the root cause exception, ensuring that deployment scripts, CI/CD runners, and orchestrators receive the correct exit code.
