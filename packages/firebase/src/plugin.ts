import { readFileSync } from "node:fs";
import { registerProvider, printSection, Config, DiscoveredResource } from "@puls-dev/core";
import { listFirebaseResources } from "./list.js";
import type { FirebaseInventory } from "@puls-dev/core";

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
      Config.set({ providers: { firebase: { projectId: sa.project_id, serviceAccountPath: pOpts } } });
    } else {
      Config.set({ providers: { firebase: pOpts } });
    }
  },
  parseInventory: (inv: FirebaseInventory): DiscoveredResource[] => {
    const toPropertyName = (name: string) => name.replace(/[^a-zA-Z0-9]/g, "_").replace(/^([0-9])/, "_$1");
    const resources: DiscoveredResource[] = [];

    inv.hostingSites.forEach((s) => resources.push({
      id: s.site, name: s.site, type: "Firebase.Hosting",
      provider: "firebase", tier: "compute",
      propertyName: toPropertyName(s.site), original: s,
    }));

    inv.functions.forEach((f) => resources.push({
      id: f.name, name: f.name, type: "Firebase.Functions",
      provider: "firebase", tier: "compute",
      propertyName: toPropertyName(f.name), original: f,
    }));

    inv.firestoreDbs.forEach((d) => resources.push({
      id: d.name, name: d.name, type: "Firebase.Firestore",
      provider: "firebase", tier: "database",
      propertyName: toPropertyName(d.name), original: d,
    }));

    inv.storageBuckets.forEach((b) => resources.push({
      id: b.name, name: b.name, type: "Firebase.Storage",
      provider: "firebase", tier: "database",
      propertyName: toPropertyName(b.name), original: b,
    }));

    return resources;
  },
  getPropertyChain: (res: DiscoveredResource): string => {
    if (res.type === "Firebase.Functions") {
      let chain = "";
      if (res.original?.region)     chain += `\n    .region("${res.original.region}")`;
      if (res.original?.runtime)    chain += `\n    .runtime("${res.original.runtime}")`;
      if (res.original?.entryPoint) chain += `\n    .entryPoint("${res.original.entryPoint}")`;
      return chain;
    }
    return "";
  },
};

registerProvider(firebasePlugin);
