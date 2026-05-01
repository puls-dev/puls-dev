export const OS = {
  DEBIAN_11: "debian-11-x64",
  UBUNTU_22_04: "ubuntu-22-04-x64",
} as const;

export const REGION = {
  FRA: "fra1",
  NYC: "nyc3",
} as const;

export const SIZE = {
  SMALL: "s-1vcpu-1gb",
  MEDIUM: "s-2vcpu-4gb",
  LARGE: "s-4vcpu-8gb",
} as const;

export const NETWORK = {
  ANY: "0.0.0.0/0",
  ANY_V6: "::/0",
  OFFICE: "80.1.2.3/32",
  VPN: "10.0.0.0/24",
} as const;
