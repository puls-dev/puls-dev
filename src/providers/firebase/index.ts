import { FirebaseHostingBuilder } from './hosting.ts';

export const Firebase = {
  Hosting: (siteId: string) => new FirebaseHostingBuilder(siteId),
};
