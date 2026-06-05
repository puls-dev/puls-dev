# Proxmox Provider

## Setup

```
PROXMOX_URL=https://pve.example.com:8006
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=puls
PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
PROXMOX_NODES=pve1,pve2
PROXMOX_DNS_DOMAIN=nolimit.int
PROXMOX_DNS_SERVERS=10.8.10.11,10.8.10.12,10.8.10.13
# PROXMOX_SSH_USER=ubuntu
```

Auth uses PVE API tokens (`USER@REALM!TOKENNAME=SECRET`). Create one in Datacenter → Permissions → API Tokens.

Define environments once in `src/types/proxmox.ts`:

```typescript
export const CONFIG = {
  STAGING: {
    url: process.env.PROXMOX_URL!,
    user: process.env.PROXMOX_USER!,
    tokenName: process.env.PROXMOX_TOKEN_NAME!,
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET!,
    nodes: process.env.PROXMOX_NODES?.split(','),
    dnsDomain: process.env.PROXMOX_DNS_DOMAIN,
    dnsServers: process.env.PROXMOX_DNS_SERVERS?.split(','),
    verifySsl: false,
    sshUser: "ubuntu",   // optional - overrides the default SSH user for provisioning
  },
};
```

Reference everywhere via `@Deploy({ proxmox: CONFIG.STAGING })`.

## VM

```typescript
Proxmox.VM("ix-sto1-app01")
  .image(OS.UBUNTU_24_04)     // template VMID or name substring
  .cores(4)
  .memory(8192)               // MB
  .ip("10.8.10.83")           // static IP - omit for DHCP or DNS auto-resolve
  .gateway("10.8.10.254")     // optional: custom gateway (default: first three octets + ".1")
  .vlan(2010)                 // VLAN tag on vmbr1
  .sshKey(KEYS)               // array of public key strings
  .sshUser("ubuntu")          // optional: SSH user for provisioning (default: "root")
  .machine("i440fx")          // machine type ("q35" or "i440fx", default "q35")
  .provision("config/default.yaml")   // single script or playbook
  .provision(["common.yml", "app.yml"]) // or multiple files run in order
  .forceConfigCheck()                 // force playbooks to run even if hashes match
  .replace("ix-sto1-app01-old")       // destroy old VM after new one is up
```

## Golden Image / VM Templates

Puls supports declaring pre-baked virtual machine templates, analogous to HashiCorp Packer's workflow. This allows developers to configure a golden template image (with pre-installed packages, Docker, libraries, or security policies), bake it once, and then spin up actual VMs from it in seconds.

### `Proxmox.Template`

Define a golden image template using the `Proxmox.Template()` helper:

```typescript
const dockerBaseTemplate = Proxmox.Template("ubuntu-docker-base")
  .baseImage(OS.UBUNTU_24_04)
  .cores(4)
  .memory(4096)
  .sshKey(KEYS)
  .sshUser("ubuntu")   // optional: SSH user for provisioning (default: "root")
  .provision("playbooks/docker.yaml", "playbooks/security-hardening.yaml");
```

**Template Lifecycle**:

1. **Idempotent Baking**: Puls checks if a template with this name already exists in the cluster. If it does and the provision playbooks match (via applied notes hashes), creation is skipped.
2. **Purge & Rebuild**: Because Proxmox templates are read-only and cannot be altered, if playbooks or configurations change, Puls will automatically stop, purge, and rebuild the template from the `baseImage`.
3. **Immutability Conversion**: After successful VM booting, SSH checks, and playbook execution, Puls will stop the VM and issue a Proxmox Template conversion request, transforming it into a read-only template in the cluster.

### VM Cloning from Template (`.fromTemplate()`)

Use the fluent `.fromTemplate()` builder method on `Proxmox.VM()` to spin up a server directly from a pre-baked template:

```typescript
@Deploy({ parallel: true, proxmox: CONFIG.STAGING })
class ProductionApp extends Stack {
  // 1. Declare the template resource
  dockerBase = Proxmox.Template("ubuntu-docker-base")
    .baseImage(OS.UBUNTU_24_04)
    .provision("playbooks/docker.yaml");

  // 2. Clone servers from the template concurrently in seconds
  server1 = Proxmox.VM("prod-game-01").fromTemplate(this.dockerBase).cores(4);
  server2 = Proxmox.VM("prod-game-02").fromTemplate(this.dockerBase).cores(4);
}
```

* **Dynamic DAG Dependencies**: Calling `.fromTemplate(template)` automatically registers an implicit dependency. The parallel scheduling engine ensures that the template is fully baked before the VMs attempt concurrent cloning.

## Templates (OS constants)

Templates are matched by VMID (numeric string) or name substring:

```typescript
export const OS = {
  UBUNTU_22_04: "ubuntu-22.04",   // name substring match
  UBUNTU_24_04: "9017",           // VMID match - use when name is ambiguous
  DEBIAN_11:    "debian-11",
  DEBIAN_12:    "debian-12",
} as const;
```

## SSH keys (KEYS constant)

```typescript
export const KEYS = [
  "ssh-ed25519 AAAA... bia@nolimitcity.com",
] as const;
```

Pass via `.sshKey(KEYS)` - injected into cloud-init so every VM has your team's keys from first boot.

## IP resolution

Static IP via `.ip("10.8.10.83")` - sets cloud-init `ipconfig0` with gateway derived from the first three octets (`10.8.10.1` by default). Use `.gateway("10.8.10.254")` to override the gateway for non-standard subnets.

If no `.ip()` is set, Puls tries DNS first:

```
dns.resolve4("vm-name.nolimit.int")  →  uses resolved IP as static
                                     →  falls back to DHCP if not in DNS
```

