import { BaseBuilder } from "@puls-dev/core";
import { cloudFetch, getProjectId } from "./api.js";

const APP_CHECK_BASE = "https://firebaseappcheck.googleapis.com";

const SERVICE_IDS: Record<string, string> = {
  firestore: "firestore.googleapis.com",
  storage: "firebasestorage.googleapis.com",
  database: "firebasedatabase.googleapis.com",
  auth: "identitytoolkit.googleapis.com",
};

function resolveServiceId(name: string): string {
  return SERVICE_IDS[name.toLowerCase()] ?? name;
}

export class FirebaseAppCheckBuilder extends BaseBuilder {
  private _configs: Map<string, "ENFORCED" | "UNENFORCED" | "OFF"> = new Map();

  constructor() {
    super("appcheck");
    this.discoveryPromise = Promise.resolve(null);
  }

  enforce(serviceName: string) {
    this._configs.set(resolveServiceId(serviceName), "ENFORCED");
    return this;
  }

  unenforced(serviceName: string) {
    this._configs.set(resolveServiceId(serviceName), "UNENFORCED");
    return this;
  }

  off(serviceName: string) {
    this._configs.set(resolveServiceId(serviceName), "OFF");
    return this;
  }

  mode(serviceName: string, mode: "ENFORCED" | "UNENFORCED" | "OFF") {
    this._configs.set(resolveServiceId(serviceName), mode);
    return this;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();

    console.log(`\n🛡️  Finalizing Firebase App Check...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] Configure App Check enforcement modes:`);
      for (const [serviceId, mode] of this._configs.entries()) {
        console.log(`      └─ ${serviceId}: ${mode}`);
      }
      return { project };
    }

    // 1. Fetch current status of each configured service
    const existingConfigs: Record<string, "ENFORCED" | "UNENFORCED" | "OFF"> = {};
    for (const serviceId of this._configs.keys()) {
      try {
        const data = await cloudFetch(
          APP_CHECK_BASE,
          `/v1/projects/${project}/services/${serviceId}`
        );
        existingConfigs[serviceId] = data.enforcementMode ?? "OFF";
      } catch (err: any) {
        // If not found or not registered yet, default to OFF
        existingConfigs[serviceId] = "OFF";
      }
    }

    // 2. Patch services whose modes have changed
    for (const [serviceId, mode] of this._configs.entries()) {
      const existingMode = existingConfigs[serviceId] ?? "OFF";
      if (existingMode !== mode) {
        console.log(`   🔄 Updating App Check service "${serviceId}": ${existingMode} → ${mode}`);
        await cloudFetch(
          APP_CHECK_BASE,
          `/v1/projects/${project}/services/${serviceId}?updateMask=enforcementMode`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: `projects/${project}/services/${serviceId}`,
              enforcementMode: mode,
            }),
          }
        );
        console.log(`   ✅ App Check service "${serviceId}" updated to ${mode}`);
      } else {
        console.log(`   ✅ App Check service "${serviceId}" already set to ${mode}`);
      }
    }

    await this.deploySidecars();
    return { project };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();

    console.log(`\n🗑️  Destroying Firebase App Check...`);
    console.log(`   ℹ️  Reverting all configured services to OFF enforcement mode`);

    if (dryRun) {
      for (const serviceId of this._configs.keys()) {
        console.log(`   📝 [PLAN] Revert ${serviceId} App Check to OFF`);
      }
      return { destroyed: "appcheck" };
    }

    for (const serviceId of this._configs.keys()) {
      try {
        console.log(`   🔄 Reverting App Check service "${serviceId}" to OFF...`);
        await cloudFetch(
          APP_CHECK_BASE,
          `/v1/projects/${project}/services/${serviceId}?updateMask=enforcementMode`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: `projects/${project}/services/${serviceId}`,
              enforcementMode: "OFF",
            }),
          }
        );
        console.log(`   ✅ App Check service "${serviceId}" reverted to OFF`);
      } catch (err) {
        // Log error and continue teardown silently
      }
    }

    await this.destroySidecars();
    return { destroyed: "appcheck" };
  }
}
