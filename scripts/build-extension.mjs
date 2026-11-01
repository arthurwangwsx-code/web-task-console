import { readFile, writeFile, mkdir, lstat, readdir, rename, rm, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'web-task-console/build-extension-v1';
const MANIFEST = 'BUILD-MANIFEST.json';
const SOURCES = [
  ['extension/background.mjs','background.mjs'],
  ['extension/chrome-host.mjs','chrome-host.mjs'],
  ['extension/console.html','console.html'],
  ['extension/console.mjs','console.mjs'],
  ['extension/controller.mjs','controller.mjs'],
  ['extension/errors.mjs','errors.mjs'],
  ['extension/idle-policy.mjs','idle-policy.mjs'],
  ['extension/manifest.json','manifest.json'],
  ['extension/page-probe.mjs','page-probe.mjs'],
  ['extension/style.css','style.css'],
  ['extension/task-binding.mjs','task-binding.mjs'],
  ['LICENSE','LICENSE'],
  ['docs/EXTENSION.md','INSTALL.md'],
  ['docs/BINDING.md','BINDING.md'],
  ['docs/IDLE.md','IDLE.md'],
  ['docs/CAPABILITY_STATUS.md','CAPABILITY_STATUS.md'],
  ['docs/PROFILE_BRIDGE.md','PROFILE_BRIDGE.md'],
  ['docs/BUILD.md','BUILD.md'],
];
const hash = data => createHash('sha256').update(data).digest('hex');
const fail = code => { throw new Error(code); };
async function stat(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function directory(path) {
  const value = await stat(path);
  if (value && (!value.isDirectory() || value.isSymbolicLink())) fail('BUILD_DIRECTORY_NOT_OWNED_OR_SYMLINK');
  return value;
}
async function plainFile(path) {
  const value = await stat(path);
  if (!value?.isFile() || value.isSymbolicLink()) fail('BUILD_SOURCE_NOT_REGULAR_FILE');
  return readFile(path);
}
async function verifyExisting(output) {
  const value = await directory(output);
  if (!value) return false;
  const marker = await stat(join(output, MANIFEST));
  if (!marker?.isFile() || marker.isSymbolicLink()) fail('BUILD_OUTPUT_NOT_OWNED');
  let record, rawRecord;
  try { rawRecord = await readFile(join(output, MANIFEST),'utf8'); record = JSON.parse(rawRecord); } catch { fail('BUILD_OUTPUT_NOT_OWNED'); }
  if (record.managedBy !== OWNER || record.schemaVersion !== 1 || !Array.isArray(record.files) || record.files.length > 100) fail('BUILD_OUTPUT_NOT_OWNED');
  const names = record.files.map(row => row?.name);
  if (names.some(name => typeof name !== 'string' || !name || name === MANIFEST || basename(name) !== name || /[\\/\u0000]/.test(name)) || new Set(names).size !== names.length) fail('BUILD_OUTPUT_NOT_OWNED');
  const actual = (await readdir(output)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names,MANIFEST].sort())) fail('BUILD_OUTPUT_MODIFIED_OR_UNKNOWN_FILES');
  const canonicalRecord = { schemaVersion:1, managedBy:OWNER, packageName:'web-task-console', version:record.version, license:'MIT', buildId:hash(JSON.stringify(record.files)), files:record.files };
  if (rawRecord !== JSON.stringify(canonicalRecord,null,2)+'\n') fail('BUILD_OUTPUT_MANIFEST_MODIFIED');
  for (const row of record.files) {
    const value = await stat(join(output,row.name));
    if (!value?.isFile() || value.isSymbolicLink()) fail('BUILD_OUTPUT_MODIFIED_OR_UNKNOWN_FILES');
    const bytes = await readFile(join(output,row.name));
    if (row.sha256 !== hash(bytes) || row.bytes !== bytes.length) fail('BUILD_OUTPUT_MODIFIED_OR_UNKNOWN_FILES');
  }
  const builtManifest = JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
  if (record.version !== builtManifest.version) fail('BUILD_OUTPUT_MANIFEST_MODIFIED');
  return true;
}

/** Reproducible local build. No install, network, browser, profile or permission calls. */
export async function buildExtension({ projectRoot = ROOT } = {}) {
  projectRoot = resolve(projectRoot);
  if (!await directory(projectRoot)) fail('BUILD_PROJECT_DIRECTORY_MISSING');
  for (const part of ['extension','docs']) if (!await directory(join(projectRoot,part))) fail('BUILD_SOURCE_DIRECTORY_MISSING');
  const outputDir = join(projectRoot,'dist','extension');
  const dist = dirname(outputDir);
  if (!await directory(dist)) await mkdir(dist, { mode:0o755 });
  const lockPath = join(dist,'.build-extension.lock');
  let lock;
  try { lock = await open(lockPath,'wx',0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('BUILD_LOCK_EXISTS_INSPECT_MANUALLY'); throw error; }
  let stage, backupDir = null, moved = false, published = false;
  try {
    await lock.writeFile(JSON.stringify({ pid:process.pid, managedBy:OWNER })+'\n');
    await verifyExisting(outputDir);
    const pkg = JSON.parse(await plainFile(join(projectRoot,'package.json')));
    const extension = JSON.parse(await plainFile(join(projectRoot,'extension','manifest.json')));
    if (pkg.name !== 'web-task-console' || pkg.license !== 'MIT' || extension.manifest_version !== 3 || extension.version !== pkg.version) fail('BUILD_PACKAGE_OR_LICENSE_MISMATCH');
    const assets = [];
    for (const [from,name] of SOURCES) assets.push({ name, bytes:await plainFile(join(projectRoot,from)) });
    assets.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const files = assets.map(({name,bytes}) => ({ name, bytes:bytes.length, sha256:hash(bytes) }));
    const buildId = hash(JSON.stringify(files));
    const record = { schemaVersion:1, managedBy:OWNER, packageName:pkg.name, version:pkg.version, license:'MIT', buildId, files };
    stage = join(dist,'.extension-stage-'+randomUUID());
    await mkdir(stage, { mode:0o755 });
    for (const asset of assets) await writeFile(join(stage,asset.name),asset.bytes,{ flag:'wx',mode:0o644 });
    await writeFile(join(stage,MANIFEST),JSON.stringify(record,null,2)+'\n',{ flag:'wx',mode:0o644 });
    const exists = await verifyExisting(outputDir);
    if (exists) {
      const backups = join(dist,'.extension-backups');
      if (!await directory(backups)) await mkdir(backups,{mode:0o755});
      backupDir = join(backups,randomUUID());
      await rename(outputDir,backupDir); moved = true;
      // Never delete old output. Concurrent user edits remain in the backup.
      await verifyExisting(backupDir);
    }
    await rename(stage,outputDir); stage = null; published = true;
    return { outputDir, buildId, files:files.length + 1, backupDir };
  } catch (error) {
    if (moved && !published && !await stat(outputDir)) {
      try { await rename(backupDir,outputDir); moved = false; } catch { /* Never overwrite an intervening directory. */ }
    }
    throw error;
  } finally {
    if (stage) await rm(stage,{ recursive:true,force:true });
    await lock.close();
    await rm(lockPath,{ force:true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildExtension(),null,2)); }
  catch (error) { console.error('Extension build stopped: '+error.message); process.exitCode = 1; }
}
