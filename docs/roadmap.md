# Roadmap

Internal tracking doc — improvements, new providers, and the path to a publishable NPM package.

---

## Tech Debt

- [ ] `package.json` has `"type": "commonjs"` and `"main": "index.js"` — no real entry point exists, needs rethinking before any npm publish
- [ ] `config/default.sh` is superseded by `config/default.yaml` — can be removed once Ansible is confirmed as the standard

---

## Provider Improvements

### Proxmox
- [ ] Cluster-aware node selection — pick the node with the most free RAM via `/nodes` API instead of always using the first configured node
- [ ] `.machine()` builder method — let users override machine type (i440fx vs q35) per VM rather than the hardcoded default
- [ ] `CONFIG.PRODUCTION` entry in `src/types/proxmox.ts`

### AWS
- [x] CloudFront cache invalidation — `.invalidate(paths[])` on a CloudFront builder
- [x] S3 file upload — `.upload(filePath)` uploads a single file to the bucket on deploy
- [ ] Route53 A-record upsert — currently only CNAMEs are supported via `upsertCnames()`
- [ ] S3 static site hosting config

### DigitalOcean
- [ ] VPC support

---

## New Providers

### AWS — Completion path (in order)
- [x] **Lambda** — deploy a function from a local zip or directory; most DSL-friendly compute primitive
- [x] **API Gateway** — route HTTP → Lambda; pairs naturally, minimal config surface
- [x] **ECS / Fargate** — container services without instance management; no VPC required for Fargate
- [x] **RDS** — managed database instances (Postgres, MySQL)
- [x] **SQS** — queues as event-driven glue between the above
- [ ] **EC2** — lower priority; Proxmox already covers the raw-VM use case, and EC2 needs VPC/SG/keypair support to be useful

### GCP / Firebase
Firebase maps naturally to the DSL — each service is a one-liner with sane defaults, no cluster management.

```typescript
@Deploy({ region: GCP_REGION.EU_WEST1, token: process.env.FIREBASE_JSON })
class Blog extends Stack {
  app  = Firebase.App("myblog").config("./dist");
  api  = Firebase.Functions("api").source("./functions");
  db   = Firebase.Firestore("mydb").rules("./firestore.rules");
}
```

- [x] `src/types/gcp.ts` — `GCP_REGION` constants
- [x] **Firebase Hosting** — deploy a web app from a local build directory
- [ ] **Firebase Functions** — deploy Cloud Functions from a local source directory
- [ ] **Firebase Firestore** — database with rules deployment
- [ ] **GCP Cloud Run** — containerized services, closer to ECS/Fargate parity
- [ ] **GCP Cloud SQL** — managed Postgres / MySQL on GCP

### Community-driven
These are good-fit providers but maintained by the community, not core. The contributing guidelines enforce the DSL contract.

- [ ] **CloudFlare** — zones, DNS, CDN; natural alternative to CloudFront for teams avoiding AWS lock-in
- [ ] **Hetzner Cloud** — popular self-hosting alternative to DigitalOcean, similar API shape
- [ ] **Akamai** — enterprise CDN / edge; complex enough that it warrants a dedicated maintainer

---

## NPM Package

- [ ] Switch `package.json` to `"type": "module"` (ESM)
- [ ] Add `"exports"` map with per-provider sub-paths so consumers can import only what they need:
  ```json
  "exports": {
    "./proxmox": "./dist/providers/proxmox/index.js",
    "./aws":     "./dist/providers/aws/index.js",
    "./do":      "./dist/providers/do/index.js"
  }
  ```
- [ ] Ship compiled JS + `.d.ts` declarations; mark provider SDK packages as peer dependencies
- [ ] Semver versioning — provider additions = minor, breaking DSL changes = major

---

## Framework Features

- [x] **Stack outputs** — pass values between stacks (e.g. VM IP from one stack feeds a DNS record in another)
- [x] **Inventory / `@Check`** — read-only discovery across all configured providers; prints counts, status, and DO cost estimates
- [ ] **Secrets integration** — pull credentials from Vault or AWS SSM at deploy time instead of env vars
- [ ] **Hooks** — `beforeDeploy` / `afterDeploy` callbacks on Stack for custom side effects
- [ ] **Multi-region** — run the same stack across N regions in parallel
