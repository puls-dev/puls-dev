# Roadmap

Internal tracking doc - improvements, new providers, and the path to a publishable NPM package.

---

## Tech Debt

- [x] `config/default.sh` is superseded by `config/default.yaml` - can be removed once Ansible is confirmed as the standard
- [x] `LoadBalancerBuilder` (DO) does not extend `BaseBuilder` - inconsistent lifecycle, uses `Config.isGlobalDryRun()` instead of `isDryRunActive()`, no sidecar/protection support
- [x] DO `DomainBuilder` deletes and recreates records on every deploy instead of true upsert - can cause brief DNS gaps
- [x] Firebase `FunctionsBuilder` skips eager discovery (resolves `null` immediately) - diverges from the standard pattern where discovery fires in the constructor
- [x] Scattered `as any` casts on Route53 record types and elsewhere - replace with proper SDK type imports where possible

---

## Testing

- [x] Basic test suite (core: `config.test.ts`, `output.test.ts`)
- [x] Provider unit tests with mocked API clients - each builder's `deploy()` and `destroy()` paths covered (create, skip, update, dry-run) (DO, AWS S3/Route53/Lambda, and Firebase Hosting/Functions fully complete)
- [ ] Dry-run integration tests - run full stacks with `dryRun: true` against real provider credentials to verify discovery without writing
- [ ] CI pipeline - run unit tests on every push; dry-run suite on PRs that touch provider code
- [ ] End-to-end tests against sandboxes (LocalStack for AWS, DO staging token, Firebase emulator)

---

## Provider Improvements

### Proxmox
- [x] Cluster-aware node selection - pick the node with the most free RAM via `/nodes` API instead of always using the first configured node
- [x] `.machine()` builder method - let users override machine type (i440fx vs q35) per VM rather than the hardcoded default
- [x] `CONFIG.PRODUCTION` entry in `src/types/proxmox.ts`
- [ ] **Golden Image / VM Templates (`Proxmox.Template`)** — Declare pre-baked templates with fluent OS base images and playbook provisioning (Packer-like behavior). Clone VMs from these templates to drop VM deployment time from minutes to seconds.

### AWS
- [x] CloudFront cache invalidation - `.invalidate(paths[])` on a CloudFront builder
- [x] S3 file upload - `.upload(filePath)` uploads a single file to the bucket on deploy
- [x] Route53 record types - A, AAAA, CNAME, MX, TXT, NS, PTR, SRV, CAA, NAPTR, SPF via `.record()`; per-record TTL; TXT auto-quoting
- [x] S3 static site hosting - `.staticSite()` sets index/error documents and public-read policy
- [x] IAM - role and inline/managed policy management; useful for cross-service wiring without manual console steps
- [x] CloudWatch alarms - CPU/memory thresholds on Fargate and RDS with SNS notification target
- [x] EC2 - Provision EC2 virtual machines with VPC/SG support and stateless tag-based playbook provisioning.

### DigitalOcean
- [x] Droplet, Domain, Firewall, Certificate, LoadBalancer
- [x] `LoadBalancerBuilder` overhaul - extend `BaseBuilder`, add `.region()`, `.healthCheck()`, `.stickySession()`, configurable forwarding rules and SSL termination
- [x] Spaces - S3-compatible object storage; `.bucket()`, `.cors()`, `.acl()`
- [x] Managed databases - Postgres, MySQL, Redis; analogous to AWS RDS
- [x] App Platform - deploy from a GitHub repo or container image without managing Droplets
- [x] VPC - create and assign Droplets/databases to a private network
- [x] Domain: add AAAA, SRV, CAA record types; implement `destroy()` for domain and records

### Firebase
- [x] Firebase Hosting - deploy a web app from a local build directory; file-level caching via SHA256
- [x] Firebase Functions - deploy Cloud Functions v2 from source; full create/update/delete lifecycle
- [x] Firebase Firestore - rules deployment and composite index management
- [x] Firebase Auth - email/password, anonymous, phone, and OAuth providers (Google, GitHub, Facebook, Twitter, Apple, Microsoft); authorized domains
- [x] Firebase Storage - rules deployment, CORS configuration, lifecycle policies
- [x] Firebase RemoteConfig - typed parameters (string, bool, number, JSON), conditions, and per-condition overrides; ETag-safe PUT
- [x] Firebase App Check - enforce attestation on Hosting, Functions, and Firestore

### Google Cloud Platform (GCP)
- [x] GCP Cloud Run (`GCP.CloudRun`) - Deploy containerized services with auto-scaling and public URLs (Fargate parity)
- [x] GCP Cloud SQL (`GCP.CloudSQL`) - Managed PostgreSQL and MySQL database instances (RDS parity)
- [x] GCP Secret Manager (`GCP.Secret`) - Manage and inject GCP secrets at deploy-time (SecretsManager parity)
- [x] GCP Pub/Sub (`GCP.PubSub`) - Topics and subscriptions for decoupled messaging (SQS/SNS parity)
- [x] GCP Cloud DNS (`GCP.CloudDNS`) - Managed zones, record sets, and DNS routing (Route53 parity)
- [x] GCP IAM (`GCP.ServiceAccount` / `GCP.IAMBinding`) - Service accounts, custom roles, and resource-level IAM bindings (IAM parity)



