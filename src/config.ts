import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

const stringRecordSchema = z.record(z.string(), z.string());
const unknownRecordSchema = z.record(z.string(), z.unknown());

const codexServerSchema = z.object({
  command: z.string().default("codex"),
  args: z.array(z.string()).default(["mcp-server"]),
  env: stringRecordSchema.default({}),
  cwd: z.string().optional(),
});

const callbacksSchema = z.object({
  enabled: z.boolean().default(true),
  askTimeoutSec: z.number().int().positive().default(3600),
}).strict();

const profileCallbacksSchema = z.object({
  enabled: z.boolean().optional(),
  askTimeoutSec: z.number().int().positive().optional(),
}).strict();

const profileSchema = z.object({
  description: z.string().optional(),
  model: z.string().optional(),
  approvalPolicy: z.string().default("never"),
  sandboxMode: z.string().default("danger-full-access"),
  baseInstructions: z.string().optional(),
  compactPrompt: z.string().optional(),
  developerInstructions: z.string().optional(),
  config: unknownRecordSchema.default({}),
  callbacks: profileCallbacksSchema.optional(),
}).strict();

const configSchema = z.object({
  codex: codexServerSchema.default({ command: "codex", args: ["mcp-server"], env: {} }),
  callbacks: callbacksSchema.default({ enabled: true, askTimeoutSec: 3600 }),
  tools: z.record(z.string(), profileSchema).default({
    codex: {
      description: "Run Codex asynchronously with danger-full-access sandboxing.",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      config: {},
    },
  }),
});

export type AsyncCodexConfig = z.infer<typeof configSchema>;
export type ToolProfile = z.infer<typeof profileSchema>;

export function loadConfig(configPath?: string): AsyncCodexConfig {
  const resolvedPath = configPath ?? process.env.ASYNC_CODEX_MCP_CONFIG;
  if (!resolvedPath) {
    return configSchema.parse({});
  }

  const file = fs.readFileSync(resolvedPath, "utf8");
  const loaded = yaml.load(file) ?? {};
  const parsed = configSchema.parse(loaded);

  if (parsed.codex.cwd && !path.isAbsolute(parsed.codex.cwd)) {
    parsed.codex.cwd = path.resolve(path.dirname(resolvedPath), parsed.codex.cwd);
  }

  return parsed;
}
