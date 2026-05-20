import "dotenv/config";
import "reflect-metadata";
import { DO, DO_TYPES, Stack, DryRun } from "../src/index.js";
const { REGION, SIZE } = DO_TYPES;

@DryRun({ token: process.env.DO_TOKEN! })
class DryRunStack extends Stack {
  // 1. Declare two backend droplets
  web1 = DO.Droplet("prod-web-01")
    .size(SIZE.MEDIUM)
    .region(REGION.FRA);

  web2 = DO.Droplet("prod-web-02")
    .size(SIZE.MEDIUM)
    .region(REGION.FRA);

  // 2. Declare certificate sidecar (optional)
  cert = DO.Certificate("example.com");

  // 3. Declare load balancer with complete settings
  lb = DO.LoadBalancer("prod-lb")
    .region(REGION.FRA)
    .target(this.web1, this.web2)
    .forward("http", 80, "http", 80)
    .forward("https", 443, "http", 80, "ssl-example.com")
    .healthCheck({
      protocol: "http",
      port: 80,
      path: "/healthz",
      checkIntervalSeconds: 15,
      responseTimeoutSeconds: 3,
    })
    .stickySession("cookies", "PROD-LB-COOKIE", 600)
    .protect();
}
