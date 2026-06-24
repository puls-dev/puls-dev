import "dotenv/config";
import "reflect-metadata";
import { Deploy } from "../../src/core/decorators.js";
import { Stack } from "../../src/core/stack.js";
import { Firebase } from "../../src/providers/firebase/index.js";

// Make sure to run `mkdocs build` or similar to generate the `./site` directory first.
@Deploy({ dryRun: false })
class DocsBlog extends Stack {
  site = Firebase.Hosting("puls-docs").source("./site").domain("pulsdev.io");
}
