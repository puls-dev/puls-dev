import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { parseYaml, loadRecordsFromFile } from "./parser.js";

describe("YAML & JSON Config Parser", () => {
  test("parses standard simple key-value YAML blocks correctly", () => {
    const yaml = `
- name: www
  type: CNAME
  value: lb.google.com
- name: mail
  type: A
  value: 1.2.3.4
  ttl: 600
`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.length, 2);
    
    assert.deepStrictEqual(result[0], {
      name: "www",
      type: "CNAME",
      value: "lb.google.com",
    });

    assert.deepStrictEqual(result[1], {
      name: "mail",
      type: "A",
      value: "1.2.3.4",
      ttl: 600,
    });
  });

  test("ignores comments and blank lines in YAML", () => {
    const yaml = `
# This is a comment at the top
- name: "@"
  type: TXT  # inline comment
  value: "v=spf1 include:_spf.google.com ~all"

# Another comment with spaces
- name: api
  type: CNAME
  value: api.service.com
`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].name, "@");
    assert.strictEqual(result[0].type, "TXT");
    assert.strictEqual(result[0].value, "v=spf1 include:_spf.google.com ~all");
    assert.strictEqual(result[1].name, "api");
  });

  test("parses nested array list values based on indentation", () => {
    const yaml = `
- type: ingress
  protocol: tcp
  port: 80
  sources:
    - 0.0.0.0/0
    - ::/0
- type: egress
  protocol: tcp
  port: all
  destinations:
    - 10.0.0.0/8
`;
    const result = parseYaml(yaml);
    assert.strictEqual(result.length, 2);

    assert.deepStrictEqual(result[0], {
      type: "ingress",
      protocol: "tcp",
      port: 80,
      sources: ["0.0.0.0/0", "::/0"],
    });

    assert.deepStrictEqual(result[1], {
      type: "egress",
      protocol: "tcp",
      port: "all",
      destinations: ["10.0.0.0/8"],
    });
  });

  test("loads from JSON and YAML files successfully", () => {
    const tempJsonPath = path.resolve(process.cwd(), "temp-test-records.json");
    const tempYamlPath = path.resolve(process.cwd(), "temp-test-records.yaml");

    const jsonContent = JSON.stringify([
      { name: "api", type: "CNAME", value: "lb.com" }
    ]);
    const yamlContent = `
- name: web
  type: A
  value: 5.6.7.8
`;

    // Write temp files
    fs.writeFileSync(tempJsonPath, jsonContent, "utf-8");
    fs.writeFileSync(tempYamlPath, yamlContent, "utf-8");

    try {
      const parsedJson = loadRecordsFromFile("temp-test-records.json");
      assert.strictEqual(parsedJson.length, 1);
      assert.deepStrictEqual(parsedJson[0], {
        name: "api",
        type: "CNAME",
        value: "lb.com",
      });

      const parsedYaml = loadRecordsFromFile("temp-test-records.yaml");
      assert.strictEqual(parsedYaml.length, 1);
      assert.deepStrictEqual(parsedYaml[0], {
        name: "web",
        type: "A",
        value: "5.6.7.8",
      });
    } finally {
      // Clean up temp files
      if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath);
      if (fs.existsSync(tempYamlPath)) fs.unlinkSync(tempYamlPath);
    }
  });
});
