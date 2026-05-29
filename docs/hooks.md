# Lifecycle Hooks: Slack & Discord Alerts

Puls provides a robust, asynchronous **Lifecycle Hooks** engine that allows developers to run custom logic at both the **Stack level** and **Resource level**. Hooks are incredibly powerful for side effects such as running database migrations, notifying team alert channels, purging CDN caches, or performing health checks during deployment boundaries.

---

## ⚡ Resource-Level Hooks

Every resource builder in the Puls framework natively inherits four fluent lifecycle chain methods:
* `.beforeDeploy(callback)`: Executes *before* the resource's `deploy()` API call.
* `.afterDeploy(callback)`: Executes *after* the resource has successfully deployed, receiving the resolved deployment output (e.g. IPs, URLs, resource IDs).
* `.beforeDestroy(callback)`: Executes *before* the resource's `destroy()` API call.
* `.afterDestroy(callback)`: Executes *after* the resource is successfully destroyed, receiving the teardown results.

### Usage Example

```typescript
import { Stack, Deploy } from "puls-dev";
import { GCP } from "puls-dev/gcp";

@Deploy({ dryRun: false })
class AppStack extends Stack {
  // Simple programmatic resource-level hook
  api = GCP.CloudRun("api-service")
    .image("gcr.io/my-project/api:latest")
    .afterDeploy(async (result) => {
      console.log(`🚀 API Service is live! Public Endpoint: ${result.url}`);
    });
}
```

---

## 🏗️ Stack-Level Hooks

A Puls `Stack` can declare class methods that run at the boundaries of the stack's deployment or teardown lifecycles.
* `beforeDeploy()`: Runs *before* any resource in the stack is deployed.
* `afterDeploy(outputs)`: Runs *after* all resources in the stack have successfully deployed, receiving a map of all resolved resource output results.
* `beforeDestroy()`: Runs *before* the stack teardown begins.
* `afterDestroy(outputs)`: Runs *after* all resources are successfully torn down.

### Usage Example

```typescript
import { Stack, Deploy } from "puls-dev";
import { DO } from "puls-dev/do";

@Deploy({ dryRun: false })
class StagingStack extends Stack {
  web = DO.Droplet("staging-web").size("s-1vcpu-1gb");
  db  = DO.Droplet("staging-db").size("s-2vcpu-2gb");

  // Stack-level post-deployment boundary hook
  async afterDeploy(outputs: any) {
    const webIp = outputs.web.ip;
    console.log(`📦 Staging Stack is active! Web IP: ${webIp}`);
    // Run integration checks, migrations, or notify teams...
  }
}
```

---

## 💬 Built-in SLACK Notifications

Puls ships with a ready-to-use **Slack Notifier** helper (`SLACK.notify(webhookUrl)`) that formats structured messages and posts them to your team channels.
* **Status formatting**: Automatically displays a rocket 🚀 emoji on successful deploys and a trashcan 🗑️ emoji on resource destructions.
* **Property inclusion**: Lists all simple, resolved output properties (such as IPs, URLs, regions) dynamically.

```typescript
import { Stack, Deploy, SLACK } from "puls-dev";
import { GCP } from "puls-dev/gcp";

const SLACK_WEBHOOK = "https://hooks.slack.com/services/...";

@Deploy({ dryRun: false })
class ProdStack extends Stack {
  app = GCP.CloudRun("prod-api")
    .image("us-central1-docker.pkg.dev/prod/api:latest")
    .afterDeploy(SLACK.notify(SLACK_WEBHOOK));
}
```

---

## 👾 Built-in DISCORD Embed Alerts

Puls also supports **Discord Webhook** alerts (`DISCORD.notify(webhookUrl)`) styled as highly visual, rich embeds:
* **Themed Colors**: Displays a green border stripe on deployments and a red border stripe on teardowns.
* **Inline Fields Grid**: Renders resolved output parameters (IPs, URLs, statuses) as an inline card grid inside the Discord message.
* **Time-stamped logs**: Includes a native footer and timestamp of the deploy boundary.

```typescript
import { Stack, Deploy, DISCORD } from "puls-dev";
import { GCP } from "puls-dev/gcp";

const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/...";

@Deploy({ dryRun: false })
class AppStack extends Stack {
  db = GCP.CloudSQL("app-db")
    .engine({ engine: "postgres", version: "16" })
    .afterDeploy(DISCORD.notify(DISCORD_WEBHOOK)) // Rich green embed card
    .afterDestroy(DISCORD.notify(DISCORD_WEBHOOK)); // Rich red embed card
}
```

---

## 🔍 How Notifiers Behave in Dry-Run

Puls respects your `.dryRun` configurations completely:
* In dry-run mode, resource deploy/destroy calls resolve to placeholder values (`PENDING` or `0.0.0.0`), which are then safely passed to your hooks.
* Both `SLACK` and `DISCORD` helpers automatically detect dry-run states and **safely print the preview to your terminal logs** instead of sending live HTTP webhook payloads:

```bash
📢 [DRY RUN] Would post Discord notification to webhook: https://discord.com/api/...
   Embed Title: 🚀 Puls Notification
   Embed Description: Resource **app-db** was successfully **deployed/updated**!
   Fields:
     • engine: `POSTGRES_16`
     • size: `db-f1-micro`
     • endpoint: `PENDING`
```
