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
import { AWS, REGION, RUNTIME, DB, DB_SIZE, DISTRO, BUCKET } from "puls-dev/aws";
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

## EC2

Provision virtual machine instances with elastic IP binding and universal playbook configurations.

```typescript
AWS.EC2("my-server")
  .ami("ami-0c55b159cbfafe1f0")     // standard AMI (Ubuntu default)
  .instanceType("t3.small")         // default: t3.micro
  .keyName("my-ssh-keypair")        // AWS SSH key pair
  .subnetId("subnet-12345")         // optional VPC subnet
  .securityGroupIds(["sg-987"])     // security groups
  .userData("#!/bin/bash\necho boot")
  .sshPrivateKey("~/.ssh/id_rsa")   // private key to connect for playbooks
  .provision("config/setup.yaml")   // run Ansible playbook on creation/hash mismatch
```

**Drift-Free Provisioning State:**
Puls stores applied playbook hashes directly in the EC2 instance tags (`puls-provision`). If you modify a playbook, Puls compares hashes and applies *only* updated playbooks on subsequent runs.

**Automatic Resizing:**
If you change `.instanceType()`, Puls automatically handles stopping the VM, modifying the instance type attribute, starting the VM, and waiting for it to reboot.

**Outputs**

| Field      | Type             | Description               |
|------------|------------------|---------------------------|
| `.out.id`  | `Output<string>` | The AWS InstanceId        |
| `.out.ip`  | `Output<string>` | The public or private IP  |

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

Hosted zone discovery, DNS record management, and domain registration.

```typescript
AWS.Route53("example.com")                    // existing hosted zone
AWS.Route53("example.com").withWildcardSSL()  // attach wildcard ACM cert (sidecar)
AWS.Route53().randomDomain().register(DOMAIN_REGISTER)  // register a new random .com
```

**Adding records**

You can add records individually, bulk-load them from local configuration files (YAML/JSON), or chain them in a hybrid fashion:

```typescript
AWS.Route53("example.com")
  .record("config/records.yaml")                  // Bulk load static records from a YAML or JSON file!
  .record("api",  "A",     "203.0.113.10", 120)   // Programmatic hybrid record!
  .record("www",  "CNAME", "example.com")
  .record("@",    "TXT",   "v=spf1 include:_spf.google.com ~all")  // quotes added automatically
```

The configuration file (e.g. `config/records.yaml`) should contain a list of records matching this format:

```yaml
# config/records.yaml
- name: "@"
  type: TXT
  value: "v=spf1 include:_spf.google.com ~all"
- name: mail
  type: A
  value: 1.2.3.4
  ttl: 600
- name: www
  type: CNAME
  value: lb.google.com
```

Supported types: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, `PTR`, `SRV`, `CAA`, `NAPTR`, `SPF`. 

When loading from a file (e.g. `record("path/to/file.yaml")`), records are parsed relative to `process.cwd()` and appended to the zone. TXT and SPF values are automatically wrapped in double quotes if not already quoted.

**Alias pointer**

Use `.pointer()` to point a name at another Puls-managed resource (e.g. a Fargate service or load balancer):

```typescript
AWS.Route53("example.com")
  .pointer("api", this.apiService)  // creates an A alias record
```

**Domain registration**

```typescript
import { REGION } from "puls-dev/aws";

const DOMAIN_REGISTER = {
  FIRSTNAME: "Jane",
  LASTNAME: "Doe",
  EMAIL: "jane@example.com",
  MOBILE: "+1.5555550100",
  CONTACT_TYPE: "PERSON",
  ADDRESSLINE: "123 Main St",
  CITY: "Seattle",
  ZIPCODE: "98101",
  COUNTRY: "US",
};

AWS.Route53("example.com").register(DOMAIN_REGISTER)
AWS.Route53().randomDomain().register(DOMAIN_REGISTER)  // registers a random available .com
```

Registration polls every 15 seconds and waits up to 15 minutes for the domain to become active. Privacy protection is enabled by default for admin, registrant, and tech contacts.

**Outputs**

| Field        | Type                                   |
|--------------|----------------------------------------|
| `.out.zone`  | `Output<{ name: string; id: string }>` |

---

## ACM

Managed automatically as a Route53 sidecar - not used directly.

`.withWildcardSSL()` on a Route53 builder requests a wildcard cert, writes the DNS validation CNAME, and waits for `ISSUED` (up to 10 minutes).

---

## SecretsManager

Read and manage AWS Secrets Manager secrets.

```typescript
// Read an existing secret (value available at deploy time via .resolvedValue)
AWS.SecretsManager("my-app/db-password")

// Create or update a secret
AWS.SecretsManager("my-app/db-password")
  .plainText("s3cr3t")
  .description("Production DB password")

// Store a JSON object (key-value secret)
AWS.SecretsManager("my-app/config")
  .keyValue({ host: "db.internal", port: 5432 })
```

**Using secrets as env vars**

