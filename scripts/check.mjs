import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = [];
for (const root of ['src','public','test','scripts','extension']) for (const name of await readdir(root)) if (name.endsWith('.mjs')) files.push(`${root}/${name}`);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
const pkg = JSON.parse(await readFile('package.json','utf8'));
JSON.parse(await readFile('extension/manifest.json','utf8'));
if (pkg.dependencies && Object.keys(pkg.dependencies).length) throw new Error('Unexpected runtime dependency; review needed');
console.log(`PASS: syntax checked ${files.length} modules; zero runtime dependencies.`);
