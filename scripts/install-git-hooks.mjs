import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function ensureExecutable(dirPath) {
  for (const entry of readdirSync(dirPath)) {
    const fullPath = path.join(dirPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      ensureExecutable(fullPath);
      continue;
    }
    chmodSync(fullPath, 0o755);
  }
}

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim();

const hooksDir = path.join(repoRoot, '.githooks');
if (!existsSync(hooksDir)) {
  throw new Error(`Hooks directory not found: ${hooksDir}`);
}

ensureExecutable(hooksDir);

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

console.log(`[git-hooks] Installed repo hooks from ${hooksDir}`);
