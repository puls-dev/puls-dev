import { getProjectId, hostingFetch, cloudFetch } from "./api.js";
import type { FirebaseInventory, FirebaseHosting, FirebaseFunction } from "../../types/inventory.js";

export async function listFirebaseResources(): Promise<FirebaseInventory> {
  const project = getProjectId();

  const [hostRes, fnRes] = await Promise.all([
    hostingFetch(`/projects/${project}/sites`).catch(() => ({})),
    cloudFetch("https://cloudfunctions.googleapis.com/v2", `/projects/${project}/locations/-/functions`).catch(() => ({})),
  ]);

  // 1. Map Hosting Sites
  const hostingSites: FirebaseHosting[] = (hostRes.sites ?? []).map((s: any) => ({
    site: s.name.split("/").pop() ?? "unknown",
  }));

  // 2. Map Cloud Functions
  const functions: FirebaseFunction[] = (fnRes.functions ?? []).map((f: any) => {
    const parts = f.name.split("/");
    const name = parts.pop() ?? "unknown";
    const region = parts[parts.indexOf("locations") + 1] ?? "unknown";
    return {
      name,
      region,
      entryPoint: f.buildConfig?.entryPoint ?? "unknown",
      runtime: f.buildConfig?.runtime ?? "unknown",
    };
  });

  return { hostingSites, functions };
}
