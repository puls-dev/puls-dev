# Google Cloud Platform (GCP) Provider

## Setup

Authentication uses a **Google Cloud Service Account JSON key file**.

1. Go to the **Google Cloud Console → IAM & Admin → Service Accounts**.
2. Click **Create Service Account**, assign it the relevant roles, and click Done.
3. Click on the created service account, go to the **Keys** tab, click **Add Key → Create new key** (JSON format).
4. Save the downloaded JSON file securely.

### Authentication Config

Puls dynamically resolves the GCP configuration through several fallbacks to make local and CI usage painless:

1. **Explicit GCP configuration**:
   ```typescript
   Config.set({
     providers: {
       gcp: {
         projectId: "my-gcp-project",
         serviceAccountPath: "/path/to/sa.json",
         region: "us-central1",  // Optional, defaults to "us-central1"
         sshUser: "ubuntu",       // Optional, default SSH user for VM/Template provisioning
       }
     }
   });
   ```
2. **Firebase reuse fallback**: If you are already using the Firebase provider, GCP automatically reuses `Config.providers.firebase` configuration.
3. **Environment variables**: If config objects are omitted, Puls checks the `GCP_SA` or `FIREBASE_SA` environment variables pointing to a JSON key file. Set `GCP_SSH_USER` to configure the default SSH user for VM and Template provisioning.

---

## Cloud Run

Deploy containerized microservices to Google Cloud Run v2 with support for custom CPU, memory limits, autoscaling, custom regions, environment variables, and public IAM invoker policies.

```typescript
GCP.CloudRun("my-web-service")
  .image("gcr.io/my-project/my-image:latest")
  .port(8080)
  .cpu("1")
  .memory("512Mi")
  .minInstances(0)
  .maxInstances(10)
  .env({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://...",
  })
  .region("us-central1")
  .public(true)
```

### Cloud Run API Reference

| Method | Type | Description | Default |
|--------|------|-------------|---------|
| `.image(img)` | `string` | **Required.** The container image URL (e.g. Artifact Registry or GCR). | - |
| `.port(p)` | `number` | The container port to expose. | `8080` |
| `.cpu(c)` | `string \| number` | CPU limits (e.g., `"1"`, `2`, `"1000m"`). Numbers are stringified. | `"1"` |
| `.memory(m)` | `string \| number` | Memory limits (e.g., `"512Mi"`, `1024`, `"2Gi"`). Numbers are treated as Mi. | `"512Mi"` |
| `.minInstances(n)` | `number` | Minimum instance scaling. | `0` |
| `.maxInstances(n)` | `number` | Maximum instance scaling. | `100` |
| `.env(vars)` | `Record<string, string \| GCPSecretBuilder>` | Key-value pairs of environment variables to inject. Values can be either raw strings or `GCP.Secret` builders. | `{}` |
| `.region(name)` | `string` | Custom GCP region. | `"us-central1"` |
| `.public(enabled)` | `boolean` | Toggles whether the service is publicly accessible via the internet. | `true` |

---

## Cloud SQL

Provision and manage PostgreSQL and MySQL relational database instances on Google Cloud SQL, with support for automatic engine mappings, custom sizing, custom database initialization, secure networking, and credentials management.

```typescript
GCP.CloudSQL("my-database")
  .engine({ engine: "postgres", version: "16" })
  .size("db-f1-micro")
  .storage(20)
  .credentials("db_user", "secure_password")
  .database("my_app_db")
  .publicAccess(false)
```

### Cloud SQL API Reference