---

## New Providers

### Cloudflare
Strong candidate for a first-class provider - widely used alongside or instead of AWS for DNS and CDN, and the API is clean.

```typescript
@Deploy({ cloudflare: { token: process.env.CF_TOKEN } })
class EdgeStack extends Stack {
  zone   = CF.Zone("example.com");
  worker = CF.Worker("api").script("./workers/api").route("api.example.com/*");
  kv     = CF.KV("sessions");
  r2     = CF.R2("assets");
}
```

- [ ] **Zone + DNS** - hosted zone discovery, full record type support (mirrors Route53 implementation)
- [ ] **Workers** - deploy a Worker script with routes and env bindings
- [ ] **KV** - key-value namespace management
- [ ] **R2** - S3-compatible object storage; useful as a cheaper CloudFront+S3 alternative
- [ ] **Pages** - static site hosting with preview deployments

### Hetzner Cloud
Popular self-hosting alternative to DigitalOcean - similar API shape, easy to add.

- [ ] **Server** - analogous to DO Droplet; image, type, location, SSH key
- [ ] **Network / VPC** - private networking between servers
- [ ] **Firewall** - inbound/outbound rules
- [ ] **Load Balancer** - HTTP/HTTPS with health checks
- [ ] **Volume** - persistent block storage attached to servers

### Microsoft Azure
Enterprise cloud provider - critical for corporate environments. Needs resource group management, VM provisioning, and active directory support.

- [ ] **Resource Groups** - basic resource lifecycle boundary
- [ ] **Azure App Service (`Azure.AppService`)** - PaaS web app provisioning with slots support
- [ ] **Azure Virtual Machines (`Azure.VM`)** - Compute instances with private virtual network support and universal playbook provisioning
- [ ] **Azure SQL Database (`Azure.SQL`)** - Managed databases with automated failover groups
- [ ] **Azure Blob Storage (`Azure.BlobStorage`)** - Massively scalable object storage

### Akamai
Enterprise CDN/edge - complex enough to warrant a dedicated maintainer; community-driven.

---

## NPM Package

- [x] Switch `package.json` to `"type": "module"` (ESM)
- [x] Basic test suite
- [x] Add `"exports"` map with per-provider sub-paths so consumers can import only what they need (e.g. `puls-dev/aws`, `puls-dev/firebase`)
- [x] Ship compiled JS + `.d.ts` declarations
- [x] Standard dependencies for zero-friction out-of-the-box pre-1.0 install
- [ ] **Scoped Monorepo Sub-Packages** — Split `puls-dev` into separate scoped packages published to the registry (`@puls-dev/core`, `@puls-dev/aws`, `@puls-dev/gcp`, etc.) to provide zero-friction installs with zero dependency bloat
- [ ] Semver versioning - provider additions = minor, breaking DSL changes = major


---

## Framework Features

- [x] **Stack outputs** - pass `Output<T>` values between stacks; eager resolution unblocks dependents automatically
- [x] **Inventory / `@Check`** - read-only discovery across all configured providers; prints counts, status, and DO cost estimates
- [x] **Dry run** - `dryRun: true` or `@DryRun` prints a full plan without any API writes
- [x] **`@Protected`** - marks a resource so it is never modified or destroyed
- [x] **Idempotent Configuration State Tracking** — Store applied playbook and file hashes directly in VM metadata (e.g. Proxmox notes/tags) to support stateless, change-aware Ansible configuration updates on already created servers
- [x] **Hooks** - `beforeDeploy` / `afterDeploy` callbacks on `Stack` for custom side effects (notify Slack, run migrations, etc.)
- [ ] **Multi-region** - run the same stack across N regions in parallel; `@Deploy({ regions: [REGION.EU_CENTRAL_1, REGION.US_EAST_1] })`
- [ ] **Parallel resource deployment** - resources within a stack that have no declared dependency could deploy concurrently instead of sequentially
- [ ] **Secrets at deploy time** - pull credentials from AWS SSM Parameter Store or HashiCorp Vault instead of requiring them as env vars upfront
- [x] **Hybrid Resource Configuration (YAML)** — Support loading bulk static configuration sets (like DNS records, firewall rules, or security group rules) directly from a `.yaml` or `.json` file within builder methods while retaining the flexibility to chain programmatic methods for dynamic resource parameters.
- [x] **Opt-in Infrastructure Blueprint Documentation (`Config.blueprint`)** — Generate version-controlled markdown blueprints (`docs/architecture.md`) of live system resources, auto-calculating monthly costs, formatting live endpoints, and rendering Mermaid.js dynamic dependency/topology graphs on local runs.


