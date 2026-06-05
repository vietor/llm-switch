import { LLMConfig } from "./llm-config.js";
import { LLMBridge } from "./llm-bridge.js";

const config = new LLMConfig();
config.exitIfInvalid();

const bridge = new LLMBridge(config);
const server = bridge.createServer();
server.listen(config.port, () => {
    console.log(`Running on http://localhost:${config.port}`);
});
