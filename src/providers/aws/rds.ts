import {
  DescribeDBInstancesCommand,
  CreateDBInstanceCommand,
  ModifyDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBSubnetGroupsCommand,
  CreateDBSubnetGroupCommand,
} from '@aws-sdk/client-rds';
import {
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import { BaseBuilder } from '../../core/resource.ts';
import { getRDSClient, getEC2Client } from './api.ts';
import { Config } from '../../core/config.ts';

const DB_PORT: Record<string, number> = {
  postgres: 5432,
  mysql:    3306,
  mariadb:  3306,
};

export class RDSBuilder extends BaseBuilder {
  private _engine: string = 'postgres';
  private _engineVersion: string = '16';
  private _instanceClass: string = 'db.t3.micro';
  private _storage: number = 20;
  private _username?: string;
  private _password?: string;
  private _dbName?: string;
  private _subnetIds?: string[];
  private _securityGroupIds?: string[];
  private _publicAccess: boolean = false;
  resolvedEndpoint: string | null = null;
  resolvedPort: number | null = null;
  resolvedArn: string | null = null;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverInstance(name);
  }

  engine(e: { engine: string; version: string }) {
    this._engine = e.engine;
    this._engineVersion = e.version;
    return this;
  }

  size(instanceClass: string)          { this._instanceClass = instanceClass; return this; }
  storage(gb: number)                  { this._storage = gb; return this; }
  subnets(ids: string[])               { this._subnetIds = ids; return this; }
  securityGroups(ids: string[])        { this._securityGroupIds = ids; return this; }
  publicAccess(enabled: boolean = true){ this._publicAccess = enabled; return this; }
  database(name: string)               { this._dbName = name; return this; }

  credentials(username: string, password: string) {
    this._username = username;
    this._password = password;
    return this;
  }

  private async discoverInstance(identifier: string): Promise<any> {
    try {
      const result = await getRDSClient().send(new DescribeDBInstancesCommand({
        DBInstanceIdentifier: identifier,
      }));
      const instance = result.DBInstances?.[0];
      if (!instance || instance.DBInstanceStatus === 'deleting') return null;
      this.resolvedArn = instance.DBInstanceArn ?? null;
      this.resolvedEndpoint = instance.Endpoint?.Address ?? null;
      this.resolvedPort = instance.Endpoint?.Port ?? null;
      return instance;
    } catch (e: any) {
      if (e.name === 'DBInstanceNotFound') return null;
      if (e.name === 'CredentialsProviderError') return null;
      throw e;
    }
  }

  private async discoverDefaultVpc(): Promise<{ vpcId: string; vpcCidr: string; subnetIds: string[] }> {
    const ec2 = getEC2Client();
    const vpcs = await ec2.send(new DescribeVpcsCommand({
      Filters: [{ Name: 'isDefault', Values: ['true'] }],
    }));
    const vpc = vpcs.Vpcs?.[0];
    if (!vpc?.VpcId) throw new Error(`[RDS:${this.name}] No default VPC found. Use .subnets(ids[]) to specify subnets.`);

    const subnets = await ec2.send(new DescribeSubnetsCommand({
      Filters: [{ Name: 'vpc-id', Values: [vpc.VpcId] }],
    }));
    const subnetIds = (subnets.Subnets ?? []).map(s => s.SubnetId!).filter(Boolean);
    return { vpcId: vpc.VpcId, vpcCidr: vpc.CidrBlock!, subnetIds };
  }

  private async ensureSubnetGroup(subnetIds: string[]): Promise<string> {
    const rds = getRDSClient();
    const groupName = `puls-${this.name}-subnet-group`;

    try {
      await rds.send(new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: groupName }));
      return groupName;
    } catch (e: any) {
      if (e.name !== 'DBSubnetGroupNotFoundFault') throw e;
    }

    await rds.send(new CreateDBSubnetGroupCommand({
      DBSubnetGroupName: groupName,
      DBSubnetGroupDescription: `OpsDSL subnet group for RDS instance "${this.name}"`,
      SubnetIds: subnetIds,
    }));
    console.log(`   ✅ Created DB subnet group: ${groupName}`);
    return groupName;
  }

  private async ensureSecurityGroup(vpcId: string, vpcCidr: string): Promise<string> {
    const ec2 = getEC2Client();
    const sgName = `puls-${this.name}-db-sg`;
    const port = DB_PORT[this._engine] ?? 5432;

    const existing = await ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [sgName] },
        { Name: 'vpc-id', Values: [vpcId] },
      ],
    }));
    if (existing.SecurityGroups?.length) return existing.SecurityGroups[0].GroupId!;

    const created = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: sgName,
      Description: `OpsDSL DB access for "${this.name}"`,
      VpcId: vpcId,
    }));
    const sgId = created.GroupId!;

    // Allow inbound on DB port from VPC CIDR only (secure default)
    // Use .publicAccess() to open to the internet
    const cidr = this._publicAccess ? '0.0.0.0/0' : vpcCidr;
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: port,
        ToPort: port,
        IpRanges: [{ CidrIp: cidr, Description: this._publicAccess ? 'Public access' : 'VPC only' }],
      }],
    }));

    console.log(`   ✅ Created security group: ${sgName} (${sgId}) — port ${port} open to ${cidr}`);
    return sgId;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const region = Config.get().providers.aws?.region ?? 'us-east-1';
    const port = DB_PORT[this._engine] ?? 5432;

    console.log(`\n⚡ Finalizing RDS Instance "${this.name}"...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] ${existing ? 'Update' : 'Create'} RDS instance "${this.name}"`);
      console.log(`      └─ Engine: ${this._engine} ${this._engineVersion}`);
      console.log(`      └─ Class: ${this._instanceClass} | Storage: ${this._storage}GB`);
      console.log(`      └─ Port: ${port} | Public: ${this._publicAccess}`);
      this.resolvedEndpoint = `${this.name}.DRYRUN.${region}.rds.amazonaws.com`;
      this.resolvedPort = port;
      return { name: this.name, endpoint: this.resolvedEndpoint, port: this.resolvedPort };
    }

    if (!this._username || !this._password) {
      throw new Error(`[RDS:${this.name}] .credentials(username, password) is required`);
    }

    // Resolve networking — only hit EC2 if needed
    let subnetGroupName: string;
    let securityGroupIds: string[];

    if (this._subnetIds && this._securityGroupIds) {
      subnetGroupName = await this.ensureSubnetGroup(this._subnetIds);
      securityGroupIds = this._securityGroupIds;
    } else {
      const { vpcId, vpcCidr, subnetIds } = await this.discoverDefaultVpc();
      subnetGroupName = await this.ensureSubnetGroup(this._subnetIds ?? subnetIds);
      securityGroupIds = this._securityGroupIds ?? [await this.ensureSecurityGroup(vpcId, vpcCidr)];
    }

    const rds = getRDSClient();

    if (existing) {
      await rds.send(new ModifyDBInstanceCommand({
        DBInstanceIdentifier: this.name,
        DBInstanceClass: this._instanceClass,
        AllocatedStorage: this._storage,
        VpcSecurityGroupIds: securityGroupIds,
        ApplyImmediately: true,
      }));
      console.log(`   ✅ Modification queued for "${this.name}" (ApplyImmediately)`);
    } else {
      await rds.send(new CreateDBInstanceCommand({
        DBInstanceIdentifier: this.name,
        DBInstanceClass: this._instanceClass,
        Engine: this._engine,
        EngineVersion: this._engineVersion,
        MasterUsername: this._username,
        MasterUserPassword: this._password,
        AllocatedStorage: this._storage,
        DBName: this._dbName,
        DBSubnetGroupName: subnetGroupName,
        VpcSecurityGroupIds: securityGroupIds,
        PubliclyAccessible: this._publicAccess,
        StorageType: 'gp3',
        BackupRetentionPeriod: 7,
        DeletionProtection: false,
      }));
      console.log(`🚀 Creating RDS instance "${this.name}" — waiting for available...`);

      await this.waitFor(`"${this.name}" to become available`, async () => {
        const r = await getRDSClient().send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: this.name }));
        const inst = r.DBInstances?.[0];
        if (inst?.DBInstanceStatus === 'available') {
          this.resolvedEndpoint = inst.Endpoint?.Address ?? null;
          this.resolvedPort = inst.Endpoint?.Port ?? null;
          this.resolvedArn = inst.DBInstanceArn ?? null;
          return true;
        }
        return false;
      }, { intervalMs: 30_000, timeoutMs: 1_200_000 });

      console.log(`   🌐 Endpoint: ${this.resolvedEndpoint}:${this.resolvedPort}`);
    }

    await this.deploySidecars();
    return { name: this.name, endpoint: this.resolvedEndpoint, port: this.resolvedPort, arn: this.resolvedArn };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying RDS Instance "${this.name}"...`);

    if (!existing) {
      console.log(`   ✅ Instance "${this.name}" does not exist — nothing to do`);
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete RDS instance "${this.name}" (no final snapshot)`);
      return { destroyed: this.name };
    }

    await getRDSClient().send(new DeleteDBInstanceCommand({
      DBInstanceIdentifier: this.name,
      SkipFinalSnapshot: true,
      DeleteAutomatedBackups: true,
    }));
    console.log(`   ✅ Deletion initiated for "${this.name}" (takes a few minutes)`);
    return { destroyed: this.name };
  }
}
