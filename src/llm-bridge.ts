import http from "node:http";
import https from "node:https";

import { LLMConfig } from "./llm-config.js";

function isSystem(msg: unknown): msg is { role: string; content: unknown } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).role === "system"
  );
}

function msgContent(msg: { content: unknown }): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const p of msg.content) {
      if (
        typeof p === "object" && p !== null &&
        (p as Record<string, unknown>).type === "text"
      ) {
        parts.push((p as Record<string, unknown>).text as string);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function rewriteAnthropic(raw: string): string | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const systemParts: string[] = [];
  const cleaned: unknown[] = [];

  for (const msg of messages) {
    if (isSystem(msg)) {
      systemParts.push(msgContent(msg));
    } else {
      cleaned.push(msg);
    }
  }

  if (systemParts.length === 0) return null;

  if (body.system !== undefined) {
    if (typeof body.system === "string" && body.system.length > 0) {
      systemParts.unshift(body.system);
    } else if (Array.isArray(body.system)) {
      systemParts.unshift(
        ...body.system.filter((s): s is string => typeof s === "string"),
      );
    }
  }

  body.system = systemParts.join("\n");
  body.messages = cleaned;

  return JSON.stringify(body);
}

function requestToChat(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];

  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      messages.push(item as Record<string, unknown>);
    }
  }

  const result: Record<string, unknown> = {
    model: body.model,
    messages,
    stream: false,
  };

  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.max_output_tokens !== undefined)
    result.max_tokens = body.max_output_tokens;
  if (body.tools !== undefined) result.tools = body.tools;
  if (body.tool_choice !== undefined) result.tool_choice = body.tool_choice;

  return result;
}

function chatToResponse(chat: Record<string, unknown>): Record<string, unknown> {
  const choices = chat.choices as Record<string, unknown>[] | undefined;
  const output: Record<string, unknown>[] = [];

  if (choices && choices.length > 0) {
    const message = choices[0].message as Record<string, unknown> | undefined;
    if (message) {
      const content: Record<string, unknown>[] = [];

      if (typeof message.content === "string" && message.content.length > 0) {
        content.push({ type: "output_text", text: message.content, annotations: [] });
      }

      if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls as Record<string, unknown>[]) {
          const fn = (tc.function || tc) as Record<string, unknown>;
          let args: unknown = fn.arguments;
          if (typeof fn.arguments === "string") {
            try { args = JSON.parse(fn.arguments); } catch { /* keep raw */ }
          }
          content.push({
            type: "function_call",
            id: tc.id,
            name: fn.name,
            arguments: args,
          });
        }
      }

      output.push({ type: "message", id: "msg_" + String(chat.id || ""), status: "completed", role: "assistant", content });
    }
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

const BLOCKED_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive",
  "transfer-encoding", "authorization",
]);

class ProxyForwarder {
  private hostname: string;
  private port: number;
  private httpModule: typeof http | typeof https;
  private hookApiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    const url = new URL(baseUrl);
    this.hostname = url.hostname;
    this.port = url.port
      ? parseInt(url.port, 10)
      : url.protocol === "https:" ? 443 : 80;
    this.httpModule = url.protocol === "https:" ? https : http;
    this.hookApiKey = apiKey;
  }

  pipe(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    path: string,
  ): void {
    this.request(req, res, path, body, (proxyRes) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (k.toLowerCase() !== "content-encoding" && v !== undefined)
          headers[k] = v;
      }
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.pipe(res);
    });
  }

  buffer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    path: string,
    onSuccess: (raw: string) => string,
  ): void {
    this.request(req, res, path, body, (proxyRes) => {
      const statusCode = proxyRes.statusCode ?? 502;
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const out = statusCode >= 400
          ? raw
          : (() => { try { return onSuccess(raw); } catch { return raw; } })();
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(out);
      });
    });
  }

  private filterHeaders(
    headers: http.IncomingHttpHeaders,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!BLOCKED_HEADERS.has(k.toLowerCase()) && v !== undefined) {
        result[k] = Array.isArray(v) ? v.join(", ") : v;
      }
    }
    result["host"] = this.hostname;
    return result;
  }

  private request(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    body: string,
    onResponse: (proxyRes: http.IncomingMessage) => void,
  ): void {
    const proxyReq = this.httpModule.request(
      {
        hostname: this.hostname,
        port: this.port,
        path,
        method: req.method,
        headers: {
          ...this.filterHeaders(req.headers),
          "Content-Length": Buffer.byteLength(body).toString(),
          ...(this.hookApiKey ? { Authorization: `Bearer ${this.hookApiKey}` } : {}),
        },
      },
      onResponse,
    );
    proxyReq.on("error", (err) => {
      res.writeHead(502).end(`Proxy error: ${err.message}`);
    });
    proxyReq.write(body);
    proxyReq.end();
  }
}

function setModel(body: string, model: string): string {
  try {
    const parsed = JSON.parse(body);
    parsed.model = model;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

export class LLMBridge {
  private forwarder: ProxyForwarder;
  private defaultModel: string;

  constructor(config: LLMConfig) {
    this.forwarder = new ProxyForwarder(config.baseUrl, config.apiKey);
    this.defaultModel = config.defaultModel;
  }

  createServer(): http.Server {
    return http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        this.handle(req, res, raw);
      });
      req.on("error", (err) => {
        res.writeHead(400).end(`Request error: ${err.message}`);
      });
    });
  }

  private handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    raw: string,
  ): void {
    const url = req.url;

    console.log(url);
    if (!url) {
      res.writeHead(400).end("Missing URL");
      return;
    }

    if (url.startsWith("/responses")) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }
      const chatReq = requestToChat(parsed);
      if (this.defaultModel) chatReq.model = this.defaultModel;
      this.forwarder.buffer(req, res, JSON.stringify(chatReq), "/v1/chat/completions", (rawResp) =>
        JSON.stringify(chatToResponse(JSON.parse(rawResp))),
      );
      return;
    }

    let body = raw;
    if (url.startsWith("/anthropic")) {
      const rewritten = rewriteAnthropic(raw);
      body = rewritten ?? raw;
    }

    if (this.defaultModel) body = setModel(body, this.defaultModel);
    this.forwarder.pipe(req, res, body, url);
  }
}
