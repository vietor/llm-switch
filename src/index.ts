#!/usr/bin/env node

import { LLMConfig } from "./llm-config.js";
import { LLMProxy } from "./llm-proxy.js";

const config = new LLMConfig();
config.validateOrExit();

const proxy = new LLMProxy(config);
const server = proxy.createServer();
server.listen(config.port, () => {
    console.log(`Running on http://localhost:${config.port}`);
});
