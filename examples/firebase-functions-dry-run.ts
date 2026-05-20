import "dotenv/config";
import "reflect-metadata";
import { Firebase, Stack, DryRun } from "../src/index.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// 1. Create a mock source directory for the function
const mockSrcDir = "./scratch/mock-func";
if (!existsSync(mockSrcDir)) {
  mkdirSync(mockSrcDir, { recursive: true });
}
writeFileSync(join(mockSrcDir, "index.js"), "exports.handler = (req, res) => res.send('ok');");
writeFileSync(
  join(mockSrcDir, "package.json"),
  JSON.stringify({ name: "mock-func", version: "1.0.0", type: "module", dependencies: {} }, null, 2)
);

// 2. Create a mock service account JSON file
const mockSaPath = "./scratch/mock-sa.json";
writeFileSync(
  mockSaPath,
  JSON.stringify({ project_id: "mock-project-id" }, null, 2)
);

@DryRun({ firebase: mockSaPath })
class FirebaseStack extends Stack {
  myFn = Firebase.Functions("hello-world")
    .region("europe-west1")
    .source(mockSrcDir)
    .entryPoint("handler")
    .runtime("nodejs22")
    .memory("512M")
    .timeout(30);
}
