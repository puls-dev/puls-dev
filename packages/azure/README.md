# @puls-dev/azure

**Azure Provider for Puls IaC. Declare Azure resource groups, VMs, storage, and functions in strongly-typed TypeScript.**

---

## What is @puls-dev/azure?

This package is the official Microsoft Azure provider plug-in for Puls. It manages Azure resources securely by resolving live states directly through the Azure REST APIs.

## Available Builders

* **`Azure.ResourceGroup`**: Logical containers for Azure resources.
* **`Azure.BlobStorage`**: Object storage for unstructured data.
* **`Azure.AppService`**: Managed web hosting.
* **`Azure.VM`**: Virtual machines.
* **`Azure.SQL`**: SQL Database instances.
* **`Azure.VirtualNetwork`**: Private cloud network routing.
* **`Azure.DNS`**: Domain routing zones.
* **`Azure.Function`**: Serverless function app resources.

## Installation

```bash
npm install @puls-dev/core @puls-dev/azure
```

## Quick Example

```typescript
import { Stack, Deploy } from "@puls-dev/core";
import { Azure } from "@puls-dev/azure";

@Deploy()
class RGStack extends Stack {
  group = Azure.ResourceGroup("my-group");
  
  storage = Azure.BlobStorage("my-backups")
    .resourceGroup(this.group);
}
```

## Authentication

Declare service principal credentials in your `.env` file:
```bash
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-secret
AZURE_TENANT_ID=your-tenant-id
AZURE_SUBSCRIPTION_ID=your-subscription-id
```

Learn more at **[pulsdev.io/providers/azure](https://pulsdev.io/providers/azure.md)**.
