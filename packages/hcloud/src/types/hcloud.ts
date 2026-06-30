export const OS_IMAGE = {
  UBUNTU_24_04: "ubuntu-24.04",
  UBUNTU_22_04: "ubuntu-22.04",
  DEBIAN_12: "debian-12",
  DEBIAN_11: "debian-11",
  ROCKY_9: "rocky-9",
  ALMALINUX_9: "almalinux-9",
} as const;

export const LOCATION = {
  NBG1: "nbg1", // Nuremberg, Germany
  FSN1: "fsn1", // Falkenstein, Germany
  HEL1: "hel1", // Helsinki, Finland
  ASH: "ash",   // Ashburn, Virginia, USA
  HIL: "hil",   // Hillsboro, Oregon, USA
} as const;

export const SERVER_TYPE = {
  CX22: "cx22",   // 2 vCPU, 4 GB RAM (Intel)
  CPX11: "cpx11", // 2 vCPU, 2 GB RAM (AMD)
  CPX21: "cpx21", // 3 vCPU, 4 GB RAM (AMD)
  CPX31: "cpx31", // 4 vCPU, 8 GB RAM (AMD)
  CPX41: "cpx41", // 8 vCPU, 16 GB RAM (AMD)
  CPX51: "cpx51", // 16 vCPU, 32 GB RAM (AMD)
  CAX11: "cax11", // 2 vCPU, 4 GB RAM (Ampere ARM)
  CAX21: "cax21", // 4 vCPU, 8 GB RAM (Ampere ARM)
  CAX31: "cax31", // 8 vCPU, 16 GB RAM (Ampere ARM)
  CAX41: "cax41", // 16 vCPU, 32 GB RAM (Ampere ARM)
} as const;

export const NETWORK = {
  ANY: "0.0.0.0/0",
  ANY_V6: "::/0",
} as const;
