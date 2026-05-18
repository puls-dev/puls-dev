import "dotenv/config";
import "reflect-metadata";
import { Deploy } from "../src/core/decorators.js";
import { Stack } from "../src/core/stack.js";
import { Firebase } from "../src/providers/firebase/index.js";

// Will deploy a Firebase Hosting site for the docs blog.
@Deploy({ dryRun: true })
class DocsBlog extends Stack {
  site = Firebase.Hosting("puls-docs").source("./site");
}
