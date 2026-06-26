# Microsoft Azure Provider

The Microsoft Azure provider (`puls-dev/azure`) allows you to declaratively provision Resource Groups, Blob Storage, App Services (Web Apps), logical SQL Databases, standalone Virtual Networks (VNet/Subnet/NSG), DNS zones & record sets, serverless Consumption Function Apps, and direct Azure Key Vault integration.

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

## SQL Database

Declaratively configure a logical SQL Server and database.

```typescript
const db = Azure.SQL("my-sql-server")
  .resourceGroup(group)
  .database("my-db") // default: defaultdb
  .sku("Basic") // default: Basic (low-cost tier)
  .credentials("dbadmin", Secret.env("DB_PASSWORD")); // username and Secret password
```

---

## Virtual Network

Create standalone Virtual Networks (VNet) with associated Subnets and Network Security Groups (NSG) configured with standard inbound rules (e.g. allowing port 22 for SSH).

```typescript
const network = Azure.VirtualNetwork("my-vnet")
  .resourceGroup(group)
  .addressSpace(["10.0.0.0/16"])
  .subnet("web-subnet", "10.0.0.0/24");
```

### VM Custom Network Binding
You can assign VMs directly to a standalone Virtual Network rather than letting Puls auto-create network sidecars:

```typescript
const server = Azure.VM("app-server")
  .resourceGroup(group)
  .network(network) // binds VM directly to 'web-subnet' of 'my-vnet'
  .sshKey("~/.ssh/id_rsa.pub");
```

---

## DNS Zones

Manage DNS zones and record sets (`A`, `AAAA`, `CNAME`, `MX`, `TXT`) with relative domain name resolution.

```typescript
const dns = Azure.DNS("mycompany.com")
  .resourceGroup(group)
  .pointer("www", "1.2.3.4") // A record
  .cname("blog", "gh-pages.github.com") // CNAME
  .txt("verify", "token123");
```

---

## Function Apps

Deploy serverless Consumption Plan Function Apps.

```typescript
const func = Azure.Function("my-func-app")
  .resourceGroup(group)
  .storage(storage) // binds required storage account
  .runtime("node") // default worker runtime
  .env("API_KEY", "secret-value");
```

---

## Key Vault Secrets

Retrieve secrets securely from Azure Key Vault at deploy time without storing them in code or version control:

```typescript
const password = Secret.azure("db-password", "my-vault-name");
```

---

## Full Example

```typescript
import "dotenv/config";
import { Stack, Deploy, Secret } from "@puls-dev/core";
import { Azure } from "@puls-dev/azure";

@Deploy({ dryRun: false })
class AzureInfrastructure extends Stack {
  // 1. Resource Group
  group = Azure.ResourceGroup("my-enterprise-rg")
    .location("westeurope");

  // 2. Standalone Network
  network = Azure.VirtualNetwork("prod-vnet")
    .resourceGroup(this.group)
    .subnet("default", "10.0.0.0/24");

  // 3. Storage Account
  storage = Azure.BlobStorage("pulsassets")
    .resourceGroup(this.group)
    .containerName("media");

  // 4. SQL Server with Key Vault password
  dbPass = Secret.azure("sql-password", "my-kv-vault");
  db = Azure.SQL("enterprise-db-server")
    .resourceGroup(this.group)
    .database("prod-db")
    .credentials("dbadmin", this.dbPass);

  // 5. Function App
  api = Azure.Function("enterprise-api")
    .resourceGroup(this.group)
    .storage(this.storage)
    .runtime("node");

  // 6. Compute VM linked to Custom Network
  server = Azure.VM("db-replica")
    .resourceGroup(this.group)
    .network(this.network)
    .size("Standard_B2s")
    .sshKey("~/.ssh/azure.pub");
}
```

---

## Teardown (destroy)

Running a stack teardown (`npx puls destroy`) for Azure:

1. Deletes the Virtual Machines and cleans up their network interfaces, public IPs, and custom VNets.
2. Deletes the logical SQL servers and databases.
3. Deletes the Function Apps and App Service Plans.
4. Deletes the Storage Accounts and containers.
5. Deletes DNS Zones.
6. Deletes the parent Resource Groups.