Configure `dnsDomain` in `CONFIG` to enable this.

## Provisioning pipeline

After a VM starts, Puls runs these steps for each provisioner provided to `.provision()`:

1. **TCP probe** (first provisioner only) - polls port 22 until SSH is accepting connections
2. **cloud-init wait** (first provisioner only) - runs `cloud-init status` via SSH until it returns `done` or `error`
3. **Provisioner** - dispatched by file extension

| Extension | Action |
|-----------|--------|
| `.yaml` / `.yml` | `ansible-playbook -i "IP," -u <user> --private-key ...` where `<user>` is resolved from `.sshUser()` → `PROXMOX_SSH_USER` env var → `config.sshUser` → `"root"` |
| `.pp` | `scp manifest.pp /tmp/` then `ssh 'puppet apply /tmp/manifest.pp'` |

### Idempotent & Incremental Provisioning

Puls implements **Idempotent Configuration State Tracking** to unify infrastructure provisioning and configuration management into a single, change-aware GitOps pipeline.

#### How It Works
Puls is completely stateless, meaning it does not rely on a local or remote state file. Instead, it securely stores applied playbook metadata directly in the Proxmox VM's **Notes** (Description) field using a non-destructive, regex-bounded block:
```
[puls-provision: playbook1.yaml=hash1,playbook2.yaml=hash2]
```
This metadata tracks the short SHA-256 hash of each applied playbook.

#### Key Features:
1. **Incremental Rollouts**: If you add a new playbook or modify an existing one (causing its hash to change), Puls detects the drift and executes **only the changed or new playbooks**.
2. **Zero-Drift Skips**: If no playbooks have changed and their hashes match the VM description metadata, Puls skips SSH connectivity probes and provisioning entirely, enabling lightning-fast deploys.
3. **Notes Preservation**: Any custom, human-written VM notes in the Proxmox Description field are fully preserved. Puls only parses and updates its own `[puls-provision: ...]` block, appending it to the end of your notes if not present.
4. **Dynamic Append Chaining**: Playbooks can be chained fluently. Calling `.provision(...)` multiple times or passing arrays will build a sequenced playbook execution chain:
   ```typescript
   Proxmox.VM("ix-sto1-app01")
     .provision("playbooks/nginx.yaml")
     .provision(["playbooks/db.yaml", "playbooks/app.yaml"])
   ```
5. **Force Re-provisioning (`@ForceConfigCheck` / `.forceConfigCheck()`)**: If you have manually altered a VM or want to ensure a clean slate, you can override state tracking to force all playbooks to run regardless of whether their hashes match.
   * **Fluent Method**:
     ```typescript
     Proxmox.VM("ix-sto1-game01")
       .provision("config/docker.yaml")
       .forceConfigCheck(); // <-- Forces playbooks to run
     ```
   * **Decorator**:
     ```typescript
     @ForceConfigCheck
     server = Proxmox.VM("ix-sto1-game01")
       .provision("config/docker.yaml");
     ```

### Ansible example (`config/default.yaml`)

```yaml
---
- name: Install Puppet 8
  hosts: all
  become: true
  vars:
    puppet_server: ix-sto1-puppet01
  tasks:
    - name: Copy Puppet Labs keyring
      ansible.builtin.copy:
        src: puppetlabs-keyring.gpg
        dest: /etc/apt/keyrings/puppetlabs-keyring.gpg
        mode: "0644"

    - name: Add Puppet 8 apt repository
      ansible.builtin.apt_repository:
        repo: "deb [signed-by=/etc/apt/keyrings/puppetlabs-keyring.gpg] http://apt.puppet.com noble puppet8"
        state: present
        filename: puppetlabs

    - name: Install Puppet
      ansible.builtin.apt:
        name: puppet
        state: present
        update_cache: true

    - name: Configure puppet.conf
      ansible.builtin.copy:
        dest: /etc/puppetlabs/puppet/puppet.conf
        mode: "0644"
        content: |
          [main]
          certname = {{ ansible_facts['hostname'] }}
          environment = production
          server = {{ puppet_server }}
```

## Destroy

```typescript
// Tear down the whole stack
@Destroy({ proxmox: CONFIG.STAGING })
class StagingInfra extends Stack { ... }

// Destroy one resource during a deploy (replace pattern)
@Deploy({ proxmox: CONFIG.STAGING })
class StagingInfra extends Stack {
  new = Proxmox.VM("ix-sto1-app02")...;

  @Destroy
  old = Proxmox.VM("ix-sto1-app01");
}
```

Or use `.replace()` for an atomic swap - new VM is fully provisioned before the old one is removed:

```typescript
Proxmox.VM("ix-sto1-app02")
  ...
  .replace("ix-sto1-app01")
```

Destroy stops the VM gracefully, then deletes it with `purge=1&destroy-unreferenced-disks=1`.

Provisioning is **skipped** during destroy - only discovery and deletion run.

## Full example

```typescript
import { Stack, Deploy, Destroy, Protected } from "puls-dev";
import { Proxmox, CONFIG, OS, KEYS } from "puls-dev/proxmox";

@Deploy({ proxmox: CONFIG.STAGING })
class StagingInfra extends Stack {
  @Protected
  db = Proxmox.VM("ix-sto1-db01")
    .image(OS.UBUNTU_24_04)
    .cores(2).memory(4096)
    .ip("10.8.10.50").vlan(2010)
    .sshKey(KEYS);

  app = Proxmox.VM("ix-sto1-app01")
    .image(OS.UBUNTU_24_04)
    .cores(4).memory(8192)
    .ip("10.8.10.51").vlan(2010)
    .sshKey(KEYS)
    .provision("config/default.yaml");
}
```
