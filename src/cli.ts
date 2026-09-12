#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const configPath = process.argv[2];
const config = loadConfig(configPath);
const handle = serveStdio(({ era }) => createServer(config, { protocolEra: era }));
process.stdin.once("end", () => { void handle.close(); });
