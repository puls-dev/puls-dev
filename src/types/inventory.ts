// ─── Proxmox ──────────────────────────────────────────────────────────────────

export interface ProxmoxVm {
  name: string;
  vmid: number;
  node: string;
  status: string;
  maxmem: number; // bytes
  maxdisk: number; // bytes
}

export interface ProxmoxInventory {
  vms: ProxmoxVm[];
}

// ─── DigitalOcean ─────────────────────────────────────────────────────────────

export interface DoDroplet {
  id: number;
  name: string;
  status: string;
  region: string;
  size: string;
  ip?: string;
  monthlyCost: number;
}

export interface DoFirewall {
  id: string;
  name: string;
  dropletCount: number;
}

export interface DoLoadBalancer {
  id: string;
  name: string;
  ip: string;
  region: string;
  status: string;
}

export interface DoDomain {
  name: string;
  ttl: number;
}

export interface DoInventory {
  droplets: DoDroplet[];
  firewalls: DoFirewall[];
  loadBalancers: DoLoadBalancer[];
  domains: DoDomain[];
  totalMonthlyCost: number;
}

// ─── AWS ──────────────────────────────────────────────────────────────────────

export interface AwsDistribution {
  id: string;
  domain: string;
  aliases: string[];
  status: string;
}

export interface AwsBucket {
  name: string;
}

export interface AwsLambdaFn {
  name: string;
  runtime: string;
  memorySizeMb: number;
}

export interface AwsRdsInstance {
  identifier: string;
  engine: string;
  instanceClass: string;
  status: string;
  endpoint?: string;
}

export interface AwsHostedZone {
  name: string;
  id: string;
  recordCount: number;
}

export interface AwsInventory {
  region: string;
  distributions: AwsDistribution[];
  buckets: AwsBucket[];
  lambdas: AwsLambdaFn[];
  rdsInstances: AwsRdsInstance[];
  hostedZones: AwsHostedZone[];
}

// ─── Combined ─────────────────────────────────────────────────────────────────

export interface InventoryError {
  provider: "proxmox" | "do" | "aws";
  message: string;
}

export interface InventoryResult {
  proxmox?: ProxmoxInventory;
  do?: DoInventory;
  aws?: AwsInventory;
  errors: InventoryError[];
}
