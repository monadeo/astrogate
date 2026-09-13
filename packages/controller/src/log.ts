export function log(scope: string, message: string, extra?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}`;
  process.stderr.write(extra ? `${line} ${JSON.stringify(extra)}\n` : `${line}\n`);
}
