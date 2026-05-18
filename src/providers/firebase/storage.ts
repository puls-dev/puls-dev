import { readFileSync } from 'node:fs';
import { BaseBuilder } from '../../core/resource.js';
import { cloudFetch, getProjectId } from './api.js';

const RULES_BASE = 'https://firebaserules.googleapis.com/v1';
const GCS_BASE   = 'https://storage.googleapis.com/storage/v1';

interface CorsRule {
  origin: string[];
  method: string[];
  responseHeader?: string[];
  maxAge?: number;
}

interface LifecycleRule {
  deleteAfterDays?: number;
  matchesPrefix?: string[];
}

export class FirebaseStorageBuilder extends BaseBuilder {
  private _rulesPath?: string;
  private _cors: CorsRule[] = [];
  private _lifecycle?: LifecycleRule;
  private _resolvedBucket?: string;

  constructor(bucket?: string) {
    // Bucket name resolved lazily in deploy() if not provided (needs projectId)
    super(bucket ?? '__default__');
    this._resolvedBucket = bucket;
    this.discoveryPromise = Promise.resolve(null);
  }

  rules(filePath: string)          { this._rulesPath = filePath; return this; }
  cors(rules: CorsRule[])          { this._cors = rules; return this; }
  lifecycle(rule: LifecycleRule)   { this._lifecycle = rule; return this; }

  private bucket(): string {
    return this._resolvedBucket ?? `${getProjectId()}.appspot.com`;
  }

  // ── Rules ─────────────────────────────────────────────────────────────────

  private releaseName(): string {
    return `projects/${getProjectId()}/releases/firebase.storage/${this.bucket()}`;
  }

  private async deployRules(dryRun: boolean): Promise<void> {
    if (!this._rulesPath) return;

    const source = readFileSync(this._rulesPath, 'utf8');

    if (dryRun) {
      console.log(`   📝 [PLAN] Deploy Storage rules from "${this._rulesPath}" → ${this.bucket()}`);
      return;
    }

    const ruleset = await cloudFetch(
      RULES_BASE,
      `/projects/${getProjectId()}/rulesets`,
      {
        method: 'POST',
        body: JSON.stringify({ source: { files: [{ name: 'storage.rules', content: source }] } }),
      },
    );

    await cloudFetch(
      RULES_BASE,
      `/${this.releaseName()}`,
      {
        method: 'PUT',
        body: JSON.stringify({ name: this.releaseName(), rulesetName: ruleset.name }),
      },
    );

    console.log(`   ✅ Storage rules deployed (ruleset: ${ruleset.name.split('/').pop()})`);
  }

  // ── CORS ──────────────────────────────────────────────────────────────────

  private async deployCors(dryRun: boolean): Promise<void> {
    if (this._cors.length === 0) return;

    const corsBody = this._cors.map(r => ({
      origin: r.origin,
      method: r.method,
      responseHeader: r.responseHeader ?? [],
      maxAgeSeconds: r.maxAge ?? 3600,
    }));

    if (dryRun) {
      console.log(`   📝 [PLAN] Set CORS on bucket "${this.bucket()}" (${this._cors.length} rule(s))`);
      for (const r of this._cors) {
        console.log(`      └─ origins: [${r.origin.join(', ')}], methods: [${r.method.join(', ')}]`);
      }
      return;
    }

    await cloudFetch(GCS_BASE, `/b/${this.bucket()}`, {
      method: 'PATCH',
      body: JSON.stringify({ cors: corsBody }),
    });

    console.log(`   ✅ CORS configured on "${this.bucket()}"`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private async deployLifecycle(dryRun: boolean): Promise<void> {
    if (!this._lifecycle) return;

    const rule: any = {
      action: { type: 'Delete' },
      condition: {},
    };

    if (this._lifecycle.deleteAfterDays !== undefined)
      rule.condition.age = this._lifecycle.deleteAfterDays;
    if (this._lifecycle.matchesPrefix?.length)
      rule.condition.matchesPrefix = this._lifecycle.matchesPrefix;

    if (dryRun) {
      const parts = [];
      if (this._lifecycle.deleteAfterDays) parts.push(`delete after ${this._lifecycle.deleteAfterDays} days`);
      if (this._lifecycle.matchesPrefix)   parts.push(`prefix: [${this._lifecycle.matchesPrefix.join(', ')}]`);
      console.log(`   📝 [PLAN] Set lifecycle on "${this.bucket()}": ${parts.join(', ')}`);
      return;
    }

    await cloudFetch(GCS_BASE, `/b/${this.bucket()}`, {
      method: 'PATCH',
      body: JSON.stringify({ lifecycle: { rule: [rule] } }),
    });

    console.log(`   ✅ Lifecycle configured on "${this.bucket()}"`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async deploy() {
    // Resolve bucket name now that projectId is available
    this._resolvedBucket = this.bucket();
    console.log(`\n🪣  Finalizing Firebase Storage "${this._resolvedBucket}"...`);

    const dryRun = this.isDryRunActive();
    await this.deployRules(dryRun);
    await this.deployCors(dryRun);
    await this.deployLifecycle(dryRun);

    return { bucket: this._resolvedBucket, project: getProjectId() };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    console.log(`\n🗑️  Destroying Firebase Storage config "${this.bucket()}"...`);
    if (dryRun) {
      console.log(`   ℹ️  Storage buckets cannot be deleted via API — remove manually in the GCP console`);
    } else {
      console.log(`   ℹ️  Storage buckets cannot be deleted via API — remove manually in the GCP console`);
    }
    return { destroyed: this.bucket() };
  }
}
