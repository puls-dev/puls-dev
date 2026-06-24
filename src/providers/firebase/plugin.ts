import { readFileSync } from "node:fs";
import { registerProvider, printSection } from "../../core/provider.js";
import { listFirebaseResources } from "./list.js";
import { Config } from "../../core/config.js";
import type { FirebaseInventory } from "../../types/inventory.js";

export const firebasePlugin = {
  name: "firebase",
  isConfigured: (cfg: any) => !!(cfg?.serviceAccountPath || process.env.FIREBASE_SA),
  list: listFirebaseResources,
  render: (inv: FirebaseInventory) => {
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
  },
  configure: (pOpts: any) => {
    if (typeof pOpts === "string") {
      const sa = JSON.parse(readFileSync(pOpts, "utf8"));
      Config.set({
        providers: {
          firebase: { projectId: sa.project_id, serviceAccountPath: pOpts },
        },
      });
    } else {
      Config.set({
        providers: {
          firebase: { ...Config.get().providers.firebase, ...pOpts },
        },
      });
    }
  }
};

registerProvider(firebasePlugin);
