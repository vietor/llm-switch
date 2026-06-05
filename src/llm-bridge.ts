import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

import { LLMConfig } from "./llm-config.js";

const BLOCKED_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive",
  "accept-encoding", "transfer-encoding", "authorization", "x-api-key",
]);

function rewriteAnthropic(raw: string): string | null {
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return null; }

  const { messages } = body;
  if (!Array.isArray(messages) || !messages.length) return null;

  const systemParts: string[] = [];
  const cleaned: unknown[] = [];

  for (const msg of messages) {
    if (msg && typeof msg === "object" && (msg as Record<string, unknown>).role === "system") {
      const content = (msg as { content: unknown }).content;
      systemParts.push(
        typeof content === "string" ? content
          : Array.isArray(content) ? content
              .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null && p.type === "text")
              .map(p => p.text as string)
              .join("\n")
          : ""
      );
    } else {
      cleaned.push(msg);
    }
  }

  if (!systemParts.length) return null;

  if (body.system !== undefined) {
    if (typeof body.system === "string" && body.system) {
      systemParts.unshift(body.system);
    } else if (Array.isArray(body.system)) {
      systemParts.unshift(...body.system.filter((s): s is string => typeof s === "string"));
    }
  }

  body.system = systemParts.join("\n");
  body.messages = cleaned;
  return JSON.stringify(body);
}

function requestToChat(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    messages.push(...body.input as Record<string, unknown>[]);
  }
  return {
    model: body.model,
    messages,
    ...(body.stream === true && { stream: true }),
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.top_p !== undefined && { top_p: body.top_p }),
    ...(body.max_output_tokens !== undefined && { max_tokens: body.max_output_tokens }),
    ...(body.tools !== undefined && { tools: body.tools }),
    ...(body.tool_choice !== undefined && { tool_choice: body.tool_choice }),
  };
}

function chatToResponse(chat: Record<string, unknown>): Record<string, unknown> {
  const choices = chat.choices as Record<string, unknown>[] | undefined;
  const output: Record<string, unknown>[] = [];

  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  if (message) {
    const content: Record<string, unknown>[] = [];
    if (message.content) content.push({ type: "output_text", text: message.content, annotations: [] });
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls as Record<string, unknown>[]) {
        const fn = (tc.function || tc) as Record<string, unknown>;
        let args = fn.arguments;
        if (typeof args === "string") try { args = JSON.parse(args); } catch {}
        content.push({ type: "function_call", id: tc.id, name: fn.name, arguments: args });
      }
    }
    output.push({ type: "message", id: "msg_" + (chat.id || ""), status: "completed", role: "assistant", content });
  }

  return { id: chat.id, object: "response", created_at: chat.created, status: "completed", model: chat.model, output, usage: chat.usage };
}

class ProxyForwarder {
  private hostname: string;
  private port: number;
  private httpModule: typeof http | typeof https;
  private basePath: string;
  private rewriteApiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    const url = new URL(baseUrl);
    this.hostname = url.hostname;
    this.port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
    this.httpModule = url.protocol === "https:" ? https : http;
    this.basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    this.rewriteApiKey = apiKey;
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

  private request(
    method: string,
    path: string,
    headers: http.IncomingHttpHeaders,
    body: string,
    onResponse: (res: http.IncomingMessage) => void,
    onError: (err: Error) => void,
  ): void {
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!BLOCKED_HEADERS.has(k.toLowerCase()) && v !== undefined) {
        hdrs[k] = Array.isArray(v) ? v.join(", ") : v;
      }
    }
    hdrs.host = this.hostname;
    hdrs["Content-Length"] = Buffer.byteLength(body).toString();
    if (this.rewriteApiKey) {
      hdrs.Authorization = `Bearer ${this.rewriteApiKey}`;
      hdrs["x-api-key"] = this.rewriteApiKey;
    }

    const proxyReq = this.httpModule.request(
      { hostname: this.hostname, port: this.port, path: this.resolvePath(path), method, headers: hdrs },
      onResponse,
    );
    proxyReq.on("error", onError);
    proxyReq.write(body);
    proxyReq.end();
  }

  pipe(req: http.IncomingMessage, res: http.ServerResponse, body: string, path: string): void {
    this.request(req.method!, path, req.headers, body, (proxyRes) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (k.toLowerCase() !== "content-encoding" && v !== undefined) headers[k] = v;
      }
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.pipe(res);
    }, (err) => { res.writeHead(502).end(`Proxy error: ${err.message}`); });
  }

  buffer(req: http.IncomingMessage, res: http.ServerResponse, body: string, path: string, onSuccess: (raw: string) => string): void {
    this.request(req.method!, path, req.headers, body, (proxyRes) => {
      const statusCode = proxyRes.statusCode ?? 502;
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(statusCode < 400 ? onSuccess(raw) : raw);
      });
    }, (err) => { res.writeHead(502).end(`Proxy error: ${err.message}`); });
  }

  raw(
    req: http.IncomingMessage,
    body: string,
    path: string,
    onResponse: (proxyRes: http.IncomingMessage) => void,
    onError: (err: Error) => void,
  ): void {
    this.request(req.method!, path, req.headers, body, onResponse, onError);
  }
}

