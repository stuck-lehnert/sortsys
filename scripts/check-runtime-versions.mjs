import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function checkRuntimeVersions(snapshot) {
  const errors = [];
  const node = snapshot.nodeVersion.trim();
  const rust = snapshot.ci.match(/^\s+toolchain:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m)?.[1];
  if (!/^\d+$/.test(node)) errors.push('.node-version must select one Node major.');
  if (!snapshot.ci.includes('node-version-file: .node-version')) errors.push('CI must read .node-version.');
  if (String(snapshot.actualNodeMajor) !== node) errors.push(`Run checks on Node ${node}, not ${snapshot.actualNodeMajor}.`);
  if (!rust) errors.push('CI must specify an explicit Rust release.');
  const rustMinor = rust?.split('.').slice(0, 2).join('.');

  for (const [name, text] of Object.entries(snapshot.rustImages)) {
    const tags = [...text.matchAll(/(?:FROM\s+|ARG\s+RUST_IMAGE=)(?:docker\.io\/)?(?:library\/)?rust:(\d+\.\d+(?:\.\d+)?)/g)];
    if (!tags.length) errors.push(`${name}: missing Rust image/default.`);
    for (const tag of tags) if (tag[1].split('.').slice(0, 2).join('.') !== rustMinor) errors.push(`${name}: Rust ${tag[1]} differs from CI ${rust}.`);
  }
  for (const [name, text] of Object.entries(snapshot.nodeImages)) {
    const tags = [...text.matchAll(/FROM\s+(?:docker\.io\/)?(?:library\/)?node:(\d+)/g)];
    if (!tags.length) errors.push(`${name}: missing Node image.`);
    for (const tag of tags) if (tag[1] !== node) errors.push(`${name}: Node ${tag[1]} differs from .node-version ${node}.`);
  }
  for (const [name, manifest] of Object.entries(snapshot.manifests)) {
    const range = manifest.dependencies?.['@types/node'] ?? manifest.devDependencies?.['@types/node'];
    if (!range || !new RegExp(`^[~^]?${node}(?:\\.|$)`).test(range)) errors.push(`${name}: @types/node must match Node ${node}.`);
  }
  // PostgreSQL 17's data layout is intentionally retained until a tested migration.
  for (const [name, text] of Object.entries(snapshot.postgresImages)) {
    const tags = [...text.matchAll(/^\s*(?:FROM\s+|image:\s*(?:\$\{POSTGRES_IMAGE:-)?)(?:docker\.io\/)?(?:library\/)?postgres:(\d+)/gm)];
    if (!tags.length) errors.push(`${name}: missing PostgreSQL default.`);
    for (const tag of tags) if (tag[1] !== '17') errors.push(`${name}: PostgreSQL major requires the documented migration, not a tag-only update.`);
  }
  const nginx = snapshot.webappDocker.match(/^FROM nginx:(\d+)\.(\d+)\./m);
  if (!nginx || nginx[1] !== '1' || Number(nginx[2]) % 2 !== 0) errors.push('Use a verified Nginx stable release (1.x even minor), not an independent mainline jump.');
  return errors;
}

export function readRuntimeSnapshot(root = fileURLToPath(new URL('../', import.meta.url))) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const catalog = read('scripts/Dockerfile.images');
  const api = read('sortsys-api-v2/Dockerfile');
  const apiTest = read('sortsys-api-v2/rust-api/Dockerfile.test');
  const webappDocker = read('sortsys-webapp-v2/Dockerfile');
  return {
    nodeVersion: read('.node-version'),
    actualNodeMajor: process.versions.node.split('.')[0],
    ci: read('.github/workflows/ci.yml'),
    rustImages: { catalog, api, apiTest, webappDocker },
    nodeImages: { catalog, webappDocker },
    manifests: Object.fromEntries(['sortsys-api-v2/client', 'sortsys-dwgviewer', 'sortsys-webapp-v2'].map(path => [path, JSON.parse(read(path + '/package.json'))])),
    postgresImages: { catalog, api, apiTest, compose: read('compose.yaml'), ghcrCompose: read('ghcr-compose.yaml') },
    webappDocker,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkRuntimeVersions(readRuntimeSnapshot());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Runtime versions agree across CI, Docker defaults and Node declarations; PostgreSQL 17 and Nginx stable policies hold.');
  }
}
