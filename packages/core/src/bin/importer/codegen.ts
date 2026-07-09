import path from "node:path";
import fs from "node:fs";
import { DiscoveredResource, providerRegistry } from "../../core/provider.js";

// ─── Property name helpers ────────────────────────────────────────────────────

function toPropertyName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_").replace(/^([0-9])/, "_$1");
}

function uniquePropertyName(base: string, used: Set<string>): string {
  if (!used.has(base)) { used.add(base); return base; }
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  const name = `${base}_${i}`;
  used.add(name);
  return name;
}

// Single pass over all selected resources so cross-tier references use the
// same deduplicated name on both sides of the generated code.
function buildPropertyNames(resources: DiscoveredResource[]): Map<DiscoveredResource, string> {
  const used = new Set<string>();
  const map  = new Map<DiscoveredResource, string>();
  for (const res of resources) {
    map.set(res, uniquePropertyName(toPropertyName(res.propertyName), used));
  }
  return map;
}

// ─── Provider import lines ────────────────────────────────────────────────────

const PROVIDER_IMPORTS: Record<string, string> = {
  aws:        'import { AWS } from "@puls-dev/aws";',
  do:         'import { DO } from "@puls-dev/do";',
  hcloud:     'import { HCloud } from "@puls-dev/hcloud";',
  gcp:        'import { GCP } from "@puls-dev/gcp";',
  azure:      'import { Azure } from "@puls-dev/azure";',
  firebase:   'import { Firebase } from "@puls-dev/firebase";',
  cloudflare: 'import { Cloudflare } from "@puls-dev/cloudflare";',
  proxmox:    'import { Proxmox } from "@puls-dev/proxmox";',
};

function importsFor(resources: DiscoveredResource[]): Set<string> {
  return new Set(resources.map((r) => PROVIDER_IMPORTS[r.provider]).filter(Boolean));
}

function getResourcePropertyChain(res: DiscoveredResource, allResources: DiscoveredResource[]): string {
  return providerRegistry.get(res.provider)?.getPropertyChain?.(res, allResources) ?? "";
}

// ─── Group name / directory helpers ──────────────────────────────────────────

function sanitizeGroupName(name: string): string {
  let clean = name.replace(/[-]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[‑-⛿]|\uD83E[\uDD00-\uDFFF]/g, "");
  clean = clean.trim()
    .replace(/^(Network|Database|Compute|standalone|group|tier)\s*:/i, "")
    .trim()
    .replace(/^\[[^\]]+\]/, "")
    .replace(/\d+$/, "")
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.toLowerCase() || "stack";
}

function getUniqueGroupDir(baseDir: string, name: string): string {
  const cleanName = sanitizeGroupName(name);
  let candidate = path.join(baseDir, cleanName);
  if (!fs.existsSync(candidate)) return candidate;
  let counter = 1;
  while (true) {
    candidate = path.join(baseDir, `${cleanName}-${counter}`);
    if (!fs.existsSync(candidate)) return candidate;
    counter++;
  }
}

// ─── Tree-based resource grouping ────────────────────────────────────────────

function groupResourcesByTree(
  resources: DiscoveredResource[],
): { name: string; resources: DiscoveredResource[] }[] {
  const childrenMap = new Map<string | number, (string | number)[]>();
  const childNodeIds = new Set<string | number>();

  resources.forEach((res) => childrenMap.set(res.id, []));

  resources.forEach((res) => {
    const parentId = res.original?.vpc_uuid || res.original?.vpcId || res.original?.subnetId;
    if (parentId && childrenMap.has(parentId)) {
      childrenMap.get(parentId)!.push(res.id);
      childNodeIds.add(res.id);
    }

    if (res.type === "AWS.CloudFront") {
      const aliases: string[] = res.original?.aliases || [];
      const origins: any[]    = res.original?.origins  || [];
      resources.forEach((other) => {
        if (other.type === "AWS.Route53") {
          const zoneName = other.name.replace(/\.$/, "");
          if (aliases.some((alias) => alias.endsWith(zoneName))) {
            childrenMap.get(res.id)!.push(other.id);
            childNodeIds.add(other.id);
          }
        }
        if (other.type === "AWS.S3") {
          if (origins.some((o) => o.domainName && o.domainName.includes(other.name))) {
            childrenMap.get(res.id)!.push(other.id);
            childNodeIds.add(other.id);
          }
        }
      });
    }

    if (res.type === "DO.Firewall") {
      const dropletIds: (string | number)[] = res.original?.dropletIds || [];
      resources.forEach((other) => {
        if (other.type === "DO.Droplet" && dropletIds.some((dId) => String(dId) === String(other.id))) {
          if (childrenMap.has(other.id)) {
            childrenMap.get(other.id)!.push(res.id);
            childNodeIds.add(res.id);
          }
        }
      });
    }
  });

  const roots = resources.filter((res) => !childNodeIds.has(res.id));

  if (roots.length === 0 && resources.length > 0) {
    return [{ name: resources[0].name, resources }];
  }

  const gatherDescendants = (id: string | number, list: DiscoveredResource[]) => {
    for (const cId of childrenMap.get(id) || []) {
      const child = resources.find((r) => r.id === cId);
      if (child && !list.includes(child)) {
        list.push(child);
        gatherDescendants(cId, list);
      }
    }
  };

  return roots.map((root) => {
    const group: DiscoveredResource[] = [root];
    gatherDescendants(root.id, group);
    return { name: root.name, resources: group };
  });
}

