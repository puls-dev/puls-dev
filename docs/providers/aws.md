# AWS Provider

## Setup

Uses standard AWS SDK environment variables - no explicit `AWS.init()` needed:

```bash
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
```

Pass the region via decorator:

```typescript
@Deploy({ region: REGION.EU_CENTRAL_1 })
class MyStack extends Stack { ... }
```

**Constants**

```typescript
import { AWS_TYPES } from "puls-dev";
const { REGION, RUNTIME, DB, DB_SIZE, DISTRO, BUCKET } = AWS_TYPES;
```

---

## Lambda

Deploy a function from a local directory or pre-built zip.

```typescript
AWS.Lambda("my-function")
  .code("./dist")                 // directory → auto-zipped, or pass a .zip path
  .runtime(RUNTIME.NODEJS_20)
  .handler("index.handler")       // default
  .memory(256)                    // MB, default 128
  .timeout(30)                    // seconds, default 30
  .env({ LOG_LEVEL: "info" })
```

An IAM execution role (`puls-lambda-{name}-role`) is created automatically if you don't supply one via `.role(arn)`.

**Constants**

```typescript
RUNTIME.NODEJS_20   // nodejs20.x
RUNTIME.NODEJS_18   // nodejs18.x
RUNTIME.PYTHON_3_12 // python3.12
RUNTIME.JAVA_21     // java21
RUNTIME.DOTNET_8    // dotnet8
```

---

## API Gateway

HTTP API (v2) routing to Lambda functions.

```typescript
AWS.APIGateway("my-api")
  .route("GET /users", this.listUsers)
  .route("POST /users", this.createUser)

// Single-function proxy - forwards all traffic to one Lambda
AWS.APIGateway("my-api").proxy(this.handler)
```

Outputs the live endpoint URL on deploy. Uses `$default` stage with auto-deploy - no manual deployment step needed. Lambda invoke permissions are granted automatically and idempotently.

---

## ECS / Fargate

Containerized services without instance management.

```typescript
AWS.Fargate("my-service")
  .image("nginx:latest")         // required
  .cpu(256)                      // vCPU units, default 256
  .memory(512)                   // MB, default 512
  .port(80)
  .replicas(2)                   // default 1
  .env({ NODE_ENV: "production" })
  .cluster("my-cluster")         // default: "puls"
```

**What it manages automatically:**

- ECS cluster (`puls` by default) - created if absent
- IAM task execution role with `AmazonECSTaskExecutionRolePolicy`
- CloudWatch log group `/puls/{name}`
- Default VPC + subnets (or override with `.subnets(ids[])`)
- Security group with port open (or override with `.securityGroups(ids[])`)

---

## RDS

Managed database instances.

```typescript
AWS.RDS("my-db")
  .engine(DB.POSTGRES_16)
  .size(DB_SIZE.SMALL)
  .storage(20)                    // GB, default 20
  .database("appdb")              // initial DB name
  .credentials("admin", process.env.DB_PASSWORD!)
```

**What it manages automatically:**

- DB subnet group across all default VPC subnets
- Security group with DB port open to VPC CIDR only (use `.publicAccess()` to open to the internet)

Waits for `available` status after creation (up to 20 minutes, polls every 30 seconds). Outputs the endpoint and port.

**Constants**

```typescript
DB.POSTGRES_16  // { engine: 'postgres', version: '16' }
DB.POSTGRES_15
DB.MYSQL_8
DB.MARIADB_11

DB_SIZE.MICRO   // db.t3.micro - free tier eligible
DB_SIZE.SMALL   // db.t3.small
DB_SIZE.MEDIUM  // db.t3.medium
DB_SIZE.LARGE   // db.r6g.large
```

---

## SQS

Standard and FIFO queues with optional dead-letter queue.

```typescript
// Standard queue
AWS.SQS("job-queue")
  .retention(7)          // days, default 4
  .timeout(60)           // visibility timeout in seconds, default 30
  .delay(0)              // delivery delay in seconds, default 0
  .dlq("job-queue-dlq", 3)   // DLQ name + max receives before redirect

// FIFO queue - .fifo suffix appended automatically
AWS.SQS("order-events")
  .fifo()
  .deduplication()
```

`.dlq()` creates the dead-letter queue first and wires the redrive policy. `resolvedDlqUrl` and `resolvedDlqArn` are available on the builder after deploy.

---

## S3

```typescript
AWS.S3("my-bucket")
  .allowFrom(this.cdn, this.game)   // adds CloudFront OAC policy for each distro
  .region(REGION.EU_WEST_1)         // bucket in non-default region
  .upload("./dist/checksums.json")  // upload a single file on deploy
```

`.allowFrom()` merges CloudFront ARNs into the bucket policy without overwriting other statements.

---

## CloudFront

Clone an existing distribution and attach it to a domain.

```typescript
AWS.CloudFront("my-distro-name")
  .copyFrom(DISTRO.CDN)              // clone config from existing distribution ID
  .forDomain(this.domain, ["ec", "nc"])     // CNAMEs: ec.zoneName, nc.zoneName
  .invalidate(["/index.html", "/api/*"])    // invalidate paths after deploy
```

`.forDomain()` wires the ACM cert from the Route53 sidecar automatically. Retries cert propagation for up to 5 minutes.

---

## Route53

Hosted zone discovery and domain registration.

```typescript
AWS.Route53("example.com")                    // existing domain
AWS.Route53().randomDomain().register(DOMAIN_REGISTER)  // register a new random .com
AWS.Route53("example.com").withWildcardSSL()  // attach wildcard ACM cert (sidecar)
```

---

## ACM

Managed automatically as a Route53 sidecar - not used directly.

`.withWildcardSSL()` on a Route53 builder requests a wildcard cert, writes the DNS validation CNAME, and waits for `ISSUED` (up to 10 minutes).

---

## Full example

```typescript
import "dotenv/config";
import "reflect-metadata";
import { AWS, AWS_TYPES, Stack, Deploy } from "puls-dev";
const { REGION, RUNTIME, DB, DB_SIZE } = AWS_TYPES;
// import { SECRETS } from "./types/secrets.ts"; // your local constants

@Deploy({ region: REGION.EU_CENTRAL_1, dryRun: false })
class AppStack extends Stack {
  // secret = AWS.SecretsManager(SECRETS.DB_KEY);
  
  db = AWS.RDS("app-db")
    .engine(DB.POSTGRES_16)
    .size(DB_SIZE.SMALL)
    .credentials(this.secret);

  api = AWS.Fargate("app-api")
    .image("my-org/app:latest")
    .cpu(512).memory(1024)
    .port(3000)
    .replicas(2);

  resizer = AWS.Lambda("image-resizer")
    .code("./functions/resizer")
    .runtime(RUNTIME.NODEJS_20)
    .memory(512);

  gateway = AWS.APIGateway("app-gateway")
    .route("GET /resize", this.resizer);

  jobs = AWS.SQS("resize-jobs")
    .retention(7)
    .dlq("resize-jobs-dlq", 3);
}
```
