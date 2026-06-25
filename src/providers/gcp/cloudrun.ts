import { BaseBuilder } from "../../core/resource.js";
import { gcpFetch, getProjectId, getRegion } from "./api.js";
import { GCPSecretBuilder, resolveGCPEnvVars } from "./secrets.js";

const RUN_BASE = "https://run.googleapis.com";

function formatCpu(cpu: string | number): string {
  return typeof cpu === "number" ? String(cpu) : cpu;
}

function formatMemory(memory: string | number): string {
  return typeof memory === "number" ? `${memory}Mi` : memory;
}

export class GCPCloudRunBuilder extends BaseBuilder {
  private _image?: string;
  private _port: number = 8080;
  private _cpu: string | number = "1";
  private _memory: string | number = "512Mi";
  private _minInstances?: number;
  private _maxInstances?: number;
  private _env: Record<string, string | GCPSecretBuilder> = {};
  private _region?: string;
  private _public: boolean = true;

  constructor(serviceId: string) {
    super(serviceId);
    this.discoveryPromise = this.discoverService();
  }

  image(img: string) {
    this._image = img;
    return this;
  }

  port(p: number) {
    this._port = p;
    return this;
  }

  cpu(c: string | number) {
    this._cpu = c;
    return this;
  }

  override getMonthlyCost(state?: any): number {
    let cpuStr = "1";
    if (state) {
      const container = state.template?.spec?.containers?.[0];
      cpuStr = container?.resources?.limits?.cpu ?? "1";
    } else {
      cpuStr = String(this._cpu);
    }
    const cpu = parseFloat(cpuStr) || 1;
    return cpu * 5;
  }

  memory(m: string | number) {
    this._memory = m;
    return this;
  }

  minInstances(n: number) {
    this._minInstances = n;
    return this;
  }

  maxInstances(n: number) {
    this._maxInstances = n;
    return this;
  }

  env(vars: Record<string, string | GCPSecretBuilder>) {
    this._env = { ...this._env, ...vars };
    return this;
  }

  region(reg: string) {
    this._region = reg;
    // Re-trigger discovery with the custom region
    this.discoveryPromise = this.discoverService();
    return this;
  }

  public(enabled: boolean = true) {
    this._public = enabled;
    return this;
  }

  getDiff(existing: any) {
    const diffs = [];
    const container = existing.template?.containers?.[0];
    const scaling = existing.template?.scaling ?? {};
    const targetIngress = this._public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY";
    if (container?.image !== this._image) {
      diffs.push({ field: "image", declared: this._image, live: container?.image });
    }
    if (container?.ports?.[0]?.containerPort !== this._port) {
      diffs.push({ field: "port", declared: this._port, live: container?.ports?.[0]?.containerPort });
    }
    if (container?.resources?.limits?.cpu !== formatCpu(this._cpu)) {
      diffs.push({ field: "cpu", declared: formatCpu(this._cpu), live: container?.resources?.limits?.cpu });
    }
    if (container?.resources?.limits?.memory !== formatMemory(this._memory)) {
      diffs.push({ field: "memory", declared: formatMemory(this._memory), live: container?.resources?.limits?.memory });
    }
    const minDeclared = this._minInstances ?? 0;
    const maxDeclared = this._maxInstances ?? 100;
    if ((scaling.minInstanceCount ?? 0) !== minDeclared) {
      diffs.push({ field: "minInstances", declared: minDeclared, live: scaling.minInstanceCount ?? 0 });
    }
    if ((scaling.maxInstanceCount ?? 100) !== maxDeclared) {
      diffs.push({ field: "maxInstances", declared: maxDeclared, live: scaling.maxInstanceCount ?? 100 });
    }
    if (existing.ingress !== targetIngress) {
      diffs.push({ field: "public", declared: this._public, live: existing.ingress === "INGRESS_TRAFFIC_ALL" });
    }
    return diffs;
  }

