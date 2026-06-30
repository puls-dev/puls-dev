# @puls-dev/firebase

**Firebase Provider for Puls IaC. Deploy hosting, serverless functions, database rules, and auth providers with built-in local emulator testing.**

---

## What is @puls-dev/firebase?

This package is the official Firebase provider plug-in for Puls. In addition to managing production Firebase resources, it features **dynamic local emulator redirection** so you can run E2E integration tests against Firestore and Authentication emulators locally without touching production.

## Available Builders

* **`Firebase.Hosting`**: Web app hosting and custom domains.
* **`Firebase.Functions`**: Deploy Firebase Cloud Functions (Node.js).
* **`Firebase.Firestore`**: Configure Firestore databases, security rules, and indexes.
* **`Firebase.Storage`**: Cloud Storage buckets and security rules.
* **`Firebase.Auth`**: Enable Authentication providers (Email/Password, Google, etc.).
* **`Firebase.RemoteConfig`**: Manage template flags.
* **`Firebase.AppCheck`**: Declare security keys.

## Installation

```bash
npm install @puls-dev/core @puls-dev/firebase
```

## Quick Example

```typescript
import { Stack, Deploy } from "@puls-dev/core";
import { Firebase } from "@puls-dev/firebase";

@Deploy()
class WebStack extends Stack {
  site = Firebase.Hosting("my-app")
    .source("./dist")
    .domain("my-app.web.app");
}
```

## Authentication & Testing

For production deploys, set your service account key path:
```bash
FIREBASE_SA=./firebase/service-account.json
```

For local testing, the provider automatically checks for emulator variables (e.g. `FIRESTORE_EMULATOR_HOST`) and redirects API calls accordingly.

Learn more at **[pulsdev.io/providers/firebase](https://pulsdev.io/providers/firebase)**.
