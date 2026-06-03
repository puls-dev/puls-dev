import "dotenv/config";
import { Stack, Deploy } from "puls-dev";
import { Proxmox, CONFIG, OS } from "puls-dev/proxmox";

@Deploy({ proxmox: CONFIG.STAGING, dryRun: false })
class StagingInfra extends Stack {
    app = Proxmox.VM("ix-sto1-biawashere01")
        .image(OS.UBUNTU_24_04)
        .cores(4).memory(8192)
        .ip("10.8.10.91").vlan(2010)
}