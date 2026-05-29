import { Config } from "./config.js";

export const SLACK = {
  /**
   * Generates a callback that posts a structured lifecycle notification to a Slack webhook.
   * In dry-run mode, it outputs a descriptive log to the terminal instead of executing HTTP writes.
   *
   * @param webhookUrl The Slack Incoming Webhook URL
   */
  notify: (webhookUrl: string) => {
    return async (result: any) => {
      const name = result?.name ?? "unknown-resource";
      const isDryRun = Config.isGlobalDryRun();

      // Check if it's a destroy result or deploy result
      const isDestroy = result && ("destroyed" in result || result.destroyed === true);
      const action = isDestroy ? "destroyed" : "deployed/updated";
      const statusEmoji = isDestroy ? "🗑️" : "🚀";

      // Filter and print simple key-value attributes
      const details = Object.entries(result ?? {})
        .filter(
          ([k, v]) =>
            k !== "name" &&
            k !== "destroyed" &&
            (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        )
        .map(([k, v]) => `• *${k}*: \`${v}\``)
        .join("\n");

      const text = `${statusEmoji} *Puls Notification*: Resource *${name}* was successfully *${action}*!\n${
        details ? `*Details*:\n${details}` : ""
      }`;

      if (isDryRun) {
        console.log(`\n📢 [DRY RUN] Would post Slack notification to webhook: ${webhookUrl}`);
        console.log(`   Message: ${text.replace(/\n/g, "\n   ")}`);
        return;
      }

      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          console.warn(`[WARN] Slack webhook returned status ${res.status}`);
        }
      } catch (err: any) {
        console.error(`[ERROR] Failed to send Slack notification: ${err.message}`);
      }
    };
  },
};

export const DISCORD = {
  /**
   * Generates a callback that posts a rich embed lifecycle notification to a Discord webhook.
   * In dry-run mode, it outputs a descriptive log to the terminal instead of executing HTTP writes.
   *
   * @param webhookUrl The Discord Incoming Webhook URL
   * @example
   * GCP.CloudRun("api")
   *   .afterDeploy(DISCORD.notify("https://discord.com/api/webhooks/..."))
   */
  notify: (webhookUrl: string) => {
    return async (result: any) => {
      const name = result?.name ?? "unknown-resource";
      const isDryRun = Config.isGlobalDryRun();

      // Check if it's a destroy result or deploy result
      const isDestroy = result && ("destroyed" in result || result.destroyed === true);
      const action = isDestroy ? "destroyed" : "deployed/updated";
      const statusEmoji = isDestroy ? "🗑️" : "🚀";
      
      // Green (0x2ecc71) for deploy, Red (0xe74c3c) for destroy
      const color = isDestroy ? 15158332 : 3066993;

      const fields = Object.entries(result ?? {})
        .filter(
          ([k, v]) =>
            k !== "name" &&
            k !== "destroyed" &&
            (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        )
        .map(([k, v]) => ({
          name: k,
          value: `\`${v}\``,
          inline: true,
        }));

      const payload = {
        embeds: [
          {
            title: `${statusEmoji} Puls Notification`,
            description: `Resource **${name}** was successfully **${action}**!`,
            color,
            fields,
            footer: {
              text: "Puls Dev Suite",
            },
            timestamp: new Date().toISOString(),
          },
        ],
      };

      if (isDryRun) {
        console.log(`\n📢 [DRY RUN] Would post Discord notification to webhook: ${webhookUrl}`);
        console.log(`   Embed Title: ${statusEmoji} Puls Notification`);
        console.log(`   Embed Description: Resource **${name}** was successfully **${action}**!`);
        if (fields.length > 0) {
          console.log("   Fields:");
          for (const f of fields) {
            console.log(`     • ${f.name}: ${f.value}`);
          }
        }
        return;
      }

      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          console.warn(`[WARN] Discord webhook returned status ${res.status}`);
        }
      } catch (err: any) {
        console.error(`[ERROR] Failed to send Discord notification: ${err.message}`);
      }
    };
  },
};