function setModel(body: string, model: string): string {
  try {
    const parsed = JSON.parse(body);
    parsed.model = model;
    return JSON.stringify(parsed);
  } catch { return body; }
}

export class LLMBridge {
  private forwarder: ProxyForwarder;
  private anthropicForwarder?: ProxyForwarder;
  private rewriteModel: string;

  constructor(config: LLMConfig) {
    this.forwarder = new ProxyForwarder(config.baseUrl, config.apiKey);
    this.anthropicForwarder = config.anthropicBaseUrl
      ? new ProxyForwarder(config.anthropicBaseUrl, config.apiKey)
      : undefined;
    this.rewriteModel = config.model;
  }

  createServer(): http.Server {
    return http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => this.handle(req, res, Buffer.concat(chunks).toString()));
      req.on("error", (err) => res.writeHead(400).end(`Request error: ${err.message}`));
    });
  }

  private streamResponses(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>): void {
    const chatReq = requestToChat(body);
    if (this.rewriteModel) chatReq.model = this.rewriteModel;
    const bodyStr = JSON.stringify(chatReq);

    this.forwarder.raw(req, bodyStr, "/chat/completions",
      (proxyRes) => {
        const statusCode = proxyRes.statusCode ?? 200;
        if (statusCode >= 400) {
          const chunks: Buffer[] = [];
          proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
          proxyRes.on("end", () => { res.writeHead(statusCode, { "Content-Type": "application/json" }); res.end(Buffer.concat(chunks).toString()); });
          return;
        }

        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

        let responseId = "", responseModel = "", fullContent = "", buffer = "";

        const contentEncoding = proxyRes.headers["content-encoding"] as string | undefined;
        const stream: http.IncomingMessage | zlib.Gunzip | zlib.Inflate = contentEncoding?.includes("gzip")
          ? proxyRes.pipe(zlib.createGunzip())
          : contentEncoding?.includes("deflate")
            ? proxyRes.pipe(zlib.createInflate())
            : proxyRes;
        stream.setEncoding("utf-8");

        stream.on("error", (err) => {
          if (!res.writableEnded) { res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); }
        });

        stream.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const choices = parsed.choices as Record<string, unknown>[] | undefined;
              if (!choices?.length) continue;

              const delta = choices[0].delta as Record<string, unknown> | undefined;
              const content = delta?.content as string | undefined;

              if (parsed.id && !responseId) responseId = parsed.id;
              if (parsed.model && !responseModel) responseModel = parsed.model;

              if (content) {
                fullContent += content;
                res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: content, index: 0 })}\n\n`);
              }

              const finishReason = choices[0].finish_reason as string | null | undefined;
              if (finishReason === "stop" || finishReason === "length") {
                res.write(`event: response.done\ndata: ${JSON.stringify({
                  type: "response.done",
                  response: {
                    id: responseId || `resp_${Date.now()}`,
                    object: "response",
                    created_at: Math.floor(Date.now() / 1000),
                    status: finishReason === "stop" ? "completed" : "incomplete",
                    model: responseModel || "",
                    output: fullContent ? [{
                      type: "message", id: `msg_${responseId || Date.now()}`,
                      status: "completed", role: "assistant",
                      content: [{ type: "output_text", text: fullContent, annotations: [] }],
                    }] : [],
                    usage: parsed.usage || null,
                  },
                })}\n\n`);
              }
            } catch {}
          }
        });

        stream.on("end", () => { if (!res.writableEnded) res.end(); });
      },
      (err) => { if (!res.writableEnded) { res.writeHead(502).end(`Proxy error: ${err.message}`); } },
    );
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
    const url = req.url;
    if (!url) { res.writeHead(400).end("Missing URL"); return; }

    if (url.startsWith("/responses")) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(raw); } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      if (parsed.stream === true) {
        this.streamResponses(req, res, parsed);
      } else {
        const chatReq = requestToChat(parsed);
        if (this.rewriteModel) chatReq.model = this.rewriteModel;
        this.forwarder.buffer(req, res, JSON.stringify(chatReq), "/chat/completions",
          (rawResp) => JSON.stringify(chatToResponse(JSON.parse(rawResp))));
      }
    } else {
      let body = raw;
      let forwarder: ProxyForwarder = this.forwarder;
      if (url.startsWith("/anthropic")) {
        body = rewriteAnthropic(raw) ?? raw;
        if (this.anthropicForwarder) forwarder = this.anthropicForwarder;
      }
      if (this.rewriteModel) body = setModel(body, this.rewriteModel);
      forwarder.pipe(req, res, body, url);
    }
  }
}
