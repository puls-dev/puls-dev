import { ListDistributionsCommand }   from '@aws-sdk/client-cloudfront';
import { ListBucketsCommand }          from '@aws-sdk/client-s3';
import { ListFunctionsCommand }        from '@aws-sdk/client-lambda';
import { DescribeDBInstancesCommand }  from '@aws-sdk/client-rds';
import { ListHostedZonesCommand }      from '@aws-sdk/client-route-53';
import { DescribeInstancesCommand }    from '@aws-sdk/client-ec2';
import { getCFClient, getS3Client, getLambdaClient, getRDSClient, getR53Client, getEC2Client } from './api.js';
import { Config } from '@puls-dev/core';
import type {
  AwsInventory, AwsDistribution, AwsBucket, AwsLambdaFn,
  AwsRdsInstance, AwsHostedZone, AwsEc2Instance,
} from '@puls-dev/core';

export async function listAwsResources(): Promise<AwsInventory> {
  const region = Config.get().providers.aws?.region ?? "us-east-1";

  const [cfResult, s3Result, lambdaResult, rdsResult, r53Result, ec2Result] = await Promise.all([
    getCFClient().send(new ListDistributionsCommand({})),
    getS3Client().send(new ListBucketsCommand({})),
    getLambdaClient().send(new ListFunctionsCommand({ MaxItems: 50 })),
    getRDSClient().send(new DescribeDBInstancesCommand({})),
    getR53Client().send(new ListHostedZonesCommand({})),
    getEC2Client().send(new DescribeInstancesCommand({ MaxResults: 200 })),
  ]);

  const distributions: AwsDistribution[] = (cfResult.DistributionList?.Items ?? []).map((d) => ({
    id:      d.Id!,
    domain:  d.DomainName!,
    aliases: d.Aliases?.Items ?? [],
    status:  d.Status ?? '',
  }));

  const buckets: AwsBucket[] = (s3Result.Buckets ?? []).map((b) => ({
    name: b.Name!,
  }));

  const lambdas: AwsLambdaFn[] = (lambdaResult.Functions ?? []).map((f) => ({
    name:         f.FunctionName!,
    runtime:      f.Runtime ?? 'unknown',
    memorySizeMb: f.MemorySize ?? 0,
  }));

  const rdsInstances: AwsRdsInstance[] = (rdsResult.DBInstances ?? []).map((i) => ({
    identifier:    i.DBInstanceIdentifier!,
    engine:        `${i.Engine} ${i.EngineVersion}`,
    instanceClass: i.DBInstanceClass!,
    status:        i.DBInstanceStatus ?? '',
    endpoint:      i.Endpoint?.Address,
  }));

  const hostedZones: AwsHostedZone[] = (r53Result.HostedZones ?? []).map((z) => ({
    name:        z.Name!,
    id:          z.Id!.replace('/hostedzone/', ''),
    recordCount: z.ResourceRecordSetCount ?? 0,
  }));

  const ec2Instances: AwsEc2Instance[] = (ec2Result.Reservations ?? [])
    .flatMap((r) => r.Instances ?? [])
    .filter((i) => i.State?.Name !== 'terminated')
    .map((i) => ({
      id:       i.InstanceId!,
      name:     i.Tags?.find((t) => t.Key === 'Name')?.Value ?? i.InstanceId!,
      type:     i.InstanceType ?? 'unknown',
      state:    i.State?.Name ?? 'unknown',
      publicIp: i.PublicIpAddress,
    }));

  return { region, distributions, buckets, lambdas, rdsInstances, hostedZones, ec2Instances };
}
