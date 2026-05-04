import "dotenv/config";
import { DO } from "./src/providers/do/droplet.ts";
import { OS, REGION, SIZE } from "./src/types/do.ts";
import { Stack } from "./src/core/stack.ts";
import { Protected, Deploy, DryRun, Destroy } from "./src/core/decorators.ts";

DO.init({ token: process.env.DO_TOKEN! });

@Deploy({ region: REGION.FRA, dryRun: true })
class StagingInfra extends Stack {
  @Protected
  web = DO.Droplet("staging-web")
    .size(SIZE.SMALL)
    .region(REGION.FRA)
    .image(OS.UBUNTU_22_04)
    .sslKey("~/.ssh/id_ed25519.pub");
}
