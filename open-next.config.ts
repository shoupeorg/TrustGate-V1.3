// OpenNext adapter config for Cloudflare Workers (no incremental cache needed: the
// pages are static or dynamic API routes).
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
