import { Stack } from "../src/core/stack";
import { AWS } from "../src/providers/aws";
import { REGION, SECRETS } from "../src/types/aws";
import { Deploy, Destroy } from "../src/core/decorators";

@Destroy({ region: REGION.EU_WEST_1, dryRun: false })
class Secrets extends Stack {
  secrets = AWS.Secret("bia-key-value-test")
    .description("key-value test")
    .keyValue({ bia: "was-here" });
}
