import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_FILE = ".llm-switch.json";

export class LLMConfig {
    readonly port: number;
    readonly baseUrl: string;
    readonly anthropicBaseUrl: string;
    readonly apiKey: string;
    readonly model: string;

    constructor() {
        let raw: Record<string, any> = {};
        try {
            raw = JSON.parse(
                fs.readFileSync(path.join(os.homedir(), CONFIG_FILE), "utf-8"),
            );
        } catch { }
        this.port = raw.port ?? 3456;
        this.baseUrl = raw.baseUrl ?? "";
        this.anthropicBaseUrl = raw.anthropicBaseUrl ?? "";
        this.apiKey = raw.apiKey ?? "";
        this.model = raw.model ?? "";
    }

    validateOrExit(): void {
        const missing: string[] = [];
        if (!this.baseUrl) missing.push("baseUrl");
        if (!this.apiKey) missing.push("apiKey");
        if (!this.model) missing.push("model");
        if (!missing.length) return;
        console.error(
            `[WARN] Missing config: ${missing.join(", ")}\n       Edit ~/${CONFIG_FILE} to set them.`,
        );
        process.exit(1);
    }
}
