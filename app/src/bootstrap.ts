// Seeds the fixed §6.1 channels on first boot. Idempotent: createChannel overwrites the same
// item, registerChannelSlug is a set-ADD, so running this on every container start is harmless.
import { createChannel, registerChannelSlug, listChannels } from "./db/repo.js";
import { config } from "./config.js";

const DEFAULT_CHANNELS: Array<[string, string]> = [
  ["announcements", "공지"],
  ["questions", "질문"],
  ["chat", "잡담"],
];

export async function seedChannels() {
  const existing = await listChannels();
  if (existing.length > 0) return;
  for (const [slug, name] of DEFAULT_CHANNELS) {
    const scaleVisible = !(config.scale === "large" && slug === "chat"); // §6.2: 잡담 hidden in large mode
    await createChannel(slug, name, scaleVisible);
    await registerChannelSlug(slug);
  }
}
