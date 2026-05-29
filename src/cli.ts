#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const configPath = process.argv[2];
const config = loadConfig(configPath);
const server = createServer(config);
await server.connect(new StdioServerTransport());
