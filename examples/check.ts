import "dotenv/config";
import "reflect-metadata";
import { Check } from "../src/core/decorators.js";
import { Checker } from "../src/core/checker.js";

// Discovers and prints all infrastructure for every configured provider.
// Run: npx tsx examples/check.ts

@Check({
  //token:  process.env.DO_TOKEN,
  region: process.env.AWS_REGION ?? "eu-central-1",
  token: process.env.AWS_SECRET_ACCESS_KEY,
  proxmox: undefined,
})
class InfraCheck extends Checker {}
