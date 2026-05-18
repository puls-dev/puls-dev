import { ListDistributionsCommand }   from '@aws-sdk/client-cloudfront';
import { ListBucketsCommand }          from '@aws-sdk/client-s3';
import { ListFunctionsCommand }        from '@aws-sdk/client-lambda';
import { DescribeDBInstancesCommand }  from '@aws-sdk/client-rds';
import { ListHostedZonesCommand }      from '@aws-sdk/client-route-53';
import { getCFClient, getS3Client, getLambdaClient, getRDSClient, getR53Client } from './api.js';
import { Config } from '../../core/config.js';
import type { AwsInventory, AwsDistribution, AwsBucket, AwsLambdaFn, AwsRdsInstance, AwsHostedZone } from '../../types/inventory.js';

export async function listAwsResources(): Promise<AwsInventory> {
  const region = Config.get().providers.aws!.region;

  const [cfResult, s3Result, lambdaResult, rdsResult, r53Result] = await Promise.all([
    getCFClient().send(new ListDistributionsCommand({})),
    getS3Client().send(new ListBucketsCommand({})),
    getLambdaClient().send(new ListFunctionsCommand({ MaxItems: 50 })),
    getRDSClient().send(new DescribeDBInstancesCommand({})),
    getR53Client().send(new ListHostedZonesCommand({})),
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

  return { region, distributions, buckets, lambdas, rdsInstances, hostedZones };
}
