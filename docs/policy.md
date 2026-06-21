# Policy-as-Code (Governance)

Puls features a native, lightweight **Policy-as-Code** validation engine. This allows you to define declarative compliance guardrails in pure TypeScript that run as pre-flight checks before executing `puls plan`, `puls deploy`, or `puls diff`.

If any resource violates a registered policy rule, the execution aborts immediately without sending write requests or starting deployments, protecting your cloud environment from insecure or non-compliant states.

---

## How It Works

You declare policy rules by calling `Policy.register()` and supplying a rule name and a `validate` function. The validation function receives each resource instance (inheriting from `BaseBuilder`) in your stacks and inspects its properties.

```typescript
import { Policy } from "puls-dev";
import { S3BucketBuilder } from "puls-dev/aws";

// Enforce versioning on all AWS S3 buckets
Policy.register({
  name: "Enforce S3 Versioning",
  validate(resource) {
    if (resource instanceof S3BucketBuilder) {
      if (!resource["_versioning"]) {
        return `AWS S3 Bucket "${resource.name}" must have versioning enabled.`;
      }
    }
  }
});
```

---

## Validation Return Behaviors

The `validate` function can express compliance outcomes in several ways:

| Return / Action | Interpretation | Result |
|---|---|---|
| `string` | **Violation**. The returned string is used as the compliance error message. | Aborts execution |
| `false` | **Violation**. A generic failure message is raised. | Aborts execution |
| `void` / `undefined` | **Compliant**. The resource passes validation for this rule. | Continues execution |
| `true` | **Compliant**. The resource passes validation for this rule. | Continues execution |
| `throw new Error(...)` | **Violation**. The error message is caught and logged. | Aborts execution |

---

## Practical Examples

Here are common compliance policies you can integrate into your Puls stacks:

### 1. Blocking Public Database Access
Ensure no GCP Cloud SQL databases or AWS RDS instances are exposed to the public internet:

```typescript
import { Policy } from "puls-dev";
import { CloudSQLBuilder } from "puls-dev/gcp";
import { RDSBuilder } from "puls-dev/aws";

Policy.register({
  name: "No Public Databases",
  validate(resource) {
    // GCP Cloud SQL check
    if (resource instanceof CloudSQLBuilder) {
      if (resource["_publicAccess"]) {
        return `GCP Cloud SQL "${resource.name}" must have public access disabled.`;
      }
    }
    
    // AWS RDS check
    if (resource instanceof RDSBuilder) {
      if (resource["_publicAccess"]) {
        return `AWS RDS Instance "${resource.name}" must not be publicly accessible.`;
      }
    }
  }
});
```

### 2. Enforcing Resource Naming Conventions
Enforce that all resources match specific naming conventions (e.g. prefixing or containing environment tags):

```typescript
import { Policy } from "puls-dev";

Policy.register({
  name: "Resource Naming Convention",
  validate(resource) {
    const isCompliant = resource.name.startsWith("prod-") || resource.name.startsWith("dev-");
    if (!isCompliant) {
      return `Resource "${resource.name}" name must be prefixed with "prod-" or "dev-".`;
    }
  }
});
```

### 3. Restricting Compute Sizing
Cap VM specifications (like Proxmox or GCP cores/memory) to control cloud costs:

```typescript
import { Policy } from "puls-dev";
import { GCPVMBuilder } from "puls-dev/gcp";

Policy.register({
  name: "Cap GCP Compute Sizing",
  validate(resource) {
    if (resource instanceof GCPVMBuilder) {
      const machineType = resource["_machineType"] || "e2-micro";
      // Prevent high-cost machines in staging/development
      if (machineType.startsWith("n2-standard") || machineType.startsWith("c2-")) {
        return `GCP VM "${resource.name}" size "${machineType}" exceeds allowed cost limits.`;
      }
    }
  }
});
```

---

## Enforcement Lifecycle

Policy validations run automatically at the start of:

* `puls plan`: Validates resources before printing the planned changes.
* `puls deploy`: Prevents executing resource creations or modifications if any violations exist.
* `puls diff`: Restricts performing remote state discoveries on non-compliant resource intentions.

If a violation occurs, the console will print a summary of the compliance violations and exit:

```text
🛑 [POLICY VIOLATION] Compliance check failed with 1 error(s):
   - GCP Cloud SQL "customer-db" must have public access disabled.
   
Error: Policy compliance checks failed. Deployment aborted.
```
