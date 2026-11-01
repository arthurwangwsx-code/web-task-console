import { JsonStore } from './store.mjs';
import { IntentEngine } from './engine.mjs';
import { DemoAdapter } from './demo-adapter.mjs';

export async function createRuntime({ dataDir = '.data', config = {} } = {}) {
  const adapter = new DemoAdapter(new JsonStore(dataDir, 'synthetic-provider'));
  const engine = new IntentEngine({ store: new JsonStore(dataDir), adapter, config });
  try { await adapter.open(); await engine.open(); }
  catch (error) { await engine.store.close().catch(() => {}); await adapter.close().catch(() => {}); throw error; }
  return { engine, adapter, async close() { await engine.close(); await adapter.close(); } };
}
