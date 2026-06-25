import { test, describe } from "node:test";
import assert from "node:assert";
import { Stack, Config } from "@puls-dev/core";
import { Firebase } from "../index.js";

async function areFirebaseEmulatorsRunning(): Promise<boolean> {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? "localhost:8080";
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "localhost:9099";
  try {
    await fetch(`http://${firestoreHost}/`);
    await fetch(`http://${authHost}/`);
    return true;
  } catch {
    return false;
  }
}

describe("Firebase Emulator E2E Tests", () => {
  test("successfully executes Auth and Firestore lifecycle against emulators", async (t) => {
    const active = await areFirebaseEmulatorsRunning();
    if (!active) {
      t.skip(
        "Firebase Emulators are not running. " +
          "Start them using: npx -y firebase-tools@latest emulators:start --project demo-puls-test --only auth,firestore"
      );
      return;
    }

    // Configure Puls Firebase provider to route to emulators
    Config.set({
      dryRun: false,
      providers: {
        firebase: {
          projectId: "demo-puls-test",
        },
      },
    });

    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
    }
    if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
    }

    class FirebaseE2EStack extends Stack {
      auth = Firebase.Auth()
        .emailPassword()
        .anonymous();

      firestore = Firebase.Firestore("(default)")
        .rules("src/tests/e2e/firestore.rules")
        .index("users", [
          { field: "email", order: "ASCENDING" },
          { field: "createdAt", order: "DESCENDING" },
        ]);
    }

    const stack = new FirebaseE2EStack();

    // Stage 1: Deploy
    console.log("   🧪 E2E STAGE 1: Deploying Firebase stack...");
    const deployOutputs = await stack.deploy();
    assert.ok(deployOutputs.auth, "Auth output should be returned");
    assert.strictEqual(deployOutputs.auth.project, "demo-puls-test");
    assert.ok(deployOutputs.firestore, "Firestore output should be returned");
    assert.strictEqual(deployOutputs.firestore.database, "(default)");

    // Stage 2: Idempotency
    console.log("   🧪 E2E STAGE 2: Deploying again (idempotency check)...");
    const deployOutputs2 = await stack.deploy();
    assert.ok(deployOutputs2.auth);
    assert.ok(deployOutputs2.firestore);

    // Stage 3: Teardown
    console.log("   🧪 E2E STAGE 3: Tearing down Firebase stack...");
    const destroyOutputs = await stack.destroy();
    assert.ok(destroyOutputs.auth, "Auth should be destroyed");
    assert.ok(destroyOutputs.firestore, "Firestore should be destroyed");
  });
});
