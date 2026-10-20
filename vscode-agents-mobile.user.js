// ==UserScript==
// @name         VS Code Agents - Mobile Input and Controls
// @namespace    local.vscode-agents-mobile
// @version      0.3.1
// @description  Phone-sized Agents controls in normal Android browser mode, with selectable input and touch fixes.
// @match        https://vscode.dev/agents*
// @run-at       document-start
// @sandbox      raw
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  if (location.pathname !== '/agents' && !location.pathname.startsWith('/agents/')) return;
  if (!matchMedia('(pointer: coarse)').matches && !/Android/i.test(navigator.userAgent)) return;

  const instanceKey = '__vscodeAgentsMobile';
  window[instanceKey]?.dispose();
  const pageWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const pageNavigator = pageWindow.navigator;
  const originalUserAgent = pageNavigator.userAgent;
  const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(pageNavigator, 'userAgent');
  let presentationUserAgent;
  let startupError;
  if (/Android/i.test(originalUserAgent)) {
    let desktopAgent = originalUserAgent.replace(/\bMobile(?:;\s*)?/gi, '');
    if (!/\bLinux\b/.test(desktopAgent)) desktopAgent = desktopAgent.replace(/\bAndroid\b/, 'Linux; Android');
    if (desktopAgent !== originalUserAgent) {
      // VS Code chooses its renderer once from the Mobile marker. Leave the
      // browser viewport, Android behavior, Firefox version, and HTTP headers intact.
      try {
        const getter = typeof exportFunction === 'function'
          ? exportFunction(() => desktopAgent, pageWindow)
          : () => desktopAgent;
        Object.defineProperty(pageNavigator, 'userAgent', { configurable: true, get: getter });
        presentationUserAgent = getter;
      } catch (error) {
        startupError = 'The script could not select desktop-style app controls. Allow its Tampermonkey page-access grant, keep Desktop site OFF, and reload.';
        console.error('[VS Code Agents Mobile] Presentation override unavailable:', error);
      }
    }
  }
  const controller = new AbortController();
  const editors = new Map();
  const widthOverrides = new Set();
  const nativeEvents = new WeakSet();
  const buttonActions = new WeakMap();
  const editorSelector = '.interactive-input-editor .monaco-editor, .sessions-chat-editor .monaco-editor';
  const interactiveSelector = 'a, button, input, textarea, select, [role="button"], [contenteditable="true"]';
  let frame = 0;
  let view = 'chat';
  let nav;
  let notice;
  let gesture;
  let lastGesture;
  let compatibilityClickTimer;
  let nativePan;
  let nativeMomentum = false;
  const blockedTouches = new Set();
  let initializedLayout = false;
  let disposed = false;
  let observedWorkbench;
  let viewportMeta;
  let originalViewport;
  let activeEditor;
  let dockedComposer;

  const style = document.createElement('style');
  style.id = 'tm-agents-style';
  style.textContent = `
    html.tm-agents-mobile { --tm-agents-header: 44px; }
    .tm-agents-nav {
      position: fixed; inset: 0 0 auto; height: var(--tm-agents-header);
      z-index: 1000; display: flex; gap: 4px; padding: 0 4px; box-sizing: border-box;
      background: var(--vscode-sideBar-background, #191a1b); color: var(--vscode-foreground, #ddd);
      border-bottom: 1px solid var(--vscode-panel-border, #444);
    }
    .tm-agents-nav button, .tm-agents-more button {
      min-height: 44px; padding: 6px 10px; border: 1px solid var(--vscode-panel-border, #555);
      border-radius: 6px; background: var(--vscode-button-secondaryBackground, #333);
      color: var(--vscode-button-secondaryForeground, #eee); font: 16px system-ui;
      cursor: pointer; touch-action: manipulation;
    }
    .tm-agents-nav button { flex: 1; border-radius: 0; border: 0; }
    .tm-agents-nav[hidden] { display: none; }
    .tm-agents-nav button[aria-pressed="true"] { box-shadow: inset 0 -3px var(--vscode-focusBorder, #168bce); }
    .tm-agents-nav button:focus-visible, .tm-agents-more button:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, #168bce); outline-offset: -2px;
    }
    .tm-agents-more {
      position: fixed; right: 4px; top: 46px; z-index: 2600; display: grid; gap: 4px;
      max-height: calc(var(--tm-agents-height, 100dvh) - 54px); max-width: calc(100vw - 8px); overflow: auto;
      padding: 6px; background: var(--vscode-menu-background, #222); border: 1px solid #666;
    }
    .tm-agents-more button { text-align: left; }
    html.tm-agents-mobile .agent-sessions-workbench:not(.phone-layout) .part.titlebar { visibility: hidden; }
    html.tm-agents-mobile .agent-sessions-workbench:not(.phone-layout) .part.sessionspart,
    html.tm-agents-mobile .agent-sessions-workbench:not(.phone-layout) .part.sidebar,
    html.tm-agents-mobile .agent-sessions-workbench:not(.phone-layout) .part.editor,
    html.tm-agents-mobile .agent-sessions-workbench:not(.phone-layout) .part.panel {
      position: fixed !important; top: var(--tm-agents-header) !important; left: 0 !important;
      width: 100vw !important; height: calc(var(--tm-agents-height, 100dvh) - var(--tm-agents-header)) !important;
      min-width: 0 !important; margin: 0 !important; box-sizing: border-box; border-radius: 0 !important;
      visibility: hidden; pointer-events: none;
    }
    html.tm-agents-mobile[data-tm-agents-view="chat"] .part.sessionspart,
    html.tm-agents-mobile[data-tm-agents-view="sessions"] .part.sidebar,
    html.tm-agents-mobile[data-tm-agents-view="files"] .part.editor,
    html.tm-agents-mobile[data-tm-agents-view="panel"] .part.panel {
      visibility: visible !important; pointer-events: auto !important; z-index: 100;
    }
    html.tm-agents-mobile:not([data-tm-agents-view="chat"]) .part.sessionspart,
    html.tm-agents-mobile:not([data-tm-agents-view="sessions"]) .part.sidebar,
    html.tm-agents-mobile:not([data-tm-agents-view="files"]) .part.editor,
    html.tm-agents-mobile:not([data-tm-agents-view="panel"]) .part.panel {
      opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;
    }
    /* Monaco still measures inactive rows. Keep their layout, but hide even
       descendants whose native styles explicitly make them visible. */
    html.tm-agents-mobile:not([data-tm-agents-view="chat"]) .part.sessionspart *,
    html.tm-agents-mobile:not([data-tm-agents-view="sessions"]) .part.sidebar *,
    html.tm-agents-mobile:not([data-tm-agents-view="files"]) .part.editor *,
    html.tm-agents-mobile:not([data-tm-agents-view="panel"]) .part.panel * {
      visibility: hidden !important; pointer-events: none !important;
    }
    html.tm-agents-mobile [data-tm-agents-fill-width] {
      width: 100% !important; min-width: 0 !important; max-width: none !important; box-sizing: border-box;
    }
    html.tm-agents-mobile .sessions-list-control,
    html.tm-agents-mobile .sessions-list-control > .monaco-list,
    html.tm-agents-mobile .sessions-list-control .monaco-scrollable-element,
    html.tm-agents-mobile .sessions-list-control .monaco-list-rows,
    html.tm-agents-mobile .part.editor [role="tree"] .monaco-scrollable-element { width: 100% !important; }
    html.tm-agents-mobile .sessions-list-control .session-title { font-size: 16px !important; }
    html.tm-agents-mobile .sessions-list-control .session-section-label { font-size: 15px !important; }
    html.tm-agents-mobile .sessions-list-control .session-details-row { font-size: 13px !important; }
    html.tm-agents-mobile .sessions-list-control .session-chat-twistie {
      min-width: 36px; touch-action: pan-y;
    }
    html.tm-agents-mobile .sessions-list-control .session-title-toolbar { visibility: visible !important; }
    html.tm-agents-mobile .tm-agents-editor-host { height: auto !important; min-height: 96px; position: relative; }
    html.tm-agents-mobile [data-tm-agents-native] {
      position: absolute !important; opacity: 0 !important; pointer-events: none !important;
      clip-path: inset(50%); top: 0; left: 0;
    }
    .tm-agents-input {
      display: block; width: 100%; min-height: 96px; max-height: calc(var(--tm-agents-height, 100dvh) * .32); box-sizing: border-box;
      resize: vertical; overflow: auto; padding: 10px; border: 0; border-radius: 6px;
      color: var(--vscode-input-foreground, #eee); background: var(--vscode-input-background, #252526);
      font: 16px/1.45 system-ui; white-space: pre-wrap; touch-action: auto;
      -webkit-user-select: text !important; user-select: text !important; -webkit-touch-callout: default;
    }
    .tm-agents-input:focus { outline: 1px solid var(--vscode-focusBorder, #168bce); outline-offset: -1px; }
    .tm-agents-input[hidden] { display: none; }
    html.tm-agents-mobile .interactive-list .monaco-list-row,
    html.tm-agents-mobile .sessions-list-control .monaco-list-row {
      touch-action: var(--tm-agents-transcript-touch-action, pinch-zoom) !important;
    }
    html.tm-agents-mobile [data-tm-agents-docked] {
      position: fixed !important; top: auto !important;
      bottom: max(0px, calc(100dvh - var(--tm-agents-height, 100dvh))) !important;
      left: 8px !important; width: calc(100vw - 16px) !important; height: auto !important;
      max-height: calc(var(--tm-agents-height, 100dvh) - 52px); overflow-y: auto;
      margin: 0 !important; box-sizing: border-box !important; z-index: 900;
      background: var(--vscode-editor-background, #191a1b);
    }
    html.tm-agents-mobile .model-picker-config-summary { display: inline-flex !important; }
    .tm-agents-status { color: var(--vscode-errorForeground, #ff8a8a); white-space: normal; padding: 4px; font: 13px/1.4 system-ui; }
    .tm-agents-status:empty { display: none; }
    #tm-agents-setup {
      position: fixed; z-index: 4000; inset: auto 8px 8px; padding: 12px;
      max-height: 70vh; overflow: auto; box-sizing: border-box;
      background: #322400; color: #fff; font: 16px/1.45 system-ui;
    }
    html.tm-agents-mobile .interactive-request .rendered-markdown,
    html.tm-agents-mobile .interactive-response .rendered-markdown {
      -webkit-user-select: text !important; user-select: text !important; -webkit-touch-callout: default;
      font-size: 16px !important; line-height: 1.5;
    }
    html.tm-agents-mobile .chat-model-picker-model .action-list-item-toolbar { visibility: visible !important; }
    html.tm-agents-mobile .context-view { max-width: calc(100vw - 8px); z-index: 3000 !important; }
    html.tm-agents-mobile .tabbed-action-list-details { max-width: calc(100vw - 24px); }
    html.tm-agents-mobile .tabbed-action-list-details button,
    html.tm-agents-mobile .tabbed-action-list-details [role="radio"] {
      min-height: 44px; font-size: 16px; white-space: normal;
    }
  `;

  function on(target, type, listener, options = {}) {
    target.addEventListener(type, listener, { ...options, signal: controller.signal });
  }

  function text(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function button(label, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    buttonActions.set(element, action);
    return element;
  }

  function report(state, error) {
    const message = error instanceof Error ? error.message : String(error);
    state.error = message;
    text(state.status, `Not synced: ${message} Sending is blocked. Your text is still in this input.`);
    console.error('[VS Code Agents Mobile]', error);
  }

  function nativeInput(state) {
    const input = state.editor.querySelector('.native-edit-context, textarea.inputarea:not([readonly])');
    if (!input) throw new Error('The native chat input is unavailable.');
    return input;
  }

  function key(target, keyValue, code, keyCode, modifiers = {}) {
    const event = new KeyboardEvent('keydown', {
      key: keyValue, code, keyCode, which: keyCode, bubbles: true, cancelable: true, ...modifiers,
    });
    nativeEvents.add(event);
    target.dispatchEvent(event);
    return event;
  }

  function selectAll(input) {
    const mac = /Mac/i.test(navigator.platform);
    const event = key(input, 'a', 'KeyA', 65, { ctrlKey: !mac, metaKey: mac });
    if (!event.defaultPrevented) throw new Error('VS Code did not accept Select All in the chat editor.');
  }

  function withNative(state, action) {
    const input = nativeInput(state);
    const focused = document.activeElement;
    const selection = [state.input.selectionStart, state.input.selectionEnd, state.input.selectionDirection];
    state.syncing = true;
    try {
      input.focus({ preventScroll: true });
      return action(input);
    } finally {
      state.syncing = false;
      const restore = focused === input && !state.nativeMode ? state.input : focused;
      if (restore === document.body || restore === document.documentElement) input.blur();
      else if (restore?.isConnected && typeof restore.focus === 'function') restore.focus({ preventScroll: true });
      state.input.setSelectionRange(...selection);
    }
  }

  function selectedText(input) {
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    nativeEvents.add(event);
    input.dispatchEvent(event);
    const clipboard = event.clipboardData;
    if (!event.defaultPrevented || !clipboard?.types.includes('text/plain')) {
      throw new Error('This browser did not expose the native editor selection.');
    }
    const metadata = clipboard.getData('vscode-editor-data');
    if (metadata && JSON.parse(metadata).isFromEmptySelection) return '';
    return clipboard.getData('text/plain').replace(/\r\n?/g, '\n');
  }

  function readNative(state) {
    return withNative(state, input => {
      selectAll(input);
      return selectedText(input);
    });
  }

  function writeNative(state, value) {
    withNative(state, input => {
      selectAll(input);
      const previous = selectedText(input);
      if (previous === value) return;
      if (previous !== state.lastNative) throw new Error('The native prompt changed while this input had unsynced text.');
      if (!value) {
        key(input, 'Backspace', 'Backspace', 8);
      } else if (input.editContext && typeof TextUpdateEvent === 'function') {
        // Composition boundaries flush Monaco's deferred native buffer before replacement.
        const context = input.editContext;
        context.dispatchEvent(new Event('compositionstart'));
        try {
          context.dispatchEvent(new TextUpdateEvent('textupdate', {
            updateRangeStart: 0, updateRangeEnd: context.text.length, text: value,
            selectionStart: value.length, selectionEnd: value.length,
          }));
        } finally {
          context.dispatchEvent(new Event('compositionend'));
        }
      } else if (input instanceof HTMLTextAreaElement) {
        input.value = value;
        input.setSelectionRange(value.length, value.length);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      } else {
        throw new Error('This native editor input is not supported.');
      }
      selectAll(input);
      if (selectedText(input) !== value) throw new Error('VS Code did not confirm the updated prompt.');
    });
  }

  function sync(state) {
    if (state.composing || state.nativeMode) return false;
    if (!isLaidOut(state.editor)) {
      state.pendingSync = true;
      return false;
    }
    try {
      if (state.input.value !== state.lastNative || state.error) writeNative(state, state.input.value);
      state.lastNative = state.input.value;
      state.error = '';
      state.pendingSync = false;
      text(state.status, '');
      return true;
    } catch (error) {
      state.pendingSync = false;
      report(state, error);
      return false;
    }
  }

  function refreshNative(state) {
    if (!isLaidOut(state.editor) || state.syncing || state.composing || state.error || state.nativeMode) return;
    try {
      const value = readNative(state);
      if (value !== state.lastNative) {
        if (state.input.value !== state.lastNative && !state.nativeMode) {
          throw new Error('The native prompt changed while this input had unsynced text.');
        }
        state.input.value = value;
        state.lastNative = value;
      }
    } catch (error) {
      report(state, error);
    }
  }

  function composer(state) {
    return state.editor.closest('.interactive-input-part, .new-chat-widget-content, .new-chat-input-container')
      || state.host.parentElement;
  }

  function toggleNativeEditor(state) {
    if (state.nativeMode) {
      try {
        const value = readNative(state);
        state.input.value = value;
        state.lastNative = value;
        state.error = '';
        text(state.status, '');
      } catch (error) {
        report(state, error);
        text(state.status, `Touch editor unavailable: ${state.error} The native editor remains enabled.`);
        return;
      }
    } else if (!sync(state)) return;
    state.nativeMode = !state.nativeMode;
    state.input.hidden = state.nativeMode;
    state.editor.toggleAttribute('data-tm-agents-native', !state.nativeMode);
    state.host.classList.toggle('tm-agents-editor-host', !state.nativeMode);
    if (state.nativeMode) {
      const native = nativeInput(state);
      native.focus({ preventScroll: true });
      key(native, 'ArrowRight', 'ArrowRight', 39);
    } else state.input.focus({ preventScroll: true });
    window.dispatchEvent(new Event('resize'));
  }

  function activateEditor(state) {
    if (activeEditor !== state) {
      activeEditor = state;
      scheduleRefresh();
    }
  }

  function renderedInput(editor) {
    return [...editor.querySelectorAll('.view-lines .view-line')].map(line => line.textContent).join('\n');
  }

  function attachEditor(editor) {
    if (editors.has(editor) || !isLaidOut(editor) || !editor.querySelector('.native-edit-context, textarea.inputarea')) return;
    const host = editor.parentElement;
    const input = document.createElement('textarea');
    input.className = 'tm-agents-input';
    input.rows = 3;
    input.placeholder = 'Message...';
    input.setAttribute('aria-label', 'Message. Enter inserts a new line. Use Send to submit.');
    input.setAttribute('enterkeyhint', 'enter');
    input.setAttribute('autocapitalize', 'sentences');
    input.spellcheck = true;
    const status = document.createElement('div');
    status.className = 'tm-agents-status';
    status.setAttribute('role', 'status');
    const state = { editor, host, input, status, lastNative: '', error: '', composing: false, syncing: false, nativeMode: false, visible: true };
    host.append(input);
    host.after(status);
    editors.set(editor, state);
    try {
      state.lastNative = readNative(state);
      input.value = state.lastNative;
      // Monaco rebuilds its className on focus; a data attribute survives rerenders.
      editor.setAttribute('data-tm-agents-native', '');
      host.classList.add('tm-agents-editor-host');
    } catch (error) {
      report(state, error);
      state.nativeMode = true;
      input.hidden = true;
      text(state.status, `Touch editor unavailable: ${state.error} The native editor remains enabled.`);
    }
    on(input, 'input', event => { if (!event.isComposing) sync(state); });
    on(input, 'focus', () => activateEditor(state));
    on(input, 'compositionstart', () => { state.composing = true; });
    on(input, 'compositionend', () => { state.composing = false; sync(state); });
    on(editor, 'focusin', () => {
      if (!state.syncing) activateEditor(state);
      if (!state.syncing && !state.nativeMode) input.focus({ preventScroll: true });
    });
    state.renderedInput = renderedInput(editor);
    state.observer = new MutationObserver(records => {
      if (records.some(record => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('.view-lines'))) {
        const current = renderedInput(editor);
        if (current !== state.renderedInput) {
          state.renderedInput = current;
          cancelAnimationFrame(state.nativeFrame);
          state.nativeFrame = requestAnimationFrame(() => refreshNative(state));
        }
      }
    });
    state.observer.observe(editor, { childList: true, subtree: true, characterData: true });
  }

  function titleButton(pattern) {
    return [...document.querySelectorAll('.part.titlebar [role="button"], .part.titlebar button')]
      .find(element => pattern.test(element.getAttribute('aria-label') || ''));
  }

  function setPane(pattern, open, hiddenClass) {
    const workbench = document.querySelector('.agent-sessions-workbench');
    const target = titleButton(pattern);
    if (!target || !workbench) return;
    const pressed = target.getAttribute('aria-pressed');
    const isOpen = pressed === null ? !workbench.classList.contains(hiddenClass) : pressed === 'true';
    if (isOpen !== open) target.click();
  }

  function setView(next) {
    if (next !== 'chat') document.activeElement?.blur?.();
    view = next;
    document.documentElement.dataset.tmAgentsView = view;
    setPane(/^Toggle Side Bar\b/, view === 'sessions', 'nosidebar');
    setPane(/^Toggle Side Panel\b/, view === 'files', 'noeditorpane');
    nav?.querySelectorAll('[data-view]').forEach(element => {
      element.setAttribute('aria-pressed', String(element.dataset.view === view));
    });
    window.dispatchEvent(new Event('resize'));
  }

  function moreActions() {
    const existing = document.querySelector('.tm-agents-more');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'tm-agents-more';
    menu.setAttribute('role', 'menu');
    const currentEditor = activeEditor && isLaidOut(activeEditor.editor)
      ? activeEditor : [...editors.values()].find(state => isLaidOut(state.editor));
    if (currentEditor) {
      const toggle = button(currentEditor.nativeMode ? 'Touch editor' : 'Native editor', () => {
        menu.remove();
        toggleNativeEditor(currentEditor);
      });
      toggle.setAttribute('role', 'menuitem');
      menu.append(toggle);
    }
    for (const target of document.querySelectorAll('.part.titlebar [role="button"], .part.titlebar button')) {
      const label = target.getAttribute('aria-label');
      if (!label || /^Toggle Side (?:Bar|Panel)\b/.test(label)) continue;
      const action = button(label, () => {
        menu.remove();
        if (/^(?:Show|Hide) Panel\b/.test(label)) {
          view = 'panel';
          document.documentElement.dataset.tmAgentsView = view;
        }
        target.click();
      });
      action.disabled = target.disabled || target.getAttribute('aria-disabled') === 'true';
      action.setAttribute('role', 'menuitem');
      menu.append(action);
    }
    document.body.append(menu);
  }

  function createNavigation() {
    if (nav) return;
    nav = document.createElement('nav');
    nav.className = 'tm-agents-nav';
    nav.setAttribute('aria-label', 'Mobile workspace');
    for (const [label, mode] of [['Sessions', 'sessions'], ['Chat', 'chat'], ['Files', 'files']]) {
      const action = button(label, () => setView(mode));
      action.dataset.view = mode;
      nav.append(action);
    }
    nav.append(button('More', moreActions));
    document.body.append(nav);
  }

  function isLaidOut(element) {
    return element.isConnected && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  }

  function stretchPaneContents() {
    for (const element of widthOverrides) {
      if (!element.isConnected) {
        element.removeAttribute('data-tm-agents-fill-width');
        widthOverrides.delete(element);
      }
    }
    for (const pane of document.querySelectorAll('.part.sidebar, .part.editor')) {
      for (const target of pane.querySelectorAll('.sessions-list-control, [role="tree"], .part.auxiliarybar')) {
        let element = target;
        while (element && element !== pane) {
          if (!widthOverrides.has(element)) {
            element.setAttribute('data-tm-agents-fill-width', '');
            widthOverrides.add(element);
          }
          element = element.parentElement;
        }
      }
    }
  }

  function showSetupNotice(message) {
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'tm-agents-setup';
      notice.setAttribute('role', 'status');
      document.body.append(notice);
    }
    text(notice, message);
    const scale = window.visualViewport?.scale || 1;
    notice.style.fontSize = `${Math.max(16, 16 / scale)}px`;
    notice.style.padding = `${Math.max(12, 12 / scale)}px`;
    if (nav) nav.hidden = true;
  }

  function eventElement(event) {
    const target = event.initialTarget || event.wrappedJSObject?.initialTarget || event.target;
    return target?.nodeType === 1 && typeof target.closest === 'function' ? target : target?.parentElement;
  }

  function touchTarget(element) {
    if (!element) return;
    const twistie = element.closest('.sessions-list-control .session-chat-twistie.collapsible, .sessions-list-control .session-section-chevron.collapsible');
    if (twistie) return { kind: 'chevron', element: twistie };
    if (element.closest(interactiveSelector)) return;
    const request = element.closest('.interactive-request .rendered-markdown');
    if (request) return { kind: 'request', element: request };
    const response = element.closest('.interactive-response .rendered-markdown');
    if (response) return { kind: 'text', element: response };
  }

  function chatLink(element) {
    return element?.closest('.interactive-request .rendered-markdown a[href], .interactive-response .rendered-markdown a[href]');
  }

  function suppress(event, preventDefault = false) {
    event.stopImmediatePropagation();
    if (preventDefault && event.cancelable) event.preventDefault();
  }

  function nativeClick(element) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 });
    nativeEvents.add(event);
    element.dispatchEvent(event);
  }

  function emitNativeTouch(type, pan) {
    const pointer = pan?.lastEvent;
    const touch = pan ? new Touch({
      identifier: pan.id, target: pan.scroller,
      clientX: pointer.clientX, clientY: pointer.clientY,
      pageX: pointer.pageX, pageY: pointer.pageY,
      screenX: pointer.screenX, screenY: pointer.screenY,
    }) : undefined;
    const active = touch && type !== 'touchend' ? [touch] : [];
    const event = new TouchEvent(type, {
      bubbles: true, cancelable: true,
      touches: active, targetTouches: active, changedTouches: touch ? [touch] : [],
    });
    nativeEvents.add(event);
    document.dispatchEvent(event);
  }

  function finishNativePan(cancelled = false) {
    if (!nativePan) return;
    const pan = nativePan;
    emitNativeTouch('touchend', pan);
    nativePan = undefined;
    if (pan.scroller.hasPointerCapture(pan.id)) pan.scroller.releasePointerCapture(pan.id);
    nativeMomentum = pan.moving && !cancelled;
    if (cancelled) emitNativeTouch('touchstart');
  }

  function startNativePan(event, element) {
    if (!initializedLayout || window.getSelection()?.toString() || (window.visualViewport?.scale || 1) > 1.05) return;
    const host = element.closest('.interactive-list, .sessions-list-control')
      || element.closest('.interactive-session')?.querySelector('.interactive-list');
    const scroller = host?.querySelector('.monaco-list-rows');
    if (!scroller) return;
    nativePan = { id: event.pointerId, scroller, x: event.clientX, y: event.clientY, lastEvent: event, moving: false };
    // Initialize only Monaco's scrolling engine, not its row-focus handlers.
    // The real touchstart stays uncancelled so browser text selection still works.
    emitNativeTouch('touchstart', nativePan);
  }

  function rememberGesture(current) {
    lastGesture = { ...current, ended: performance.now() };
    clearTimeout(compatibilityClickTimer);
    compatibilityClickTimer = setTimeout(() => { lastGesture = undefined; }, 900);
  }

  function submissionStates(element) {
    const action = element?.closest('button, [role="button"]');
    const label = action?.getAttribute('aria-label') || action?.textContent || '';
    if (!/^(?:Send\b|Submit\b|Queue\b|Steer\b|Add to Queue\b)/i.test(label)) return [];
    return [...editors.values()].filter(state => !state.nativeMode && composer(state)?.contains(action));
  }

  function guardSubmission(event) {
    for (const state of submissionStates(eventElement(event))) {
      if (!state.reviewRequired) {
        if (state.composing) {
          text(state.status, 'Finish composing the text before tapping Send.');
        } else {
          try {
            const actual = readNative(state);
            if (actual !== state.lastNative) {
              if (state.input.value !== state.lastNative) {
                throw new Error('The native prompt changed while this input had unsynced text.');
              }
              state.input.value = actual;
              state.lastNative = actual;
              state.error = '';
              text(state.status, 'The native prompt changed. Review it, then tap Send again.');
            } else if (sync(state)) {
              continue;
            }
          } catch (error) {
            report(state, error);
          }
        }
        state.reviewRequired = true;
      }
      suppress(event, true);
      return true;
    }
    return false;
  }

  on(window, 'pointerdown', event => {
    if (nativeEvents.has(event)) return;
    if (nativeMomentum) { emitNativeTouch('touchstart'); nativeMomentum = false; }
    if (event.isPrimary !== false) submissionStates(eventElement(event)).forEach(state => { state.reviewRequired = false; });
    if (eventElement(event)?.closest('.tm-agents-nav button, .tm-agents-more button')) {
      suppress(event, true);
      return;
    }
    if (event.pointerType !== 'touch') return;
    if (event.isPrimary === false) {
      if (gesture) gesture.moved = true;
      finishNativePan(true);
      return;
    }
    finishNativePan(true);
    lastGesture = undefined;
    const link = chatLink(eventElement(event));
    if (link) { startNativePan(event, link); suppress(event); return; }
    const target = touchTarget(eventElement(event));
    if (!target) return;
    gesture = { ...target, id: event.pointerId, x: event.clientX, y: event.clientY, started: performance.now(), moved: false };
    startNativePan(event, target.element);
    suppress(event);
  }, { capture: true });
  on(window, 'pointermove', event => {
    const moved = gesture?.id === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 6;
    if (moved) gesture.moved = true;
    if (nativePan?.id !== event.pointerId || window.getSelection()?.toString()) return;
    nativePan.lastEvent = event;
    if (!nativePan.moving && Math.hypot(event.clientX - nativePan.x, event.clientY - nativePan.y) <= 6) return;
    nativePan.moving = true;
    if (event.isTrusted && nativePan.scroller.isConnected && !nativePan.scroller.hasPointerCapture(event.pointerId)) {
      nativePan.scroller.setPointerCapture(event.pointerId);
    }
    emitNativeTouch('touchmove', nativePan);
  }, { capture: true, passive: true });
  on(window, 'pointercancel', event => {
    if (gesture?.id === event.pointerId) {
      rememberGesture(gesture);
      gesture = undefined;
    }
    if (nativePan?.id === event.pointerId) finishNativePan(true);
  }, { capture: true });
  on(window, 'pointerup', event => {
    if (nativePan?.id === event.pointerId) finishNativePan();
    if (gesture?.id !== event.pointerId) return;
    const current = gesture;
    gesture = undefined;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 6) current.moved = true;
    rememberGesture(current);
    suppress(event);
    if (current.moved || performance.now() - current.started >= 450 || window.getSelection()?.toString()) return;
    if (!current.element.isConnected) return;
    if (current.kind === 'chevron') nativeClick(current.element);
    if (current.kind === 'request') {
      const row = current.element.closest('.interactive-request');
      if (row.classList.contains('editing') || row.classList.contains('editing-input')) return;
      if (current.element.classList.contains('clickable')) nativeClick(current.element);
      else if (!key(row, ' ', 'Space', 32).defaultPrevented) {
        const status = document.querySelector('.tm-agents-status');
        if (status) text(status, 'This message cannot be edited through the native UI.');
      }
    }
  }, { capture: true });

  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    on(window, type, event => {
      if (nativeEvents.has(event) || !initializedLayout) return;
      const changed = Array.from(event.changedTouches || []);
      const element = eventElement(event);
      const protectedTarget = element?.closest('.tm-agents-input') || touchTarget(element) || chatLink(element);
      const tracked = changed.some(touch => blockedTouches.has(touch.identifier));
      if (type === 'touchstart' && (protectedTarget || blockedTouches.size)) {
        changed.forEach(touch => blockedTouches.add(touch.identifier));
        suppress(event);
      } else if (protectedTarget || tracked) {
        suppress(event);
      }
      if (type === 'touchend' || type === 'touchcancel') {
        changed.forEach(touch => blockedTouches.delete(touch.identifier));
        if (type === 'touchcancel') finishNativePan(true);
      }
    }, { capture: true, passive: true });
  }
  for (const type of ['-monaco-gesturetap', '-monaco-gesturecontextmenu']) {
    on(window, type, event => {
      if (type === '-monaco-gesturetap' && guardSubmission(event)) return;
      const element = eventElement(event);
      if ((nativePan && element && nativePan.scroller.isSameNode(element)) || touchTarget(element) || chatLink(element)) suppress(event, true);
    }, { capture: true });
  }
  on(window, 'contextmenu', event => {
    const element = eventElement(event);
    if (element?.closest('.tm-agents-input') || touchTarget(element) || chatLink(element)) {
      if (gesture) gesture.moved = true;
      finishNativePan(true);
      suppress(event);
    }
  }, { capture: true });
  on(window, 'click', event => {
    if (nativeEvents.has(event)) return;
    const target = eventElement(event);
    const ownButton = target?.closest('.tm-agents-nav button, .tm-agents-more button');
    if (ownButton && buttonActions.has(ownButton)) {
      suppress(event, true);
      if (!ownButton.disabled) buttonActions.get(ownButton)();
      return;
    }
    const timeline = event.pointerType === 'touch'
      ? target?.closest('.prompt-timeline-gutter-row-jump')?.closest('.prompt-timeline-rail-gutter')
      : undefined;
    if (timeline) {
      // Let the native jump finish, then clear the compatibility-mouse hover
      // that otherwise keeps its popup covering the transcript after a tap.
      requestAnimationFrame(() => {
        if (!disposed && timeline.isConnected) {
          timeline.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: document.body }));
        }
      });
    }
    if (lastGesture && performance.now() - lastGesture.ended < 900 && lastGesture.element.contains(target)) {
      suppress(event, true);
      return;
    }
    if (guardSubmission(event)) return;
    if (view === 'sessions' && target?.closest('.sessions-list-control .session-item')) {
      requestAnimationFrame(() => setView('chat'));
    }
  }, { capture: true });
  for (const type of ['keydown', 'keyup', 'keypress']) {
    on(window, type, event => {
      if (nativeEvents.has(event)) return;
      const target = eventElement(event);
      if (type === 'keydown' && (event.key === 'Enter' || event.key === ' ')) {
        submissionStates(target).forEach(state => { state.reviewRequired = false; });
        if (guardSubmission(event)) return;
      }
      if (target?.closest('.tm-agents-input')) {
        suppress(event);
      } else if (event.key === 'Enter' && target?.closest('.interactive-input-editor, .sessions-chat-editor')) {
        suppress(event);
      }
    }, { capture: true });
  }

  function refresh() {
    frame = 0;
    if (disposed || !document.body) return;
    if (!style.isConnected) document.head.append(style);
    const workbench = document.querySelector('.agent-sessions-workbench');
    if (!workbench) return;
    if (observedWorkbench !== workbench) {
      workbenchObserver.disconnect();
      workbenchObserver.observe(workbench, { attributes: true, attributeFilter: ['class'] });
      observedWorkbench = workbench;
    }
    const viewport = window.visualViewport;
    const wideDesktop = !/Android/i.test(originalUserAgent) && innerWidth >= 640 &&
      ((viewport && viewport.scale < .95) || (screen.width > 0 && screen.width < 640));
    if (startupError || wideDesktop || workbench.classList.contains('phone-layout')) {
      showSetupNotice(startupError || (wideDesktop
        ? 'Turn Desktop site OFF in Firefox, then reload. Version 0.3.1 uses the real phone viewport and selects desktop-style app controls itself.'
        : 'Keep Desktop site OFF and reload after enabling the script. The page loaded its phone renderer before the script could select desktop-style controls.'));
      return;
    }
    notice?.remove();
    notice = undefined;
    if (nav) nav.hidden = false;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && meta !== viewportMeta) {
      viewportMeta = meta;
      originalViewport = meta.getAttribute('content');
      meta.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content');
    }
    const height = viewport && Math.abs(viewport.scale - 1) < .05 ? viewport.height : innerHeight;
    const rootStyle = document.documentElement.style;
    if (rootStyle.getPropertyValue('--tm-agents-height') !== `${height}px`) rootStyle.setProperty('--tm-agents-height', `${height}px`);
    const touchAction = viewport && viewport.scale > 1.05 ? 'auto' : 'pinch-zoom';
    if (rootStyle.getPropertyValue('--tm-agents-transcript-touch-action') !== touchAction) rootStyle.setProperty('--tm-agents-transcript-touch-action', touchAction);
    if (!document.documentElement.classList.contains('tm-agents-mobile')) document.documentElement.classList.add('tm-agents-mobile');
    createNavigation();
    if (!initializedLayout) {
      initializedLayout = true;
      setView('chat');
    }
    stretchPaneContents();
    for (const [editor, state] of editors) {
      if (!editor.isConnected) {
        state.observer?.disconnect();
        cancelAnimationFrame(state.nativeFrame);
        state.editor.removeAttribute('data-tm-agents-native');
        state.host.classList.remove('tm-agents-editor-host');
        state.input.remove();
        state.status.remove();
        editors.delete(editor);
      } else {
        const visible = isLaidOut(editor);
        if (visible && !state.visible) {
          if (state.pendingSync) sync(state);
          else refreshNative(state);
        }
        state.visible = visible;
      }
    }
    document.querySelectorAll(editorSelector).forEach(attachEditor);
    const focusedEditor = [...editors.values()].find(state =>
      state.input === document.activeElement || state.editor.contains(document.activeElement));
    if (focusedEditor) activeEditor = focusedEditor;
    const keyboardOpen = viewport && Math.abs(viewport.scale - 1) < .05 && height < innerHeight - 80;
    const nextDocked = keyboardOpen && activeEditor?.editor.isConnected ? composer(activeEditor) : undefined;
    if (nextDocked !== dockedComposer) {
      dockedComposer?.removeAttribute('data-tm-agents-docked');
      dockedComposer = nextDocked;
      dockedComposer?.setAttribute('data-tm-agents-docked', '');
    }
  }

  function scheduleRefresh() {
    if (!frame && !disposed) frame = requestAnimationFrame(refresh);
  }

  function needsLayoutRefresh(records) {
    const hosts = '.interactive-input-editor, .sessions-chat-editor';
    const structure = '.agent-sessions-workbench, .part.sidebar, .part.editor, .part.sessionspart, .part.panel, .interactive-input-editor, .sessions-chat-editor';
    for (const record of records) {
      const parent = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType !== 1) continue;
        if (node.matches(structure) || node.querySelector(structure)) return true;
        if (node.matches('.monaco-editor') && (editors.has(node) || parent?.closest(hosts))) return true;
        if (parent?.closest('.part.sidebar, .part.editor') &&
            (node.matches('.sessions-list-control, [role="tree"], .part.auxiliarybar') ||
             node.querySelector('.sessions-list-control, [role="tree"], .part.auxiliarybar'))) return true;
      }
    }
    return false;
  }

  const observer = new MutationObserver(records => {
    if (needsLayoutRefresh(records)) scheduleRefresh();
  });
  const workbenchObserver = new MutationObserver(scheduleRefresh);
  observer.observe(document, { subtree: true, childList: true });
  on(document, 'DOMContentLoaded', scheduleRefresh);
  on(window, 'resize', scheduleRefresh);
  on(window.visualViewport || window, 'resize', scheduleRefresh);
  window[instanceKey] = {
    dispose() {
      finishNativePan(true);
      if (nativeMomentum) emitNativeTouch('touchstart');
      disposed = true;
      controller.abort();
      observer.disconnect();
      workbenchObserver.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(compatibilityClickTimer);
      blockedTouches.clear();
      for (const state of editors.values()) {
        state.observer?.disconnect();
        cancelAnimationFrame(state.nativeFrame);
        state.editor.removeAttribute('data-tm-agents-native');
        state.host.classList.remove('tm-agents-editor-host');
        state.input.remove();
        state.status.remove();
      }
      nav?.remove();
      notice?.remove();
      document.querySelector('.tm-agents-more')?.remove();
      style.remove();
      for (const element of widthOverrides) element.removeAttribute('data-tm-agents-fill-width');
      widthOverrides.clear();
      dockedComposer?.removeAttribute('data-tm-agents-docked');
      if (viewportMeta?.isConnected) {
        if (originalViewport === null) viewportMeta.removeAttribute('content');
        else viewportMeta.setAttribute('content', originalViewport);
      }
      document.documentElement.style.removeProperty('--tm-agents-height');
      document.documentElement.style.removeProperty('--tm-agents-transcript-touch-action');
      document.documentElement.classList.remove('tm-agents-mobile');
      delete document.documentElement.dataset.tmAgentsView;
      if (presentationUserAgent && Object.getOwnPropertyDescriptor(pageNavigator, 'userAgent')?.get === presentationUserAgent) {
        if (originalUserAgentDescriptor) Object.defineProperty(pageNavigator, 'userAgent', originalUserAgentDescriptor);
        else delete pageNavigator.userAgent;
      }
      delete window[instanceKey];
    },
  };
  scheduleRefresh();
})();
