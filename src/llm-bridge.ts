import http from "node:http";
import https from "node:https";

import { LLMConfig } from "./llm-config.js";

const BLOCKED_HEADERS = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "accept-encoding",
    "transfer-encoding",
    "authorization",
    "x-api-key",
]);

function joinTextParts(content: unknown): string {
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

function extractSystem(raw: string): string | null {
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(raw);
    } catch {
        return null;
    }

    const { messages } = body;
    if (!Array.isArray(messages) || !messages.length) return null;

    const systemParts: string[] = [];
    const cleaned: unknown[] = [];

    for (const msg of messages) {
        if (
            msg &&
            typeof msg === "object" &&
            (msg as Record<string, unknown>).role === "system"
        ) {
            systemParts.push(joinTextParts((msg as { content: unknown }).content));
        } else {
            cleaned.push(msg);
        }
    }

    if (!systemParts.length) return null;

    if (typeof body.system === "string" && body.system) {
        systemParts.unshift(body.system);
    } else if (Array.isArray(body.system)) {
        for (const s of body.system) {
            if (typeof s === "string") systemParts.unshift(s);
        }
    }

    body.system = systemParts.join("\n");
    body.messages = cleaned;
    return JSON.stringify(body);
}

function toChatCompletion(
    body: Record<string, unknown>,
): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    if (body.instructions)
        messages.push({ role: "system", content: body.instructions });
    if (typeof body.input === "string") {
        messages.push({ role: "user", content: body.input });
    } else if (Array.isArray(body.input)) {
        messages.push(...(body.input as Record<string, unknown>[]));
    }
    return {
        model: body.model,
        messages,
        ...(body.stream === true && { stream: true }),
        ...(body.temperature !== undefined && { temperature: body.temperature }),
        ...(body.top_p !== undefined && { top_p: body.top_p }),
        ...(body.max_output_tokens !== undefined && {
            max_tokens: body.max_output_tokens,
        }),
        ...(body.tools !== undefined && { tools: body.tools }),
        ...(body.tool_choice !== undefined && { tool_choice: body.tool_choice }),
    };
}

function toResponseFormat(
    chat: Record<string, unknown>,
): Record<string, unknown> {
    const message = (chat.choices as Record<string, unknown>[] | undefined)?.[0]
        ?.message as Record<string, unknown> | undefined;
    const output: Record<string, unknown>[] = [];

    if (message) {
        const content: Record<string, unknown>[] = [];
        if (message.content)
            content.push({
                type: "output_text",
                text: message.content,
                annotations: [],
            });
        if (Array.isArray(message.tool_calls)) {
            for (const tc of message.tool_calls as Record<string, unknown>[]) {
                const fn = (tc.function || tc) as Record<string, unknown>;
                let args = fn.arguments;
                if (typeof args === "string")
                    try {
                        args = JSON.parse(args);
                    } catch { }
                content.push({
                    type: "function_call",
                    id: tc.id,
                    name: fn.name,
                    arguments: args,
                });
            }
        }
        output.push({
            type: "message",
            id: "msg_" + (chat.id || ""),
            status: "completed",
            role: "assistant",
            content,
        });
    }

    return {
        id: chat.id,
        object: "response",
        created_at: chat.created,
        status: "completed",
        model: chat.model,
        output,
        usage: chat.usage,
    };
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

function writeSSE(
    res: http.ServerResponse,
    event: string,
    data: unknown,
): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function forEachSSELine(
    proxyRes: http.IncomingMessage,
    onData: (parsed: Record<string, unknown>) => void,
    onEnd: () => void,
): void {
    let buffer = "";
    proxyRes.setEncoding("utf-8");
    proxyRes.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
                onData(JSON.parse(data));
            } catch { }
        }
    });
    proxyRes.on("end", onEnd);
}

function buildDoneEvent(
    id: string,
    model: string,
    content: string,
    finishReason: string,
    usage: unknown,
) {
    return {
        type: "response.done",
        response: {
            id: id || `resp_${Date.now()}`,
            created_at: Math.floor(Date.now() / 1000),
            status: finishReason === "stop" ? "completed" : "incomplete",
            model: model || "",
            output: content
                ? [
                    {
                        type: "message",
                        id: `msg_${id || Date.now()}`,
                        status: "completed",
                        role: "assistant",
                        content: [
                            { type: "output_text", text: content, annotations: [] },
                        ],
                    },
                ]
                : [],
            usage: usage || null,
        },
    };
}

