import type { GlobalConfig } from "@puls-dev/core";

type ProxmoxConfig = NonNullable<GlobalConfig["providers"]["proxmox"]>;

export const CONFIG: Record<string, ProxmoxConfig> = {
  STAGING: {
    url: process.env.PROXMOX_URL!,
    user: process.env.PROXMOX_USER!,
    tokenName: process.env.PROXMOX_TOKEN_NAME!,
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET!,
    nodes: process.env.PROXMOX_NODES?.split(","),
    dnsDomain: process.env.PROXMOX_DNS_DOMAIN,
    dnsServers: process.env.PROXMOX_DNS_SERVERS?.split(","),
    verifySsl: false,
  },
  PRODUCTION: {
    url: process.env.PROD_PROXMOX_URL!,
    user: process.env.PROD_PROXMOX_USER!,
    tokenName: process.env.PROD_PROXMOX_TOKEN_NAME!,
    tokenSecret: process.env.PROD_PROXMOX_TOKEN_SECRET!,
    nodes: process.env.PROD_PROXMOX_NODES?.split(","),
    dnsDomain: process.env.PROD_PROXMOX_DNS_DOMAIN,
    dnsServers: process.env.PROD_PROXMOX_DNS_SERVERS?.split(","),
    verifySsl: false,
  },
};

export const OS = {
  UBUNTU_22_04: "ubuntu-22.04",
  UBUNTU_24_04: "9017", // ubuntu-24.04 but via template-id
  DEBIAN_11: "debian-11",
  DEBIAN_12: "debian-12",
} as const;

export type OSImage = (typeof OS)[keyof typeof OS] | (string & {}) | number;
