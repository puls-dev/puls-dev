# Getting Started

## Prerequisites

- Node.js 20+
- npm
- Credentials for at least one provider

## Install

Install the core stack engine, and the specific cloud providers you want to manage (for example, `@puls-dev/aws`):

```bash
npm install @puls-dev/core @puls-dev/aws
```

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

## Your first stack

Create a file - any name, anywhere in the project:

```typescript
import "dotenv/config";
import "reflect-metadata";
import { Stack, Deploy } from "@puls-dev/core";
import { AWS, REGION, RUNTIME } from "@puls-dev/aws";

@Deploy({ region: REGION.EU_CENTRAL_1 })
class MyFirstStack extends Stack {
  fn = AWS.Lambda("hello-world")
    .code("./functions/hello")
    .runtime(RUNTIME.NODEJS_20);
}
```

## The `puls` CLI

`@puls-dev/core` ships a `puls` binary. Run the one-time shell setup so you never need `npx` again:

```bash
npx @puls-dev/core install-shell
```

This creates a tiny launcher at `~/.puls/bin/puls` and adds it to your PATH in `~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish`. After sourcing your shell config (or opening a new terminal), `puls` is available everywhere:

```bash
puls plan    my-first-stack.ts   # dry-run - prints what would change, no API writes
puls deploy  my-first-stack.ts   # apply the stack
puls destroy my-first-stack.ts   # tear down the stack
puls diff    my-first-stack.ts   # compare declared intent vs live cloud state
```

**Always run `plan` first.** It activates dry-run mode automatically regardless of what `dryRun` is set to in your decorator.

Additional flags:

```bash
puls deploy  my-stack.ts --parallel        # enable parallel resource execution
puls deploy  my-stack.ts --dry-run         # force dry-run on any command
puls diff    my-stack.ts --fail-on-drift   # exit 1 if any resource has drifted
puls --version
puls --help
```

To remove the shell integration: `puls uninstall-shell`

> **Note:** `puls` requires [tsx](https://github.com/privatenumber/tsx) to execute TypeScript files.
> It is installed automatically as a dev dependency: `npm install --save-dev tsx`
>
> In CI pipelines always use `npx puls`- `install-shell` is for local development only.

### Running without the CLI

You can still run stack files directly if you prefer:

```bash
npx tsx my-first-stack.ts
```

Use the `dryRun` decorator option to control mode in that case:

```typescript
@Deploy({ region: REGION.EU_CENTRAL_1, dryRun: true })  // safe - no API writes
```

## Dry run output

```
🏗️  Deploying Stack: MyFirstStack

⚡ Finalizing Lambda Function "hello-world"...
   📝 [PLAN] Create function "hello-world"
      └─ Runtime: nodejs20.x | Handler: index.handler
      └─ Memory: 128MB | Timeout: 30s
      └─ Code: ./functions/hello
```

## Env file

Create `.env` in the project root with credentials for the providers you use:

```bash
# DigitalOcean
DO_TOKEN=

# AWS (standard SDK env vars)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1

# Proxmox
PROXMOX_URL=https://pve.example.com:8006
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=puls
PROXMOX_TOKEN_SECRET=
PROXMOX_NODES=pve1,pve2
PROXMOX_DNS_DOMAIN=internal.example.com
PROXMOX_DNS_SERVERS=10.0.0.1

# Firebase / GCP
FIREBASE_SA=./firebase/service-account.json
GCP_SA=./gcp/service-account.json

# Cloudflare
CLOUDFLARE_TOKEN=
CLOUDFLARE_ACCOUNT_ID=

# Azure
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_TENANT_ID=
AZURE_SUBSCRIPTION_ID=
```

All stack files start with `import "dotenv/config"` to load this file.

## Idempotency

Running the same stack twice is always safe. Puls discovers existing state before every deploy and skips resources that already match. You'll see:

```
✅ Function "hello-world" already exists
```

instead of an error or a duplicate.

## Provider setup

See the individual provider pages for credentials and constants. Note that you can always [define your own custom types and constants](concepts.md#extensibility--custom-types) if the built-in ones don't suit your needs.

- [AWS](providers/aws.md)
- [Azure](providers/azure.md)
- [Cloudflare](providers/cloudflare.md)
- [DigitalOcean](providers/digitalocean.md)
- [Firebase](providers/firebase.md)
- [GCP](providers/gcp.md)
- [Proxmox](providers/proxmox.md)
