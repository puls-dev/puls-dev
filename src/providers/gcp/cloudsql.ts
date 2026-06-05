import { BaseBuilder } from "../../core/resource.js";
import { gcpFetch, getProjectId, getRegion } from "./api.js";

const SQL_BASE = "https://sqladmin.googleapis.com";

const DB_PORT: Record<string, number> = {
  postgres: 5432,
  postgresql: 5432,
  mysql: 3306,
};

function formatDatabaseVersion(engine: string, version: string): string {
  const eng = engine.toLowerCase();
  if (eng === "postgres" || eng === "postgresql") {
    return `POSTGRES_${version.split(".")[0]}`;
  }
  if (eng === "mysql") {
    return `MYSQL_${version.replace(/\./g, "_")}`;
  }
  return `${engine.toUpperCase()}_${version}`;
}

export class GCPCloudSQLBuilder extends BaseBuilder {
  private _engine: string = "postgres";
  private _engineVersion: string = "16";
  private _tier: string = "db-f1-micro";
  private _storage: number = 10;
  private _username?: string;
  private _password?: string;
  private _dbName?: string;
  private _publicAccess: boolean = false;
  private _region?: string;

  resolvedEndpoint: string | null = null;
  resolvedPort: number | null = null;
  resolvedConnectionName: string | null = null;

  constructor(instanceId: string) {
    super(instanceId);
    this.discoveryPromise = this.discoverInstance();
  }

  engine(e: { engine: "postgres" | "mysql"; version: string }) {
    this._engine = e.engine;
    this._engineVersion = e.version;
    return this;
  }

  size(tier: string) {
    this._tier = tier;
    return this;
  }

  storage(gb: number) {
    this._storage = gb;
    return this;
  }

  credentials(username: string, password: string) {
    this._username = username;
    this._password = password;
    return this;
  }

  database(name: string) {
    this._dbName = name;
    return this;
  }

  publicAccess(enabled: boolean = true) {
    this._publicAccess = enabled;
    return this;
  }

  region(reg: string) {
    this._region = reg;
    this.discoveryPromise = this.discoverInstance();
    return this;
  }

  getDiff(existing: any) {
    const diffs = [];
    const declaredDbVersion = `${this._engine.toUpperCase()}_${this._engineVersion}`;
    if (existing.databaseVersion !== declaredDbVersion) {
      diffs.push({ field: "databaseVersion", declared: declaredDbVersion, live: existing.databaseVersion });
    }
    const liveTier = existing.settings?.tier;
    if (liveTier !== undefined && liveTier !== this._tier) {
      diffs.push({ field: "tier", declared: this._tier, live: liveTier });
    }
    const liveDiskSize = existing.settings?.dataDiskSizeGb;
    if (liveDiskSize !== undefined && Number(liveDiskSize) !== this._storage) {
      diffs.push({ field: "storage", declared: `${this._storage} GB`, live: `${liveDiskSize} GB` });
    }
    const isPublic = (existing.settings?.ipConfiguration?.authorizedNetworks ?? []).length > 0;
    if (isPublic !== this._publicAccess) {
      diffs.push({ field: "publicAccess", declared: this._publicAccess, live: isPublic });
    }
    return diffs;
  }

  private async discoverInstance(): Promise<any> {
    try {
      const project = getProjectId();
      const instanceId = this.name;
      const res = await gcpFetch(
        SQL_BASE,
        `/v1/projects/${project}/instances/${instanceId}`
      );
      if (res.state === "DELETED") return null;

      const primaryIp = res.ipAddresses?.find((ip: any) => ip.type === "PRIMARY")?.ipAddress;
      this.resolvedEndpoint = primaryIp ?? null;
      this.resolvedPort = DB_PORT[this._engine] ?? 5432;
      this.resolvedConnectionName = res.connectionName ?? null;
      return res;
    } catch (e: any) {
      if (
        e.message?.includes("404") ||
        e.message?.includes("403") ||
        e.message?.includes("credentials not configured")
      ) {
        return null;
      }
      throw e;
    }
  }