| Method | Type | Description | Default |
|--------|------|-------------|---------|
| `.engine(e)` | `{ engine: "postgres" \| "mysql", version: string }` | Database engine and version. Version is mapped automatically (e.g. `postgres`, `16` -> `POSTGRES_16`). | `postgres`, `16` |
| `.size(tier)` | `string` | Machine tier (e.g. `"db-f1-micro"`, `"db-g1-small"`, `"db-custom-2-7680"`). | `"db-f1-micro"` |
| `.storage(gb)` | `number` | Storage size in GB. Disk size can only be increased, not decreased. | `10` |
| `.credentials(user, pwd)` | `string, string` | **Required.** The master username and password. If a custom user is specified (not `postgres` or `root`), it is automatically created post-deploy. | - |
| `.database(name)` | `string` | Custom database name to be created inside the instance post-deploy. | - |
| `.publicAccess(enabled)` | `boolean` | Toggles whether `0.0.0.0/0` is authorized to access the public IP of the database. | `false` |
| `.region(name)` | `string` | Custom GCP region. | `"us-central1"` |

### Outputs

* `endpoint` (`PRIMARY` IP address, once available).
* `port` (mapped according to the selected engine, e.g., `5432` for Postgres, `3306` for MySQL).
* `connectionName` (the connection string `project:region:instance` required to connect via Cloud SQL Auth Proxy).

---

## Secret Manager

Manage sensitive settings and keys on Google Cloud Secret Manager. Values are automatically base64-encoded on upload and safely decoded upon retrieval. You can wire `GCP.Secret` instances directly to `GCP.CloudRun` environment variables for seamless, secure value injection.

```typescript
GCP.Secret("database-password")
  .plainText("supersecretpwd123")
```

### Secret Manager API Reference

| Method | Type | Description | Default |
|--------|------|-------------|---------|
| `.plainText(value)` | `string` | Sets the raw plaintext value of the secret. Automatically pushes a new version when deployed if it differs from the active value. | - |
| `.keyValue(obj)` | `object` | Serializes an object to JSON string format before storing it. | - |

---

## Pub/Sub (Topics & Subscriptions)

Create and manage asynchronous event-driven queues on GCP Pub/Sub. Puls separates decoupled messaging into two first-class builders: `GCP.PubSub.Topic` (analogous to AWS SNS) and `GCP.PubSub.Subscription` (analogous to AWS SQS).

```typescript
// 1. Topic definition
const myTopic = GCP.PubSub.Topic("user-events");

// 2. Pull-based Subscription
GCP.PubSub.Subscription("user-events-pull")
  .topic(myTopic)
  .ackDeadline(20);

// 3. Push-based Subscription
GCP.PubSub.Subscription("user-events-push")
  .topic(myTopic)
  .pushEndpoint("https://my-api-service.run.app/events")
  .ackDeadline(10);
```

### Topic API Reference

No additional configurations are required to deploy a basic Pub/Sub topic container.

* `resolvedTopicName` (resolves to the full Google Cloud topic resource path `projects/{project}/topics/{topicId}`).

### Subscription API Reference

| Method | Type | Description | Default |
|--------|------|-------------|---------|
| `.topic(t)` | `string \| GCPPubSubTopicBuilder` | **Required.** The topic ID or topic builder instance to bind this subscription to. | - |
| `.pushEndpoint(url)` | `string` | Optional. Setting this configures a **Push Subscription** that automatically posts event payloads to the given URL. Omit this to create a default **Pull Subscription**. | - |
| `.ackDeadline(seconds)` | `number` | Acknowledgment deadline in seconds. | `10` |

---

## Cloud DNS

Provision and manage Google Cloud DNS Hosted Zones and record sets with 100% parity to AWS Route53 and DigitalOcean Domain. Features auto-trailing-dot formatting, uppercase alphanumeric zone ID conversions, transactional record updates (deleting the old set and adding the new one in a single request), dynamic cross-resource target resolving, and **hybrid configuration loading** from local files.

```typescript
GCP.CloudDNS("mycompany.com")
  .record("config/records.yaml")       // Bulk load static records from a YAML or JSON file!
  .record("api", "A", "10.0.0.9", 120)  // Programmatic hybrid chaining!
  .pointer("www", apiService)          // Point directly to a Cloud Run or VM instance
```

The configuration file (e.g. `config/records.yaml`) should contain a sequence of records matching this structure:

