# Getting Started

## Prerequisites

- Node.js 20+
- npm
- Credentials for at least one provider

## Install

```bash
npm install puls-dev
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
import { AWS, AWS_TYPES, Stack, Deploy } from "puls-dev";
const { REGION, RUNTIME } = AWS_TYPES;

@Deploy({ region: REGION.EU_CENTRAL_1, dryRun: true })
class MyFirstStack extends Stack {
  fn = AWS.Lambda("hello-world")
    .code("./functions/hello")
    .runtime(RUNTIME.NODEJS_20);
}
```

Run it:

```bash
npx tsx my-first-stack.ts
```

With `dryRun: true`, Puls prints what it *would* do without touching any API. When you're ready to apply, flip it to `false`.

## Dry run

Every stack should be run dry first:

```typescript
@Deploy({ region: REGION.EU_CENTRAL_1, dryRun: true })  // safe - no API writes
```

Output looks like:

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

# Firebase
FIREBASE_SA=./firebase/service-account.json
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
- [Proxmox](providers/proxmox.md)
- [DigitalOcean](providers/digitalocean.md)
- [Firebase](providers/firebase.md)
