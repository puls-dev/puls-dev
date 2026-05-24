# Pulsdev.io

**Intent-driven infrastructure-as-code. Describe what you want - Puls figures out create, update, or skip.**

No state files. No plan step. No YAML. Just TypeScript against real APIs, idempotent by default.

```typescript
@Deploy({ proxmox: CONFIG.STAGING })
class GameInfra extends Stack {
  server = Proxmox.VM("example-vm")
    .image(OS.UBUNTU_24_04)
    .cores(4).memory(8192)
    .ip("1.1.1.1").vlan(VLAN.STAGING)
    .sshKey(KEYS)
    .provision(["config/default.yaml", "config/service.yaml"]);
}
```

---

## How it works

The moment you declare a resource, Puls starts an API lookup in the background - **eager discovery**. By the time `deploy()` runs, it already knows the current state. It diffs, acts, and moves on.

```
Declare resource  →  Discovery fires immediately
                  →  You chain config (.cores(), .ip(), ...)
                  →  deploy() awaits discovery, diffs, acts
```

Running the same stack twice is always safe. Resources that already match are skipped without an API write.

---

## Providers

| Provider | Resources |
|----------|-----------|
| **AWS** | Route53, ACM, CloudFront, S3, Lambda, API Gateway, ECS/Fargate, RDS, SQS |
| **Proxmox** | VM (clone, cloud-init, provision, immutable replace) |
| **DigitalOcean** | Droplet, Domain, Firewall, Certificate, LoadBalancer |
| **Firebase** | Hosting |

---

## A bigger example

```typescript
@Deploy({ region: REGION.US_EAST_1 })
class AppStack extends Stack {
  // Secrets
  secret = AWS.SecretsManager(SECRETS.DB_KEY)

  // Database
  db = AWS.RDS("app-db")
    .engine(DB.POSTGRES_16)
    .size(DB_SIZE.SMALL)
    .credentials(this.secret);

  // Container service - auto-creates cluster, IAM role, log group, security group
  api = AWS.Fargate("app-api")
    .image("my-org/app:latest")
    .cpu(512).memory(1024)
    .port(3000)
    .replicas(2)
    .env({ DATABASE_URL: "..." });

  // Serverless function
  resizer = AWS.Lambda("image-resizer")
    .code("./functions/resizer")
    .runtime(RUNTIME.NODEJS_20)
    .memory(512);

  // HTTP routing
  gateway = AWS.APIGateway("app-api-gw")
    .route("GET /resize", this.resizer);

  // Queue for async jobs
  jobs = AWS.SQS("resize-jobs")
    .retention(7)
    .dlq("resize-jobs-dlq", 3);
}
```

---

## Community

Have questions or want to contribute? Join the conversation on Discord: **pulsdev.io** ([Join](https://discord.gg/CjgRayuH))

---

## Install

```bash
npm install puls-dev
cp .env.example .env  # fill in your credentials
npx tsx your-stack.ts
```

Requires Node 20+.
