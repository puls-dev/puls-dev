# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-07-03

### Providers

**AWS** - S3, EC2, RDS, CloudFront, Route53, Lambda, ACM, CloudWatch, IAM, SQS, SNS, Fargate, API Gateway, Secrets Manager, SSM, EC2 Templates

**DigitalOcean** - Droplets, Firewalls, LoadBalancers, Domains, Databases, App Platform, Spaces, VPC, Certificates

**Google Cloud Platform** - Cloud Run, Cloud SQL, Compute VM, Cloud DNS, Pub/Sub, Secret Manager, IAM, BigQuery, GCP Templates

**Firebase** - Hosting, Cloud Functions v2, Firestore, Auth, Storage, RemoteConfig, App Check

**Hetzner Cloud** - Servers, Networks, Firewalls, Load Balancers, Volumes

**Cloudflare** - Zones, DNS, Workers, KV, R2, Pages

**Proxmox** - VMs, Templates (cluster-aware node selection, Golden Image provisioning)

**Microsoft Azure** - App Service, Virtual Machines, SQL Database, Blob Storage, Resource Groups

### Framework Features

- **Stack outputs** - `Output<T>` for cross-stack wiring with eager resolution
- **Parallel deployment** - concurrent resource deployment with dependency resolution
- **Dry run** - full plan preview without API writes (`dryRun: true` or `@DryRun`)
- **`@Protected`** - prevents accidental modification or destruction of critical resources
- **Drift detection** - `puls diff` compares declared intent against live cloud state
- **`@Check` inventory** - read-only discovery across all configured providers
- **Secrets at deploy time** - pull credentials from AWS SSM, GCP Secret Manager, Azure Key Vault
- **Hybrid YAML configuration** - load DNS records, firewall rules, security groups from YAML/JSON files
- **Infrastructure blueprints** - auto-generated `docs/architecture.md` with cost estimates and Mermaid topology graphs
- **Multi-region** - run the same stack across N regions in parallel
- **Multi-account contexts** - dynamic or context-bound provider credentials per stack
- **Eager cost estimation** - cost shift projections in `puls diff`/`puls plan`
- **Policy-as-Code** - pre-deploy compliance guards in pure TypeScript
- **Golden Image templates** - pre-baked templates for EC2, GCP, and Proxmox (Packer-like behavior)
- **Generic retry & backoff** - `withRetry` utility for transient cloud API failures
- **Idempotent provisioning** - playbook and file hash tracking in VM metadata

### Importer (`puls import`)

- Visual web UI for discovering and adopting existing cloud resources
- Grouped by service type with collapsible sections and bulk selection
- Dependency expansion - auto-includes connected resources (CloudFront → Route53/S3, Firewall → Droplet)
- Route53 records exported as clean YAML files (`zonename-records.yaml`)
- Generates tiered TypeScript stacks (NetworkStack, DatabaseStack, ComputeStack)
- Supports AWS, DigitalOcean, HCloud, GCP, Firebase, Proxmox

### Package Structure

- Scoped monorepo: `@puls-dev/core`, `@puls-dev/aws`, `@puls-dev/do`, `@puls-dev/gcp`, `@puls-dev/firebase`, `@puls-dev/hcloud`, `@puls-dev/cloudflare`, `@puls-dev/proxmox`, `@puls-dev/azure`
- Provider packages declare `@puls-dev/core` as a peer dependency
- `"exports"` field on all packages for proper ESM encapsulation
- MIT licensed
