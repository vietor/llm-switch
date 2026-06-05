import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SETTINGS_FILE = ".llm-switch.json";

export class LLMConfig {
  readonly port: number;
  readonly baseUrl: string;
  readonly anthropicBaseUrl: string;
  readonly apiKey: string;
  readonly model: string;

  constructor() {
    let cfg: Record<string, any> = {};
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), SETTINGS_FILE), "utf-8"));
    } catch {}
    this.port = cfg.port ?? 3000;
    this.baseUrl = cfg.baseUrl ?? "";
    this.anthropicBaseUrl = cfg.anthropicBaseUrl ?? "";
    this.apiKey = cfg.apiKey ?? "";
    this.model = cfg.model ?? "";
  }

  validate(): void {
    const missing: string[] = [];
    if (!this.baseUrl) missing.push("baseUrl");
    if (!this.apiKey) missing.push("apiKey");
    if (!this.model) missing.push("model");
    if (!missing.length) return;
    console.error(`[WARN] Missing required config: ${missing.join(", ")}\n       Edit ~/${SETTINGS_FILE} to set them.`);
    process.exit(1);
  }
}
