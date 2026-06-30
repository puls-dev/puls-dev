// ─── Proxmox ──────────────────────────────────────────────────────────────────

export interface ProxmoxVm {
  name: string;
  vmid: number;
  node: string;
  status: string;
  maxmem: number; // bytes
  maxdisk: number; // bytes
}

export interface ProxmoxTemplate {
  name: string;
  vmid: number;
  node: string;
}

export interface ProxmoxInventory {
  vms: ProxmoxVm[];
  templates: ProxmoxTemplate[];
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

export interface DoDatabase {
  id: string;
  name: string;
  engine: string;
  region: string;
  status: string;
  nodeCount: number;
}

export interface DoApp {
  id: string;
  name: string;
  liveUrl: string;
  status: string;
}

export interface DoVpc {
  id: string;
  name: string;
  region: string;
  ipRange: string;
}

export interface DoInventory {
  droplets: DoDroplet[];
  firewalls: DoFirewall[];
  loadBalancers: DoLoadBalancer[];
  domains: DoDomain[];
  databases: DoDatabase[];
  apps: DoApp[];
  vpcs: DoVpc[];
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

export interface AwsEc2Instance {
  id: string;
  name: string;
  type: string;
  state: string;
  publicIp?: string;
}

export interface AwsInventory {
  region: string;
  distributions: AwsDistribution[];
  buckets: AwsBucket[];
  lambdas: AwsLambdaFn[];
  rdsInstances: AwsRdsInstance[];
  hostedZones: AwsHostedZone[];
  ec2Instances: AwsEc2Instance[];
}

// ─── GCP ──────────────────────────────────────────────────────────────────────

export interface GcpVM {
  name: string;
  zone: string;
  machineType: string;
  status: string;
  ip: string;
}

export interface GcpCloudSQL {
  name: string;
  engine: string;
  tier: string;
  status: string;
}

export interface GcpCloudRun {
  name: string;
  region: string;
  url: string;
}

export interface GcpCloudDNS {
  name: string;
  dnsName: string;
}

export interface GcpPubSubTopic {
  name: string;
}

export interface GcpSecret {
  name: string;
}

export interface GcpInventory {
  vms: GcpVM[];
  rdsInstances: GcpCloudSQL[];
  distributions: GcpCloudRun[];
  hostedZones: GcpCloudDNS[];
  pubSubTopics: GcpPubSubTopic[];
  secrets: GcpSecret[];
}

// ─── Firebase ─────────────────────────────────────────────────────────────────

export interface FirebaseHosting {
  site: string;
}

export interface FirebaseFunction {
  name: string;
  region: string;
  entryPoint: string;
  runtime: string;
}

export interface FirebaseFirestoreDb {
  name: string;
  type: string;
  state: string;
}

export interface FirebaseStorageBucket {
  name: string;
  location: string;
}

export interface FirebaseAuthProvider {
  providerId: string;
}

export interface FirebaseRemoteConfig {
  parameterCount: number;
  version: string;
}

export interface FirebaseInventory {
  hostingSites: FirebaseHosting[];
  functions: FirebaseFunction[];
  firestoreDbs: FirebaseFirestoreDb[];
  storageBuckets: FirebaseStorageBucket[];
  authProviders: FirebaseAuthProvider[];
  remoteConfig?: FirebaseRemoteConfig;
}

// ─── Hetzner Cloud ────────────────────────────────────────────────────────────

export interface HCloudServer {
  id: number;
  name: string;
  status: string;
  location: string;
  serverType: string;
  ip?: string;
  monthlyCost: number;
}

export interface HCloudFirewall {
  id: number;
  name: string;
  serverCount: number;
}

export interface HCloudNetwork {
  id: number;
  name: string;
  ipRange: string;
}

export interface HCloudVolume {
  id: number;
  name: string;
  size: number;
  serverId?: number;
}

export interface HCloudLoadBalancer {
  id: number;
  name: string;
  ip?: string;
  location: string;
  type: string;
}

export interface HCloudInventory {
  servers: HCloudServer[];
  firewalls: HCloudFirewall[];
  networks: HCloudNetwork[];
  volumes: HCloudVolume[];
  loadBalancers: HCloudLoadBalancer[];
  totalMonthlyCost: number;
}

// ─── Combined ─────────────────────────────────────────────────────────────────

export interface InventoryError {
  provider: string;
  message: string;
}

export interface InventoryResult {
  proxmox?: ProxmoxInventory;
  do?: DoInventory;
  aws?: AwsInventory;
  gcp?: GcpInventory;
  firebase?: FirebaseInventory;
  hcloud?: HCloudInventory;
  errors: InventoryError[];
  [key: string]: any;
}

