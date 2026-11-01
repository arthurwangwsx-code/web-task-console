import { ChromeHost } from './chrome-host.mjs';
import { ExtensionController } from './controller.mjs';
import { safeErrorCode } from './errors.mjs';

const KEY = 'webTaskConsoleV1';
let initialization;
function controller() {
  initialization ??= (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    let { browserSessionId } = await chrome.storage.session.get('browserSessionId');
    if (!browserSessionId) { browserSessionId = crypto.randomUUID(); await chrome.storage.session.set({ browserSessionId }); }
    const store = { async read() { return (await chrome.storage.local.get(KEY))[KEY] ?? null; }, async write(state) { await chrome.storage.local.set({ [KEY]: state }); } };
    return new ExtensionController({ store, host: new ChromeHost(chrome), sessionId: browserSessionId }).init();
  })();
  return initialization;
}

chrome.action.onClicked.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('console.html') }); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // No content-script, webpage, other extension, or external caller can operate the controller.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('console.html')) { respond({ ok: false, error: 'UNTRUSTED_MESSAGE_SOURCE' }); return false; }
  (async () => {
    const instance = await controller();
    const allowed = new Set(['create','open','inspect','restore','send','capture','cancel','pause','verifyBinding','observeMessages','idleCheck']);
    if (message?.op === 'state' || message?.op === 'permissionChanged') return { ...instance.snapshot(), hostApproved: await instance.host.hasPermission() };
    if (!allowed.has(message?.op)) throw new Error('UNSUPPORTED_OPERATION');
    return instance[message.op](message);
  })().then(value => respond({ ok: true, value }), error => respond({ ok: false, error: safeErrorCode(error) }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { controller().then(instance => instance.removed(tabId)).catch(() => {}); });