// ─── Route53 YAML records ─────────────────────────────────────────────────────

function writeRoute53Yaml(
  res: DiscoveredResource,
  outputDir: string,
  files: string[],
): string | null {
  const records = res.original?.records as Array<{ name: string; type: string; value: string; ttl: number }> | undefined;
  if (!records || records.length === 0) return null;

  const zoneName = res.name.replace(/\.$/, "");
  const lines: string[] = [];

  for (const r of records) {
    if (r.type === "NS" || r.type === "SOA") continue;

    let name = r.name.replace(/\.$/, "");
    if (name === zoneName)                     name = "@";
    else if (name.endsWith("." + zoneName))    name = name.slice(0, -(zoneName.length + 1));

    lines.push(`- name: ${name}`);
    lines.push(`  type: ${r.type}`);

    if (r.type === "MX") {
      const spaceIdx = r.value.indexOf(" ");
      if (spaceIdx > -1) {
        lines.push(`  value: ${r.value.slice(spaceIdx + 1).replace(/\.$/, "")}`);
        lines.push(`  priority: ${r.value.slice(0, spaceIdx)}`);
      } else {
        lines.push(`  value: ${r.value.replace(/\.$/, "")}`);
      }
    } else {
      lines.push(`  value: ${r.value.replace(/\.$/, "")}`);
    }

    if (r.ttl && r.ttl !== 300) lines.push(`  ttl: ${r.ttl}`);
  }

  if (lines.length === 0) return null;

  const sanitized = zoneName.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const fileName = `${sanitized}-records.yaml`;
  fs.writeFileSync(path.join(outputDir, fileName), lines.join("\n") + "\n");

  const relPath = path.relative(process.cwd(), path.join(outputDir, fileName)).replace(/\\/g, "/");
  files.push(relPath);
  return `./${relPath}`;
}

// ─── Code emitters ───────────────────────────────────────────────────────────

function generateFlatCode(
  resources: DiscoveredResource[],
  propNames: Map<DiscoveredResource, string>,
  outputDir: string,
  files: string[],
): string {
  let code = `// Generated by \`puls import\` - review, then remove dryRun to go live.\n`;
  code    += `import { Stack, Deploy } from "@puls-dev/core";\n`;
  importsFor(resources).forEach((imp) => { code += `${imp}\n`; });
  code    += `\n@Deploy({ dryRun: true })\nexport class InfraStack extends Stack {\n`;

  for (const res of resources) {
    const prop = propNames.get(res)!;
    code += `  ${prop} = ${res.type}("${res.name}")\n    .adoptId("${res.id}")`;
    if (res.type === "AWS.Route53") {
      const yamlPath = writeRoute53Yaml(res, outputDir, files);
      if (yamlPath) code += `\n    .record("${yamlPath}")`;
    } else {
      if (res.vpcRef && propNames.has(res.vpcRef)) {
        code += `\n    .vpc(this.${propNames.get(res.vpcRef)!})`;
      }
      code += getResourcePropertyChain(res, resources);
    }
    code += `;\n\n`;
  }
  return code + `}\n`;
}

