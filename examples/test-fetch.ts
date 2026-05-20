import "dotenv/config";

async function test(path: string) {
  const token = process.env.DO_TOKEN;
  console.log(`\n--- Testing ${path} ---`);
  const res = await fetch(`https://api.digitalocean.com/v2${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
  console.log("Status:", res.status);
  console.log("Encoding:", res.headers.get("content-encoding"));
  try {
    const data = await res.json();
    console.log("Success! Data keys:", Object.keys(data));
  } catch (e: any) {
    console.error("Failed parsing JSON:", e.message);
  }
}

async function run() {
  await test("/droplets?name=prod-web-01&per_page=200");
  await test("/droplets?name=prod-web-02&per_page=200");
  await test("/certificates?per_page=200");
  await test("/load_balancers?per_page=200");
}

run().catch(console.error);
