import { promises as fs } from 'node:fs';
import path from 'node:path';

/** One process owns one data directory. Stale locks are never silently removed. */
export class JsonStore {
  constructor(directory, name = 'intents') {
    this.directory = path.resolve(directory);
    this.filename = path.join(this.directory, `${name}.json`);
    this.lockname = path.join(this.directory, `${name}.lock`);
  }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.lock = await fs.open(this.lockname, 'wx', 0o600);
      await this.lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await this.lock.sync();
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`DATA_DIRECTORY_LOCKED: inspect ${this.lockname}; do not remove while its process may be alive`);
      throw error;
    }
    try { return JSON.parse(await fs.readFile(this.filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; await this.close(); throw error; }
  }
  async save(value) {
    if (!this.lock) throw new Error('STORE_NOT_OPEN');
    const tmp = `${this.filename}.${process.pid}.tmp`;
    const handle = await fs.open(tmp, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(tmp, this.filename);
    const dir = await fs.open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async close() {
    if (!this.lock) return;
    await this.lock.close(); this.lock = null;
    await fs.unlink(this.lockname);
  }
}

export class MemoryStore {
  constructor(value = null) { this.value = value; }
  async open() { return structuredClone(this.value); }
  async save(value) { this.value = structuredClone(value); }
  async close() {}
}
