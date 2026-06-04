import "reflect-metadata";
import { Config } from "./config.js";
import type {
  InventoryResult,
  InventoryError,
  ProxmoxInventory,
  DoInventory,
  AwsInventory,
  GcpInventory,
  FirebaseInventory,
} from "../types/inventory.ts";


// ─── Box-drawing ──────────────────────────────────────────────────────────────

type Col<T> = { header: string; width: number; render: (row: T) => string };

function clip(text: string, width: number): string {
  return text.length > width
    ? text.slice(0, width - 1) + "…"
    : text.padEnd(width);
}

function printSection<T>(title: string, rows: T[], cols: Col<T>[]): void {
  const colsWidth =
    cols.reduce((s, c) => s + c.width, 0) + (cols.length - 1) * 2;
  const innerWidth = Math.max(colsWidth + 4, title.length + 4);
  const bar = (l: string, r: string) => `  ${l}${"─".repeat(innerWidth)}${r}`;
  const row = (content: string) => `  │  ${content.padEnd(innerWidth - 4)}  │`;

  console.log("");
  console.log(bar("┌", "┐"));
  console.log(row(title));
  console.log(bar("├", "┤"));

  if (rows.length === 0) {
    console.log(row("(none)"));
  } else {
    const headerLine = cols
      .map((c) => clip(c.header.toUpperCase(), c.width))
      .join("  ");
    console.log(row(headerLine));
    console.log(bar("├", "┤"));
    for (const r of rows) {
      console.log(row(cols.map((c) => clip(c.render(r), c.width)).join("  ")));
    }
  }

  console.log(bar("└", "┘"));
}

// ─── Per-provider renderers ───────────────────────────────────────────────────

function renderProxmox(inv: ProxmoxInventory): void {
  const running = inv.vms.filter((v) => v.status === "running").length;
  printSection(
    `Proxmox  ·  ${inv.vms.length} VM${inv.vms.length !== 1 ? "s" : ""}  (${running} running)`,
    inv.vms,
    [
      { header: "Name", width: 26, render: (v) => v.name },
      { header: "VMID", width: 6, render: (v) => String(v.vmid) },
      { header: "Node", width: 12, render: (v) => v.node },
      { header: "Status", width: 8, render: (v) => v.status },
      {
        header: "Mem",
        width: 6,
        render: (v) => `${Math.round(v.maxmem / 1024 ** 3)}GB`,
      },
      {
        header: "Disk",
        width: 6,
        render: (v) => `${Math.round(v.maxdisk / 1024 ** 3)}GB`,
      },
    ],
  );

  if (inv.templates.length > 0) {
    printSection(
      `Proxmox Templates  ·  ${inv.templates.length}`,
      inv.templates,
      [
        { header: "Name", width: 32, render: (t) => t.name },
        { header: "VMID", width: 6, render: (t) => String(t.vmid) },
        { header: "Node", width: 12, render: (t) => t.node },
      ],
    );
  }
}

