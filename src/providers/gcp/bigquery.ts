import { BaseBuilder } from "../../core/resource.js";
import { Output } from "../../core/output.js";
import { gcpFetch, getProjectId } from "./api.js";

const BQ_BASE = "https://bigquery.googleapis.com";

// Maps each view's sentinel string to its builder instance.
// Populated at construction time so query() can look up deps from interpolated sentinels.
const _viewRegistry = new Map<string, GCPBigQueryViewBuilder>();

export class GCPBigQueryViewBuilder extends BaseBuilder {
  readonly out = {
    qualifiedRef: new Output<string>(),
  };

  private _dataset?: string;
  private _query?: string;
  private _useLegacySql: boolean = false;
  private readonly _sentinel: string;

  constructor(viewId: string) {
    super(viewId);
    this._sentinel = `__PULS_BQ_${viewId}_${Math.random().toString(36).slice(2, 8)}__`;
    _viewRegistry.set(this._sentinel, this);
    this.discoveryPromise = Promise.resolve(null);
  }

  dataset(datasetId: string) {
    this._dataset = datasetId;
    this.discoveryPromise = this.discoverView();
    return this;
  }

  /**
   * Set the SQL query for this view. Supports native output interpolation:
   * interpolating another `GCPBigQueryViewBuilder` in a template literal
   * automatically wires a `dependsOn` and resolves to its qualified ref at deploy time.
   *
   * @example
   *   activeUsers = GCP.BigQueryView("active_users").dataset("ds").query("SELECT ...");
   *   userLtv     = GCP.BigQueryView("user_ltv").dataset("ds")
   *                   .query(`SELECT * FROM ${this.activeUsers} WHERE ...`);
   */
  query(sql: string) {
    this._query = sql;
    for (const [sentinel, dep] of _viewRegistry) {
      if (dep !== this && sql.includes(sentinel)) {
        this.dependsOn(dep);
      }
    }
    return this;
  }

  useLegacySql(enabled: boolean = true) {
    this._useLegacySql = enabled;
    return this;
  }

  // Called implicitly by template literal interpolation: `${someView}`
  // Returns a sentinel string that query() later maps back to this builder.
  toString(): string {
    return this._sentinel;
  }

  get qualifiedRef(): string {
    if (!this._dataset) return "";
    const project = getProjectId();
    return `\`${project}.${this._dataset}.${this.name}\``;
  }

  getDiff(existing: any) {
    const liveQuery = existing?.view?.query as string | undefined;
    if (!liveQuery || !this._query) return [];
    
    // Resolve sentinels to their deterministic qualifiedRefs
    const resolvedDeclared = this.resolveQuery();
    
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    if (normalize(liveQuery) !== normalize(resolvedDeclared)) {
      return [{ field: "query", declared: "(updated)", live: "(differs)" }];
    }
    return [];
  }

  private async discoverView(): Promise<any> {
    if (!this._dataset) return null;
    try {
      const project = getProjectId();
      return await gcpFetch(
        BQ_BASE,
        `/bigquery/v2/projects/${project}/datasets/${this._dataset}/tables/${this.name}`
      );
    } catch (err: any) {
      if (err.message?.includes("404") || err.message?.includes("Not Found")) return null;
      throw err;
    }
  }

  private resolveQuery(): string {
    if (!this._query) throw new Error(`BigQueryView "${this.name}": no query set. Call .query().`);
    let sql = this._query;
    for (const [sentinel, dep] of _viewRegistry) {
      if (sql.includes(sentinel)) {
        sql = sql.split(sentinel).join(dep.qualifiedRef);
      }
    }
    return sql;
  }

  async deploy(): Promise<any> {
    const dryRun = this.isDryRunActive();
    if (!this._dataset) throw new Error(`BigQueryView "${this.name}": no dataset set. Call .dataset().`);

    const project = getProjectId();
    const qualifiedRef = this.qualifiedRef;
    const existing = await this.discoveryPromise;
    const resolvedSql = this.resolveQuery();

    if (existing) {
      this.out.qualifiedRef.resolve(qualifiedRef);
      const diffs = this.getDiff(existing);

      if (diffs.length === 0) {
        console.log(`\n📊 BigQuery View "${this.name}" is up to date.`);
        return { name: this.name, dataset: this._dataset, qualifiedRef };
      }

      if (await this.checkProtection(true)) return { name: this.name, protected: true };

      if (dryRun) {
        console.log(`\n📊 [PLAN] Update BigQuery View "${this.name}" (query changed)`);
        return { name: this.name, dataset: this._dataset, qualifiedRef };
      }

      console.log(`\n📊 Updating BigQuery View "${this.name}"...`);
      await gcpFetch(
        BQ_BASE,
        `/bigquery/v2/projects/${project}/datasets/${this._dataset}/tables/${this.name}`,
        {
          method: "PUT",
          body: JSON.stringify({
            tableReference: { projectId: project, datasetId: this._dataset, tableId: this.name },
            view: { query: resolvedSql, useLegacySql: this._useLegacySql },
          }),
        }
      );
      console.log(`   ✅ Updated view "${this.name}" in dataset "${this._dataset}"`);
      return { name: this.name, dataset: this._dataset, qualifiedRef };
    }

    if (dryRun) {
      console.log(`\n📊 [PLAN] Create BigQuery View "${this.name}" in dataset "${this._dataset}"`);
      console.log(`   └─ Query: ${resolvedSql.slice(0, 80)}${resolvedSql.length > 80 ? "…" : ""}`);
      this.out.qualifiedRef.resolve(qualifiedRef);
      return { name: this.name, dataset: this._dataset, qualifiedRef };
    }

    console.log(`\n📊 Creating BigQuery View "${this.name}"...`);
    await gcpFetch(
      BQ_BASE,
      `/bigquery/v2/projects/${project}/datasets/${this._dataset}/tables`,
      {
        method: "POST",
        body: JSON.stringify({
          tableReference: { projectId: project, datasetId: this._dataset, tableId: this.name },
          view: { query: resolvedSql, useLegacySql: this._useLegacySql },
        }),
      }
    );
    this.out.qualifiedRef.resolve(qualifiedRef);
    console.log(`   ✅ Created view "${this.name}" → ${qualifiedRef}`);
    return { name: this.name, dataset: this._dataset, qualifiedRef };
  }

  async destroy(): Promise<any> {
    if (!this._dataset) return { destroyed: false };
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;

    console.log(`\n🗑️  Destroying BigQuery View "${this.name}"...`);

    if (!existing) {
      console.log(`   ─  View "${this.name}" not found`);
      return { destroyed: false };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete view "${this.name}" from dataset "${this._dataset}"`);
      return { destroyed: this.name };
    }

    const project = getProjectId();
    await gcpFetch(
      BQ_BASE,
      `/bigquery/v2/projects/${project}/datasets/${this._dataset}/tables/${this.name}`,
      { method: "DELETE" }
    );
    console.log(`   ✅ Deleted view "${this.name}"`);
    return { destroyed: this.name };
  }
}
