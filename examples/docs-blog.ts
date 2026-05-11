import "dotenv/config";
import "reflect-metadata";
import { Deploy } from "../src/core/decorators.ts";
import { Stack } from "../src/core/stack.ts";
import { Firebase } from "../src/providers/firebase/index.ts";

@Deploy({ dryRun: true })
class DocsBlog extends Stack {
  site = Firebase.Hosting("opsdsl-docs").source("./site");
}
