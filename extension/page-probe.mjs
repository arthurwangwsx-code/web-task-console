/** Serialized by chrome.scripting.executeScript; no captured variables or hidden app state. */
export function pageProbe(input) {
  if (location.origin !== 'https://chatgpt.com' || window.top !== window) throw new Error('UNAPPROVED_PAGE');
  const actual = new URL(location.href);
  if (actual.username || actual.password || actual.search || actual.hash || (actual.pathname !== '/' && !/^\/c\/[a-zA-Z0-9-]{1,100}$/.test(actual.pathname))) throw new Error('UNAPPROVED_CHAT_PATH');
  if (input.expectedUrl && location.href !== input.expectedUrl) throw new Error('PAGE_NAVIGATED');
  const visible = el => el.getClientRects().length > 0 && !['hidden','collapse'].includes(getComputedStyle(el).visibility) && Number(getComputedStyle(el).opacity) !== 0;
  const modalPresent = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')].some(visible);
  // Observed read-only on the current ChatGPT UI on 2026-10-31. No guessed ids.
  const editors = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
    .filter(el => ['询问 ChatGPT', 'Ask ChatGPT'].includes(el.getAttribute('aria-label')) && visible(el));
  const editor = editors.length === 1 ? editors[0] : null;
  const form = editor?.closest('form');
  const buttons = form ? [...form.querySelectorAll('button[type="submit"]')]
    .filter(el => ['发送', 'Send', 'Send prompt'].includes(el.getAttribute('aria-label')) && visible(el)) : [];
  const read = el => el?.innerText ?? '';
  const draftMatches = Boolean(editor && read(editor) === input.wirePrompt);
  const button = buttons.length === 1 ? buttons[0] : null;
  const rect = button?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : -1, y = rect ? rect.top + rect.height / 2 : -1;
  const hit = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight ? document.elementFromPoint(x,y) : null;
  const unobstructed = Boolean(button && hit && (hit === button || button.contains(hit)) && !button.closest('[inert],[aria-hidden="true"]') && !editor.closest('[inert],[aria-hidden="true"]') && getComputedStyle(button).pointerEvents !== 'none');
  const conversationId = actual.pathname.startsWith('/c/') ? actual.pathname.slice(3) : null;
  const base = { url: location.href, conversationId, composerCount: editors.length, sendButtonCount: buttons.length,
    draftEmpty: Boolean(editor && !read(editor).trim()), draftMatches,
    sendEnabled: Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && unobstructed && !modalPresent),
    blockedByModal: modalPresent, unobstructed,
    selectorVersion: 'chatgpt-visible-2026-10-31', ack: false, businessState: 'unknown' };
  if (input.op === 'inspect') return base;
  if (input.op === 'send') {
    // This implementation NEVER writes or clears a page draft. The user pastes it.
    if (!draftMatches || !base.sendEnabled || editors.length !== 1 || buttons.length !== 1) throw new Error('DRAFT_NOT_EXACT_OR_SEND_CONTROL_UNAVAILABLE');
    // Both URL check and click are in this document's one synchronous operation.
    // chrome.scripting targets its exact documentId. Never press Enter or retry.
    buttons[0].click();
    return { ...base, clickDispatched: true, ack: false };
  }
  if (input.op === 'capture') {
    const selection = window.getSelection();
    const raw = selection?.toString() ?? '';
    if (!raw || raw.length > 65536 || selection.rangeCount !== 1) throw new Error('SELECT_ONE_BOUNDED_NATIVE_JSON_RECEIPT');
    const ancestor = selection.getRangeAt(0).commonAncestorContainer;
    const element = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
    if (!element || element.closest('form,input,textarea,[contenteditable="true"]')) throw new Error('RECEIPT_MUST_NOT_BE_A_DRAFT');
    const range = selection.getRangeAt(0);
    if ([...document.querySelectorAll('form,input,textarea,[contenteditable="true"]')].some(el => range.intersectsNode(el))) throw new Error('SELECTION_INTERSECTS_DRAFT_OR_FORM');
    return { ...base, selectedReceipt: raw };
  }
  throw new Error('UNSUPPORTED_PROBE_OPERATION');
}
