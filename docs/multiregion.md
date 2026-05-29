# Multi-Region Deployments

Puls supports first-class **Multi-Region Deployments** natively in the deployment engine. You can declare that a single stack configuration should be deployed across multiple cloud regions (e.g. AWS or GCP) with dynamic context isolation and clean, rate-limit friendly sequential execution.

---

## 🌍 Configuring Multi-Region Stacks

You can configure multi-region deployments simply by passing a `regions` array parameter to the class-level `@Deploy` or `@Destroy` decorators:

```typescript
import { Stack, Deploy, REGION } from "puls-dev";
import { AWS } from "puls-dev/aws";

// This stack will be deployed sequentially to us-east-1, eu-central-1, and ap-northeast-1
@Deploy({
  regions: [REGION.US_EAST_1, REGION.EU_CENTRAL_1, REGION.AP_NORTHEAST_1],
  dryRun: false
})
class RegionalAppStack extends Stack {
  // Instantiated once per region with the active region configured
  api = AWS.Lambda("image-processor")
    .code("./dist")
    .memory(512);
}
```

### Under the Hood: Region Context Isolation
To prevent configuration race conditions on the global config context and to stay within strict cloud provider API rate limits:
1. Puls loops through each declared region **sequentially**.
2. Before instantiating each stack instance, it swaps the active provider region (e.g. `providers.aws.region = activeRegion`).
3. It instantiates the Stack constructor (which triggers eagerness boundaries inside resources with the correct region set).
4. Runs `deploy()` and logs terminal outputs inside a visually distinct regional console block.

---

## 🔍 Referencing Regional Stack Outputs

When a stack is deployed across multiple regions, Puls generates a distinct stack instance for each region and indexes them inside the global stack registry under a regional key:
```typescript
"RegionalAppStack:us-east-1"
"RegionalAppStack:eu-central-1"
```

Downstream stacks can retrieve outputs from a **specific regional deployment** by passing the region parameter to `Stack.from()`:

```typescript
import { Stack, Deploy, REGION } from "puls-dev";
import { AWS } from "puls-dev/aws";
import { RegionalAppStack } from "./app-stack.js";

@Deploy({ region: REGION.US_EAST_1 })
class GlobalDashboard extends Stack {
  // Reference outputs from the us-east-1 deployment
  usApp = Stack.from(RegionalAppStack, REGION.US_EAST_1);
  
  // Reference outputs from the eu-central-1 deployment
  euApp = Stack.from(RegionalAppStack, REGION.EU_CENTRAL_1);

  dashboard = AWS.Fargate("dashboard")
    .image("my-org/dashboard:latest")
    .env({
      US_LAMBDA_ARN: this.usApp.api.arn,
      EU_LAMBDA_ARN: this.euApp.api.arn,
    });
}
```

---

## 💥 Multi-Region Teardown

Teardowns are declared symmetrically using the `@Destroy` decorator. When `@Destroy` is triggered with multiple regions, Puls cleanly walks the regions list in sequence, setting the correct config region, instantiating the resource mappings, and tearing them down:

```typescript
@Destroy({
  regions: [REGION.US_EAST_1, REGION.EU_CENTRAL_1]
})
class RegionalAppStack extends Stack {
  api = AWS.Lambda("image-processor");
}
```
