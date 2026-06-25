import "dotenv/config";
import "reflect-metadata";
import { Firebase } from "../../packages/firebase/src";
import { Deploy, Stack } from "@puls-dev/core";

// Make sure to run `mkdocs build` or similar to generate the `./site` directory first.
@Deploy({ dryRun: true })
class DocsBlog extends Stack {
  site = Firebase.Hosting("puls-docs").source("./site").domain("pulsdev.io");
}
