import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const ignoredDirectories = new Set([".git", ".wrangler", "node_modules", "plans", "__pycache__", ".pytest_cache"]);
const permittedExtensions = new Set([".js", ".mjs", ".py", ".json", ".jsonc", ".md", ".sql", ".ps1", ".yaml", ".yml", ".txt"]);
const patterns = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["alpaca_key", /\b(?:PK|AK)[A-Z0-9]{18,}\b/g],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{32,}/g],
  ["assigned_secret", /\b(?:ADMIN_TOKEN|ALPACA_API_SECRET|BACKTEST_SERVICE_SECRET|BACKTEST_CALLBACK_SECRET|AXIOM_BACKTEST_SECRET)\s*=\s*["']?(?!replace-|test-|development-|process\.|os\.environ|\$\{)[A-Za-z0-9._~+/=-]{24,}/g],
];

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && (ignoredDirectories.has(entry.name) || entry.name.startsWith(".venv"))) continue;
    if (entry.name === ".dev.vars" || entry.name.startsWith(".dev.vars.")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (permittedExtensions.has(extname(entry.name)) || entry.name === "Dockerfile") output.push(path);
  }
  return output;
}

const findings = [];
for (const path of await files(root)) {
  const text = await readFile(path, "utf8");
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ file: relative(root, path), kind, offset: match.index });
  }
}

if (findings.length) {
  console.error(JSON.stringify({ status: "failed", findings }, null, 2));
  process.exitCode = 1;
} else console.log(JSON.stringify({ status: "clean", scanned_root: "." }));
