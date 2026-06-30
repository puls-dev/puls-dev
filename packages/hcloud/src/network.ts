import { BaseBuilder } from '@puls-dev/core';
import { Output } from '@puls-dev/core';
import { getHCloudApi } from './api.js';

export class NetworkBuilder extends BaseBuilder {
  readonly out = {
    id: new Output<number>(),
  };

  private _ipRange: string = "10.0.0.0/16";
  private networkId?: number;

  private log(msg: string) {
    console.log(`   🌐 [HCloud.Network] ${msg}`);
  }

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverNetwork(name);
  }

  private async discoverNetwork(name: string): Promise<any> {
    const api = getHCloudApi();
    const data = await api.get<{ networks: any[] }>('/networks');
    const match = data.networks.find(n => n.name === name) ?? null;
    if (match) {
      this.networkId = match.id;
      this.out.id.resolve(match.id);
    }
    return match;
  }

  ipRange(range: string) {
    this._ipRange = range;
    return this;
  }

  getDiff(existing: any) {
    const diffs = [];
    if (existing && existing.ip_range !== this._ipRange) {
      diffs.push({ field: "ipRange", declared: this._ipRange, live: existing.ip_range });
    }
    return diffs;
  }

  async deploy() {
    const api = getHCloudApi();
    const existing = await this.discoveryPromise;

    if (!existing) {
      this.log(`Creating Network...`);
      const res = await api.post<{ network: any }>('/networks', {
        name: this.name,
        ip_range: this._ipRange,
      });
      this.networkId = res.network.id;
      this.out.id.resolve(res.network.id);
      this.log(`Created Network with ID ${this.networkId}`);
    } else {
      const diffs = this.getDiff(existing);
      if (diffs.length > 0) {
        this.log(`Network IP range has drifted. Re-creating...`);
        await api.delete(`/networks/${this.networkId}`);
        const res = await api.post<{ network: any }>('/networks', {
          name: this.name,
          ip_range: this._ipRange,
        });
        this.networkId = res.network.id;
        this.out.id.resolve(res.network.id);
      } else {
        this.log(`Network already exists and is up to date.`);
      }
    }
  }

  async destroy() {
    const existing = await this.discoveryPromise;
    if (existing) {
      this.log(`Deleting Network...`);
      const api = getHCloudApi();
      await api.delete(`/networks/${this.networkId}`);
      this.log(`Deleted Network.`);
    } else {
      this.log(`Network does not exist. Skipping deletion.`);
    }
  }
}