  private async discoverService(): Promise<any> {
    try {
      const project = getProjectId();
      const location = this._region ?? getRegion();
      return await gcpFetch(
        RUN_BASE,
        `/v2/projects/${project}/locations/${location}/services/${this.name}`
      );
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

  async deploy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const location = this._region ?? getRegion();
    const serviceId = this.name;

    console.log(`\n⚡ Finalizing GCP Cloud Run Service "${serviceId}"...`);

    if (!this._image) {
      throw new Error(`[GCP.CloudRun:${serviceId}] .image("...") is required`);
    }

    const existing = await this.discoveryPromise;

    const targetCpu = formatCpu(this._cpu);
    const targetMemory = formatMemory(this._memory);
    const targetMinInstances = this._minInstances ?? 0;
    const targetMaxInstances = this._maxInstances ?? 100;
    const targetIngress = this._public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY";

    const resolvedEnv = await resolveGCPEnvVars(this._env, dryRun);
    const targetEnv = Object.entries(resolvedEnv).map(([name, value]) => ({
      name,
      value,
    }));

    if (dryRun) {
      console.log(
        `   📝 [PLAN] ${existing ? "Update" : "Create"} Cloud Run service "${serviceId}" in ${location}`
      );
      console.log(`      └─ Image: ${this._image}`);
      console.log(`      └─ Port: ${this._port}`);
      console.log(`      └─ CPU: ${targetCpu} | Memory: ${targetMemory}`);
      console.log(`      └─ Scaling: min ${targetMinInstances}, max ${targetMaxInstances}`);
      console.log(`      └─ Public Access: ${this._public ? "enabled" : "disabled"}`);
      if (targetEnv.length > 0) {
        console.log(`      └─ Env vars: ${targetEnv.map((e) => e.name).join(", ")}`);
      }
      return {
        serviceId,
        url: `https://${serviceId}-dryrun.a.run.app`,
      };
    }

    // Determine if update is needed
    let needsUpdate = !existing;
    if (existing) {
      const existingContainer = existing.template?.containers?.[0];
      const existingLimits = existingContainer?.resources?.limits ?? {};
      const existingPorts = existingContainer?.ports ?? [];
      const existingEnv = existingContainer?.env ?? [];
      const existingScaling = existing.template?.scaling ?? {};

      // Env vars match
      const sortedExistingEnv = [...existingEnv].sort((a, b) => a.name.localeCompare(b.name));
      const sortedTargetEnv = [...targetEnv].sort((a, b) => a.name.localeCompare(b.name));
      const envsMatch = JSON.stringify(sortedExistingEnv) === JSON.stringify(sortedTargetEnv);

      needsUpdate =
        existingContainer?.image !== this._image ||
        existingPorts[0]?.containerPort !== this._port ||
        existingLimits.cpu !== targetCpu ||
        existingLimits.memory !== targetMemory ||
        (existingScaling.minInstanceCount ?? 0) !== targetMinInstances ||
        (existingScaling.maxInstanceCount ?? 100) !== targetMaxInstances ||
        existing.ingress !== targetIngress ||
        !envsMatch;
    }

    const serviceBody = {
      template: {
        containers: [
          {
            image: this._image,
            ports: [{ containerPort: this._port }],
            resources: {
              limits: {
                cpu: targetCpu,
                memory: targetMemory,
              },
            },
            env: targetEnv,
          },
        ],
        scaling: {
          minInstanceCount: targetMinInstances,
          maxInstanceCount: targetMaxInstances,
        },
      },
      ingress: targetIngress,
    };

    let resultService: any;

    if (!existing) {
      console.log(`🚀 Creating GCP Cloud Run service "${serviceId}"...`);
      resultService = await gcpFetch(
        RUN_BASE,
        `/v2/projects/${project}/locations/${location}/services?serviceId=${serviceId}`,
        {
          method: "POST",
          body: JSON.stringify(serviceBody),
        }
      );
    } else if (needsUpdate) {
      console.log(`🔄 Updating GCP Cloud Run service "${serviceId}"...`);
      resultService = await gcpFetch(
        RUN_BASE,
        `/v2/projects/${project}/locations/${location}/services/${serviceId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: `projects/${project}/locations/${location}/services/${serviceId}`,
            ...serviceBody,
          }),
        }
      );
    } else {
      console.log(`✅ GCP Cloud Run service "${serviceId}" is up to date.`);
      resultService = existing;
    }

    // Apply IAM Invoker Policy
    if (this._public) {
      console.log(`   🔓 Making service public (binding roles/run.invoker to allUsers)...`);
      await gcpFetch(
        RUN_BASE,
        `/v2/projects/${project}/locations/${location}/services/${serviceId}:setIamPolicy`,
        {
          method: "POST",
          body: JSON.stringify({
            policy: {
              bindings: [
                {
                  role: "roles/run.invoker",
                  members: ["allUsers"],
                },
              ],
            },
          }),
        }
      );
      console.log(`   ✅ Public IAM policy applied.`);
    } else {
      console.log(`   🔒 Restricting service to private (clearing allUsers invoker binding)...`);
      await gcpFetch(
        RUN_BASE,
        `/v2/projects/${project}/locations/${location}/services/${serviceId}:setIamPolicy`,
        {
          method: "POST",
          body: JSON.stringify({
            policy: {
              bindings: [],
            },
          }),
        }
      );
      console.log(`   ✅ Private IAM policy applied.`);
    }

    await this.deploySidecars();

    const url = resultService.uri ?? `https://${serviceId}.a.run.app`;
    console.log(`🚀 Service live → ${url}`);
    return {
      serviceId,
      url,
    };
  }

  async destroy() {
    const dryRun = this.isDryRunActive();
    const project = getProjectId();
    const location = this._region ?? getRegion();
    const serviceId = this.name;

    console.log(`\n🗑️  Destroying GCP Cloud Run Service "${serviceId}"...`);

    const existing = await this.discoverService();

    if (!existing) {
      console.log(`   ✅ Service "${serviceId}" does not exist - nothing to do.`);
      return { destroyed: serviceId };
    }

    if (dryRun) {
      console.log(`   📝 [PLAN] Delete Cloud Run service "${serviceId}" in ${location}`);
      return { destroyed: serviceId };
    }

    console.log(`   🔄 Deleting Cloud Run service "${serviceId}"...`);
    await gcpFetch(
      RUN_BASE,
      `/v2/projects/${project}/locations/${location}/services/${serviceId}`,
      {
        method: "DELETE",
      }
    );
    console.log(`   ✅ Service "${serviceId}" deleted.`);

    await this.destroySidecars();
    return { destroyed: serviceId };
  }
}
