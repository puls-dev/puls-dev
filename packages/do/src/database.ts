import { BaseBuilder } from "@puls-dev/core";
import { getDoApi } from "./api.js";
import { Output } from "@puls-dev/core";

export class DatabaseBuilder extends BaseBuilder {
  readonly out = {
    host: new Output<string>(),
    port: new Output<number>(),
    uri: new Output<string>(),
    user: new Output<string>(),
    password: new Output<string>(),
    id: new Output<string>(),
  };

  private _engine: string = "pg";
  private _version: string = "15";
  private _size: string = "db-s-1vcpu-1gb";
  private _region: string = "nyc3";
  private _nodes: number = 1;
  private _vpcUuid?: string;
  private _firewallRules: Array<{ type: "ip_addr" | "droplet" | "k8s" | "tag" | "app"; value: string }> = [];

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverCluster(name);
  }

  engine(type: "pg" | "mysql" | "redis" | "mongodb" | "valkey" | "kafka") {
    this._engine = type;
    return this;
  }

  version(v: string) {
    this._version = v;
    return this;
  }

  size(slug: string) {
    this._size = slug;
    return this;
  }

  region(r: string) {
    this._region = r;
    this.discoveryPromise = this.discoverCluster(this.name);
    return this;
  }

  nodes(num: number) {
    this._nodes = num;
    return this;
  }

  override getMonthlyCost(state?: any): number {
    const slug = state ? (state.size_slug ?? state.size) : this._size;
    const nodes = state ? (state.num_nodes ?? state.nodeCount ?? 1) : this._nodes;
    const pricing: Record<string, number> = {
      'db-s-1vcpu-1gb':  15,
      'db-s-1vcpu-2gb':  30,
      'db-s-2vcpu-2gb':  50,
      'db-s-2vcpu-4gb':  60,
      'db-s-4vcpu-8gb': 120,
    };
    const pricePerNode = pricing[slug] ?? 15;
    return pricePerNode * nodes;
  }

  vpc(uuid: string) {
    this._vpcUuid = uuid;
    return this;
  }

  allowIp(cidr: string) {
    this._firewallRules.push({ type: "ip_addr", value: cidr });
    return this;
  }

  allowDroplet(dropletId: string) {
    this._firewallRules.push({ type: "droplet", value: dropletId });
    return this;
  }

  allowTag(tagName: string) {
    this._firewallRules.push({ type: "tag", value: tagName });
    return this;
  }

  getDiff(existing: any) {
    const diffs = [];
    if (existing.engine !== this._engine) {
      diffs.push({ field: "engine", declared: this._engine, live: existing.engine });
    }
    if (existing.version !== this._version) {
      diffs.push({ field: "version", declared: this._version, live: existing.version });
    }
    if (existing.size !== this._size) {
      diffs.push({ field: "size", declared: this._size, live: existing.size });
    }
    if (existing.region !== this._region) {
      diffs.push({ field: "region", declared: this._region, live: existing.region });
    }
    if (existing.num_nodes !== this._nodes) {
      diffs.push({ field: "nodes", declared: this._nodes, live: existing.num_nodes });
    }
    return diffs;
  }

  private async discoverCluster(name: string): Promise<any> {
    try {
      const api = getDoApi();
      const res = await api.get<{ databases: any[] }>("/databases");
      const match = (res.databases ?? []).find((db) => db.name === name);
      if (match) {
        // Resolve connection outputs immediately
        const conn = match.private_connection ?? match.connection;
        if (conn) {
          this.out.host.resolve(conn.host);
          this.out.port.resolve(conn.port);
          this.out.uri.resolve(conn.uri);
          this.out.user.resolve(conn.user);
          this.out.password.resolve(conn.password);
        }
        this.out.id.resolve(match.id);
      }
      return match ?? null;
    } catch {
      return null;
    }
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getDoApi();

    console.log(`\n🗄️  Finalizing DigitalOcean Database Cluster "${this.name}"...`);

    if (existing) {
      console.log(`   ✅ Database Cluster "${this.name}" already exists (id=${existing.id}, status=${existing.status}).`);
      
      const conn = existing.private_connection ?? existing.connection;
      if (conn) {
        this.out.host.resolve(conn.host);
        this.out.port.resolve(conn.port);
        this.out.uri.resolve(conn.uri);
        this.out.user.resolve(conn.user);
        this.out.password.resolve(conn.password);
      }
      this.out.id.resolve(existing.id);

      // Handle firewall rules updates
      if (this._firewallRules.length > 0) {
        if (dryRun) {
          console.log(`   📝 [PLAN] Update Database Firewall Rules (replace list):`);
          for (const rule of this._firewallRules) {
            console.log(`      └─ Rule: ${rule.type}:${rule.value}`);
          }
        } else {
          await api.put(`/databases/${existing.id}/firewall`, {
            rules: this._firewallRules,
          });
          console.log(`   ✅ Database Firewall Rules updated successfully.`);
        }
      }

      return {
        name: this.name,
        id: existing.id,
        status: existing.status,
      };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Create DigitalOcean Database Cluster "${this.name}" (${this._region})`);
      console.log(`      └─ Engine: ${this._engine} (version: ${this._version})`);
      console.log(`      └─ Size: ${this._size} | Nodes: ${this._nodes}`);
      if (this._vpcUuid) {
        console.log(`      └─ VPC Network: ${this._vpcUuid}`);
      }
      if (this._firewallRules.length > 0) {
        console.log(`      └─ Firewall Rules to apply:`);
        for (const rule of this._firewallRules) {
          console.log(`         └─ ${rule.type}:${rule.value}`);
        }
      }

      this.out.host.resolve("127.0.0.1");
      this.out.port.resolve(5432);
      this.out.uri.resolve("postgresql://db:pass@127.0.0.1:5432/db");
      this.out.user.resolve("db");
      this.out.password.resolve("pass");
      this.out.id.resolve("PENDING");

      return { name: this.name, id: "PENDING" };
    }

    // Create the database cluster
    console.log(`🚀 Creating DigitalOcean Database Cluster "${this.name}" (takes several minutes)...`);
    const body: any = {
      name: this.name,
      engine: this._engine,
      version: this._version,
      region: this._region,
      size: this._size,
      num_nodes: this._nodes,
    };
    if (this._vpcUuid) {
      body.private_network_uuid = this._vpcUuid;
    }

    const createRes = await api.post<{ database: any }>("/databases", body);
    const dbCluster = createRes.database;
    console.log(`🚀 Database Cluster created with ID: ${dbCluster.id}`);

    // Wait for the database cluster to become active
    await this.waitFor(
      `Database Cluster "${this.name}" to become active`,
      async () => {
        const check = await api.get<{ database: any }>(`/databases/${dbCluster.id}`);
        if (check.database && check.database.status === "online") {
          const conn = check.database.private_connection ?? check.database.connection;
          if (conn) {
            this.out.host.resolve(conn.host);
            this.out.port.resolve(conn.port);
            this.out.uri.resolve(conn.uri);
            this.out.user.resolve(conn.user);
            this.out.password.resolve(conn.password);
          }
          this.out.id.resolve(check.database.id);
          return true;
        }
        return false;
      },
      { intervalMs: 15_000, timeoutMs: 900_000 }
    );

    // Apply database firewall rules (trusted sources) if specified
    if (this._firewallRules.length > 0) {
      console.log(`   🔏 Applying Database Firewall Rules...`);
      await api.put(`/databases/${dbCluster.id}/firewall`, {
        rules: this._firewallRules,
      });
      console.log(`   ✅ Database Firewall Rules applied.`);
    }

    console.log(`🚀 Database available.`);
    return {
      name: this.name,
      id: dbCluster.id,
      status: "online",
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getDoApi();

    console.log(`\n🗑️  Destroying DigitalOcean Database Cluster "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  Database Cluster "${this.name}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Database Cluster "${this.name}" (id=${existing.id})`);
      return { destroyed: this.name };
    }

    console.log(`   🔄 Deleting Database Cluster "${this.name}" (id=${existing.id})...`);
    await api.delete(`/databases/${existing.id}`);
    console.log(`   🗑️  Removed Database Cluster "${this.name}"`);
    return { destroyed: this.name };
  }
}
