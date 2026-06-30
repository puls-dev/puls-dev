# @puls-dev/hcloud

**Hetzner Cloud (HCloud) Provider for Puls IaC. Declare servers, networks, firewalls, and SSH keys in strongly-typed TypeScript.**

---

## What is @puls-dev/hcloud?

This package is the official Hetzner Cloud provider plug-in for Puls. It manages HCloud resources securely by resolving live states directly through the Hetzner Cloud REST APIs.

## Available Builders

* **`HCloud.Server`**: Provision cloud servers (analogous to Droplets) with support for SSH keys, server types, locations, and our signature Ansible playbook provisioning.
* **`HCloud.SSHKey`**: Register SSH public keys on your Hetzner Cloud account.
* **`HCloud.Network`**: Create private networks (VPCs) with custom IP ranges.
* **`HCloud.Firewall`**: Define inbound/outbound firewall rules.

## Installation

```bash
npm install @puls-dev/core @puls-dev/hcloud
```

## Quick Example

```typescript
import { Stack, Deploy } from "@puls-dev/core";
import { HCloud, SERVER_TYPE, LOCATION, OS_IMAGE } from "@puls-dev/hcloud";

@Deploy()
class MyStack extends Stack {
  key = HCloud.SSHKey("my-key")
    .publicKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL...");

  net = HCloud.Network("private-net")
    .ipRange("10.0.0.0/16");

  web = HCloud.Server("web-server")
    .serverType(SERVER_TYPE.CX22)
    .image(OS_IMAGE.UBUNTU_24_04)
    .location(LOCATION.NBG1)
    .sshKeys([this.key])
    .networks([this.net])
    .provision(["playbooks/web.yml"]);
}
```

## Authentication

Declare your Hetzner Cloud API token in your \`.env\` file:
```bash
HCLOUD_TOKEN=your-hetzner-cloud-api-token
```

Learn more at **[pulsdev.io/providers/hcloud](https://pulsdev.io/providers/hcloud)**.
