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
    const settingsPath = path.join(os.homedir(), SETTINGS_FILE);
    let cfg: Record<string, any> = {};
    try {
      cfg = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      // use defaults
    }
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
    if (missing.length > 0) {
      console.error(`[WARN] Missing required config: ${missing.join(", ")}`);
      console.error(`       Edit ~/${SETTINGS_FILE} to set them.`);
      process.exit(1);
    }
  }
}
