import type { GlobalConfig } from '../core/config.ts';

type ProxmoxConfig = NonNullable<GlobalConfig['providers']['proxmox']>;

export const CONFIG: Record<string, ProxmoxConfig> = {
  STAGING: {
    url: process.env.PROXMOX_URL!,
    user: process.env.PROXMOX_USER!,
    tokenName: process.env.PROXMOX_TOKEN_NAME!,
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET!,
    nodes: process.env.PROXMOX_NODES?.split(','),
    dnsDomain: process.env.PROXMOX_DNS_DOMAIN,
    dnsServers: process.env.PROXMOX_DNS_SERVERS?.split(','),
    verifySsl: false,
  },
};

export const OS = {
  UBUNTU_22_04: "ubuntu-22.04",
  UBUNTU_24_04: "9017",
  DEBIAN_11: "debian-11",
  DEBIAN_12: "debian-12",
} as const;

export type OSImage = (typeof OS)[keyof typeof OS];

// SSH public key strings to inject via cloud-init
export const KEYS = [
  // Add team public keys here, e.g.:
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF3Kp5n3EtvXEjMqtvvzw0/QoSQapOxhBj0s0tyYbbZJ bia@nolimitcity.com",
] as const;
