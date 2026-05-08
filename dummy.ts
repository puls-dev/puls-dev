import { Deploy } from "./src/core/decorators";
import { REGION } from "./src/types/aws";

@Deploy({ region: REGION.EU_CENTRAL_1, token: process.env.firebase.json})
blog = Firebase.App("myblog").config("./src/App.js");
