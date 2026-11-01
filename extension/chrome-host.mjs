import { pageProbe } from './page-probe.mjs';
export const CHAT_ORIGIN = 'https://chatgpt.com';
export const CHAT_PERMISSION = { origins: [`${CHAT_ORIGIN}/*`] };

export class ChromeHost {
  constructor(api) { this.api = api; }
  async hasPermission() { return this.api.permissions.contains(CHAT_PERMISSION); }
  async open(url) {
    if (!await this.hasPermission()) throw new Error('CHATGPT_PERMISSION_REQUIRED');
    const target = new URL(url);
    if (target.origin !== CHAT_ORIGIN || target.username || target.password || target.search || target.hash || (target.pathname !== '/' && !/^\/c\/[a-zA-Z0-9-]{1,100}$/.test(target.pathname))) throw new Error('UNAPPROVED_CHAT_URL');
    const tab = await this.api.tabs.create({ url, active: true });
    if (!Number.isInteger(tab?.id) || tab.incognito) throw new Error('TAB_CREATION_UNKNOWN');
    return { tabId: tab.id, url };
  }
  async inspect(tab, wirePrompt, bind = false) {
    return this.execute(tab, { op: 'inspect', wirePrompt }, bind);
  }
  async execute(tab, input, bind = false) {
    if (input.op === 'send') throw new Error('ATOMIC_NATIVE_DISPATCH_UNAVAILABLE');
    if (!await this.hasPermission()) throw new Error('CHATGPT_PERMISSION_REQUIRED');
    const metadata = await this.api.tabs.get(tab.tabId);
    if (metadata.id !== tab.tabId || metadata.incognito || !metadata.url?.startsWith(`${CHAT_ORIGIN}/`)) throw new Error('OWNED_TAB_ORIGIN_CHANGED');
    if (!bind && !tab.documentId) throw new Error('DOCUMENT_NOT_BOUND');
    const target = bind ? { tabId: tab.tabId, frameIds: [0] } : { tabId: tab.tabId, documentIds: [tab.documentId] };
    const output = await this.api.scripting.executeScript({ target, world: 'ISOLATED', func: pageProbe,
      args: [{ ...input, expectedUrl: input.expectedUrl ?? (input.op === 'send' ? tab.url : undefined) }] });
    if (output.length !== 1 || output[0].frameId !== 0 || !output[0].documentId || (!bind && output[0].documentId !== tab.documentId)) throw new Error('AMBIGUOUS_DOCUMENT_RESULT');
    if (!output[0].result) throw new Error('MISSING_PAGE_RESULT');
    return { ...output[0].result, documentId: output[0].documentId };
  }
  async verifyIdentity() {
    // Tabs/Scripting prove a browser document, NOT the signed-in ChatGPT account
    // or native conversation/message ownership. Do not scrape private APIs.
    return { available: false, reason: 'NATIVE_ACCOUNT_AND_MESSAGE_ID_CONTRACT_UNAVAILABLE' };
  }
  async send() { throw new Error('ATOMIC_NATIVE_DISPATCH_UNAVAILABLE'); }
  async dispatchVerified() { throw new Error('ATOMIC_NATIVE_DISPATCH_UNAVAILABLE'); }
  async capture(tab, wirePrompt) { return this.execute(tab, { op: 'capture', wirePrompt }); }
  async rebindReadOnly(tab, expectedUrl, wirePrompt) {
    // Explicit caller approval plus exact URL; only read operations are restored.
    const target = new URL(expectedUrl);
    if (target.username || target.password || target.origin !== CHAT_ORIGIN) throw new Error('UNAPPROVED_CHAT_URL');
    const current = await this.api.tabs.get(tab.tabId);
    if (current.url !== expectedUrl) throw new Error('READONLY_REBIND_URL_MISMATCH');
    return this.execute(tab, { op: 'inspect', wirePrompt, expectedUrl }, true);
  }
}
