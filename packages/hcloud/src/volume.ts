import { BaseBuilder, Output, Config } from '@puls-dev/core';
import { getHCloudApi } from './api.js';
import { ServerBuilder } from './server.js';

export class VolumeBuilder extends BaseBuilder {
  readonly out = {
    id: new Output<number>(),
    linuxDevice: new Output<string>(),
  };

  private _size: number = 10; // GB
  private _location: string = Config.get().providers.hcloud?.defaultLocation || 'nbg1';
  private _server?: ServerBuilder | number;
  private _automount: boolean = false;
  private _format?: 'ext4' | 'xfs';
  private volumeId?: number;

  constructor(name: string) {
    super(name);
    this.discoveryPromise = this.discoverVolume(name);
  }

  private async discoverVolume(name: string): Promise<any> {
    const api = getHCloudApi();
    const data = await api.get<{ volumes: any[] }>('/volumes');
    const match = data.volumes.find(v => v.name === name) ?? null;
    if (match) {
      this.volumeId = match.id;
      this.out.id.resolve(match.id);
      this.out.linuxDevice.resolve(match.linux_device);
    }
    return match;
  }

  size(gb: number) {
    this._size = gb;
    return this;
  }

  location(loc: string) {
    this._location = loc;
    return this;
  }

  server(server: ServerBuilder | number) {
    this._server = server;
    return this;
  }

  automount(auto: boolean) {
    this._automount = auto;
    return this;
  }

  format(fsType: 'ext4' | 'xfs') {
    this._format = fsType;
    return this;
  }

  private log(msg: string) {
    console.log(`   💾 [HCloud.Volume] ${msg}`);
  }

  getDiff(existing: any) {
    const diffs = [];
    if (existing && existing.size !== this._size) {
      diffs.push({ field: "size", declared: this._size, live: existing.size });
    }
    return diffs;
  }

  async deploy() {
    const dryRun = this.isDryRunActive();
    const existing = await this.discoveryPromise;
    const api = getHCloudApi();

    const targetServerId = this._server instanceof ServerBuilder 
      ? await this._server.out.id.get() 
      : this._server;

    if (dryRun) {
      this.log(`Planning volume "${this.name}"...`);
      if (!existing) {
        this.log(`[PLAN] Create volume ${this.name} (${this._size} GB in ${this._location})`);
        if (targetServerId) {
          this.log(`      └─ Attach to server: ${targetServerId}`);
        }
        this.out.id.resolve(-1);
        this.out.linuxDevice.resolve('/dev/disk/by-id/scsi-0HC_Volume_mock');
      } else {
        const diffs = this.getDiff(existing);
        if (diffs.length > 0) {
          this.log(`[PLAN] Resize volume ${this.name} ${existing.size} GB -> ${this._size} GB`);
        }
        const currentServerId = existing.server;
        if (targetServerId !== currentServerId) {
          if (currentServerId && !targetServerId) {
            this.log(`[PLAN] Detach volume from server ${currentServerId}`);
          } else if (!currentServerId && targetServerId) {
            this.log(`[PLAN] Attach volume to server ${targetServerId}`);
          } else if (currentServerId && targetServerId) {
            this.log(`[PLAN] Detach from server ${currentServerId} and attach to ${targetServerId}`);
          }
        }
      }
      return;
    }

    this.log(`Finalizing volume...`);

    if (!existing) {
      const payload: any = {
        name: this.name,
        size: this._size,
        automount: this._automount,
      };
      if (this._format) payload.format = this._format;
      if (targetServerId) {
        payload.server = targetServerId;
      } else {
        payload.location = this._location;
      }

      const res = await api.post<{ volume: any; action?: any }>('/volumes', payload);
      this.volumeId = res.volume.id;
      this.out.id.resolve(res.volume.id);
      this.out.linuxDevice.resolve(res.volume.linux_device);

      if (res.action) {
        await api.waitForAction(res.action.id);
      }
      this.log(`Created volume (id=${this.volumeId})`);
    } else {
      const diffs = this.getDiff(existing);
      if (diffs.length > 0) {
        this.log(`Resizing volume to ${this._size} GB...`);
        const res = await api.post<{ action: any }>(`/volumes/${this.volumeId}/actions/resize`, { size: this._size });
        await api.waitForAction(res.action.id);
      }

      const currentServerId = existing.server;
      if (targetServerId !== currentServerId) {
        if (currentServerId) {
          this.log(`Detaching volume from server ${currentServerId}...`);
          const res = await api.post<{ action: any }>(`/volumes/${this.volumeId}/actions/detach`, {});
          await api.waitForAction(res.action.id);
        }
        if (targetServerId) {
          this.log(`Attaching volume to server ${targetServerId}...`);
          const res = await api.post<{ action: any }>(`/volumes/${this.volumeId}/actions/attach`, {
            server: targetServerId,
            automount: this._automount,
          });
          await api.waitForAction(res.action.id);
        }
      }
      this.log(`Volume is up to date.`);
    }
  }

  async destroy() {
    const existing = await this.discoveryPromise;
    if (existing) {
      this.log(`Deleting volume...`);
      const api = getHCloudApi();
      if (existing.server) {
        this.log(`Detaching from server first...`);
        const res = await api.post<{ action: any }>(`/volumes/${existing.id}/actions/detach`, {});
        await api.waitForAction(res.action.id);
      }
      await api.delete(`/volumes/${existing.id}`);
      this.log(`Deleted volume.`);
    } else {
      this.log(`Volume does not exist. Skipping deletion.`);
    }
  }
}
