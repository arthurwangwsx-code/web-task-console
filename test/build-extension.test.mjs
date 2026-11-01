import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, readdir, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildExtension } from '../scripts/build-extension.mjs';
const root = resolve(new URL('..',import.meta.url).pathname);
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'web-console-build-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const name of ['extension','docs','package.json','LICENSE'])await cp(join(root,name),join(dir,name),{recursive:true});
  return dir;
}
async function hashes(dir) {
  const result={};
  for(const name of (await readdir(dir)).sort())result[name]=createHash('sha256').update(await readFile(join(dir,name))).digest('hex');
  return result;
}
test('extension build is byte-reproducible and includes MIT plus deterministic inventory',async t=>{
  const dir=await fixture(t),a=await buildExtension({projectRoot:dir}),before=await hashes(a.outputDir),b=await buildExtension({projectRoot:dir});
  assert.equal(a.buildId,b.buildId);assert.deepEqual(await hashes(b.outputDir),before);assert.ok(b.backupDir);
  assert.deepEqual(await hashes(b.backupDir),before);
  const record=JSON.parse(await readFile(join(a.outputDir,'BUILD-MANIFEST.json'),'utf8'));
  assert.equal(record.license,'MIT');assert.equal(record.files.length,18);assert.equal(a.files,19);
  assert.equal(JSON.stringify(record).includes(dir),false);
  assert.match(await readFile(join(a.outputDir,'LICENSE'),'utf8'),/MIT License/);
});
test('source change rebuilds fixed output and preserves the previous owned output',async t=>{
  const dir=await fixture(t),first=await buildExtension({projectRoot:dir}),old=await hashes(first.outputDir);
  await writeFile(join(dir,'extension','style.css'),'\n/* synthetic build change */\n',{flag:'a'});
  const next=await buildExtension({projectRoot:dir});assert.equal(next.outputDir,first.outputDir);assert.notEqual(next.buildId,first.buildId);
  assert.deepEqual(await hashes(next.backupDir),old);
});
test('unmarked existing output is never adopted or overwritten',async t=>{
  const dir=await fixture(t),out=join(dir,'dist','extension');await mkdir(out,{recursive:true});await writeFile(join(out,'user.txt'),'synthetic user file');
  await assert.rejects(buildExtension({projectRoot:dir}),/BUILD_OUTPUT_NOT_OWNED/);
  assert.equal(await readFile(join(out,'user.txt'),'utf8'),'synthetic user file');
});
test('modified generated output is preserved rather than overwritten',async t=>{
  const dir=await fixture(t),{outputDir}=await buildExtension({projectRoot:dir});
  await writeFile(join(outputDir,'style.css'),'synthetic user modification');
  await assert.rejects(buildExtension({projectRoot:dir}),/MODIFIED_OR_UNKNOWN/);
  assert.equal(await readFile(join(outputDir,'style.css'),'utf8'),'synthetic user modification');
});
test('unknown added files in managed output stop rebuilding and are preserved',async t=>{
  const dir=await fixture(t),{outputDir}=await buildExtension({projectRoot:dir});
  await writeFile(join(outputDir,'user-file.txt'),'synthetic');
  await assert.rejects(buildExtension({projectRoot:dir}),/MODIFIED_OR_UNKNOWN/);
  assert.equal(await readFile(join(outputDir,'user-file.txt'),'utf8'),'synthetic');
});
test('manual build inventory changes are not silently overwritten',async t=>{
  const dir=await fixture(t),{outputDir}=await buildExtension({projectRoot:dir}),path=join(outputDir,'BUILD-MANIFEST.json');
  const data=JSON.parse(await readFile(path,'utf8'));data.userNote='synthetic keep this note';
  const manual=JSON.stringify(data,null,2)+'\n';await writeFile(path,manual);
  await assert.rejects(buildExtension({projectRoot:dir}),/MANIFEST_MODIFIED/);
  assert.equal(await readFile(path,'utf8'),manual);
});
test('symlinked output and symlinked source assets are rejected',async t=>{
  const dir=await fixture(t);await mkdir(join(dir,'dist'));await mkdir(join(dir,'elsewhere'));
  await symlink(join(dir,'elsewhere'),join(dir,'dist','extension'));
  await assert.rejects(buildExtension({projectRoot:dir}),/SYMLINK/);
  await rm(join(dir,'dist','extension'));await rm(join(dir,'extension','style.css'));
  await symlink(join(dir,'LICENSE'),join(dir,'extension','style.css'));
  await assert.rejects(buildExtension({projectRoot:dir}),/NOT_REGULAR_FILE/);
  assert.deepEqual(await readdir(join(dir,'elsewhere')),[]);
});
test('an existing build lock is not removed or bypassed',async t=>{
  const dir=await fixture(t);await mkdir(join(dir,'dist'));await writeFile(join(dir,'dist','.build-extension.lock'),'synthetic lock');
  await assert.rejects(buildExtension({projectRoot:dir}),/BUILD_LOCK_EXISTS/);
  assert.equal(await readFile(join(dir,'dist','.build-extension.lock'),'utf8'),'synthetic lock');
});
test('build excludes arbitrary source files, runtime data and private environment files',async t=>{
  const dir=await fixture(t);await writeFile(join(dir,'.env'),'synthetic private data');await writeFile(join(dir,'extension','unapproved.json'),'synthetic private data');await mkdir(join(dir,'.data'));await writeFile(join(dir,'.data','state.json'),'synthetic private data');
  const {outputDir}=await buildExtension({projectRoot:dir}),names=await readdir(outputDir);
  for(const forbidden of ['.env','.data','state.json','unapproved.json'])assert.equal(names.includes(forbidden),false);
  assert.equal((await stat(join(outputDir,'manifest.json'))).isFile(),true);
});
