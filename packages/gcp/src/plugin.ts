import { registerProvider, printSection } from "@puls-dev/core";
import { listGcpResources } from "./list.js";
import { Config } from "@puls-dev/core";
import type { GcpInventory } from "@puls-dev/core";

export const gcpPlugin = {
  name: "gcp",
  isConfigured: (cfg: any) => !!(cfg?.serviceAccountPath || process.env.GCP_SA),
  list: listGcpResources,
  render: (inv: GcpInventory) => {
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
  },
  configure: (pOpts: any) => {
    Config.set({
      providers: {
        gcp: { ...Config.get().providers.gcp, ...pOpts },
      },
    });
  }
};

registerProvider(gcpPlugin);
