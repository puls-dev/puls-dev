import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SUPPORTED_PROVIDERS = ["aws", "proxmox"] as const;
type Provider = (typeof SUPPORTED_PROVIDERS)[number];

const GITIGNORE = `node_modules/
dist/
.env
*.log
`;

const ENV_EXAMPLES: Record<Provider, string> = {
  aws: `AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
AWS_AMI_ID=ami-0c55b159cbfafe1f0
AWS_KEY_NAME=my-keypair
DOMAIN_NAME=example.com
`,
  proxmox: `PROXMOX_URL=https://pve.example.com:8006
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=puls
PROXMOX_TOKEN_SECRET=
PROXMOX_NODES=pve1,pve2
PROXMOX_DNS_DOMAIN=local
PROXMOX_DNS_SERVERS=1.1.1.1
`,
};

const AWS_FILES: Record<string, string> = {
  "infra/aws/compute.ts": `import { Stack, Deploy } from "@puls-dev/core";
import { EC2VMBuilder } from "@puls-dev/aws";

@Deploy({ dryRun: true })
export class ComputeStack extends Stack {
  webServer = new EC2VMBuilder("web-server")
    .instanceType("t3.small")
    .ami(process.env.AWS_AMI_ID!)
    .keyName(process.env.AWS_KEY_NAME!)
    .provision("./playbooks/setup.yaml");
}
`,
  "infra/aws/storage.ts": `import { Stack, Deploy } from "@puls-dev/core";
import { S3BucketBuilder } from "@puls-dev/aws";

@Deploy({ dryRun: true })
export class StorageStack extends Stack {
  assets = new S3BucketBuilder("my-assets")
    .region(process.env.AWS_REGION ?? "us-east-1")
    .versioning(true);

  site = new S3BucketBuilder("my-site")
    .region(process.env.AWS_REGION ?? "us-east-1")
    .staticSite("index.html", "404.html");
}
`,
  "infra/aws/database.ts": `import { Stack, Deploy } from "@puls-dev/core";
import { RDSBuilder, SecretsBuilder } from "@puls-dev/aws";

@Deploy({ dryRun: true })
export class DatabaseStack extends Stack {
  dbPassword = new SecretsBuilder("app/db-password")
    .plainText("change-me-in-production");

  db = new RDSBuilder("app-db")
    .engine({ engine: "postgres", version: "16" })
    .size("db.t3.micro")
    .storage(20);
}
`,
  "infra/aws/serverless.ts": `import { Stack, Deploy } from "@puls-dev/core";
import { LambdaBuilder, APIGatewayBuilder } from "@puls-dev/aws";

@Deploy({ dryRun: true })
export class ServerlessStack extends Stack {
  handler = new LambdaBuilder("app-handler")
    .code("./src")
    .handler("index.handler")
    .runtime("nodejs20.x")
    .memory(256)
    .env({ NODE_ENV: "production" });

  api = new APIGatewayBuilder("app-api")
    .route("GET /health", this.handler)
    .proxy(this.handler);
}
`,
  "infra/aws/dns.ts": `import { Stack, Deploy } from "@puls-dev/core";
import { Route53Builder, CloudFrontBuilder } from "@puls-dev/aws";
import { StorageStack } from "./storage.js";

@Deploy({ dryRun: true })
export class DnsStack extends Stack {
  domain = new Route53Builder(process.env.DOMAIN_NAME ?? "example.com")
    .withWildcardSSL();

  cdn = new CloudFrontBuilder("site-cdn")
    .originBucket(Stack.from(StorageStack).site);
}
`,
};

const PROXMOX_FILES: Record<string, string> = {
  "infra/proxmox/templates.ts": `import { Stack, Deploy } from "@puls-dev/core";
import { TemplateBuilder } from "@puls-dev/proxmox";

@Deploy({ dryRun: true })
export class TemplateStack extends Stack {
  ubuntuBase = new TemplateBuilder("ubuntu-24-base")
    .image({
      name: "ubuntu-24.04",
      url: "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img",
    })
    .cores(2)
    .memory(2048)
    .node(process.env.PROXMOX_NODES?.split(",")[0] ?? "pve1")
    .provision("./playbooks/base.yaml");
}
`,
  "infra/proxmox/vms.ts": `import { Stack, Deploy } from "@puls-dev/core";
import { VMBuilder } from "@puls-dev/proxmox";
import { TemplateStack } from "./templates.js";

@Deploy({ dryRun: true })
export class VMStack extends Stack {
  web01 = new VMBuilder("web-01")
    .fromTemplate(Stack.from(TemplateStack).ubuntuBase)
    .cores(2)
    .memory(4096)
    .ip("192.168.1.10/24")
    .gateway("192.168.1.1")
    .provision("./playbooks/web.yaml");

  db01 = new VMBuilder("db-01")
    .fromTemplate(Stack.from(TemplateStack).ubuntuBase)
    .cores(4)
    .memory(8192)
    .ip("192.168.1.11/24")
    .gateway("192.168.1.1")
    .provision("./playbooks/database.yaml");
}
`,
};

const PROVIDER_FILES: Record<Provider, Record<string, string>> = {
  aws: AWS_FILES,
  proxmox: PROXMOX_FILES,
};

const NEXT_STEPS: Record<Provider, string[]> = {
  aws: [
    "cp .env.example .env  and fill in your credentials",
    "puls plan infra/aws/compute.ts",
    "Remove dryRun: true when you're ready to deploy",
  ],
  proxmox: [
    "cp .env.example .env  and fill in your credentials",
    "puls plan infra/proxmox/templates.ts",
    "Remove dryRun: true when you're ready to deploy",
  ],
};

function write(filePath: string, content: string, skipIfExists = false): void {
  if (skipIfExists && existsSync(filePath)) {
    console.log(`  (skip)  ${filePath}`);
    return;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  console.log(`  ✓  ${filePath}`);
}

export async function runInit(provider: string | undefined): Promise<void> {
  if (!provider) {
    console.error(
      `Error: Missing provider.\n\nUsage: puls init <provider>\n\nSupported providers: ${SUPPORTED_PROVIDERS.join(", ")}`
    );
    process.exit(1);
  }

  if (!SUPPORTED_PROVIDERS.includes(provider as Provider)) {
    console.error(
      `Error: Unknown provider "${provider}".\n\nSupported providers: ${SUPPORTED_PROVIDERS.join(", ")}`
    );
    process.exit(1);
  }

  const p = provider as Provider;
  const cwd = process.cwd();

  console.log(`\nInitializing Puls project with provider: ${p}\n`);

  // Git init if not already in a repo
  let gitInitialized = false;
  try {
    execSync("git rev-parse --git-dir", { stdio: "ignore" });
  } catch {
    execSync("git init", { stdio: "ignore" });
    gitInitialized = true;
    console.log("  ✓  git init");
  }

  // Shared files
  write(path.join(cwd, ".gitignore"), GITIGNORE, true);
  write(path.join(cwd, ".env.example"), ENV_EXAMPLES[p], true);

  // Provider scaffold files
  console.log("");
  for (const [relPath, content] of Object.entries(PROVIDER_FILES[p])) {
    write(path.join(cwd, relPath), content);
  }

  // Next steps
  console.log("\nReady. Next steps:");
  NEXT_STEPS[p].forEach((step, i) => {
    console.log(`  ${i + 1}. ${step}`);
  });
  console.log("");
}
