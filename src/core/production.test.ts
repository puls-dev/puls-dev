import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { Stack } from "./stack.js";
import { Config } from "./config.js";
import { Output } from "./output.js";
import { BaseBuilder } from "./resource.js";
import { Secret } from "./secret.js";
import { resourceContextStorage } from "./context.js";
import { runAnsible } from "./provisioner.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class DelayResource extends BaseBuilder {
  readonly out = { val: new Output<string>() };
  constructor(name: string, private delayMs: number, private executionLogs: string[]) {
    super(name);
  }
  async deploy() {
    this.executionLogs.push(`start:${this.name}`);
    await delay(this.delayMs);
    this.executionLogs.push(`end:${this.name}`);
    return { name: this.name };
  }
}

class FailResource extends BaseBuilder {
  async deploy() {
    throw new Error("Failure in deploy!");
  }
}

class AbortResource extends BaseBuilder {
  constructor(name: string, private signalLogs: string[]) {
    super(name);
  }
  async deploy() {
    const signal = resourceContextStorage.getStore()?.abortSignal;
    if (signal) {
      if (signal.aborted) {
        this.signalLogs.push(`aborted-before:${this.name}`);
      } else {
        signal.addEventListener("abort", () => {
          this.signalLogs.push(`aborted-during:${this.name}`);
        });
      }
    }
    await delay(50);
    return { name: this.name };
  }
}

describe("Production Features Unit Tests", () => {
  beforeEach(() => {
    Config.set({
      dryRun: false,
      parallel: false,
      offline: false,
      providers: {}
    });
  });

  test("Secret Redaction in console.log during Stack execution", async () => {
    // Register secret
    const mySecret = new Secret("my-api-key", async () => "super-secret-12345");
    await mySecret.get(); // resolves and registers it

    const logs: string[] = [];
    const originalLog = console.log;
    
    // Create a stack that logs the secret
    class SecretStack extends Stack {
      r1 = new DelayResource("r1", 10, []);
      
      async beforeDeploy() {
        console.log("Starting deployment with my-api-key super-secret-12345");
      }
    }

    const stack = new SecretStack();
    
    // Intercept console.log temporarily just to capture it
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
      originalLog(...args);
    };

    try {
      await stack.deploy();
    } finally {
      console.log = originalLog;
    }

    const deploymentLog = logs.join("\n");
    assert.ok(!deploymentLog.includes("super-secret-12345"), "Should NOT contain raw secret");
    assert.ok(deploymentLog.includes("my-api-key ********"), "Should contain redacted secret replacement");
  });

  test("Secret Redaction in formatEntry table matching patterns", async () => {
    class CredentialsStack extends Stack {
      creds_resource = new class extends BaseBuilder {
        async deploy() {
          return {
            password: "my-cleartext-password",
            api_token: "my-cleartext-token",
            safe_field: "public-info"
          };
        }
      }("creds");

      db_password = new class extends BaseBuilder {
        async deploy() {
          return "my-cleartext-db-pass";
        }
      }("db-pass");
    }

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
      originalLog(...args);
    };

    try {
      await new CredentialsStack().deploy();
    } finally {
      console.log = originalLog;
    }

    const tableOutput = logs.join("\n");
    assert.ok(!tableOutput.includes("my-cleartext-password"), "Should redact password key values in table");
    assert.ok(!tableOutput.includes("my-cleartext-token"), "Should redact token key values in table");
    assert.ok(!tableOutput.includes("my-cleartext-db-pass"), "Should redact sensitive parent key values in table");
    assert.ok(tableOutput.includes("********"), "Should replace with asterisks");
    assert.ok(tableOutput.includes("public-info"), "Should preserve non-sensitive fields");
  });

  test("Parallel Scheduler Cancellation (Fail-Fast)", async () => {
    Config.set({ parallel: true });
    const signalLogs: string[] = [];

    class CancelStack extends Stack {
      r1 = new AbortResource("r1", signalLogs);
      r2 = new FailResource("r2");
    }

    await assert.rejects(async () => {
      await new CancelStack().deploy();
    }, /Failure in deploy!/);

    // Wait a bit for abort listener
    await delay(30);

    assert.ok(
      signalLogs.includes("aborted-during:r1") || signalLogs.includes("aborted-before:r1"),
      "Aborted resource should have abort signal triggered"
    );
  });

  test("Credential-Free Offline Dry-Run Mode", async () => {
    Config.set({ offline: true, dryRun: true });

    class OfflineStack extends Stack {
      aws_vm = new class extends BaseBuilder {
        async deploy() {
          const { getEC2Client } = await import("../providers/aws/api.js");
          const client = getEC2Client();
          const res = await client.send({ constructor: { name: "RunInstancesCommand" } } as any);
          return res;
        }
      }("aws");

      gcp_vm = new class extends BaseBuilder {
        async deploy() {
          const { gcpFetch } = await import("../providers/gcp/api.js");
          const res = await gcpFetch("compute", "/instances");
          return res;
        }
      }("gcp");
    }

    const outputs = await new OfflineStack().deploy();
    assert.ok(outputs.aws_vm.Instances[0].InstanceId.startsWith("i-mock"), "AWS VM should resolve to mock");
    assert.ok(outputs.gcp_vm.id.startsWith("mock-gcp-instance"), "GCP VM should resolve to mock");
  });

  test("Ansible Provisioner Stack-Wide Dynamic Inventory Generation", async () => {
    const context = {
      stackName: "my-test-stack",
      hosts: [
        { name: "web1", ip: "1.2.3.4", user: "root", sshKey: "/path/to/key", provider: "do" },
        { name: "db1", ip: "5.6.7.8", user: "ubuntu", sshKey: "/path/to/other-key", provider: "aws" }
      ]
    };

    await resourceContextStorage.run(context, async () => {
      try {
        await runAnsible("1.2.3.4", "root", "/path/to/key", "playbook.yml");
      } catch (err: any) {
        // We expect it might fail if ansible-playbook binary is missing, but it should still attempt write!
        assert.ok(err.message.includes("ansible-playbook") || err.message.includes("ENOENT"), "Should attempt run");
      }
      
      const fs = await import("node:fs");
      const exists = fs.existsSync("/tmp/puls-inventory-my-test-stack.ini");
      assert.ok(exists, "Dynamic inventory file should be generated in /tmp");
      const contents = fs.readFileSync("/tmp/puls-inventory-my-test-stack.ini", "utf8");
      assert.ok(contents.includes("web1 ansible_host=1.2.3.4"), "Should contain web1 host entry");
      assert.ok(contents.includes("db1 ansible_host=5.6.7.8"), "Should contain db1 host entry");
    });
  });
});
