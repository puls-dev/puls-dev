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
- [ ] CloudFront cache invalidation — `.invalidate(paths[])` on a CloudFront builder
- [ ] Route53 A-record upsert — currently only CNAMEs are supported via `upsertCnames()`
- [ ] S3 static site hosting config

### DigitalOcean
- [ ] VPC support

---

## New Providers

### AWS Compute
- [ ] **EC2** — instance, security group, key pair; the most-requested AWS resource
- [ ] **ECS / Fargate** — container task definitions, services, clusters
- [ ] **RDS** — managed database instances (Postgres, MySQL)
- [ ] **Lambda** — deploy a function from a local zip or directory

### Other
- [ ] **Hetzner Cloud** — popular self-hosting alternative to DigitalOcean, similar API shape

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

- [ ] **Stack outputs** — pass values between stacks (e.g. VM IP from one stack feeds a DNS record in another)
- [ ] **Secrets integration** — pull credentials from Vault or AWS SSM at deploy time instead of env vars
- [ ] **Hooks** — `beforeDeploy` / `afterDeploy` callbacks on Stack for custom side effects
- [ ] **Multi-region** — run the same stack across N regions in parallel
