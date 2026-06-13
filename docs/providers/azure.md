# Microsoft Azure Provider

The Microsoft Azure provider (`puls-dev/azure`) allows you to declaratively provision Resource Groups, Blob Storage, App Services (Web Apps), and Virtual Machines with private networks and universal playbook provisioning.

## Setup

Authentication uses an **Azure Active Directory Service Principal** with access to your subscription.

### Environment Configuration
Configure the credentials in your environment (e.g. your `.env` file):

```bash
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-client-secret
AZURE_TENANT_ID=your-tenant-id
AZURE_SUBSCRIPTION_ID=your-subscription-id
AZURE_LOCATION=eastus # default region
AZURE_SSH_USER=azureuser # default SSH user
```

### Decorator Setup
Alternatively, configure them programmatically within the `@Deploy` decorator:

```typescript
@Deploy({
  azure: {
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    tenantId: process.env.AZURE_TENANT_ID!,
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    defaultLocation: "eastus",
  }
})
class AppStack extends Stack {}
```

---

## Resource Group

Logical lifecycle boundary container for Azure resource grouping. All other Azure resources require a Resource Group.

```typescript
const group = Azure.ResourceGroup("my-app-rg")
  .location("westus2");
```

---

## Blob Storage

Provision an Azure Storage Account and a Blob Container under it.

```typescript
const storage = Azure.BlobStorage("mystorageacct")
  .resourceGroup(group)
  .sku("Standard_GRS") // default Standard_LRS
  .containerName("uploads"); // default "default"
```

> [!NOTE]
> Azure Storage Account names must be globally unique, lowercase, alphanumeric, and between 3-24 characters.

---

## App Service (Web Apps)

Deploy a Linux App Service Web App and its parent App Service Plan.

```typescript
Azure.AppService("my-web-app")
  .resourceGroup(group)
  .sku("B1") // App Service Plan Sku (e.g. F1, B1, P1v2)
  .runtime("NODE|18-lts") // Linux FX version runtime
  .planName("my-app-service-plan"); // default plan-my-web-app
```

---

## Virtual Machines

Provision Virtual Machines with automatic networking sidecar creation (Virtual Network, Subnet, Public IP, and Network Interface Card) and Ansible playbook provisioning.

```typescript
Azure.VM("my-prod-server")
  .resourceGroup(group)
  .size("Standard_B2s") // default Standard_B1s
  .image("Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest")
  .sshKey("~/.ssh/id_rsa.pub") // path to public SSH key file or contents
  .sshUser("azureuser") // default: azureuser
  .provision("playbooks/nginx.yaml")
  .forceConfigCheck(); // force Ansible run
```

### Stateless Change-Aware Provisioning
Applied playbook hashes are stored directly in the Virtual Machine's **Resource Tags** (using tag `puls-provision`). On every deployment, Puls checks VM tags to determine which playbooks have changed and executes only the new or modified playbooks over SSH, maintaining a 100% stateless configuration footprint.

---

## Full Example

```typescript
import "dotenv/config";
import { Stack, Deploy } from "puls-dev";
import { Azure } from "puls-dev/azure";

@Deploy({ dryRun: false })
class AzureInfrastructure extends Stack {
  // 1. Resource Group
  group = Azure.ResourceGroup("my-enterprise-rg")
    .location("westeurope");

  // 2. Storage
  storage = Azure.BlobStorage("pulsassets")
    .resourceGroup(this.group)
    .containerName("media");

  // 3. Web Service
  api = Azure.AppService("enterprise-api")
    .resourceGroup(this.group)
    .sku("B1")
    .runtime("NODE|20-lts");

  // 4. Compute VM
  server = Azure.VM("db-replica")
    .resourceGroup(this.group)
    .size("Standard_B2s")
    .sshKey("~/.ssh/azure.pub")
    .provision("playbooks/db-replica.yaml");
}
```

---

## Teardown (destroy)

Running a stack teardown (`npx puls destroy`) for Azure:

1. Deletes the Virtual Machines and cleans up their network interface cards (NICs), public IP resources, and Virtual Networks (VNets).
2. Deletes the App Service Web Apps and App Service Plans.
3. Deletes the Storage Accounts and containers.
4. Deletes the parent Resource Groups.
