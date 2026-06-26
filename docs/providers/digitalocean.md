# DigitalOcean Provider

## Setup

```
DO_TOKEN=your_digitalocean_token
# DO_SSH_USER=ubuntu
```

Pass via decorator or call `DO.init()` before declaring resources:

```typescript
@Deploy({ token: process.env.DO_TOKEN! })
class MyStack extends Stack { ... }
```

## Droplet

```typescript
DO.Droplet("prod-web")
  .size(SIZE.MEDIUM)        // s-2vcpu-4gb
  .region(REGION.FRA)       // fra1
  .image(OS.UBUNTU_22_04)   // default if omitted
  .allowPublicWeb()         // creates Firewall sidecar: 80 + 443 open
```

### Configuration & Playbook Provisioning (Ansible)

DigitalOcean Droplets support first-class, stateless, change-aware provisioning of Ansible playbooks and Puppet manifests directly on the VM via `.provision()`:

* **Fluent API Methods**:
  - `.provision(playbookPath)`: Declares one or more playbooks to run on the droplet.
  - `.forceConfigCheck()`: Bypasses the cache checks and forces execution of all declared playbooks.
* **Stateless Idempotency Tracking**: 
  - Since cloud droplets do not have descriptions or local notes, Puls encodes applied playbook hashes into DigitalOcean Droplet **Tags** dynamically formatted as: `puls-h-<playbook-slug>-<hash>`.
  - When you deploy your stack, Puls fetches the droplet's active cloud tags, extracts the previously applied hashes, compares them against your local files, and executes **only** changed playbooks!
  - Once completed, Puls automatically updates the droplet's tags via the API (removing deprecated hashes and attaching new ones).

```typescript
DO.Droplet("prod-web")
  .size(SIZE.MEDIUM)
  .region(REGION.NYC)
  .sshKey("~/.ssh/id_rsa") // SSH key used for Ansible/SSH authentication
  .sshUser("ubuntu")       // optional: SSH user (default: "root", or DO_SSH_USER env var)
  .provision("config/common.yaml", "config/nginx.yaml")
  .forceConfigCheck()      // (Optional) Forces re-running playbooks
```

**Constants**

```typescript
import { DO, OS, REGION, SIZE } from "@puls-dev/do";

OS.UBUNTU_22_04   // "ubuntu-22-04-x64"
OS.DEBIAN_11      // "debian-11-x64"

REGION.FRA        // "fra1"
REGION.NYC        // "nyc3"

SIZE.SMALL        // s-1vcpu-1gb
SIZE.MEDIUM       // s-2vcpu-4gb
SIZE.LARGE        // s-4vcpu-8gb
```

## Domain

Manage hosted domains, DNS records, and SSL certificates on DigitalOcean with transactional updates and **hybrid configuration loading**.

```typescript
DO.Domain("example.com")
  .record("config/records.yaml")      // Bulk load static records from a YAML or JSON file!
  .record("api", "A", "10.0.0.9")     // Programmatic hybrid record!
  .pointer("@", this.web)             // A record pointing at a Droplet (resolves IP automatically)
  .withSSL()                          // creates Let's Encrypt Certificate sidecar
```

The configuration file (e.g. `config/records.yaml`) should contain a list of records matching this format:

```yaml
# config/records.yaml
- name: "@"
  type: TXT
  value: "v=spf1 include:_spf.google.com ~all"
- name: mail
  type: A
  value: 1.2.3.4
- name: www
  type: CNAME
  value: lb.google.com
```

### Domain API Reference

| Method | Type | Description | Default |
|--------|------|-------------|---------|
| `.record(filePath)` | `string` | Bulk loads and appends a list of DNS records from a local `.yaml`, `.yml`, or `.json` file. | - |
| `.record(name, type, value, ...)` | `string, string, string` | Adds a custom DNS record to the zone. Supports `A`, `AAAA`, `CNAME`, `TXT`, `MX`, `SRV`, `CAA`. | - |
| `.pointer(name, target)` | `string, DropletBuilder \| Output<string> \| string` | Points a record name to a Droplet, automatically resolving its public IP address. | - |
| `.withSSL()` | `void` | Requests a free Let's Encrypt SSL certificate sidecar for the domain. | - |

