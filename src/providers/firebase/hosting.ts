import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { gzipSync } from "node:zlib";
import { BaseBuilder } from "../../core/resource.js";
import { getProjectId, hostingFetch, getFirebaseToken } from "./api.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".xml": "application/xml",
};

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function sha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export class FirebaseHostingBuilder extends BaseBuilder {
  private _sourcePath?: string;

  constructor(siteId: string) {
    super(siteId);
    // Discovery: check if the site has any releases (confirms it exists and is active)
    this.discoveryPromise = this.discoverSite(siteId);
  }

  source(path: string) {
    this._sourcePath = path;
    return this;
  }

  private async discoverSite(siteId: string): Promise<any> {
    try {
      const projectId = getProjectId();
      const result = await hostingFetch(`/projects/${projectId}/sites/${siteId}`);
      return result;
    } catch (e: any) {
      // Site doesn't exist yet or credentials not set yet - not an error at construction time
      if (e.message?.includes("403") || e.message?.includes("404")) return null;
      if (e.message?.includes("Firebase not configured")) return null;
      throw e;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const projectId = getProjectId();
    const siteId = this.name;
    const parent = `projects/${projectId}/sites/${siteId}`;

    console.log(`\n⚡ Finalizing Firebase Hosting "${siteId}"...`);

    if (!this._sourcePath)
      throw new Error(
        `[Firebase.Hosting:${siteId}] .source("./dist") is required`,
      );

    const files = walkDir(this._sourcePath);
    if (files.length === 0)
      throw new Error(
        `[Firebase.Hosting:${siteId}] No files found in "${this._sourcePath}"`,
      );

    const existing = await this.discoveryPromise;

    if (dryRun) {
      console.log(
        `   📝 [PLAN] Deploy ${files.length} file(s) to https://${siteId}.web.app`,
      );
      if (!existing) console.log(`      └─ Will create secondary site "${siteId}"`);
      for (const f of files.slice(0, 5)) {
        console.log(`      └─ /${relative(this._sourcePath, f)}`);
      }
      if (files.length > 5)
        console.log(`      └─ ... and ${files.length - 5} more`);
      return { siteId, url: `https://${siteId}.web.app` };
    }

    // 0. Ensure site exists (for secondary sites)
    if (!existing) {
      console.log(`   🆕 Creating secondary site "${siteId}"...`);
      try {
        await hostingFetch(`/projects/${projectId}/sites?siteId=${siteId}`, {
          method: "POST",
          body: JSON.stringify({}), // Defaults to USER_SITE
        });
      } catch (e: any) {
        if (!e.message.includes("409")) throw e;
      }
    }

    // 1. Create a new version
    const version = await hostingFetch(`/${parent}/versions`, {
      method: "POST",
      body: JSON.stringify({
        config: {
          headers: [
            { glob: "**", headers: { "Cache-Control": "max-age=3600" } },
          ],
        },
      }),
    });
    const versionId = version.name.split("/").pop();
    console.log(`   📦 Version created: ${versionId}`);

    // 2. Build file hash map - keys are URL paths, values are SHA256 hashes
    // NOTE: Firebase Hosting requires gzipped content and the hash must match the gzipped bytes.
    const fileMap: Record<string, string> = {};
    const absoluteToCompressed: Record<string, Buffer> = {};
    const hashToUrl: Record<string, string> = {};
    
    for (const absPath of files) {
      const urlPath = "/" + relative(this._sourcePath, absPath).replace(/\\/g, "/");
      const content = readFileSync(absPath);
      const compressed = gzipSync(content);
      const hash = createHash("sha256").update(compressed).digest("hex");
      
      fileMap[urlPath] = hash;
      absoluteToCompressed[absPath] = compressed;
      hashToUrl[hash] = absPath;
    }

    // 3. Populate files - API tells us which hashes need uploading
    const populate = await hostingFetch(
      `/${parent}/versions/${versionId}:populateFiles`,
      {
        method: "POST",
        body: JSON.stringify({ files: fileMap }),
      },
    );

    const uploadUrl: string = populate.uploadUrl;
    const required: string[] = populate.uploadRequiredHashes ?? [];

    console.log(
      `   📤 Uploading ${required.length} file(s) (${files.length - required.length} cached)`,
    );

    // 4. Upload each required file
    const token = await getFirebaseToken([
      "https://www.googleapis.com/auth/firebase.hosting",
    ]);
    for (const hash of required) {
      const absPath = hashToUrl[hash];
      const compressed = absoluteToCompressed[absPath];
      
      const res = await fetch(`${uploadUrl}/${hash}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        body: compressed,
      });
      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`Upload failed for ${absPath}: ${res.status} - ${errorBody}`);
      }
    }

    // 5. Finalize the version
    await hostingFetch(`/${parent}/versions/${versionId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "FINALIZED" }),
    });

    // 6. Create a release
    await hostingFetch(
      `/${parent}/releases?versionName=${parent}/versions/${versionId}`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );

    const url = `https://${siteId}.web.app`;
    console.log(`🚀 Deployed ${files.length} file(s) → ${url}`);
    return { siteId, url };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    console.log(`\n🗑️  Destroying Firebase Hosting site "${this.name}"...`);
    if (dryRun) {
      console.log(`   📝 [PLAN] Delete all releases for site "${this.name}"`);
      return { destroyed: this.name };
    }
    // Firebase doesn't support deleting the default site - we can only roll back releases.
    // For non-default sites, the Sites API supports deletion (requires Blaze plan).
    console.log(
      `   ℹ️  Firebase Hosting sites cannot be deleted via API (default site is permanent).`,
    );
    console.log(
      `      To unpublish, go to the Firebase console and disable Hosting.`,
    );
    return { destroyed: this.name };
  }
}
