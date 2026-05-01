export const OS = {
  DEBIAN_11: "debian-11-x64",
  UBUNTU_22_04: "ubuntu-22-04-x64",
  FEDORA_37: "fedora-37-x64",
} as const;

export const REGION = {
  FRA: "fra1",
  NYC: "nyc3",
  LON: "lon1",
  AMS: "ams3",
} as const;

export const SIZE = {
  SMALL: "s-1vcpu-1gb",
  MEDIUM: "s-2vcpu-4gb",
  LARGE: "s-4vcpu-8gb",
} as const;

export class DropletBuilder {
  private config: any = {
    image: OS.UBUNTU_22_04,
    region: REGION.NYC,
    size: SIZE.SMALL,
  };

  private discoveryPromise: Promise<any>;

  constructor(private name: string) {
    // EAGER DISCOVERY: Start checking the API immediately in the background
    this.discoveryPromise = this.mockApiCheck(name);
  }

  image(image: (typeof OS)[keyof typeof OS] | string) {
    this.config.image = image;
    return this;
  }

  region(region: (typeof REGION)[keyof typeof REGION] | string) {
    this.config.region = region;
    return this;
  }

  size(size: (typeof SIZE)[keyof typeof SIZE] | string) {
    this.config.size = size;
    return this;
  }

  async deploy() {
    console.log(`\n⏳ Finalizing "${this.name}"...`);

    // Await the background discovery that started in the constructor
    const existing = await this.discoveryPromise;

    if (existing) {
      const hasChanges =
        existing.size !== this.config.size ||
        existing.region !== this.config.region;

      if (hasChanges) {
        console.log(`✨ Found ${this.name}. ⚠️  Changes detected!`);
        console.log(`   Update: [${existing.size}] -> [${this.config.size}]`);
        // await api.update(...)
      } else {
        console.log(`✅ ${this.name} exists and is up to date. Skipping.`);
      }
    } else {
      console.log(`🚀 ${this.name} not found. Creating new resource...`);
      // await api.create(...)
    }

    return this.config;
  }

  private async mockApiCheck(name: string) {
    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 500));

    const mockDatabase: Record<string, any> = {
      "web-server": {
        id: 123,
        name: "web-server",
        size: SIZE.SMALL,
        region: REGION.FRA,
      },
    };
    return mockDatabase[name] || null;
  }
}

export const DO = {
  Droplet: (name: string) => new DropletBuilder(name),
};
