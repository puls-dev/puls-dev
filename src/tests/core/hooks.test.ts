import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { Stack } from "../../core/stack.js";
import { BaseBuilder } from "../../core/resource.js";
import { Config } from "../../core/config.js";
import { SLACK, DISCORD } from "../../core/hooks.js";

// A minimal dummy resource builder for testing hooks
class TestResource extends BaseBuilder {
  constructor(name: string, private resultValue: any = { name: "test-res", ip: "1.2.3.4" }) {
    super(name);
  }

  async deploy() {
    return this.resultValue;
  }

  async destroy() {
    return { name: this.name, destroyed: true };
  }
}

describe("Lifecycle Hooks & Notifier Tests", () => {
  let executionLogs: string[] = [];

  beforeEach(() => {
    Config.set({
      dryRun: false,
      providers: {},
    });
    executionLogs = [];
  });

  test("runs Stack-level and Resource-level deploy hooks in the correct order", async () => {
    class MyStack extends Stack {
      async beforeDeploy() {
        executionLogs.push("stack-before-deploy");
      }

      async afterDeploy(outputs: any) {
        executionLogs.push(`stack-after-deploy:${outputs.res.ip}`);
      }

      res = new TestResource("my-res", { name: "my-res", ip: "9.9.9.9" })
        .beforeDeploy(() => {
          executionLogs.push("res-before-deploy");
        })
        .afterDeploy((result) => {
          executionLogs.push(`res-after-deploy:${result.ip}`);
        });
    }

    const stack = new MyStack();
    const outputs = await stack.deploy();

    // Verify ordering
    assert.deepStrictEqual(executionLogs, [
      "stack-before-deploy",
      "res-before-deploy",
      "res-after-deploy:9.9.9.9",
      "stack-after-deploy:9.9.9.9",
    ]);

    assert.deepStrictEqual(outputs.res, { name: "my-res", ip: "9.9.9.9" });
  });

  test("runs Stack-level and Resource-level destroy hooks in the correct order", async () => {
    class MyStack extends Stack {
      async beforeDestroy() {
        executionLogs.push("stack-before-destroy");
      }

      async afterDestroy(outputs: any) {
        executionLogs.push(`stack-after-destroy:${outputs.res.destroyed}`);
      }

      res = new TestResource("my-res")
        .beforeDestroy(() => {
          executionLogs.push("res-before-destroy");
        })
        .afterDestroy((result) => {
          executionLogs.push(`res-after-destroy:${result.destroyed}`);
        });
    }

    const stack = new MyStack();
    const outputs = await stack.destroy();

    // Verify ordering (destroy properties are iterated in reverse order, which doesn't affect single resource)
    assert.deepStrictEqual(executionLogs, [
      "stack-before-destroy",
      "res-before-destroy",
      "res-after-destroy:true",
      "stack-after-destroy:true",
    ]);

    assert.deepStrictEqual(outputs.res, { name: "my-res", destroyed: true });
  });

  test("SLACK.notify helper sends fetch call on real deploys", async () => {
    const originalFetch = globalThis.fetch;
    let fetchPayload: any = null;
    let fetchUrl = "";

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetchUrl = url;
      fetchPayload = JSON.parse(init?.body as string);
      return {
        ok: true,
        status: 200,
      } as Response;
    }) as any;

    try {
      const webhook = "https://hooks.slack.com/services/T00/B00/X00";
      const notifyHook = SLACK.notify(webhook);

      const deployResult = { name: "web-app", url: "https://web.run.app", ip: "1.2.3.4" };
      await notifyHook(deployResult);

      assert.strictEqual(fetchUrl, webhook);
      assert.ok(fetchPayload);
      assert.ok(fetchPayload.text.includes("🚀"));
      assert.ok(fetchPayload.text.includes("web-app"));
      assert.ok(fetchPayload.text.includes("https://web.run.app"));
      assert.ok(fetchPayload.text.includes("1.2.3.4"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("SLACK.notify helper formats text and logs to console on dry-runs", async () => {
    Config.set({
      dryRun: true,
      providers: {},
    });

    const originalLog = console.log;
    let logOutput = "";
    console.log = (...args: any[]) => {
      logOutput += args.join(" ") + "\n";
    };

    try {
      const notifyHook = SLACK.notify("https://hooks.slack.com/services/T00");
      const destroyResult = { name: "old-db", destroyed: true };
      await notifyHook(destroyResult);

      assert.ok(logOutput.includes("📢 [DRY RUN]"));
      assert.ok(logOutput.includes("Would post Slack notification"));
      assert.ok(logOutput.includes("🗑️"));
      assert.ok(logOutput.includes("old-db"));
      assert.ok(logOutput.includes("destroyed"));
    } finally {
      console.log = originalLog;
    }
  });

  test("DISCORD.notify helper sends fetch call with rich embed on real deploys", async () => {
    const originalFetch = globalThis.fetch;
    let fetchPayload: any = null;
    let fetchUrl = "";

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetchUrl = url;
      fetchPayload = JSON.parse(init?.body as string);
      return {
        ok: true,
        status: 200,
      } as Response;
    }) as any;

    try {
      const webhook = "https://discord.com/api/webhooks/123/abc";
      const notifyHook = DISCORD.notify(webhook);

      const deployResult = { name: "api-srv", url: "https://api.run.app", active: true };
      await notifyHook(deployResult);

      assert.strictEqual(fetchUrl, webhook);
      assert.ok(fetchPayload);
      assert.ok(fetchPayload.embeds);
      assert.strictEqual(fetchPayload.embeds.length, 1);

      const embed = fetchPayload.embeds[0];
      assert.strictEqual(embed.title, "🚀 Puls Notification");
      assert.ok(embed.description.includes("api-srv"));
      assert.ok(embed.description.includes("deployed/updated"));
      assert.strictEqual(embed.color, 3066993); // Green

      assert.strictEqual(embed.fields.length, 2);
      assert.deepStrictEqual(embed.fields[0], { name: "url", value: "`https://api.run.app`", inline: true });
      assert.deepStrictEqual(embed.fields[1], { name: "active", value: "`true`", inline: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("DISCORD.notify helper formats embeds and logs to console on dry-runs", async () => {
    Config.set({
      dryRun: true,
      providers: {},
    });

    const originalLog = console.log;
    let logOutput = "";
    console.log = (...args: any[]) => {
      logOutput += args.join(" ") + "\n";
    };

    try {
      const notifyHook = DISCORD.notify("https://discord.com/api/webhooks/123");
      const destroyResult = { name: "old-cache", destroyed: true };
      await notifyHook(destroyResult);

      assert.ok(logOutput.includes("📢 [DRY RUN]"));
      assert.ok(logOutput.includes("Would post Discord notification"));
      assert.ok(logOutput.includes("🗑️"));
      assert.ok(logOutput.includes("old-cache"));
      assert.ok(logOutput.includes("destroyed"));
    } finally {
      console.log = originalLog;
    }
  });
});
