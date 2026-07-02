import { registerProvider, printSection, Config, DiscoveredResource, ResourceGroup } from "@puls-dev/core";
import { listAwsResources } from "./list.js";
import type { AwsInventory } from "@puls-dev/core";

export const awsPlugin = {
  name: "aws",
  isConfigured: (cfg: any) => !!(cfg?.region || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_PROFILE),
  list: listAwsResources,
  render: (inv: AwsInventory) => {
    if (inv.ec2Instances.length > 0) {
      printSection(
        `AWS EC2  ·  ${inv.ec2Instances.length} instances  ·  ${inv.region}`,
        inv.ec2Instances,
        [
          { header: "Name", width: 24, render: (i) => i.name },
          { header: "ID", width: 20, render: (i) => i.id },
          { header: "Type", width: 14, render: (i) => i.type },
          { header: "State", width: 10, render: (i) => i.state },
          { header: "IP", width: 15, render: (i) => i.publicIp ?? "-" },
        ],
      );
    }

    if (inv.distributions.length > 0) {
      printSection(
        `AWS CloudFront  ·  ${inv.distributions.length}  ·  ${inv.region}`,
        inv.distributions,
        [
          { header: "ID", width: 14, render: (d) => d.id },
          {
            header: "Domain",
            width: 34,
            render: (d) => d.aliases[0] ?? d.domain,
          },
          { header: "Status", width: 10, render: (d) => d.status },
        ],
      );
    }

    if (inv.buckets.length > 0) {
      printSection(`AWS S3  ·  ${inv.buckets.length} buckets`, inv.buckets, [
        { header: "Bucket", width: 52, render: (b) => b.name },
      ]);
    }

    if (inv.lambdas.length > 0) {
      printSection(
        `AWS Lambda  ·  ${inv.lambdas.length} functions`,
        inv.lambdas,
        [
          { header: "Function", width: 32, render: (f) => f.name },
          { header: "Runtime", width: 12, render: (f) => f.runtime },
          { header: "Memory", width: 8, render: (f) => `${f.memorySizeMb}MB` },
        ],
      );
    }

    if (inv.rdsInstances.length > 0) {
      printSection(
        `AWS RDS  ·  ${inv.rdsInstances.length} instances`,
        inv.rdsInstances,
        [
          { header: "Identifier", width: 26, render: (i) => i.identifier },
          { header: "Engine", width: 18, render: (i) => i.engine },
          { header: "Class", width: 14, render: (i) => i.instanceClass },
          { header: "Status", width: 10, render: (i) => i.status },
        ],
      );
    }

    if (inv.hostedZones.length > 0) {
      printSection(
        `AWS Route53  ·  ${inv.hostedZones.length} zones`,
        inv.hostedZones,
        [
          { header: "Zone", width: 38, render: (z) => z.name },
          { header: "Records", width: 7, render: (z) => String(z.recordCount) },
        ],
      );
    }
  },
  configure: (pOpts: any) => {
    Config.set({
      providers: {
        aws: pOpts,
      },
    });
  },
  parseInventory: (inv: AwsInventory): DiscoveredResource[] => {
    const rawResources: DiscoveredResource[] = [];
    const toPropertyName = (name: string) => name.replace(/[^a-zA-Z0-9]/g, "_").replace(/^([0-9])/, "_$1");

    inv.hostedZones?.forEach((z: any) =>
      rawResources.push({
        id: z.id,
        name: z.name,
        type: "AWS.Route53",
        provider: "aws",
        tier: "network",
        propertyName: toPropertyName(z.name),
        original: z,
      })
    );
    inv.buckets?.forEach((b: any) =>
      rawResources.push({
        id: b.name,
        name: b.name,
        type: "AWS.S3",
        provider: "aws",
        tier: "database",
        propertyName: toPropertyName(b.name),
        original: b,
      })
    );
    inv.rdsInstances?.forEach((i: any) =>
      rawResources.push({
        id: i.identifier,
        name: i.identifier,
        type: "AWS.RDS",
        provider: "aws",
        tier: "database",
        propertyName: toPropertyName(i.identifier),
        original: i,
      })
    );
    inv.distributions?.forEach((d: any) =>
      rawResources.push({
        id: d.id,
        name: d.id,
        type: "AWS.CloudFront",
        provider: "aws",
        tier: "compute",
        propertyName: toPropertyName(d.id),
        original: d,
      })
    );
    inv.ec2Instances?.forEach((i: any) =>
      rawResources.push({
        id: i.id,
        name: i.name,
        type: "AWS.EC2",
        provider: "aws",
        tier: "compute",
        propertyName: toPropertyName(i.name),
        original: i,
      })
    );
    return rawResources;
  },
  groupResources: (resources: DiscoveredResource[]): ResourceGroup[] => {
    const groups: ResourceGroup[] = [];
    const processedIds = new Set<string | number>();

    const dnsZones = resources.filter((r) => r.type === "AWS.Route53");
    dnsZones.forEach((zone) => {
      processedIds.add(zone.id);
      const recordCount = zone.original?.records?.length ?? 0;

      groups.push({
        id: `dns:${zone.id}`,
        name: `🗺️  DNS Zone: ${zone.name}`,
        provider: zone.provider,
        description: `Hosted Zone boundary with ${recordCount} records`,
        resources: [zone],
      });
    });

    // Default standalone group for rest
    resources.forEach((r) => {
      if (processedIds.has(r.id)) return;
      processedIds.add(r.id);
      groups.push({
        id: `standalone:${r.id}`,
        name: `📦  [${r.type}] ${r.name}`,
        provider: r.provider,
        description: `Standalone resource`,
        resources: [r],
      });
    });

    return groups;
  },
  getPropertyChain: (res: DiscoveredResource): string => {
    let chain = "";
    if (res.type === "AWS.EC2") {
      if (res.original?.type) {
        chain += `\n    .instanceType("${res.original.type}")`;
      }
    } else if (res.type === "AWS.Route53") {
      if (res.original?.records) {
        res.original.records.forEach((rec: any) => {
          if (rec.type === "NS" || rec.type === "SOA") return;
          const escapedVal = String(rec.value).replace(/"/g, '\\"');
          chain += `\n    .record("${rec.name}", "${rec.type}", "${escapedVal}", ${rec.ttl})`;
        });
      }
    }
    return chain;
  }
};

registerProvider(awsPlugin);
