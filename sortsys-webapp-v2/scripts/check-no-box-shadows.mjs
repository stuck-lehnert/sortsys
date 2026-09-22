import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sourceRoots = [
  new URL('../app/', import.meta.url),
  new URL('../../sortsys-react-components/src/', import.meta.url),
  new URL('../../sortsys-dwgviewer/src/', import.meta.url),
];
const sourceExtensions = new Set(['.css', '.js', '.jsx', '.ts', '.tsx']);
const forbiddenPatterns = [/\bbox-shadow\b/, /\bboxShadow\b/];
const violations = [];

for (const sourceRoot of sourceRoots) {
  await inspectDirectory(sourceRoot);
}

if (violations.length > 0) {
  console.error('Box shadows are not part of the sortsys UI. Remove these declarations:');
  violations.forEach(violation => console.error(`- ${violation}`));
  process.exitCode = 1;
}

async function inspectDirectory(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });

  for (const entry of entries) {
    const entryUrl = new URL(entry.name, directoryUrl);

    if (entry.isDirectory()) {
      await inspectDirectory(new URL(`${entry.name}/`, directoryUrl));
      continue;
    }

    if (!sourceExtensions.has(fileExtension(entry.name))) continue;

    const contents = await readFile(entryUrl, 'utf8');
    const lines = contents.split(/\r?\n/);

    lines.forEach((line, index) => {
      if (!forbiddenPatterns.some(pattern => pattern.test(line))) return;

      const relativePath = fileURLToPath(entryUrl).replace(`${fileURLToPath(new URL('../../', import.meta.url))}/`, '');
      violations.push(`${relativePath}:${index + 1}`);
    });
  }
}

function fileExtension(fileName) {
  const separatorIndex = fileName.lastIndexOf('.');
  return separatorIndex < 0 ? '' : fileName.slice(separatorIndex);
}