  private async waitForOperation(opName: string, label: string): Promise<void> {
    const project = getProjectId();
    await this.waitFor(
      label,
      async () => {
        const op = await gcpFetch(
          SQL_BASE,
          `/v1/projects/${project}/operations/${opName}`
        );
        if (op.status === "DONE") {
          if (op.error) {
            throw new Error(`Cloud SQL Operation failed: ${JSON.stringify(op.error)}`);
          }
          return true;
        }
        return false;
      },
      { intervalMs: 10_000, timeoutMs: 900_000 }
    );
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const location = this._region ?? getRegion();
    const instanceId = this.name;
    const port = DB_PORT[this._engine] ?? 5432;

    console.log(`\n⚡ Finalizing GCP Cloud SQL Instance "${instanceId}"...`);

    if (!this._username || !this._password) {
      throw new Error(`[GCP.CloudSQL:${instanceId}] .credentials(username, password) is required`);
    }

    const existing = await this.discoveryPromise;
    const targetDbVersion = formatDatabaseVersion(this._engine, this._engineVersion);

    const targetAuthorizedNetworks = this._publicAccess
      ? [{ value: "0.0.0.0/0", name: "internet" }]
      : [];

    if (dryRun) {
      console.log(
        `   📝 [PLAN] ${existing ? "Update" : "Create"} Cloud SQL instance "${instanceId}" in ${location}`
      );
      console.log(`      └─ Engine: ${this._engine} (${targetDbVersion})`);
      console.log(`      └─ Tier: ${this._tier} | Disk: ${this._storage}GB`);
      console.log(`      └─ Public Access: ${this._publicAccess ? "enabled" : "disabled"}`);
      if (this._dbName) {
        console.log(`      └─ Database to create: "${this._dbName}"`);
      }
      if (this._username && this._username !== "postgres" && this._username !== "root") {
        console.log(`      └─ Custom user to create: "${this._username}"`);
      }

      this.resolvedEndpoint = "127.0.0.1";
      this.resolvedPort = port;
      this.resolvedConnectionName = `${project}:${location}:${instanceId}`;

      return {
        name: instanceId,
        endpoint: this.resolvedEndpoint,
        port: this.resolvedPort,
        connectionName: this.resolvedConnectionName,
      };
    }

    let needsUpdate = !existing;
    if (existing) {
      const existingSettings = existing.settings ?? {};
      const existingNetworks = existingSettings.ipConfiguration?.authorizedNetworks ?? [];

      const hasTierChange = existingSettings.tier !== this._tier;
      const hasStorageChange = Number(existingSettings.dataDiskSizeGb ?? 0) < this._storage;
      const hasNetworkChange = JSON.stringify(existingNetworks) !== JSON.stringify(targetAuthorizedNetworks);

      needsUpdate = hasTierChange || hasStorageChange || hasNetworkChange;
    }

    const settings = {
      tier: this._tier,
      dataDiskSizeGb: String(this._storage),
      ipConfiguration: {
        ipv4Enabled: true,
        authorizedNetworks: targetAuthorizedNetworks,
      },
    };

    let currentInstance: any;

    if (!existing) {
      console.log(`🚀 Creating GCP Cloud SQL instance "${instanceId}" (takes several minutes)...`);

      const op = await gcpFetch(
        SQL_BASE,
        `/v1/projects/${project}/instances`,
        {
          method: "POST",
          body: JSON.stringify({
            name: instanceId,
            databaseVersion: targetDbVersion,
            region: location,
            rootPassword: this._password,
            settings,
          }),
        }
      );

      await this.waitForOperation(op.name, `Instance creation "${instanceId}"`);

      currentInstance = await gcpFetch(
        SQL_BASE,
        `/v1/projects/${project}/instances/${instanceId}`
      );
    } else if (needsUpdate) {
      console.log(`🔄 Updating GCP Cloud SQL instance "${instanceId}"...`);
      const op = await gcpFetch(
        SQL_BASE,
        `/v1/projects/${project}/instances/${instanceId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ settings }),
        }
      );

      await this.waitForOperation(op.name, `Instance update "${instanceId}"`);

      currentInstance = await gcpFetch(
        SQL_BASE,
        `/v1/projects/${project}/instances/${instanceId}`
      );
    } else {
      console.log(`✅ GCP Cloud SQL instance "${instanceId}" is up to date.`);
      currentInstance = existing;
    }

    const primaryIp = currentInstance.ipAddresses?.find((ip: any) => ip.type === "PRIMARY")?.ipAddress;
    this.resolvedEndpoint = primaryIp ?? null;
    this.resolvedPort = port;
    this.resolvedConnectionName = currentInstance.connectionName ?? null;

    if (this._dbName) {
      console.log(`   🗄️  Ensuring database "${this._dbName}" exists...`);
      try {
        await gcpFetch(
          SQL_BASE,
          `/v1/projects/${project}/instances/${instanceId}/databases`,
          {
            method: "POST",
            body: JSON.stringify({
              name: this._dbName,
              instance: instanceId,
              project,
            }),
          }
        );
        console.log(`   ✅ Database "${this._dbName}" created.`);
      } catch (e: any) {
        if (!e.message?.includes("409")) {
          throw e;
        }
        console.log(`   ✅ Database "${this._dbName}" already exists.`);
      }
    }

    const defaultAdmin = this._engine === "postgres" ? "postgres" : "root";
    if (this._username && this._username !== defaultAdmin) {
      console.log(`   👤 Ensuring custom user "${this._username}" exists...`);
      try {
        await gcpFetch(
          SQL_BASE,
          `/v1/projects/${project}/instances/${instanceId}/users`,
          {
            method: "POST",
            body: JSON.stringify({
              name: this._username,
              password: this._password,
              instance: instanceId,
              project,
            }),
          }
        );
        console.log(`   ✅ Custom user "${this._username}" created.`);
      } catch (e: any) {
        if (!e.message?.includes("409")) {
          throw e;
        }
        console.log(`   ✅ Custom user "${this._username}" already exists.`);
      }
    }

    await this.deploySidecars();

    console.log(`🚀 Database available → ${this.resolvedEndpoint}:${this.resolvedPort}`);
    return {
      name: instanceId,
      endpoint: this.resolvedEndpoint,
      port: this.resolvedPort,
      connectionName: this.resolvedConnectionName,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const instanceId = this.name;

    console.log(`\n🗑️  Destroying GCP Cloud SQL Instance "${instanceId}"...`);

    const existing = await this.discoverInstance();
    if (!existing) {
      console.log(`   ✅ Instance "${instanceId}" does not exist - nothing to do.`);
      return { destroyed: instanceId };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Cloud SQL instance "${instanceId}"`);
      return { destroyed: instanceId };
    }

    console.log(`   🔄 Deleting Cloud SQL instance "${instanceId}"...`);
    const op = await gcpFetch(
      SQL_BASE,
      `/v1/projects/${project}/instances/${instanceId}`,
      {
        method: "DELETE",
      }
    );

    await this.waitForOperation(op.name, `Instance deletion "${instanceId}"`);
    console.log(`   ✅ Instance "${instanceId}" deleted.`);

    await this.destroySidecars();
    return { destroyed: instanceId };
  }
}
