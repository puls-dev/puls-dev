# @puls-dev/gcp

**Google Cloud Platform (GCP) Provider for Puls IaC. Declare VM instances, Cloud Run services, SQL databases, and Pub/Sub topics.**

---

## What is @puls-dev/gcp?

This package is the official Google Cloud provider plug-in for Puls. It manages GCP resources securely with zero local state files by resolving active settings directly through GCP APIs.

## Available Builders

* **`GCP.CloudRun`**: Fully managed containerized service deployments.
* **`GCP.CloudSQL`**: Managed MySQL, PostgreSQL, and SQL Server instances.
* **`GCP.Secret`**: Retrieve and manage secrets inside GCP Secrets Manager at deploy-time.
* **`GCP.PubSub.Topic` / `GCP.PubSub.Subscription`**: Event messaging streams.
* **`GCP.CloudDNS`**: Zone routing and record sets.
* **`GCP.VM`**: Compute Engine instances.
* **`GCP.ServiceAccount` / `GCP.IAMBinding`**: IAM configuration.

## Installation

```bash
npm install @puls-dev/core @puls-dev/gcp
```

## Quick Example

```typescript
import { Stack, Deploy } from "@puls-dev/core";
import { GCP } from "@puls-dev/gcp";

@Deploy()
class CloudStack extends Stack {
  service = GCP.CloudRun("api-server")
    .image("gcr.io/my-project/api:latest")
    .memory("1Gi");
}
```

## Authentication

Provide the path to your service account credential JSON file in your `.env` file:
```bash
GCP_SA=./gcp/service-account.json
```

Learn more at **[pulsdev.io/providers/gcp](https://pulsdev.io/providers/gcp)**.
