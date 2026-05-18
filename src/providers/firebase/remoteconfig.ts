import { BaseBuilder } from '../../core/resource.js';
import { getFirebaseToken, getProjectId } from './api.js';

const RC_BASE  = 'https://firebaseremoteconfig.googleapis.com/v1';
const RC_SCOPE = 'https://www.googleapis.com/auth/firebase.remoteconfig';

type ParamValue  = string | number | boolean | object;
type ValueType   = 'STRING' | 'BOOLEAN' | 'NUMBER' | 'JSON';

interface Param {
  key: string;
  value: ParamValue;
  type: ValueType;
  description?: string;
  conditionalValues?: Record<string, ParamValue>;
}

interface Condition {
  name: string;
  expression: string;
}

function inferType(v: ParamValue): ValueType {
  if (typeof v === 'boolean') return 'BOOLEAN';
  if (typeof v === 'number')  return 'NUMBER';
  if (typeof v === 'object')  return 'JSON';
  return 'STRING';
}

function serialize(v: ParamValue): string {
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export class FirebaseRemoteConfigBuilder extends BaseBuilder {
  private _params: Param[] = [];
  private _conditions: Condition[] = [];

  constructor() {
    super('remoteconfig');
    this.discoveryPromise = Promise.resolve(null);
  }

  string(key: string, value: string, description?: string) {
    this._params.push({ key, value, type: 'STRING', description });
    return this;
  }
  bool(key: string, value: boolean, description?: string) {
    this._params.push({ key, value, type: 'BOOLEAN', description });
    return this;
  }
  number(key: string, value: number, description?: string) {
    this._params.push({ key, value, type: 'NUMBER', description });
    return this;
  }
  json(key: string, value: object, description?: string) {
    this._params.push({ key, value, type: 'JSON', description });
    return this;
  }

  // Generic param — type inferred from value
  param(key: string, value: ParamValue, description?: string) {
    this._params.push({ key, value, type: inferType(value), description });
    return this;
  }

  condition(name: string, expression: string) {
    this._conditions.push({ name, expression });
    return this;
  }

  // Override a param's value for a specific condition
  override(paramKey: string, conditionName: string, value: ParamValue) {
    const p = this._params.find(p => p.key === paramKey);
    if (!p) throw new Error(`[RemoteConfig] param "${paramKey}" not defined — call .param()/.bool()/etc. first`);
    p.conditionalValues ??= {};
    p.conditionalValues[conditionName] = value;
    return this;
  }

  // ── Internal fetch with ETag support ─────────────────────────────────────

  private async rcFetch(path: string, opts: RequestInit & { etag?: string } = {}): Promise<{ data: any; etag: string | null }> {
    const token = await getFirebaseToken([RC_SCOPE]);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    };
    if (opts.etag) headers['If-Match'] = opts.etag;

    const res = await fetch(`${RC_BASE}${path}`, { ...opts, headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`RemoteConfig API ${opts.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
    }
    const text = await res.text();
    return { data: text ? JSON.parse(text) : null, etag: res.headers.get('etag') };
  }

  // ── Deploy ────────────────────────────────────────────────────────────────

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();

    console.log(`\n🎛️  Finalizing Firebase RemoteConfig...`);

    if (dryRun) {
      console.log(`   📝 [PLAN] Set ${this._params.length} parameter(s):`);
      for (const p of this._params) {
        const overrides = p.conditionalValues ? ` + ${Object.keys(p.conditionalValues).length} override(s)` : '';
        console.log(`      └─ ${p.key} (${p.type}): ${serialize(p.value)}${overrides}`);
      }
      if (this._conditions.length) {
        console.log(`   📝 [PLAN] Set ${this._conditions.length} condition(s):`);
        for (const c of this._conditions) console.log(`      └─ "${c.name}": ${c.expression}`);
      }
      return { project };
    }

    // Fetch current template + ETag
    const { data: current, etag } = await this.rcFetch(`/projects/${project}/remoteConfig`);

    // Merge our params into the existing template (non-destructive — preserves params we didn't define)
    const parameters: Record<string, any> = { ...(current?.parameters ?? {}) };
    for (const p of this._params) {
      const entry: any = {
        defaultValue: { value: serialize(p.value) },
        valueType: p.type,
      };
      if (p.description) entry.description = p.description;
      if (p.conditionalValues) {
        entry.conditionalValues = {};
        for (const [cond, val] of Object.entries(p.conditionalValues)) {
          entry.conditionalValues[cond] = { value: serialize(val) };
        }
      }
      parameters[p.key] = entry;
    }

    // Merge conditions (add new ones, preserve existing)
    const existingConditions: any[] = current?.conditions ?? [];
    const existingNames = new Set(existingConditions.map((c: any) => c.name));
    const conditions = [
      ...existingConditions,
      ...this._conditions.filter(c => !existingNames.has(c.name)),
    ];

    const body = { parameters, conditions, parameterGroups: current?.parameterGroups ?? {} };

    await this.rcFetch(`/projects/${project}/remoteConfig`, {
      method: 'PUT',
      body: JSON.stringify(body),
      etag: etag ?? '*',
    });

    console.log(`   ✅ ${this._params.length} parameter(s) published`);
    if (this._conditions.length) console.log(`   ✅ ${this._conditions.length} condition(s) set`);

    return { project };
  }

  async destroy() {
    console.log(`\n🗑️  Destroying Firebase RemoteConfig...`);
    console.log(`   ℹ️  RemoteConfig templates cannot be deleted via API — clear parameters in the Firebase console`);
    return { destroyed: 'remoteconfig' };
  }
}