function writeError(
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

    pipe(
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
            (err) => writeError(res, 502, `Proxy error: ${err.message}`),
        );
    }

    buffer(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        body: string,
        path: string,
        transform: (raw: string) => string,
    ): void {
        this.send(
            req.method!,
            path,
            req.headers,
            body,
            (proxyRes) => {
                const statusCode = proxyRes.statusCode ?? 502;
                const chunks: Buffer[] = [];
                proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
                proxyRes.on("end", () => {
                    const raw = Buffer.concat(chunks).toString();
                    res.writeHead(statusCode, { "Content-Type": "application/json" });
                    res.end(statusCode < 400 ? transform(raw) : raw);
                });
            },
            (err) => writeError(res, 502, `Proxy error: ${err.message}`),
        );
    }
}

export class LLMBridge {
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
                this.handleRequest(req, res, Buffer.concat(chunks).toString()),
            );
            req.on("error", (err) =>
                writeError(res, 400, `Request error: ${err.message}`),
            );
        });
    }

    private handleRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        raw: string,
    ): void {
        const url = req.url;
        if (!url) {
            writeError(res, 400, "Missing URL");
            return;
        }

        if (url.startsWith("/responses")) {
            return this.handleResponses(req, res, raw);
        }
        this.handleProxy(req, res, raw, url);
    }

    private handleResponses(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        raw: string,
    ): void {
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(raw);
        } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid JSON" }));
            return;
        }

        if (parsed.stream === true) {
            this.streamToSSE(req, res, parsed);
        } else {
            const chatReq = toChatCompletion(parsed);
            if (this.modelOverride) chatReq.model = this.modelOverride;
            this.forwarder.buffer(
                req,
                res,
                JSON.stringify(chatReq),
                "/chat/completions",
                (rawResp) => JSON.stringify(toResponseFormat(JSON.parse(rawResp))),
            );
        }
    }

    private handleProxy(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        raw: string,
        url: string,
    ): void {
        let path = url;
        let body = raw;
        let forwarder: Forwarder = this.forwarder;

        if (url.startsWith("/anthropic")) {
            body = extractSystem(raw) ?? raw;
            if (this.anthropicForwarder) {
                path = url.substring(10);
                forwarder = this.anthropicForwarder;
            }
        }

        if (this.modelOverride) body = overrideModel(body, this.modelOverride);
        forwarder.pipe(req, res, body, path);
    }

    private streamToSSE(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        body: Record<string, unknown>,
    ): void {
        const chatReq = toChatCompletion(body);
        if (this.modelOverride) chatReq.model = this.modelOverride;

        this.forwarder.send(
            req.method!,
            "/chat/completions",
            req.headers,
            JSON.stringify(chatReq),
            (proxyRes) => this.handleStreamResponse(proxyRes, res),
            (err) => writeError(res, 502, `Proxy error: ${err.message}`),
        );
    }

    private handleStreamResponse(
        proxyRes: http.IncomingMessage,
        res: http.ServerResponse,
    ): void {
        if ((proxyRes.statusCode ?? 200) >= 400) {
            return this.forwardUpstreamError(proxyRes, res);
        }

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        proxyRes.on("error", () => {
            if (!res.writableEnded) {
                writeSSE(res, "error", { error: "stream error" });
                res.end();
            }
        });

        let responseId = "",
            responseModel = "",
            fullContent = "";

        forEachSSELine(
            proxyRes,
            (parsed) => {
                const choices = parsed.choices as Record<string, unknown>[] | undefined;
                if (!choices?.length) return;

                const delta = choices[0].delta as Record<string, unknown> | undefined;
                const content = delta?.content as string | undefined;

                if (parsed.id && !responseId) responseId = parsed.id as string;
                if (parsed.model && !responseModel)
                    responseModel = parsed.model as string;

                if (content) {
                    fullContent += content;
                    writeSSE(res, "response.output_text.delta", {
                        type: "response.output_text.delta",
                        delta: content,
                        index: 0,
                    });
                }

                const finishReason = choices[0].finish_reason as
                    | string
                    | null
                    | undefined;
                if (finishReason === "stop" || finishReason === "length") {
                    writeSSE(
                        res,
                        "response.done",
                        buildDoneEvent(
                            responseId,
                            responseModel,
                            fullContent,
                            finishReason,
                            parsed.usage,
                        ),
                    );
                }
            },
            () => {
                if (!res.writableEnded) res.end();
            },
        );
    }

    private forwardUpstreamError(
        proxyRes: http.IncomingMessage,
        res: http.ServerResponse,
    ): void {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
            res.writeHead(proxyRes.statusCode!, {
                "Content-Type": "application/json",
            });
            res.end(Buffer.concat(chunks).toString());
        });
    }
}
