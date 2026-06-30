import { BaseBuilder } from '@puls-dev/core';
import { Output } from '@puls-dev/core';
import { getHCloudApi } from './api.js';

export class SSHKeyBuilder extends BaseBuilder {
  readonly out = {
    id: new Output<number>(),
    fingerprint: new Output<string>(),
  };

  private _publicKey?: string;
  private keyId?: number;

  private log(msg: string) {
    console.log(`   🔑 [HCloud.SSHKey] ${msg}`);
  }

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverKey(name);
  }

  private async discoverKey(name: string): Promise<any> {
    const api = getHCloudApi();
    const data = await api.get<{ ssh_keys: any[] }>('/ssh_keys');
    const match = data.ssh_keys.find(k => k.name === name) ?? null;
    if (match) {
      this.keyId = match.id;
      this.out.id.resolve(match.id);
      this.out.fingerprint.resolve(match.fingerprint);
    }
    return match;
  }

  publicKey(key: string) {
    this._publicKey = key.trim();
    return this;
  }

  getDiff(existing: any) {
    const diffs = [];
    if (this._publicKey && existing && existing.public_key.trim() !== this._publicKey) {
      diffs.push({ field: "publicKey", declared: this._publicKey, live: existing.public_key });
    }
    return diffs;
  }

  async deploy() {
    const api = getHCloudApi();
    const existing = await this.discoveryPromise;

    if (!existing) {
      if (!this._publicKey) {
        throw new Error(`Cannot create SSH Key '${this.name}': publicKey must be specified.`);
      }
      this.log(`Creating SSH Key...`);
      const res = await api.post<{ ssh_key: any }>('/ssh_keys', {
        name: this.name,
        public_key: this._publicKey,
      });
      this.keyId = res.ssh_key.id;
      this.out.id.resolve(res.ssh_key.id);
      this.out.fingerprint.resolve(res.ssh_key.fingerprint);
      this.log(`Created SSH Key with ID ${this.keyId}`);
    } else {
      const diffs = this.getDiff(existing);
      if (diffs.length > 0) {
        this.log(`SSH Key public key has drifted. Re-creating...`);
        await api.delete(`/ssh_keys/${this.keyId}`);
        const res = await api.post<{ ssh_key: any }>('/ssh_keys', {
          name: this.name,
          public_key: this._publicKey,
        });
        this.keyId = res.ssh_key.id;
        this.out.id.resolve(res.ssh_key.id);
        this.out.fingerprint.resolve(res.ssh_key.fingerprint);
      } else {
        this.log(`SSH Key already exists and is up to date.`);
      }
    }
  }

  async destroy() {
    const existing = await this.discoveryPromise;
    if (existing) {
      this.log(`Deleting SSH Key...`);
      const api = getHCloudApi();
      await api.delete(`/ssh_keys/${this.keyId}`);
      this.log(`Deleted SSH Key.`);
    } else {
      this.log(`SSH Key does not exist. Skipping deletion.`);
    }
  }
}
