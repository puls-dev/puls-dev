# Hetzner Cloud (HCloud) Provider

## Setup

Set your Hetzner Cloud API token in your `.env` file:
```bash
HCLOUD_TOKEN=your_hetzner_cloud_token
# HCLOUD_SSH_USER=ubuntu
```

Pass via decorator or call `HCloud.init()` before declaring resources:

```typescript
import { Stack, Deploy } from "@puls-dev/core";
import { HCloud } from "@puls-dev/hcloud";

@Deploy({ token: process.env.HCLOUD_TOKEN! })
class MyStack extends Stack { ... }
```

---

## Server

Declare and manage Hetzner Cloud servers:

```typescript
HCloud.Server("prod-web")
  .serverType(SERVER_TYPE.CX22)  // cx22 (Intel)
  .location(LOCATION.NBG1)       // Nuremberg
  .image(OS_IMAGE.UBUNTU_24_04)  // ubuntu-24.04
```

### Configuration & Playbook Provisioning (Ansible)

Hetzner Cloud servers support first-class, stateless, change-aware provisioning of Ansible playbooks directly on the VM via `.provision()`:

* **Fluent API Methods**:
  - `.provision(playbookPath)`: Declares one or more playbooks to run on the server.
  - `.forceConfigCheck()`: Bypasses the cache checks and forces execution of all declared playbooks.
* **Stateless Idempotency Tracking**: 
  - Since Hetzner Cloud servers do not have local notes, Puls encodes applied playbook hashes into Hetzner Cloud Server **Labels** dynamically formatted as: `puls-h-<playbook-slug>: <hash>`.
  - When you deploy your stack, Puls fetches the server's active labels, extracts the previously applied hashes, compares them against your local files, and executes **only** changed playbooks!
  - Once completed, Puls automatically updates the server's labels via the API.

```typescript
HCloud.Server("prod-web")
  .serverType(SERVER_TYPE.CX22)
  .location(LOCATION.NBG1)
  .sshKey("~/.ssh/id_ed25519") // SSH key used for Ansible/SSH authentication
  .sshUser("ubuntu")           // optional: SSH user (default: "root", or HCLOUD_SSH_USER env var)
  .provision("config/common.yaml", "config/nginx.yaml")
  .forceConfigCheck()          // (Optional) Forces re-running playbooks
```

**Constants**

```typescript
import { HCloud, OS_IMAGE, LOCATION, SERVER_TYPE } from "@puls-dev/hcloud";

OS_IMAGE.UBUNTU_24_04   // "ubuntu-24.04"
OS_IMAGE.UBUNTU_22_04   // "ubuntu-22.04"
OS_IMAGE.DEBIAN_12      // "debian-12"

LOCATION.NBG1          // "nbg1" (Nuremberg, Germany)
LOCATION.FSN1          // "fsn1" (Falkenstein, Germany)
LOCATION.HEL1          // "hel1" (Helsinki, Finland)
LOCATION.ASH           // "ash" (Ashburn, Virginia, USA)
LOCATION.HIL           // "hil" (Hillsboro, Oregon, USA)

SERVER_TYPE.CX22       // "cx22"   (2 vCPU, 4 GB RAM, Intel)
SERVER_TYPE.CPX11      // "cpx11"  (2 vCPU, 2 GB RAM, AMD)
SERVER_TYPE.CPX31      // "cpx31"  (4 vCPU, 8 GB RAM, AMD)
SERVER_TYPE.CAX11      // "cax11"  (2 vCPU, 4 GB RAM, ARM)
```

---

## SSHKey

Register and manage SSH public keys on your Hetzner Cloud account:

```typescript
const key = HCloud.SSHKey("my-key")
  .publicKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL...");
```

---

## Network (VPC)

Create and manage isolated private networks:

```typescript
const net = HCloud.Network("private-net")
  .ipRange("10.0.0.0/16");
```

---

## Firewall

Provision and manage custom Hetzner Cloud Firewalls with advanced ingress and egress security rules, and bind them to servers.

```typescript
HCloud.Firewall("app-firewall")
  .rules("config/firewall-rules.yaml")   // Bulk load rules from a local file
  .ingress("tcp", 22, ["192.168.1.100"])  // Programmatic ingress overrides
  .attachTo("prod-web")                  // Bind directly to a server by name
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

| Method | Type | Description |
|--------|------|-------------|
| `.rules(filePath)` | `string` | Bulk loads both `ingress` and `egress` security rules from a local `.yaml`, `.yml`, or `.json` file. |
| `.ingress(protocol, port, sources)` | `string, string \| number, string[]` | Declares an inbound traffic rule (e.g. `tcp`, `80`, `["0.0.0.0/0", "::/0"]`). |
| `.egress(protocol, port, destinations)` | `string, string \| number, string[]` | Declares an outbound traffic rule (e.g. `tcp`, `"all"`, `["0.0.0.0/0"]`). |
| `.attachTo(serverName)` | `string` | Binds this firewall to the specified Server name. |

## Volume

Create and manage SSD block storage volumes:

```typescript
const volume = HCloud.Volume("db-data")
  .size(50)                    // 50 GB
  .location(LOCATION.NBG1)     // Nuremberg
  .format("ext4")              // ext4 or xfs
  .automount(true)
  .server(this.web);           // Attach dynamically to a Server
```

---

## LoadBalancer

Provision and manage custom Hetzner Cloud Load Balancers:

```typescript
const lb = HCloud.LoadBalancer("web-lb")
  .type("lb11")                // lb11, lb21, lb31
  .location(LOCATION.NBG1)
  .algorithm("round_robin")
  .forward(80, 80, "http")     // listenPort, targetPort, protocol
  .target(this.web);           // Add target servers
```

---

## Full Example

```typescript
import { Stack, Deploy, Protected } from "@puls-dev/core";
import { HCloud, SERVER_TYPE, LOCATION, OS_IMAGE } from "@puls-dev/hcloud";

@Deploy({ token: process.env.HCLOUD_TOKEN! })
class Production extends Stack {
  key = HCloud.SSHKey("my-key")
    .publicKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL...");

  net = HCloud.Network("private-net")
    .ipRange("10.0.0.0/16");

  web = HCloud.Server("prod-web")
    .serverType(SERVER_TYPE.CX22)
    .location(LOCATION.NBG1)
    .image(OS_IMAGE.UBUNTU_24_04)
    .sshKeys([this.key])
    .networks([this.net]);

  // Attach a persistent 50 GB block storage volume to our server
  dataVolume = HCloud.Volume("prod-data")
    .size(50)
    .format("ext4")
    .automount(true)
    .server(this.web);

  // Set up a firewall protecting our web server
  fw = HCloud.Firewall("web-firewall")
    .ingress("tcp", 80, ["0.0.0.0/0"])
    .ingress("tcp", 443, ["0.0.0.0/0"])
    .attachTo("prod-web");

  // Route traffic through a Hetzner Load Balancer
  lb = HCloud.LoadBalancer("prod-lb")
    .type("lb11")
    .location(LOCATION.NBG1)
    .forward(80, 80, "http")
    .target(this.web);
}
```
