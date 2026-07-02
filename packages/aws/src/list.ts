import { ListDistributionsCommand }   from '@aws-sdk/client-cloudfront';
import { ListBucketsCommand }          from '@aws-sdk/client-s3';
import { ListFunctionsCommand }        from '@aws-sdk/client-lambda';
import { DescribeDBInstancesCommand }  from '@aws-sdk/client-rds';
import { ListHostedZonesCommand, ListResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { DescribeInstancesCommand, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { getCFClient, getS3Client, getLambdaClient, getRDSClient, getR53Client, getEC2Client } from './api.js';
import { Config } from '@puls-dev/core';
import type {
  AwsInventory, AwsDistribution, AwsBucket, AwsLambdaFn,
  AwsRdsInstance, AwsHostedZone, AwsEc2Instance,
} from '@puls-dev/core';

export async function listAwsResources(): Promise<AwsInventory> {
  const defaultRegion = Config.get().providers.aws?.region ?? "us-east-1";

  // Determine all active regions to scan
  let regionsToScan = [defaultRegion];
  try {
    const ec2Client = getEC2Client(defaultRegion);
    const regionsRes = await ec2Client.send(new DescribeRegionsCommand({}));
    const parsedRegions = (regionsRes.Regions ?? [])
      .filter((r) => r.OptInStatus !== "not-opted-in")
      .map((r) => r.RegionName!);
    if (parsedRegions.length > 0) {
      regionsToScan = parsedRegions;
    }
  } catch (err) {
    // If DescribeRegions fails (e.g. offline/mock or restricted permissions), fall back to standard list
    regionsToScan = [
      "us-east-1", "us-east-2", "us-west-1", "us-west-2",
      "eu-central-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1",
      "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1", "ap-southeast-1", "ap-southeast-2",
      "sa-east-1", "ca-central-1"
    ];
  }

  if (regionsToScan.length === 0) {
    regionsToScan = [defaultRegion];
  }

  // Query global services (once)
  const [cfResult, s3Result, r53Result] = await Promise.all([
    getCFClient().send(new ListDistributionsCommand({})),
    getS3Client().send(new ListBucketsCommand({})),
    getR53Client().send(new ListHostedZonesCommand({})),
  ]);

  // Query regional services in parallel across all regions
  const lambdaResults = await Promise.all(
    regionsToScan.map(async (r) => {
      try {
        const res = await getLambdaClient(r).send(new ListFunctionsCommand({ MaxItems: 50 }));
        return (res.Functions ?? []).map((f) => ({
          name:         f.FunctionName!,
          runtime:      f.Runtime ?? 'unknown',
          memorySizeMb: f.MemorySize ?? 0,
          region:       r,
        }));
      } catch {
        return [];
      }
    })
  );

  const rdsResults = await Promise.all(
    regionsToScan.map(async (r) => {
      try {
        const res = await getRDSClient(r).send(new DescribeDBInstancesCommand({}));
        return (res.DBInstances ?? []).map((i) => ({
          identifier:    i.DBInstanceIdentifier!,
          engine:        `${i.Engine} ${i.EngineVersion}`,
          instanceClass: i.DBInstanceClass!,
          status:        i.DBInstanceStatus ?? '',
          endpoint:      i.Endpoint?.Address,
          region:        r,
        }));
      } catch {
        return [];
      }
    })
  );

  const ec2Results = await Promise.all(
    regionsToScan.map(async (r) => {
      try {
        const res = await getEC2Client(r).send(new DescribeInstancesCommand({ MaxResults: 200 }));
        return (res.Reservations ?? [])
          .flatMap((resv) => resv.Instances ?? [])
          .filter((i) => i.State?.Name !== 'terminated')
          .map((i) => ({
            id:       i.InstanceId!,
            name:     i.Tags?.find((t) => t.Key === 'Name')?.Value ?? i.InstanceId!,
            type:     i.InstanceType ?? 'unknown',
            state:    i.State?.Name ?? 'unknown',
            publicIp: i.PublicIpAddress,
            region:   r,
          }));
      } catch {
        return [];
      }
    })
  );

  const distributions: AwsDistribution[] = (cfResult.DistributionList?.Items ?? []).map((d) => ({
    id:      d.Id!,
    domain:  d.DomainName!,
    aliases: d.Aliases?.Items ?? [],
    origins: d.Origins?.Items?.map(o => ({ domainName: o.DomainName })) ?? [],
    status:  d.Status ?? '',
  }));

  const buckets: AwsBucket[] = (s3Result.Buckets ?? []).map((b) => ({
    name: b.Name!,
  }));

  const lambdas: AwsLambdaFn[] = lambdaResults.flat();
  const rdsInstances: AwsRdsInstance[] = rdsResults.flat();
  const ec2Instances: AwsEc2Instance[] = ec2Results.flat();

  const hostedZones: AwsHostedZone[] = await Promise.all(
    (r53Result.HostedZones ?? []).map(async (z) => {
      const zoneId = z.Id!.replace('/hostedzone/', '');
      let records: Array<{ name: string; type: string; value: string; ttl: number }> = [];
      try {
        const recordsResult = await getR53Client().send(
          new ListResourceRecordSetsCommand({ HostedZoneId: zoneId })
        );
        records = (recordsResult.ResourceRecordSets ?? []).map((r) => ({
          name: r.Name!,
          type: r.Type!,
          value: (r.ResourceRecords ?? []).map((rv) => rv.Value!).join(", ") || r.AliasTarget?.DNSName || "",
          ttl: r.TTL ?? 300,
        }));
      } catch (err: any) {
        // Fallback or ignore if credentials don't permit reading record sets
      }
      return {
        name: z.Name!,
        id: zoneId,
        recordCount: z.ResourceRecordSetCount ?? records.length,
        records,
      };
    })
  );

  return { region: defaultRegion, distributions, buckets, lambdas, rdsInstances, hostedZones, ec2Instances: ec2Instances as any };
}
