import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('../app/', import.meta.url);
const sourceExtensions = new Set(['.ts', '.tsx']);
const violations = [];

async function inspectDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      await inspectDirectory(path);
      continue;
    }

    if (!sourceExtensions.has(extname(entry.name))) continue;

    const source = await readFile(path, 'utf8');
    const checks = [
      {
        pattern: /route\(\s*['"]assistant(?:\/|['"])/g,
        message: 'legacy /assistant SPA route',
      },
      {
        pattern: /['"`]\/assistant(?:[/?#'"`]|$)/g,
        message: 'legacy /assistant navigation target',
      },
      {
        pattern: /\b(?:query|streamQuery|mutate)\(\s*['"`]assistant\./g,
        message: 'legacy assistant.* API request',
      },
    ];

    for (const check of checks) {
      for (const match of source.matchAll(check.pattern)) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${relative(root.pathname, path)}:${line}: ${check.message}`);
      }
    }
  }
}

await inspectDirectory(root.pathname);

if (violations.length > 0) {
  console.error('LLM naming check failed:\n' + violations.join('\n'));
  process.exitCode = 1;
}
