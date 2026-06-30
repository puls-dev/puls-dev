# @puls-dev/do

**DigitalOcean Provider for Puls IaC. Spin up Droplets, firewalls, and apps programmatically in TypeScript without state files.**

---

## What is @puls-dev/do?

This package is the official DigitalOcean provider plug-in for Puls. It queries the DigitalOcean API directly to perform eager resource discovery, drift-detection, and updates.

## Available Builders

* **`DO.Droplet`**: Managed virtual machines (supports SSH keys, region selection, and size specs).
* **`DO.Database`**: Managed PostgreSQL, MySQL, Redis, or MongoDB clusters.
* **`DO.App`**: DigitalOcean App Platform deployments for web apps and backend services.
* **`DO.LoadBalancer`**: Managed traffic distribution.
* **`DO.Firewall`**: Inbound and outbound network rule definitions.
* **`DO.VPC`**: Isolated private networks.
* **`DO.Domain`**: Custom domain names and DNS records.

## Installation

```bash
npm install @puls-dev/core @puls-dev/do
```

## Quick Example

```typescript
import { Stack, Deploy } from "@puls-dev/core";
import { DO, REGION, SIZE } from "@puls-dev/do";

@Deploy()
class WebStack extends Stack {
  vpc = DO.VPC("web-network").ipRange("10.10.10.0/24");
  
  web = DO.Droplet("app-server")
    .size(SIZE.S_1VCPU_1GB)
    .region(REGION.NYC3)
    .vpc(this.vpc);
}
```

## Authentication

Declare your API token in your `.env` file:
```bash
DO_TOKEN=your-digitalocean-api-token
```

Learn more at **[pulsdev.io/providers/digitalocean](https://pulsdev.io/providers/digitalocean)**.
