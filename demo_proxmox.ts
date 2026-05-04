import "dotenv/config";
import { Proxmox } from "./src/providers/proxmox/index.ts";
import { KEYS, OS } from "./src/types/proxmox.ts";
import { Stack } from "./src/core/stack.ts";
import { Deploy, Destroy } from "./src/core/decorators.ts";

@Deploy({
  proxmox: {
    url: process.env.PROXMOX_URL!,
    user: process.env.PROXMOX_USER!,
    tokenName: process.env.PROXMOX_TOKEN_NAME!,
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET!,
    nodes: process.env.PROXMOX_NODES?.split(","),
    dnsDomain: process.env.PROXMOX_DNS_DOMAIN,
    dnsServers: process.env.PROXMOX_DNS_SERVERS?.split(","),
    verifySsl: false,
  },
  dryRun: false,
})
class BiaWasHere extends Stack {
  server = Proxmox.VM("ix-sto1-biawashere01")
    .image(OS.UBUNTU_24_04)
    .cores(4)
    .memory(8192)
    .ip("10.8.10.83")
    .vlan(2010)
    .sshKey(KEYS);
  // .provision("./configs/defaults.yml");
}
