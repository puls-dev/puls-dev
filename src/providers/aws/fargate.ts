import {
  DescribeClustersCommand,
  CreateClusterCommand,
  DescribeServicesCommand,
  CreateServiceCommand,
  UpdateServiceCommand,
  DeleteServiceCommand,
  RegisterTaskDefinitionCommand,
  NetworkMode,
  LaunchType,
  SchedulingStrategy,
} from '@aws-sdk/client-ecs';
import {
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  DeleteSecurityGroupCommand,
} from '@aws-sdk/client-ec2';
import {
  GetRoleCommand,
  CreateRoleCommand,
  AttachRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  DescribeLogGroupsCommand,
  CreateLogGroupCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { BaseBuilder } from '../../core/resource.ts';
import { getECSClient, getEC2Client, getIAMClient, getCWLogsClient } from './api.ts';
import { SecretsBuilder, resolveEnvVars } from './secrets.ts';
import { Config } from '../../core/config.ts';

const ECS_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
});

export class FargateBuilder extends BaseBuilder {
  private _image?: string;
  private _cpu: number = 256;
  private _memory: number = 512;
  private _port?: number;
  private _replicas: number = 1;
  private _env: Record<string, string | SecretsBuilder> = {};
  private _clusterName: string = 'puls';
  private _subnetIds?: string[];
  private _securityGroupIds?: string[];
  resolvedArn: string | null = null;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverService(name);
  }

  image(img: string)                       { this._image = img; return this; }
  cpu(units: number)                       { this._cpu = units; return this; }
  memory(mb: number)                       { this._memory = mb; return this; }
  port(p: number)                          { this._port = p; return this; }
  replicas(n: number)                      { this._replicas = n; return this; }
  cluster(name: string)                    { this._clusterName = name; return this; }
  subnets(ids: string[])                   { this._subnetIds = ids; return this; }
  securityGroups(ids: string[])            { this._securityGroupIds = ids; return this; }
  env(vars: Record<string, string | SecretsBuilder>) { this._env = { ...this._env, ...vars }; return this; }

  private async discoverService(name: string): Promise<any> {
    try {
      const ecs = getECSClient();
      const clusterDesc = await ecs.send(new DescribeClustersCommand({ clusters: [this._clusterName] }));
      const cluster = clusterDesc.clusters?.find(c => c.status === 'ACTIVE');
      if (!cluster) return null;

      const result = await ecs.send(new DescribeServicesCommand({
        cluster: this._clusterName,
        services: [name],
      }));
      const svc = result.services?.find(s => s.status !== 'INACTIVE');
      if (svc) this.resolvedArn = svc.serviceArn ?? null;
      return svc ?? null;
    } catch (e: any) {
      if (e.name === 'ClusterNotFoundException' || e.name === 'CredentialsProviderError') return null;
      throw e;
    }
  }

  private async ensureCluster(): Promise<string> {
    const ecs = getECSClient();
    const desc = await ecs.send(new DescribeClustersCommand({ clusters: [this._clusterName] }));
    const existing = desc.clusters?.find(c => c.status === 'ACTIVE');
    if (existing) return existing.clusterArn!;

    const created = await ecs.send(new CreateClusterCommand({ clusterName: this._clusterName }));
    console.log(`   ✅ Created ECS cluster: ${this._clusterName}`);
    return created.cluster!.clusterArn!;
  }

  private async ensureExecutionRole(): Promise<string> {
    const roleName = `puls-fargate-${this.name}-exec-role`;
    const iam = getIAMClient();
    try {
      const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }));
      return existing.Role!.Arn!;
    } catch (e: any) {
      if (e.name !== 'NoSuchEntityException') throw e;
    }

    const created = await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: ECS_ASSUME_ROLE_POLICY,
      Description: `Task execution role for OpsDSL Fargate service "${this.name}"`,
    }));
    await iam.send(new AttachRolePolicyCommand({
      RoleName: roleName,
      PolicyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
    }));
    console.log(`   ✅ Created execution role: ${roleName}`);
    return created.Role!.Arn!;
  }

  private async ensureLogGroup(): Promise<string> {
    const logGroupName = `/puls/${this.name}`;
    const cw = getCWLogsClient();
    const existing = await cw.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName }));
    if (existing.logGroups?.some(g => g.logGroupName === logGroupName)) return logGroupName;

    await cw.send(new CreateLogGroupCommand({ logGroupName }));
    console.log(`   ✅ Created log group: ${logGroupName}`);
    return logGroupName;
  }

  private async discoverDefaultVpc(): Promise<{ vpcId: string; subnetIds: string[] }> {
    const ec2 = getEC2Client();
    const vpcs = await ec2.send(new DescribeVpcsCommand({
      Filters: [{ Name: 'isDefault', Values: ['true'] }],
    }));
    const vpcId = vpcs.Vpcs?.[0]?.VpcId;
    if (!vpcId) throw new Error(`[Fargate:${this.name}] No default VPC found. Use .subnets(ids[]) to specify subnets.`);

    const subnets = await ec2.send(new DescribeSubnetsCommand({
      Filters: [{ Name: 'vpc-id', Values: [vpcId] }],
    }));
    const subnetIds = (subnets.Subnets ?? []).map(s => s.SubnetId!).filter(Boolean);
    return { vpcId, subnetIds };
  }

  private async ensureSecurityGroup(vpcId: string): Promise<string> {
    const ec2 = getEC2Client();
    const sgName = `puls-${this.name}-sg`;

    const existing = await ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [sgName] },
        { Name: 'vpc-id', Values: [vpcId] },
      ],
    }));
    if (existing.SecurityGroups?.length) return existing.SecurityGroups[0].GroupId!;

    const created = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: sgName,
      Description: `OpsDSL Fargate service "${this.name}"`,
      VpcId: vpcId,
    }));
    const sgId = created.GroupId!;

    if (this._port) {
      await ec2.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: sgId,
        IpPermissions: [{
          IpProtocol: 'tcp',
          FromPort: this._port,
          ToPort: this._port,
          IpRanges: [{ CidrIp: '0.0.0.0/0' }],
          Ipv6Ranges: [{ CidrIpv6: '::/0' }],
        }],
      }));
    }

    console.log(`   ✅ Created security group: ${sgName} (${sgId})`);
    return sgId;
  }

  private async resolveNetworking(): Promise<{ subnetIds: string[]; securityGroupIds: string[] }> {
    if (this._subnetIds && this._securityGroupIds) {
      return { subnetIds: this._subnetIds, securityGroupIds: this._securityGroupIds };
    }
    const { vpcId, subnetIds } = await this.discoverDefaultVpc();
    const sgId = this._securityGroupIds?.[0] ?? await this.ensureSecurityGroup(vpcId);
    return {
      subnetIds: this._subnetIds ?? subnetIds,
      securityGroupIds: [sgId],
    };
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const region = Config.get().providers.aws?.region ?? 'us-east-1';

    console.log(`\n⚡ Finalizing Fargate Service "${this.name}"...`);

    if (!this._image) throw new Error(`[Fargate:${this.name}] .image("...") is required`);

    if (dryRun) {
      console.log(`   📝 [PLAN] ${existing ? 'Update' : 'Create'} Fargate service "${this.name}"`);
      console.log(`      └─ Cluster: ${this._clusterName}`);
      console.log(`      └─ Image: ${this._image}`);
      console.log(`      └─ CPU: ${this._cpu} | Memory: ${this._memory}MB | Replicas: ${this._replicas}`);
      if (this._port) console.log(`      └─ Port: ${this._port}`);
      if (Object.keys(this._env).length) console.log(`      └─ Env vars: ${Object.keys(this._env).join(', ')}`);
      this.resolvedArn = `arn:aws:ecs:${region}:000000000000:service/${this._clusterName}/DRYRUN`;
      return { name: this.name, arn: this.resolvedArn };
    }

    const [clusterArn, executionRoleArn, logGroupName, networking] = await Promise.all([
      this.ensureCluster(),
      this.ensureExecutionRole(),
      this.ensureLogGroup(),
      this.resolveNetworking(),
    ]);

    // Register a new task definition revision
    const containerDef: any = {
      name: this.name,
      image: this._image,
      essential: true,
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': logGroupName,
          'awslogs-region': region,
          'awslogs-stream-prefix': this.name,
        },
      },
    };
    if (this._port) containerDef.portMappings = [{ containerPort: this._port, protocol: 'tcp' }];
    if (Object.keys(this._env).length) {
      const resolvedEnv = await resolveEnvVars(this._env);
      containerDef.environment = Object.entries(resolvedEnv).map(([name, value]) => ({ name, value }));
    }

    const taskDef = await getECSClient().send(new RegisterTaskDefinitionCommand({
      family: this.name,
      networkMode: NetworkMode.AWSVPC,
      requiresCompatibilities: ['FARGATE'],
      cpu: String(this._cpu),
      memory: String(this._memory),
      executionRoleArn,
      containerDefinitions: [containerDef],
    }));
    const taskDefArn = taskDef.taskDefinition!.taskDefinitionArn!;
    console.log(`   ✅ Registered task definition: ${this.name}:${taskDef.taskDefinition!.revision}`);

    const networkConfig = {
      awsvpcConfiguration: {
        subnets: networking.subnetIds,
        securityGroups: networking.securityGroupIds,
        assignPublicIp: 'ENABLED' as const,
      },
    };

    const ecs = getECSClient();

    if (existing) {
      await ecs.send(new UpdateServiceCommand({
        cluster: this._clusterName,
        service: this.name,
        taskDefinition: taskDefArn,
        desiredCount: this._replicas,
        networkConfiguration: networkConfig,
        forceNewDeployment: true,
      }));
      console.log(`   ✅ Updated service "${this.name}" → rolling deployment started`);
    } else {
      const created = await ecs.send(new CreateServiceCommand({
        cluster: clusterArn,
        serviceName: this.name,
        taskDefinition: taskDefArn,
        desiredCount: this._replicas,
        launchType: LaunchType.FARGATE,
        networkConfiguration: networkConfig,
        schedulingStrategy: SchedulingStrategy.REPLICA,
      }));
      this.resolvedArn = created.service!.serviceArn!;
      console.log(`🚀 Created Fargate service "${this.name}" (arn=${this.resolvedArn})`);
    }

    await this.deploySidecars();
    return { name: this.name, arn: this.resolvedArn, cluster: this._clusterName };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying Fargate Service "${this.name}"...`);

    if (!existing) {
      console.log(`   ✅ Service "${this.name}" does not exist — nothing to do`);
      return { destroyed: this.name };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Drain and delete service "${this.name}" in cluster "${this._clusterName}"`);
      return { destroyed: this.name };
    }

    const ecs = getECSClient();
    // Drain before delete — required by ECS
    await ecs.send(new UpdateServiceCommand({
      cluster: this._clusterName,
      service: this.name,
      desiredCount: 0,
    }));
    await ecs.send(new DeleteServiceCommand({
      cluster: this._clusterName,
      service: this.name,
      force: true,
    }));
    console.log(`   ✅ Deleted service "${this.name}"`);
    return { destroyed: this.name };
  }
}
