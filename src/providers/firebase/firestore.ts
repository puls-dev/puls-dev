import { readFileSync } from 'node:fs';
import { BaseBuilder } from '../../core/resource.js';
import { cloudFetch, getProjectId } from './api.js';

const RULES_BASE = 'https://firebaserules.googleapis.com/v1';
const FS_BASE    = 'https://firestore.googleapis.com/v1';

type FieldOrder = 'ASCENDING' | 'DESCENDING';
interface IndexField { field: string; order: FieldOrder; }
interface IndexDef   { collection: string; fields: IndexField[]; }

export class FirebaseFirestoreBuilder extends BaseBuilder {
  private _rulesPath?: string;
  private _indexes: IndexDef[] = [];

  constructor(database: string = '(default)') {
    super(database);
    this.discoveryPromise = Promise.resolve(null);
  }

  rules(filePath: string)                              { this._rulesPath = filePath; return this; }
  index(collection: string, fields: IndexField[])      { this._indexes.push({ collection, fields }); return this; }

  // ── Rules ────────────────────────────────────────────────────────────────

  private rulesRelease() {
    return `projects/${getProjectId()}/releases/cloud.firestore`;
  }

  private async currentRulesReleaseRuleset(): Promise<string | null> {
    try {
      const rel = await cloudFetch(RULES_BASE, `/${this.rulesRelease()}`);
      return rel?.rulesetName ?? null;
    } catch { return null; }
  }

  private async deployRules(dryRun: boolean): Promise<void> {
    if (!this._rulesPath) return;

    const source = readFileSync(this._rulesPath, 'utf8');
    const current = await this.currentRulesReleaseRuleset();

    if (dryRun) {
      console.log(`   📝 [PLAN] Deploy Firestore rules from "${this._rulesPath}"`);
      if (current) console.log(`      └─ replaces ruleset: ${current.split('/').pop()}`);
      return;
    }

    const ruleset = await cloudFetch(
      RULES_BASE,
      `/projects/${getProjectId()}/rulesets`,
      {
        method: 'POST',
        body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: source }] } }),
      },
    );

    await cloudFetch(
      RULES_BASE,
      `/${this.rulesRelease()}`,
      {
        method: 'PUT',
        body: JSON.stringify({ name: this.rulesRelease(), rulesetName: ruleset.name }),
      },
    );

    console.log(`   ✅ Rules deployed (ruleset: ${ruleset.name.split('/').pop()})`);
  }

  // ── Indexes ───────────────────────────────────────────────────────────────

  private dbPath() {
    return `projects/${getProjectId()}/databases/${this.name}`;
  }

  private async listExistingIndexes(): Promise<any[]> {
    try {
      const res = await cloudFetch(FS_BASE, `/${this.dbPath()}/collectionGroups/-/indexes`);
      return res?.indexes ?? [];
    } catch { return []; }
  }

  private indexKey(collection: string, fields: IndexField[]): string {
    return `${collection}:${fields.map(f => `${f.field}:${f.order}`).join(',')}`;
  }

  private async deployIndexes(dryRun: boolean): Promise<void> {
    if (this._indexes.length === 0) return;

    const existing = await this.listExistingIndexes();
    const existingKeys = new Set(
      existing.map((idx: any) => {
        const parts = idx.name.split('/collectionGroups/');
        const collection = parts[1]?.split('/')[0] ?? '';
        const fields: IndexField[] = (idx.fields ?? [])
          .filter((f: any) => f.fieldPath !== '__name__')
          .map((f: any) => ({ field: f.fieldPath, order: f.order as FieldOrder }));
        return this.indexKey(collection, fields);
      }),
    );

    const toCreate = this._indexes.filter(i => !existingKeys.has(this.indexKey(i.collection, i.fields)));

    if (dryRun) {
      console.log(`   📝 [PLAN] ${toCreate.length} index(es) to create, ${this._indexes.length - toCreate.length} already exist`);
      for (const idx of toCreate) {
        console.log(`      └─ ${idx.collection}: [${idx.fields.map(f => `${f.field} ${f.order}`).join(', ')}]`);
      }
      return;
    }

    for (const idx of toCreate) {
      await cloudFetch(
        FS_BASE,
        `/${this.dbPath()}/collectionGroups/${idx.collection}/indexes`,
        {
          method: 'POST',
          body: JSON.stringify({
            queryScope: 'COLLECTION',
            fields: idx.fields.map(f => ({ fieldPath: f.field, order: f.order })),
          }),
        },
      );
      console.log(`   ✅ Index created: ${idx.collection} [${idx.fields.map(f => `${f.field} ${f.order}`).join(', ')}]`);
    }

    if (toCreate.length === 0) console.log(`   ✅ All indexes already exist`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async deploy() {
    console.log(`\n🔥 Finalizing Firestore "${this.name}"...`);
    const dryRun = this.isDryRunActive();
    await this.deployRules(dryRun);
    await this.deployIndexes(dryRun);
    return { database: this.name, project: getProjectId() };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    console.log(`\n🗑️  Destroying Firestore config "${this.name}"...`);
    // Firestore databases themselves cannot be deleted via API — only the config managed here
    if (dryRun) {
      if (this._rulesPath) console.log(`   📝 [PLAN] Rules release cannot be rolled back via API — do this in the Firebase console`);
      console.log(`   ℹ️  Firestore databases cannot be deleted via API`);
    } else {
      console.log(`   ℹ️  Firestore databases cannot be deleted via API. Remove rules/indexes manually in the Firebase console.`);
    }
    return { destroyed: this.name };
  }
}
