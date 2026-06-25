import { getProjectId, hostingFetch, cloudFetch } from "./api.js";
import type {
  FirebaseInventory, FirebaseHosting, FirebaseFunction,
  FirebaseFirestoreDb, FirebaseStorageBucket, FirebaseAuthProvider, FirebaseRemoteConfig,
} from "@puls-dev/core";

export async function listFirebaseResources(): Promise<FirebaseInventory> {
  const project = getProjectId();

  const [hostRes, fnRes, firestoreRes, storageRes, authRes, rcRes] = await Promise.all([
    hostingFetch(`/projects/${project}/sites`).catch(() => ({})),
    cloudFetch("https://cloudfunctions.googleapis.com/v2", `/projects/${project}/locations/-/functions`).catch(() => ({})),
    cloudFetch("https://firestore.googleapis.com/v1", `/projects/${project}/databases`).catch(() => ({})),
    cloudFetch("https://storage.googleapis.com/storage/v1", `/b?project=${project}`).catch(() => ({})),
    cloudFetch("https://identitytoolkit.googleapis.com/admin/v2", `/projects/${project}/config`).catch(() => ({})),
    cloudFetch("https://firebaseremoteconfig.googleapis.com/v1", `/projects/${project}/remoteConfig`).catch(() => ({})),
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

  // 3. Map Firestore Databases
  const firestoreDbs: FirebaseFirestoreDb[] = (firestoreRes.databases ?? []).map((d: any) => ({
    name:  d.name.split("/").pop() ?? d.name,
    type:  d.type ?? "FIRESTORE_NATIVE",
    state: d.state ?? "unknown",
  }));

  // 4. Map Storage Buckets (filter to project-owned buckets)
  const storageBuckets: FirebaseStorageBucket[] = (storageRes.items ?? [])
    .filter((b: any) => b.name?.includes(project))
    .map((b: any) => ({
      name:     b.name,
      location: b.location ?? "unknown",
    }));

  // 5. Map Auth Sign-in Providers from Identity Toolkit config
  const signIn = authRes.signIn ?? {};
  const authProviders: FirebaseAuthProvider[] = [
    ...(signIn.email?.enabled     ? [{ providerId: "email/password" }] : []),
    ...(signIn.phoneNumber?.enabled ? [{ providerId: "phone" }] : []),
    ...(signIn.anonymous?.enabled   ? [{ providerId: "anonymous" }] : []),
  ];

  // 6. Map RemoteConfig
  let remoteConfig: FirebaseRemoteConfig | undefined;
  if (rcRes.parameters !== undefined || rcRes.version) {
    remoteConfig = {
      parameterCount: Object.keys(rcRes.parameters ?? {}).length,
      version: rcRes.version?.versionNumber ?? "unknown",
    };
  }

  return { hostingSites, functions, firestoreDbs, storageBuckets, authProviders, remoteConfig };
}
