export class DropletBuilder {
  name;
  config = {
    image: "ubuntu-20-04-x64",
    region: "nyc3",
    size: "s-1vcpu-1gb",
  };
  constructor(name) {
    this.name = name;
  }
  image(image) {
    this.config.image = image;
    return this;
  }
  region(region) {
    this.config.region = region;
    return this;
  }
  size(size) {
    this.config.size = size;
    return this;
  }
  // Finalizes the configuration and returns it
  deploy() {
    console.log(`🚀 Deploying Droplet: ${this.name}`);
    console.log(`Config:`, JSON.stringify(this.config, null, 2));
    return this.config;
  }
}
export const DO = {
  Droplet: (name) => new DropletBuilder(name),
};
//# sourceMappingURL=dsl.js.map