```yaml
# config/records.yaml
- name: "@"
  type: TXT
  value: "v=spf1 include:_spf.google.com ~all"
- name: mail
  type: A
  value: 1.2.3.4
  ttl: 600
- name: www
  type: CNAME
  value: lb.google.com
```

### Cloud DNS API Reference

| Method | Type | Description | Default |
|--------|------|-------------|---------|
| `.record(filePath)` | `string` | Bulk loads and appends a list of DNS records from a local `.yaml`, `.yml`, or `.json` file. | - |
| `.record(name, type, value, ttl?)` | `string, string, string, number` | Adds a single custom DNS record set to the zone. Target names and values are automatically appended with trailing dots, and `TXT`/`SPF` records are auto-quoted. | - |
| `.pointer(name, target)` | `string, BaseBuilder \| Output<string> \| string` | Resolves a cross-resource target endpoint (e.g. Cloud Run service URL or VM IP) at deploy-time, automatically converting `A` records to `CNAME` and stripping protocol headers for external domain integrations. | - |
---

## Compute Engine VM

Provision and manage VM instances on Google Cloud Compute Engine with seamless OS booting, custom network configuration, public SSH key deployment, and **universal playbook provisioning**.

```typescript
GCP.VM("my-app-server")
  .machineType("e2-medium")
  .zone("us-central1-a")
  .image("projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts")
  .network("global/networks/default")
  .sshKey("~/.ssh/id_ed25519.pub")
  .provision("config/docker.yaml", "config/nginx.yaml")
```

### Compute Engine VM API Reference

| Method | Type | Description | Default |
|--------|------|-------------|---------|
| `.machineType(type)` | `string` | Machine tier to provision (e.g. `"e2-micro"`, `"e2-medium"`, `"n2-standard-2"`). | `"e2-micro"` |
| `.image(img)` | `string` | Boot image URI or family name. | `"projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts"` |
| `.zone(z)` | `string` | GCP availability zone where the VM instance resides. | `"us-central1-a"` |
| `.network(netPath)` | `string` | Virtual Private Cloud network resource path. | `"global/networks/default"` |
| `.sshKey(keys)` | `string \| string[]` | Public SSH key strings, or local paths to public keys (e.g. `"~/.ssh/id_rsa.pub"`) to inject into the VM for SSH access. | `[]` |
| `.sshUser(user)` | `string` | SSH username used for provisioning. Falls back to `GCP_SSH_USER` env var → `config.gcp.sshUser` → `"root"`. | `"root"` |
| `.provision(...playbooks)` | `string[]` | Ordered list of playbook configuration YAML files to execute on the VM post-boot. | `[]` |
| `.forceConfigCheck()` | `void` | Forces Puls to ignore previously cached playbook hashes and re-run all provision playbooks. | - |

### Outputs

* `ip` (`Output<string>`): The resolved public/external IPv4 address assigned to the VM.
* `id` (`Output<string>`): The unique GCP Compute Engine instance identifier.

### How Provisioning Works

1. **Stateless Configuration Caching**: Puls keeps track of applied playbooks by storing their hashes under the instance's custom metadata key `puls-provision`. This keeps configuration caching stateless and cloud-native, avoiding any separate database.
2. **Idempotency**: During deployment, Puls checks if the hashes of your local playbooks match the hashes in the VM metadata. If they match, playbook execution is safely skipped.
3. **Dynamic Stops and Resizes**: If the `machineType` configuration is modified, Puls will automatically stop the VM instance, apply the new sizing configuration (`setSize`), and restart the VM, returning it to a running state.

### Golden Image & VM Templates

Puls supports declaring pre-baked Google Compute custom images, analogous to HashiCorp Packer's workflow. This allows developers to configure a custom golden image (with pre-installed packages, Docker, libraries, or security policies), bake it once, and then spin up actual GCP VMs from it in seconds.

#### `GCP.Template`

Define a custom GCP image template using the `GCP.Template()` helper:

