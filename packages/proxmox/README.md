# @puls-dev/proxmox

**Proxmox VE Provider for Puls IaC. Provision VMs and templates on Proxmox clusters with automatic node selection and Ansible integration.**

---

## What is @puls-dev/proxmox?

This package is the official Proxmox VE provider plug-in for Puls. It queries the Proxmox cluster APIs directly to support:
* **Cluster-Aware Node Selection**: Pick the best node automatically based on available RAM.
* **Ansible Provisioning**: Bake VM templates, run custom playbooks, and maintain change-aware hash metadata in VM notes (eliminating repeated playbook executions).

## Available Builders

* **`Proxmox.VM`**: Clone, configure, and boot virtual machines.
* **`Proxmox.Template`**: Provision, bake, and convert VMs to templates.

## Installation

```bash
npm install @puls-dev/core @puls-dev/proxmox
```

## Quick Example

```typescript
import { Stack, Deploy } from "@puls-dev/core";
import { Proxmox } from "@puls-dev/proxmox";

@Deploy()
class VMStack extends Stack {
  server = Proxmox.VM("nginx-server")
    .cores(2).memory(2048)
    .provision(["playbooks/nginx.yaml"]);
}
```

## Authentication

Specify Proxmox cluster settings in your `.env` file:
```bash
PROXMOX_URL=https://pve.example.com:8006
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=puls
PROXMOX_TOKEN_SECRET=your-api-secret
```

Learn more at **[pulsdev.io/providers/proxmox](https://pulsdev.io/providers/proxmox)**.