function renderDo(inv: DoInventory): void {
  const costStr =
    inv.totalMonthlyCost > 0 ? `  ·  $${inv.totalMonthlyCost}/mo` : "";
  printSection(
    `DigitalOcean Droplets  ·  ${inv.droplets.length}${costStr}`,
    inv.droplets,
    [
      { header: "Name", width: 24, render: (d) => d.name },
      { header: "Region", width: 6, render: (d) => d.region },
      { header: "Size", width: 18, render: (d) => d.size },
      { header: "Status", width: 8, render: (d) => d.status },
      { header: "IP", width: 15, render: (d) => d.ip ?? "-" },
      {
        header: "$/mo",
        width: 5,
        render: (d) => (d.monthlyCost > 0 ? `$${d.monthlyCost}` : "?"),
      },
    ],
  );

  if (inv.firewalls.length > 0) {
    printSection(
      `DigitalOcean Firewalls  ·  ${inv.firewalls.length}`,
      inv.firewalls,
      [
        { header: "Name", width: 32, render: (f) => f.name },
        { header: "Droplets", width: 8, render: (f) => String(f.dropletCount) },
      ],
    );
  }

  if (inv.loadBalancers.length > 0) {
    printSection(
      `DigitalOcean Load Balancers  ·  ${inv.loadBalancers.length}`,
      inv.loadBalancers,
      [
        { header: "Name", width: 24, render: (lb) => lb.name },
        { header: "Region", width: 6, render: (lb) => lb.region },
        { header: "IP", width: 15, render: (lb) => lb.ip },
        { header: "Status", width: 8, render: (lb) => lb.status },
      ],
    );
  }

  if (inv.domains.length > 0) {
    printSection(
      `DigitalOcean Domains  ·  ${inv.domains.length}`,
      inv.domains,
      [
        { header: "Domain", width: 42, render: (d) => d.name },
        { header: "TTL", width: 6, render: (d) => String(d.ttl) },
      ],
    );
  }

  if (inv.databases.length > 0) {
    printSection(
      `DigitalOcean Databases  ·  ${inv.databases.length}`,
      inv.databases,
      [
        { header: "Name", width: 24, render: (d) => d.name },
        { header: "Engine", width: 14, render: (d) => d.engine },
        { header: "Region", width: 8, render: (d) => d.region },
        { header: "Status", width: 10, render: (d) => d.status },
        { header: "Nodes", width: 5, render: (d) => String(d.nodeCount) },
      ],
    );
  }

  if (inv.apps.length > 0) {
    printSection(
      `DigitalOcean Apps  ·  ${inv.apps.length}`,
      inv.apps,
      [
        { header: "Name", width: 24, render: (a) => a.name },
        { header: "Status", width: 12, render: (a) => a.status },
        { header: "URL", width: 40, render: (a) => a.liveUrl || "-" },
      ],
    );
  }

  if (inv.vpcs.length > 0) {
    printSection(
      `DigitalOcean VPCs  ·  ${inv.vpcs.length}`,
      inv.vpcs,
      [
        { header: "Name", width: 24, render: (v) => v.name },
        { header: "Region", width: 8, render: (v) => v.region },
        { header: "IP Range", width: 20, render: (v) => v.ipRange },
      ],
    );
  }
}

function renderAws(inv: AwsInventory): void {
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
}

function renderGcp(inv: GcpInventory): void {
  if (inv.vms.length > 0) {
    printSection(
      `GCP Compute VMs  ·  ${inv.vms.length}`,
      inv.vms,
      [
        { header: "Name", width: 24, render: (v) => v.name },
        { header: "Zone", width: 15, render: (v) => v.zone },
        { header: "Machine Type", width: 14, render: (v) => v.machineType },
        { header: "Status", width: 8, render: (v) => v.status },
        { header: "IP", width: 15, render: (v) => v.ip },
      ],
    );
  }

  if (inv.rdsInstances.length > 0) {
    printSection(
      `GCP Cloud SQL  ·  ${inv.rdsInstances.length}`,
      inv.rdsInstances,
      [
        { header: "Name", width: 24, render: (i) => i.name },
        { header: "Engine", width: 18, render: (i) => i.engine },
        { header: "Tier", width: 12, render: (i) => i.tier },
        { header: "Status", width: 10, render: (i) => i.status },
      ],
    );
  }

  if (inv.distributions.length > 0) {
    printSection(
      `GCP Cloud Run  ·  ${inv.distributions.length}`,
      inv.distributions,
      [
        { header: "Service", width: 24, render: (s) => s.name },
        { header: "Region", width: 12, render: (s) => s.region },
        { header: "URL", width: 42, render: (s) => s.url },
      ],
    );
  }

  if (inv.hostedZones.length > 0) {
    printSection(
      `GCP Cloud DNS  ·  ${inv.hostedZones.length}`,
      inv.hostedZones,
      [
        { header: "Zone", width: 24, render: (z) => z.name },
        { header: "DNS Name", width: 32, render: (z) => z.dnsName },
      ],
    );
  }

  if (inv.pubSubTopics.length > 0) {
    printSection(
      `GCP Pub/Sub Topics  ·  ${inv.pubSubTopics.length}`,
      inv.pubSubTopics,
      [
        { header: "Topic", width: 52, render: (t) => t.name },
      ],
    );
  }

  if (inv.secrets.length > 0) {
    printSection(
      `GCP Secret Manager  ·  ${inv.secrets.length}`,
      inv.secrets,
      [
        { header: "Secret", width: 52, render: (s) => s.name },
      ],
    );
  }
}

