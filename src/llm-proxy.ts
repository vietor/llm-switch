import http from "node:http";
import https from "node:https";

import { LLMConfig } from "./llm-config.js";

const BLOCKED_HEADERS = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "authorization",
    "x-api-key",
]);

function joinTextContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (p): p is Record<string, unknown> =>
                typeof p === "object" && p !== null && p.type === "text",
        )
        .map((p) => p.text as string)
        .join("\n");
}

function extractSystem(body: Record<string, unknown>): boolean {
    const { messages } = body;
    if (!Array.isArray(messages) || !messages.length) return false;

    const systemParts: string[] = [];
    const cleaned: unknown[] = [];

    for (const msg of messages) {
        if (
            msg &&
            typeof msg === "object" &&
            (msg as Record<string, unknown>).role === "system"
        ) {
            systemParts.push(joinTextContent((msg as { content: unknown }).content));
        } else {
            cleaned.push(msg);
        }
    }

    if (!systemParts.length) return false;

    if (typeof body.system === "string" && body.system) {
        systemParts.unshift(body.system);
    } else if (Array.isArray(body.system)) {
        for (const s of body.system) {
            if (typeof s === "string") systemParts.unshift(s);
        }
    }

    body.system = systemParts.join("\n");
    body.messages = cleaned;
    return true;
}

function overrideModel(body: string, model: string): string {
    try {
        const parsed = JSON.parse(body);
        parsed.model = model;
        return JSON.stringify(parsed);
    } catch {
        return body;
    }
}

function sendError(
    res: http.ServerResponse,
    status: number,
    msg: string,
): void {
    res.writeHead(status).end(msg);
}

class Forwarder {
    private hostname: string;
    private port: number;
    private httpModule: typeof http | typeof https;
    private basePath: string;
    private apiKey: string;

    constructor(baseUrl: string, apiKey: string) {
        const url = new URL(baseUrl);
        this.hostname = url.hostname;
        this.port = url.port
            ? parseInt(url.port, 10)
            : url.protocol === "https:"
                ? 443
                : 80;
        this.httpModule = url.protocol === "https:" ? https : http;
        this.basePath =
            url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
        this.apiKey = apiKey;
    }

    private resolvePath(path: string): string {
        if (!this.basePath) return path;
        const p = path.startsWith("/") ? path : "/" + path;
        const lastSeg = this.basePath.split("/").filter(Boolean).pop();
        if (lastSeg && (p === "/" + lastSeg || p.startsWith("/" + lastSeg + "/"))) {
            return this.basePath + p.slice(lastSeg.length + 1);
        }
        return this.basePath + p;
    }

    private buildHeaders(
        headers: http.IncomingHttpHeaders,
    ): Record<string, string> {
        const hdrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
            if (!BLOCKED_HEADERS.has(k.toLowerCase()) && v !== undefined) {
                hdrs[k] = Array.isArray(v) ? v.join(", ") : v;
            }
        }
        hdrs.host = this.hostname;
        hdrs["accept-encoding"] = "identity";
        if (this.apiKey) {
            hdrs.Authorization = `Bearer ${this.apiKey}`;
            hdrs["x-api-key"] = this.apiKey;
        }
        return hdrs;
    }

    send(
        method: string,
        path: string,
        headers: http.IncomingHttpHeaders,
        body: string,
        onResponse: (res: http.IncomingMessage) => void,
        onError: (err: Error) => void,
    ): void {
        const hdrs = this.buildHeaders(headers);
        hdrs["Content-Length"] = Buffer.byteLength(body).toString();

        const proxyReq = this.httpModule.request(
            {
                hostname: this.hostname,
                port: this.port,
                path: this.resolvePath(path),
                method,
                headers: hdrs,
            },
            onResponse,
        );
        proxyReq.on("error", onError);
        proxyReq.write(body);
        proxyReq.end();
    }

    forward(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        body: string,
        path: string,
    ): void {
        this.send(
            req.method!,
            path,
            req.headers,
            body,
            (proxyRes) => {
                res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
                proxyRes.pipe(res);
            },
            (err) => sendError(res, 502, `Proxy error: ${err.message}`),
        );
    }

}

export class LLMProxy {
    private forwarder: Forwarder;
    private anthropicForwarder?: Forwarder;
    private modelOverride: string;

    constructor(config: LLMConfig) {
        this.forwarder = new Forwarder(config.baseUrl, config.apiKey);
        this.anthropicForwarder = config.anthropicBaseUrl
            ? new Forwarder(config.anthropicBaseUrl, config.apiKey)
            : undefined;
        this.modelOverride = config.model;
    }

    createServer(): http.Server {
        return http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () =>
                this.handleProxy(req, res, Buffer.concat(chunks).toString()),
            );
            req.on("error", (err) =>
                sendError(res, 400, `Request error: ${err.message}`),
            );
        });
    }

    private handleProxy(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        raw: string,
    ): void {
        const url = req.url;
        if (!url) {
            sendError(res, 400, "Missing URL");
            return;
        }

        let path = url;
        let body = raw;
        let forwarder: Forwarder = this.forwarder;

        if (url.startsWith("/anthropic")) {
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = {};
            }
            if (extractSystem(parsed)) {
                if (this.modelOverride) parsed.model = this.modelOverride;
                body = JSON.stringify(parsed);
            } else if (this.modelOverride) {
                body = overrideModel(raw, this.modelOverride);
            }

            if (this.anthropicForwarder) {
                path = url.substring(10);
                forwarder = this.anthropicForwarder;
            }
        } else if (this.modelOverride) {
            body = overrideModel(body, this.modelOverride);
        }

        forwarder.forward(req, res, body, path);
    }
}