Pass a `SecretsBuilder` directly into `.env()` on Lambda or Fargate - Puls resolves the secret value at deploy time and injects it as a plain string:

```typescript
const dbPass = AWS.SecretsManager("my-app/db-password");

AWS.Lambda("my-fn")
  .code("./dist")
  .runtime(RUNTIME.NODEJS_20)
  .env({ DB_PASSWORD: dbPass })
```

**Destroy behaviour**

By default, `@Destroy` schedules a 30-day recovery window. Use `.forceDelete()` to delete immediately:

```typescript
AWS.SecretsManager("my-app/temp-token").forceDelete()
```

---

## IAM

Create and manage custom IAM roles and policies with automatic version pruning.

```typescript
// Create a managed policy
const s3Policy = AWS.IAMPolicy("s3-read-policy")
  .document({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:ListBucket"],
        Resource: ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*"],
      },
    ],
  })
  .description("Grants read access to my-bucket");

// Create a role and attach policies
const workerRole = AWS.IAMRole("worker-execution-role")
  .description("Execution role for background workers")
  .attach(s3Policy)                                      // attach managed policy builder
  .attach("arn:aws:iam::aws:policy/AWSLambda_FullAccess") // or attach ARN directly
  .inlinePolicy("sqs-write", {                            // add inline policy
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["sqs:SendMessage"],
        Resource: "*",
      },
    ],
  });

// Attach custom role to a Lambda function
AWS.Lambda("worker")
  .code("./dist")
  .runtime(RUNTIME.NODEJS_20)
  .role(workerRole); // wires the role automatically
```

* **Version Pruning**: AWS limits customer-managed policies to 5 versions. `AWS.IAMPolicy` automatically lists and prunes the oldest non-default version before applying updates, guaranteeing failure-free continuous deployments.

---

## SNS

Provision Simple Notification Service (SNS) topics and manage subscriptions with clean, idempotent synchronization.

```typescript
const alertTopic = AWS.SNS("billing-alerts")
  .displayName("Billing Alert Topic")
  .subscribe("email", "admin@company.com")
  .subscribe("sms", "+15555550199");
```

On deploy, Puls creates the topic, updates the display name, and automatically synchronizes subscriptions by removing stale endpoints and subscribing new ones.

**Outputs**

| Field      | Type             |
|------------|------------------|
| `.out.arn` | `Output<string>` |

---

## CloudWatch Alarms

Configure metric threshold alerts and wire them to SNS notification targets. Includes premium auto-wiring helpers for Fargate and RDS.

```typescript
// General-purpose custom metric alarm
AWS.Alarm("checkout-errors")
  .metric("CheckoutService", "ErrorCount", { Environment: "production" })
  .comparison("GreaterThanThreshold")
  .threshold(5)
  .period(60)                     // 60 seconds
  .evaluationPeriods(2)           // 2 consecutive periods
  .statistic("Sum")
  .actions(this.alertTopic);       // wires the SNS topic builder eagerly

// Premium Fargate helper: triggers if CPU usage >= 80%
AWS.Alarm("api-cpu-high")
  .fargateCPU(this.apiService, 80)
  .actions(this.alertTopic);

// Premium Fargate helper: triggers if memory usage >= 85%
AWS.Alarm("api-mem-high")
  .fargateMemory(this.apiService, 85)
  .actions(this.alertTopic);

// Premium RDS helper: triggers if CPU usage >= 90%
AWS.Alarm("db-cpu-high")
  .rdsCPU(this.database, 90)
  .actions(this.alertTopic);

// Premium RDS helper: triggers if free storage space falls below 5GB
AWS.Alarm("db-storage-low")
  .rdsStorage(this.database, 5_000_000_000)
  .actions(this.alertTopic);
```

**Outputs**

| Field       | Type             |
|-------------|------------------|
| `.out.name` | `Output<string>` |
| `.out.arn`  | `Output<string>` |

---

## Full example

```typescript
import "dotenv/config";
import "reflect-metadata";
import { Stack, Deploy } from "puls-dev";
import { AWS, REGION, RUNTIME, DB, DB_SIZE } from "puls-dev/aws";

@Deploy({ region: REGION.EU_CENTRAL_1, dryRun: false })
class AppStack extends Stack {
  secret = AWS.SecretsManager("my-app/db-password");
  
  db = AWS.RDS("app-db")
    .engine(DB.POSTGRES_16)
    .size(DB_SIZE.SMALL)
    .credentials("admin", this.secret);

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

  // Alerts & Alarms
  alerts = AWS.SNS("ops-alerts")
    .displayName("Operations Alerts")
    .subscribe("email", "ops@company.com");

  apiCpuAlarm = AWS.Alarm("api-cpu-alarm")
    .fargateCPU(this.api, 80)
    .actions(this.alerts);

  dbCpuAlarm = AWS.Alarm("db-cpu-alarm")
    .rdsCPU(this.db, 90)
    .actions(this.alerts);
}
```
