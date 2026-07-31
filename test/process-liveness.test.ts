import { describe, expect, it } from "vitest";
import { isProcessAlive, processStartToken } from "../src/process-liveness.js";

describe("process liveness", () => {
  it("distinguishes the current process from a reused PID", () => {
    const token = processStartToken(process.pid);
    expect(token).toBeDefined();
    expect(isProcessAlive(process.pid, token)).toBe(true);
    expect(isProcessAlive(process.pid, `${token}-different`)).toBe(false);
  });
});
