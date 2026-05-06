import "dotenv/config";
import { Proxmox } from "../src/providers/proxmox/index.ts";
import { CONFIG, KEYS, OS } from "../src/types/proxmox.ts";
import { Stack } from "../src/core/stack.ts";
import { Deploy, Destroy } from "../src/core/decorators.ts";

@Deploy({ proxmox: CONFIG.STAGING, dryRun: true })
class StagingInfra extends Stack {
  server = Proxmox.VM("ix-sto1-biawashere01")
    .image(OS.UBUNTU_24_04)
    .cores(4)
    .memory(8192)
    .ip("10.8.10.83")
    .vlan(2010)
    .sshKey(KEYS)
    .provision("config/default.yaml");
}
