import "dotenv/config";
import "reflect-metadata";
import { Deploy, Stack } from "../src/index.js";
import { GCP } from "../src/providers/gcp/index.js";

@Deploy({ dryRun: true })
class TestServer extends Stack {
  server = GCP.VM("my-app-server")
    .machineType("e2-medium")
    .zone("us-central1-a")
    .image("projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts")
    .network("global/networks/default")
    .sshKey("~/.ssh/id_ed25519.pub")
    .provision("config/docker.yaml", "config/nginx.yaml");
}
