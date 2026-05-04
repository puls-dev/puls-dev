import { DO, OS, REGION, SIZE } from "./dsl.ts";
import { Destroy } from "./src/core/decorators.ts";

async function main() {
  console.log("--- Case 1: Existing Resource with Changes ---");
  // 'web-server' exists in mock with SIZE.SMALL and REGION.FRA
  await DO.Droplet("web-server")
    .image(OS.DEBIAN_11)
    .region(REGION.FRA)
    .size(SIZE.MEDIUM) // This will trigger an update
    .deploy();

  console.log("\n--- Case 2: New Resource ---");
  await DO.Droplet("database-master")
    .image(OS.UBUNTU_22_04)
    .region(REGION.NYC)
    .size(SIZE.LARGE)
    .deploy();
}

main();