function renderFirebase(inv: FirebaseInventory): void {
  if (inv.hostingSites.length > 0) {
    printSection(
      `Firebase Hosting  ·  ${inv.hostingSites.length}`,
      inv.hostingSites,
      [
        { header: "Site ID", width: 32, render: (s) => s.site },
      ],
    );
  }

  if (inv.functions.length > 0) {
    printSection(
      `Firebase Functions  ·  ${inv.functions.length}`,
      inv.functions,
      [
        { header: "Function", width: 24, render: (f) => f.name },
        { header: "Region", width: 12, render: (f) => f.region },
        { header: "Entry Point", width: 18, render: (f) => f.entryPoint },
        { header: "Runtime", width: 10, render: (f) => f.runtime },
      ],
    );
  }

  if (inv.firestoreDbs.length > 0) {
    printSection(
      `Firebase Firestore  ·  ${inv.firestoreDbs.length}`,
      inv.firestoreDbs,
      [
        { header: "Database", width: 24, render: (d) => d.name },
        { header: "Type", width: 20, render: (d) => d.type },
        { header: "State", width: 10, render: (d) => d.state },
      ],
    );
  }

  if (inv.storageBuckets.length > 0) {
    printSection(
      `Firebase Storage  ·  ${inv.storageBuckets.length}`,
      inv.storageBuckets,
      [
        { header: "Bucket", width: 40, render: (b) => b.name },
        { header: "Location", width: 12, render: (b) => b.location },
      ],
    );
  }

  if (inv.authProviders.length > 0) {
    printSection(
      `Firebase Auth  ·  ${inv.authProviders.length} provider${inv.authProviders.length !== 1 ? "s" : ""}`,
      inv.authProviders,
      [
        { header: "Provider", width: 32, render: (p) => p.providerId },
      ],
    );
  }

  if (inv.remoteConfig) {
    const rc = inv.remoteConfig;
    printSection(
      `Firebase RemoteConfig  ·  v${rc.version}`,
      [rc],
      [
        { header: "Parameters", width: 10, render: (r) => String(r.parameterCount) },
        { header: "Version", width: 12, render: (r) => r.version },
      ],
    );
  }
}

// ─── Checker ──────────────────────────────────────────────────────────────────

export abstract class Checker {
  async check(): Promise<InventoryResult> {
    const cfg = Config.get();
    const errors: InventoryError[] = [];
    const result: InventoryResult = { errors };
    const tasks: Promise<void>[] = [];

    console.log(`\n🔍 Checking infrastructure...`);

    if (cfg.providers.proxmox?.url && cfg.providers.proxmox?.tokenSecret) {
      tasks.push(
        import("../providers/proxmox/list.js")
          .then((m) => m.listProxmoxVMs())
          .then((inv) => {
            result.proxmox = inv;
          })
          .catch((err: Error) => {
            errors.push({ provider: "proxmox", message: err.message });
          }),
      );
    }

    if (cfg.providers.do?.token) {
      tasks.push(
        import("../providers/do/list.js")
          .then((m) => m.listDoResources())
          .then((inv) => {
            result.do = inv;
          })
          .catch((err: Error) => {
            errors.push({ provider: "do", message: err.message });
          }),
      );
    }

    if (cfg.providers.aws?.region) {
      tasks.push(
        import("../providers/aws/list.js")
          .then((m) => m.listAwsResources())
          .then((inv) => {
            result.aws = inv;
          })
          .catch((err: Error) => {
            errors.push({ provider: "aws", message: err.message });
          }),
      );
    }

    if (cfg.providers.gcp?.serviceAccountPath || process.env.GCP_SA) {
      tasks.push(
        import("../providers/gcp/list.js")
          .then((m) => m.listGcpResources())
          .then((inv) => {
            result.gcp = inv;
          })
          .catch((err: Error) => {
            errors.push({ provider: "gcp", message: err.message });
          }),
      );
    }

    if (cfg.providers.firebase?.serviceAccountPath || process.env.FIREBASE_SA) {
      tasks.push(
        import("../providers/firebase/list.js")
          .then((m) => m.listFirebaseResources())
          .then((inv) => {
            result.firebase = inv;
          })
          .catch((err: Error) => {
            errors.push({ provider: "firebase", message: err.message });
          }),
      );
    }

    await Promise.all(tasks);

    if (result.proxmox) renderProxmox(result.proxmox);
    if (result.do) renderDo(result.do);
    if (result.aws) renderAws(result.aws);
    if (result.gcp) renderGcp(result.gcp);
    if (result.firebase) renderFirebase(result.firebase);

    for (const e of errors) {
      console.warn(`\n  [!] ${e.provider}: ${e.message}`);
    }

    const totalCost = result.do?.totalMonthlyCost ?? 0;
    if (totalCost > 0) {
      console.log(
        `\n  Total estimated monthly cost (DigitalOcean): $${totalCost}`,
      );
    }

    return result;
  }
}
