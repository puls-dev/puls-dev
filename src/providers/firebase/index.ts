import "./plugin.js";
import { FirebaseHostingBuilder } from './hosting.js';
import { FirebaseFunctionsBuilder, FUNCTIONS_RUNTIME } from './functions.js';
import { FirebaseFirestoreBuilder } from './firestore.js';
import { FirebaseStorageBuilder } from './storage.js';
import { FirebaseAuthBuilder } from './auth.js';
import { FirebaseRemoteConfigBuilder } from './remoteconfig.js';
import { FirebaseAppCheckBuilder } from './appcheck.js';

export { FUNCTIONS_RUNTIME };

export const Firebase = {
  Hosting:      (siteId: string) => new FirebaseHostingBuilder(siteId),
  Functions:    (functionName: string) => new FirebaseFunctionsBuilder(functionName),
  Firestore:    (database: string = '(default)') => new FirebaseFirestoreBuilder(database),
  Storage:      (bucket?: string) => new FirebaseStorageBuilder(bucket),
  Auth:         () => new FirebaseAuthBuilder(),
  RemoteConfig: () => new FirebaseRemoteConfigBuilder(),
  AppCheck:     () => new FirebaseAppCheckBuilder(),
};
