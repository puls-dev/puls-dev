import { registerProvider, printSection } from "@puls-dev/core";
import { listAwsResources } from "./list.js";
import { Config } from "@puls-dev/core";
import type { AwsInventory } from "@puls-dev/core";

export const awsPlugin = {
  name: "aws",
  isConfigured: (cfg: any) => !!cfg?.region,
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
        aws: { ...Config.get().providers.aws, ...pOpts },
      },
    });
  }
};

registerProvider(awsPlugin);
