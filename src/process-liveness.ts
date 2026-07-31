import fs from "node:fs";

export function processStartToken(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
}

export function isProcessAlive(
  pid: number,
  expectedStartToken?: string,
): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (!expectedStartToken) return true;
  const currentToken = processStartToken(pid);
  return currentToken === undefined || currentToken === expectedStartToken;
}