## LoadBalancer

```typescript
DO.LoadBalancer("prod-lb")
  .region(REGION.FRA)
  .target(this.web, this.api)   // forwards to these Droplets
```

## Firewall

Provision and manage custom DigitalOcean Firewalls with advanced ingress and egress security rules, Droplet bindings, and **hybrid configuration loading** from local files.

```typescript
DO.Firewall("app-firewall")
  .rules("config/firewall-rules.yaml")   // Bulk load ingress and egress rules from a local file!
  .ingress("tcp", 22, ["192.168.1.100"])  // Programmatic hybrid overrides!
  .attachTo("prod-web")                  // Bind directly to a Droplet by name
```

The configuration file (e.g. `config/firewall-rules.yaml`) should contain inbound and outbound rules matching this format:

```yaml
# config/firewall-rules.yaml
- type: ingress
  protocol: tcp
  port: 80
  sources:
    - 0.0.0.0/0
    - ::/0
- type: egress
  protocol: tcp
  port: all
  destinations:
    - 0.0.0.0/0
```

### Firewall API Reference

| Method | Type | Description | Default |
|--------|------|-------------|---------|
| `.rules(filePath)` | `string` | Bulk loads both `ingress` and `egress` security rules from a local `.yaml`, `.yml`, or `.json` file. | - |
| `.ingress(protocol, port, sources)` | `string, string \| number, string[]` | Declares an inbound traffic rule (e.g. `tcp`, `80`, `["0.0.0.0/0", "::/0"]`). | - |
| `.egress(protocol, port, destinations)` | `string, string \| number, string[]` | Declares an outbound traffic rule (e.g. `tcp`, `"all"`, `["0.0.0.0/0"]`). | - |
| `.attachTo(dropletName)` | `string` | Binds this firewall to the specified Droplet name. | - |

## Spaces (S3-compatible Object Storage)

DigitalOcean Spaces provides a highly available, S3-compatible object storage service. Manage buckets, custom access control lists (ACL), cross-origin resource sharing (CORS), and file uploads seamlessly.

### Setup Credentials
DO Spaces requires a Spaces Access Key ID and Secret Access Key. Pass them via environment variables or configure them during initialization:
* **Env vars**: Set `SPACES_ACCESS_KEY_ID` and `SPACES_SECRET_ACCESS_KEY`.
* **DO Init**:
```typescript
DO.init({
  token: process.env.DO_TOKEN!,
  spacesAccessKey: "your-access-key",
  spacesSecretKey: "your-secret-key",
});
```

### Usage Example
```typescript
DO.Spaces("my-static-assets")
  .region("nyc3")                       // default "nyc3"
  .acl("public-read")                   // "private" (default) or "public-read"
  .cors([                               // custom CORS policy
    {
      AllowedHeaders: ["*"],
      AllowedMethods: ["GET", "HEAD"],
      AllowedOrigins: ["https://example.com"],
      MaxAgeSeconds: 3600,
    }
  ])
  .upload("dist/logo.png");             // uploads a file to the space on deploy
```

## Managed Databases

DigitalOcean Managed Databases provides fully managed PostgreSQL, MySQL, Redis, MongoDB, Valkey, and Kafka database clusters.

### Features
* **Auto-Resolving Connection Outputs**: Automatically exposes the cluster connection details (`host`, `port`, `uri`, `user`, `password`, `id`) as dynamic stack outputs.
* **Private Network (VPC) Assignment**: Easily bind the database cluster to your private VPC network using `.vpc(uuid)`. If assigned, Puls automatically prefers secure, isolated internal DNS hostname endpoints (`private_connection`) over public ones for all downstream resource wiring!
* **Trusted Sources (Firewall Rules)**: Secure access using database-level firewalls. Register trusted Droplets or IP ranges via `.allowDroplet(id)` and `.allowIp(cidr)`.