function generateTierCode(
  stackName: string,
  resources: DiscoveredResource[],
  allPropNames: Map<DiscoveredResource, string>,
  imports: Set<string>,
  headerLines: string[] = [],
  allResources: DiscoveredResource[],
  outputDir: string,
  files: string[],
): string {
  let code = `// Generated by \`puls import\` - review, then remove dryRun to go live.\n`;
  code    += `import { Stack, Deploy } from "@puls-dev/core";\n`;
  imports.forEach((imp)     => { code += `${imp}\n`; });
  headerLines.forEach((line) => { code += `${line}\n`; });
  code    += `\n@Deploy({ dryRun: true })\nexport class ${stackName} extends Stack {\n`;

  if (stackName === "DatabaseStack" && headerLines.some((l) => l.includes("NetworkStack"))) {
    code += `  network = Stack.from(NetworkStack);\n\n`;
  } else if (stackName === "ComputeStack") {
    let dep = false;
    if (headerLines.some((l) => l.includes("NetworkStack"))) { code += `  network = Stack.from(NetworkStack);\n`; dep = true; }
    if (headerLines.some((l) => l.includes("DatabaseStack"))) { code += `  db = Stack.from(DatabaseStack);\n`; dep = true; }
    if (dep) code += `\n`;
  }

  for (const res of resources) {
    const prop = allPropNames.get(res)!;
    code += `  ${prop} = ${res.type}("${res.name}")\n    .adoptId("${res.id}")`;
    if (res.type === "AWS.Route53") {
      const yamlPath = writeRoute53Yaml(res, outputDir, files);
      if (yamlPath) code += `\n    .record("${yamlPath}")`;
    } else {
      if (res.vpcRef && allPropNames.has(res.vpcRef)) {
        code += `\n    .vpc(this.network.${allPropNames.get(res.vpcRef)!}.out.id)`;
      }
      code += getResourcePropertyChain(res, allResources);
    }
    code += `;\n\n`;
  }
  return code + `}\n`;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function generateInfrastructureCode(resources: DiscoveredResource[], strategy: string): number {
  const outDir = path.resolve(process.cwd(), "infra");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const groups = groupResourcesByTree(resources);
  const files: string[] = [];

  for (const group of groups) {
    if (group.resources.length === 0) continue;

    const groupDir = getUniqueGroupDir(outDir, group.name);
    fs.mkdirSync(groupDir, { recursive: true });

    const gr       = group.resources;
    const networks = gr.filter((r) => r.tier === "network");
    const dbs      = gr.filter((r) => r.tier === "database");
    const compute  = gr.filter((r) => r.tier === "compute");

    for (const c of compute) {
      const parentId = c.original?.vpc_uuid ?? c.original?.vpcId ?? c.original?.subnetId;
      if (parentId) {
        const match = networks.find((n) => n.id === parentId);
        if (match) c.vpcRef = match;
      }
    }

    const propNames    = buildPropertyNames(gr);
    const relGroupDir  = path.relative(process.cwd(), groupDir);

    if (strategy.startsWith("Flat")) {
      const filePath = path.join(groupDir, "infra.ts");
      fs.writeFileSync(filePath, generateFlatCode(gr, propNames, groupDir, files));
      files.push(path.join(relGroupDir, "infra.ts"));
    } else {
      if (networks.length > 0) {
        const networkDir = path.join(groupDir, "network");
        fs.mkdirSync(networkDir, { recursive: true });
        const filePath = path.join(networkDir, "network-stack.ts");
        fs.writeFileSync(filePath, generateTierCode("NetworkStack", networks, propNames, importsFor(networks), [], gr, networkDir, files));
        files.push(path.join(relGroupDir, "network", "network-stack.ts"));
      }
      const dbHeaders = networks.length > 0 ? ['import { NetworkStack } from "./network/network-stack.js";'] : [];
      if (dbs.length > 0) {
        const filePath = path.join(groupDir, "database-stack.ts");
        fs.writeFileSync(filePath, generateTierCode("DatabaseStack", dbs, propNames, importsFor(dbs), dbHeaders, gr, groupDir, files));
        files.push(path.join(relGroupDir, "database-stack.ts"));
      }
      const computeHeaders = [
        ...(networks.length > 0 ? ['import { NetworkStack } from "./network/network-stack.js";'] : []),
        ...(dbs.length > 0      ? ['import { DatabaseStack } from "./database-stack.js";']       : []),
      ];
      if (compute.length > 0) {
        const filePath = path.join(groupDir, "compute-stack.ts");
        fs.writeFileSync(filePath, generateTierCode("ComputeStack", compute, propNames, importsFor(compute), computeHeaders, gr, groupDir, files));
        files.push(path.join(relGroupDir, "compute-stack.ts"));
      }
    }
  }

  console.log(`\n  ✅  ${files.length} file(s) written:`);
  files.forEach((f) => console.log(`     ${f}`));
  console.log(`\n     Next: remove \`dryRun: true\` in @Deploy when you're ready to go live.\n`);
  return files.length;
}
