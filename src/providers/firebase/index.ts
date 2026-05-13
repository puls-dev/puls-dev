import { FirebaseHostingBuilder } from './hosting.ts';
import { FirebaseFunctionsBuilder, FUNCTIONS_RUNTIME } from './functions.ts';
import { FirebaseFirestoreBuilder } from './firestore.ts';
import { FirebaseStorageBuilder } from './storage.ts';
import { FirebaseAuthBuilder } from './auth.ts';
import { FirebaseRemoteConfigBuilder } from './remoteconfig.ts';

export { FUNCTIONS_RUNTIME };

export const Firebase = {
  Hosting:      (siteId: string) => new FirebaseHostingBuilder(siteId),
  Functions:    (functionName: string) => new FirebaseFunctionsBuilder(functionName),
  Firestore:    (database: string = '(default)') => new FirebaseFirestoreBuilder(database),
  Storage:      (bucket?: string) => new FirebaseStorageBuilder(bucket),
  Auth:         () => new FirebaseAuthBuilder(),
  RemoteConfig: () => new FirebaseRemoteConfigBuilder(),
};