### Usage Example
```typescript
DO.Database("prod-postgresql")
  .engine("pg")                         // pg, mysql, redis, mongodb, valkey, kafka
  .version("16")                        // engine major version
  .size("db-s-1vcpu-2gb")               // droplet size slug
  .region(REGION.NYC)
  .nodes(2)                             // high-availability node count
  .vpc("your-vpc-uuid-here")            // private network assignment
  .allowIp("192.168.1.1/32")            // trust specific external IP
  .allowDroplet("12345678");            // trust a specific Droplet ID
```

You can then easily wire your database connection outputs directly into other resources, such as Droplets:
```typescript
appServer = DO.Droplet("app")
  .provision("config/app.yaml")
  // Automatically passes the database URI dynamically once resolved!
  .env({ DATABASE_URL: this.db.out.uri });
```

## App Platform (PaaS)

DigitalOcean App Platform is a fully managed platform as a service (PaaS) that lets developers deploy apps directly from GitHub repositories or container registries.

### Features
* **Auto-Resolving Ingress Outputs**: Automatically exposes the deployed app's ID (`id`) and dynamic public URL (`liveUrl`) as stack outputs once resolved.
* **Declarative App Specs**: Directly accepts standard, native JSON-format App Specifications via `.spec(json)`. This lets you easily copy-paste any existing DigitalOcean App Spec.
* **Rolling Updates**: If you modify the specification, Puls automatically compares changes and dispatches a rolling update dynamically!

### Usage Example
```typescript
DO.App("my-react-app")
  .spec({
    region: "nyc",
    services: [
      {
        name: "web",
        github: {
          repo: "your-username/your-frontend",
          branch: "main",
          deploy_on_push: true,
        },
        instance_size_slug: "apps-s-1vcpu-1gb",
        instance_count: 1,
        http_port: 80,
      }
    ],
    static_sites: [
      {
        name: "landing-page",
        github: {
          repo: "your-username/landing-site",
          branch: "main",
        },
        build_command: "npm run build",
        output_dir: "dist",
      }
    ]
  });
```

You can then wire your App Platform public URL directly into other resources, such as domain records:
```typescript
dns = DO.Domain("example.com")
  .pointer("app", this.app.out.liveUrl);
```

## VPC (Virtual Private Cloud)

DigitalOcean VPC provides private, isolated networks for account resources. Defining custom VPCs enables secure internal communication, custom subnetting, and private service wiring.

### Features
* **Auto-Resolving Network Outputs**: Automatically exposes the VPC's unique UUID (`id`) and allocated CIDR block (`ipRange`) as dynamic stack outputs.
* **Droplet and Database Hookup**: Wire both droplet VMs (`.vpc(uuid)`) and managed database clusters (`.vpc(uuid)`) directly into your custom private networks.
* **Safety Rules**: During teardown/destruction, Puls automatically detects and skips deleting DigitalOcean's default region VPCs, avoiding common API errors.

### Usage Example
```typescript
// Define custom private VPC network
const vpc = DO.VPC("production-private-net")
  .region(REGION.NYC)
  .ipRange("10.240.0.0/16")
  .description("Secure private network for staging/production VMs");

// Provision a Droplet inside the VPC
const web = DO.Droplet("prod-web")
  .region(REGION.NYC)
  .size(SIZE.MEDIUM)
  .vpc(vpc.out.id); // Dynamic wiring

// Provision a Database cluster inside the same VPC
const db = DO.Database("prod-db")
  .region(REGION.NYC)
  .size("db-s-1vcpu-2gb")
  .vpc(vpc.out.id);
```

## Full example

```typescript
import { Stack, Deploy, Protected } from "@puls-dev/core";
import { DO, OS, REGION, SIZE } from "@puls-dev/do";

@Deploy({ token: process.env.DO_TOKEN! })
class Production extends Stack {
  web = DO.Droplet("prod-web")
    .size(SIZE.MEDIUM)
    .region(REGION.FRA)
    .allowPublicWeb();

  @Protected
  db = DO.Droplet("prod-db")
    .size(SIZE.LARGE)
    .region(REGION.FRA);

  dns = DO.Domain("example.com")
    .pointer("@", this.web)
    .withSSL();
}
```