```typescript
const dockerBaseTemplate = GCP.Template("ubuntu-docker-base")
  .baseImage("projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts") // base image
  .machineType("e2-medium")
  .zone("us-central1-a")
  .sshKey("~/.ssh/id_ed25519.pub")
  .sshUser("ubuntu")   // optional: SSH user for provisioning (default: "root")
  .provision("playbooks/docker.yaml", "playbooks/security-hardening.yaml");
```

**Baking Lifecycle**:

1. **Idempotent Baking**: Puls checks if a custom image with this name already exists in your GCP project. If it does and the provision playbooks match (via the applied hashes saved inside the image's description field), image baking is skipped.
2. **Delete & Rebuild**: Because GCP images are read-only and immutable, if playbooks or configurations change, Puls will automatically delete the old custom image (`DELETE /compute/v1/projects/.../global/images/{name}`) before rebuilding.
3. **Automated VM Lifecycle**: Puls creates a temporary instance (`puls-bake-temp-{name}`), waits for SSH, runs the Ansible playbooks, stops the instance, creates a new custom image from the stopped instance's boot disk, writes the playbook hashes into the image's description field, waits until the image status is `READY`, and deletes the temporary provisioning VM instance.

#### VM Cloning from Template (`.fromTemplate()`)

Use the fluent `.fromTemplate()` builder method on `GCP.VM()` to spin up a server directly from a pre-baked custom image:

```typescript
@Deploy({ parallel: true })
class ProductionCluster extends Stack {
  // 1. Declare the template resource
  dockerBase = GCP.Template("ubuntu-docker-base")
    .baseImage("projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts")
    .sshKey("~/.ssh/id_ed25519.pub")
    .provision("playbooks/docker.yaml");

  // 2. Clone GCP VMs from the custom image concurrently in seconds
  server1 = GCP.VM("prod-game-01").fromTemplate(this.dockerBase).machineType("e2-medium");
  server2 = GCP.VM("prod-game-02").fromTemplate(this.dockerBase).machineType("e2-medium");
}
```

* **Dynamic DAG Dependencies**: Calling `.fromTemplate(template)` automatically registers an implicit dependency. The parallel scheduling engine ensures that the custom image is fully baked and available before the GCP VM instances start spawning concurrently.

---

## IAM (Service Accounts & Bindings)

Provision and manage custom Google Cloud Service Accounts (`GCP.ServiceAccount`) and project-level IAM bindings (`GCP.IAMBinding`) to automate secure credentials setup.

### Service Account

Create a new Service Account cleanly.

```typescript
const mySA = GCP.ServiceAccount("backup-agent")
  .displayName("Backup Agent Service Account")
  .description("Used for nightly database backup jobs");
```

#### Service Account API Reference

| Method | Type | Description | Default |
|--------|------|-------------|---------|
| `.displayName(name)` | `string` | Sets the readable display name. | - |
| `.description(desc)` | `string` | Sets the description. | - |

* `email` (dynamically resolves to the fully-qualified service account email address, e.g. `backup-agent@project.iam.gserviceaccount.com`).

---

### IAM Binding

Bind members safely to project-level roles with Optimistic Concurrency Control (ETag lock) and non-destructive merges.

```typescript
GCP.IAMBinding("storage-admin-binding")
  .role("roles/storage.admin")
  .member(mySA) // Wire Service Account builder directly!
  .member("user:bob@gmail.com")
```

#### IAM Binding API Reference

| Method | Type | Description | Default |
|--------|------|-------------|---------|
| `.role(name)` | `string` | **Required.** The project-level IAM role to bind (e.g. `roles/pubsub.publisher`, `roles/storage.admin`). | - |
| `.member(m)` | `string \| GCPServiceAccountBuilder \| Output<string>` | Binds a single member. Strings are automatically prefixed with the correct type (e.g., `serviceAccount:` or `user:`). | - |
| `.members(...m)` | `Array<string \| GCPServiceAccountBuilder \| Output<string>>` | Binds multiple members. | - |

---

## Complete Example

This example demonstrates deploying a secure stack consisting of a Cloud SQL database, a Secret Manager secret containing the database credentials, a Pub/Sub topic + push subscription, a Cloud Run API service, a custom Service Account with publisher rights, and a Cloud DNS zone that points a CNAME to the API service.

```typescript
import "dotenv/config";
import "reflect-metadata";
import { Stack, Deploy, Config } from "puls-dev";
import { GCP } from "puls-dev/gcp";

Config.set({
  providers: {
    gcp: {
      projectId: "prod-stack-101",
      serviceAccountPath: "./gcp-key.json",
      region: "us-east1",
    },
  },
});

@Deploy({ dryRun: false })
class CloudStack extends Stack {
  // 1. Pub/Sub Topic for background tasks
  eventsTopic = GCP.PubSub.Topic("background-tasks");

  // 2. Secret Credentials
  dbPassword = GCP.Secret("app-db-password")
    .plainText("supersecurepassword123");

  // 3. Private Postgres Database
  db = GCP.CloudSQL("app-db")
    .engine({ engine: "postgres", version: "16" })
    .size("db-f1-micro")
    .storage(20)
    .credentials("app_user", this.dbPassword.resolvedValue ?? "fallbackpwd")
    .database("production_db")
    .publicAccess(false);

  // 4. Public API Service
  web = GCP.CloudRun("api-service")
    .image("us-east1-docker.pkg.dev/prod-stack-101/images/api:latest")
    .port(3000)
    .cpu(1)
    .memory(512)
    .env({
      NODE_ENV: "production",
      DATABASE_HOST: this.db.endpoint,
      DATABASE_PORT: this.db.port,
      DATABASE_NAME: "production_db",
      DATABASE_USER: "app_user",
      DATABASE_PASS: this.dbPassword,
      TOPIC_NAME: this.eventsTopic.resolvedTopicName ?? "unknown-topic",
    })
    .public(true);

  // 5. Push Subscription sending Topic events directly back to API handler
  pushSub = GCP.PubSub.Subscription("tasks-push")
    .topic(this.eventsTopic)
    .pushEndpoint("https://api-service-xyz.run.app/tasks/webhook")
    .ackDeadline(15);

  // 6. Custom Service Account for background workers
  workerSA = GCP.ServiceAccount("background-worker")
    .displayName("Background Worker")
    .description("Service account with publisher permissions");

  // 7. IAM Binding giving the Service Account publisher rights
  pubBinding = GCP.IAMBinding("worker-pub-rights")
    .role("roles/pubsub.publisher")
    .member(this.workerSA);

  // 8. Cloud DNS Zone pointing to the API service CNAME
  dns = GCP.CloudDNS("mycompany.com")
    .record("www", "CNAME", "lb.google.com")
    .pointer("api", this.web);
}
```

Deploy your stack with:

```bash
npx tsx examples/deploy.ts
```

---

## Required Permissions

To manage Cloud Run, Cloud SQL, Secret Manager, Pub/Sub, Cloud DNS, and IAM resources, your service account key needs the following IAM roles:

* **Cloud Run Admin** (`roles/run.admin`) - full control over Cloud Run services.
* **Service Account User** (`roles/iam.serviceAccountUser`) - to associate runtime service accounts.
* **Cloud SQL Admin** (`roles/cloudsql.admin`) - full control over Cloud SQL database instances.
* **Secret Manager Admin** (`roles/secretmanager.admin`) - full control over Secret Manager containers and values.
* **Pub/Sub Admin** (`roles/pubsub.admin`) - full control over Pub/Sub topics and subscriptions.
* **DNS Administrator** (`roles/dns.admin`) - full control over Google Cloud DNS zones and records.
* **Create/Delete Service Accounts** (`roles/iam.serviceAccountAdmin`) - to create, modify, and delete custom service accounts.
* **Project IAM Admin** (`roles/resourcemanager.projectIamAdmin`) - to set and modify project-level IAM policies.
