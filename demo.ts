import "dotenv/config";
import { DO } from "./src/providers/do/droplet.ts";
import { REGION, SIZE } from "./src/types/do.ts";
import { Stack } from "./src/core/stack.ts";
import { Protected, Deploy, DryRun, Destroy } from "./src/core/decorators.ts";

DO.init({ token: process.env.DO_TOKEN! });

@Destroy
class StagingInfra extends Stack {
  web = DO.Droplet("staging-web").size(SIZE.SMALL).region(REGION.FRA);
}
