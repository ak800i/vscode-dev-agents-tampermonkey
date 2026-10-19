// ==UserScript==
// @name         VS Code Agents - Mobile Input and Controls
// @namespace    local.vscode-agents-mobile
// @version      0.1.0
// @description  Phone-sized desktop layout, native model settings, selectable input, and touch fixes.
// @match        https://vscode.dev/agents*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  if (location.pathname !== '/agents' && !location.pathname.startsWith('/agents/')) return;
  if (!matchMedia('(pointer: coarse)').matches && !/Android/i.test(navigator.userAgent)) return;

  const instanceKey = '__vscodeAgentsMobile';
  window[instanceKey]?.dispose();
  const controller = new AbortController();
  const editors = new Map();
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
    .tm-agents-nav button, .tm-agents-settings button, .tm-agents-more button {
      min-height: 44px; padding: 6px 10px; border: 1px solid var(--vscode-panel-border, #555);
      border-radius: 6px; background: var(--vscode-button-secondaryBackground, #333);
      color: var(--vscode-button-secondaryForeground, #eee); font: 14px system-ui;
      cursor: pointer; touch-action: manipulation;
    }
    .tm-agents-nav button { flex: 1; border-radius: 0; border: 0; }
    .tm-agents-nav button[aria-pressed="true"] { box-shadow: inset 0 -3px var(--vscode-focusBorder, #168bce); }
    .tm-agents-nav button:focus-visible, .tm-agents-settings button:focus-visible {
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
    html.tm-agents-mobile .sessions-list-control,
    html.tm-agents-mobile .sessions-list-control > .monaco-list { width: 100% !important; }
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
    html.tm-agents-mobile [data-tm-agents-docked] {
      position: fixed !important; top: auto !important;
      bottom: max(0px, calc(100dvh - var(--tm-agents-height, 100dvh))) !important;
      left: 8px !important; width: calc(100vw - 16px) !important; height: auto !important;
      max-height: calc(var(--tm-agents-height, 100dvh) - 52px); overflow-y: auto;
      margin: 0 !important; box-sizing: border-box !important; z-index: 900;
      background: var(--vscode-editor-background, #191a1b);
    }
    .tm-agents-settings { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0; }
    .tm-agents-settings button { flex: 1 1 auto; }
    .tm-agents-settings button:disabled { opacity: .65; cursor: default; }
    .tm-agents-status { color: var(--vscode-errorForeground, #ff8a8a); white-space: normal; padding: 4px; font: 13px/1.4 system-ui; }
    .tm-agents-status:empty { display: none; }
    #tm-agents-setup { position: fixed; z-index: 4000; inset: auto 8px 8px; padding: 12px; background: #322400; color: #fff; }
    html.tm-agents-mobile .interactive-request .rendered-markdown,
    html.tm-agents-mobile .interactive-response .rendered-markdown {
      -webkit-user-select: text !important; user-select: text !important; -webkit-touch-callout: default;
    }
    html.tm-agents-mobile .chat-model-picker-model .action-list-item-toolbar { visibility: visible !important; }
    html.tm-agents-mobile .context-view { max-width: calc(100vw - 8px); z-index: 3000 !important; }
    html.tm-agents-mobile .tabbed-action-list-details { max-width: calc(100vw - 24px); }
    html.tm-agents-mobile .tabbed-action-list-details button,
    html.tm-agents-mobile .tabbed-action-list-details [role="radio"] { min-height: 36px; }
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
        // Paste providers can finish asynchronously and overwrite a newer draft.
        input.editContext.dispatchEvent(new TextUpdateEvent('textupdate', {
          updateRangeStart: 0, updateRangeEnd: input.editContext.text.length, text: value,
          selectionStart: value.length, selectionEnd: value.length,
        }));
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
    try {
      if (state.input.value !== state.lastNative || state.error) writeNative(state, state.input.value);
      state.lastNative = state.input.value;
      state.error = '';
      text(state.status, '');
      return true;
    } catch (error) {
      report(state, error);
      return false;
    }
  }

  function refreshNative(state) {
    if (!state.editor.isConnected || state.syncing || state.composing || state.error || state.nativeMode) return;
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

  function modelButtons(state) {
    const root = composer(state);
    return {
      model: root?.querySelector('.model-picker-name[role="button"], .model-picker-name'),
      details: root?.querySelector('.model-picker-config-summary, .model-picker-config[role="button"]'),
    };
  }

  function openModelSettings(state, details) {
    const controls = modelButtons(state);
    const target = details ? controls.details : controls.model;
    if (!target || target.getAttribute('aria-disabled') === 'true' || target.disabled) {
      text(state.status, 'Model settings are unavailable here. Enable Desktop site in Firefox and reload.');
      return;
    }
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window });
    nativeEvents.add(event);
    target.dispatchEvent(event);
  }

  function updateModelSettings(state) {
    const { model, details } = modelButtons(state);
    const label = details?.getAttribute('aria-label') || '';
    const automatic = /^Auto\b/i.test(label);
    const effort = label.match(/(?:Thinking (?:Level|Effort)|Reasoning (?:Level|Effort)|Effort):\s*([^,]+)/i)?.[1];
    const context = label.match(/(?:Context Size|Context Window|Max context):\s*([^,]+)/i)?.[1];
    const name = model?.getAttribute('aria-label')?.replace(/^Models,\s*/i, '') || 'Choose model';
    text(state.model, name);
    text(state.effort, `Effort: ${effort || (automatic ? 'Automatic' : 'Not exposed')}`);
    text(state.context, `Context: ${context || (automatic ? 'Automatic' : 'Not exposed')}`);
    state.model.disabled = !model;
    state.effort.disabled = !details;
    state.context.disabled = !details;
  }

  function attachEditor(editor) {
    if (editors.has(editor) || !editor.querySelector('.native-edit-context, textarea.inputarea')) return;
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
    const settings = document.createElement('div');
    settings.className = 'tm-agents-settings';
    const state = { editor, host, input, status, settings, lastNative: '', error: '', composing: false, syncing: false, nativeMode: false };
    state.model = button('Choose model', () => openModelSettings(state, false));
    state.effort = button('Effort: Not exposed', () => openModelSettings(state, true));
    state.context = button('Context: Not exposed', () => openModelSettings(state, true));
    state.toggle = button('Native editor', () => {
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
      input.hidden = state.nativeMode;
      editor.toggleAttribute('data-tm-agents-native', !state.nativeMode);
      host.classList.toggle('tm-agents-editor-host', !state.nativeMode);
      text(state.toggle, state.nativeMode ? 'Touch editor' : 'Native editor');
      if (state.nativeMode) {
        const native = nativeInput(state);
        native.focus({ preventScroll: true });
        key(native, 'ArrowRight', 'ArrowRight', 39);
      }
      else input.focus({ preventScroll: true });
      window.dispatchEvent(new Event('resize'));
    });
    settings.append(state.model, state.effort, state.context, state.toggle);
    host.append(input);
    host.after(settings, status);
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
      text(state.toggle, 'Touch editor');
      text(state.status, `Touch editor unavailable: ${state.error} The native editor remains enabled.`);
    }
    on(input, 'input', event => { if (!event.isComposing) sync(state); });
    on(input, 'focus', () => { activeEditor = state; scheduleRefresh(); });
    on(input, 'compositionstart', () => { state.composing = true; });
    on(input, 'compositionend', () => { state.composing = false; sync(state); });
    on(editor, 'focusin', () => {
      if (!state.syncing) { activeEditor = state; scheduleRefresh(); }
      if (!state.syncing && !state.nativeMode) input.focus({ preventScroll: true });
    });
    state.observer = new MutationObserver(records => {
      if (records.some(record => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('.view-lines'))) {
        cancelAnimationFrame(state.nativeFrame);
        state.nativeFrame = requestAnimationFrame(() => refreshNative(state));
      }
    });
    state.observer.observe(editor, { childList: true, subtree: true, characterData: true });
    updateModelSettings(state);
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

  function eventElement(event) {
    const target = event.initialTarget || event.target;
    return target instanceof Element ? target : target?.parentElement;
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
    if (event.isPrimary !== false) submissionStates(eventElement(event)).forEach(state => { state.reviewRequired = false; });
    if (eventElement(event)?.closest('.tm-agents-nav button, .tm-agents-settings button, .tm-agents-more button')) {
      suppress(event, true);
      return;
    }
    if (event.pointerType !== 'touch') return;
    if (event.isPrimary === false) {
      if (gesture) gesture.moved = true;
      return;
    }
    if (chatLink(eventElement(event))) { suppress(event); return; }
    const target = touchTarget(eventElement(event));
    if (!target) return;
    gesture = { ...target, id: event.pointerId, x: event.clientX, y: event.clientY, started: performance.now(), moved: false };
    suppress(event);
  }, { capture: true });
  on(window, 'pointermove', event => {
    if (gesture?.id === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) gesture.moved = true;
  }, { capture: true, passive: true });
  on(window, 'pointercancel', event => {
    if (gesture?.id === event.pointerId) {
      lastGesture = { ...gesture, ended: performance.now() };
      gesture = undefined;
    }
  }, { capture: true });
  on(window, 'pointerup', event => {
    if (gesture?.id !== event.pointerId) return;
    const current = gesture;
    gesture = undefined;
    lastGesture = { ...current, ended: performance.now() };
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

  for (const type of ['touchstart', 'touchend', '-monaco-gesturetap']) {
    on(window, type, event => {
      if (type === '-monaco-gesturetap' && guardSubmission(event)) return;
      if (touchTarget(eventElement(event)) || chatLink(eventElement(event))) suppress(event, type === '-monaco-gesturetap');
    }, { capture: true, passive: type !== '-monaco-gesturetap' });
  }
  on(window, 'contextmenu', event => {
    const element = eventElement(event);
    if (element?.closest('.tm-agents-input') || touchTarget(element) || chatLink(element)) {
      if (gesture) gesture.moved = true;
      suppress(event);
    }
  }, { capture: true });
  on(window, 'click', event => {
    if (nativeEvents.has(event)) return;
    const target = eventElement(event);
    const ownButton = target?.closest('.tm-agents-nav button, .tm-agents-settings button, .tm-agents-more button');
    if (ownButton && buttonActions.has(ownButton)) {
      suppress(event, true);
      if (!ownButton.disabled) buttonActions.get(ownButton)();
      return;
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
    if (workbench.classList.contains('phone-layout')) {
      if (!notice) {
        notice = document.createElement('div');
        notice.id = 'tm-agents-setup';
        notice.setAttribute('role', 'status');
        notice.textContent = 'Enable Desktop site in Firefox, then reload. The native phone UI omits the effort and context controls.';
        document.body.append(notice);
      }
      return;
    }
    notice?.remove();
    notice = undefined;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && meta !== viewportMeta) {
      viewportMeta = meta;
      originalViewport = meta.getAttribute('content');
      meta.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content');
    }
    const viewport = window.visualViewport;
    const height = viewport && Math.abs(viewport.scale - 1) < .05 ? viewport.height : innerHeight;
    document.documentElement.style.setProperty('--tm-agents-height', `${height}px`);
    document.documentElement.classList.add('tm-agents-mobile');
    createNavigation();
    if (!initializedLayout) {
      initializedLayout = true;
      setView('chat');
    }
    for (const [editor, state] of editors) {
      if (!editor.isConnected) {
        state.observer?.disconnect();
        cancelAnimationFrame(state.nativeFrame);
        state.input.remove();
        state.settings.remove();
        state.status.remove();
        editors.delete(editor);
      }
    }
    document.querySelectorAll(editorSelector).forEach(attachEditor);
    editors.forEach(updateModelSettings);
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

  const observer = new MutationObserver(scheduleRefresh);
  const workbenchObserver = new MutationObserver(scheduleRefresh);
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'aria-disabled'] });
  on(document, 'DOMContentLoaded', scheduleRefresh);
  on(window, 'resize', scheduleRefresh);
  on(window.visualViewport || window, 'resize', scheduleRefresh);
  window[instanceKey] = {
    dispose() {
      disposed = true;
      controller.abort();
      observer.disconnect();
      workbenchObserver.disconnect();
      cancelAnimationFrame(frame);
      for (const state of editors.values()) {
        state.observer?.disconnect();
        cancelAnimationFrame(state.nativeFrame);
        state.editor.removeAttribute('data-tm-agents-native');
        state.host.classList.remove('tm-agents-editor-host');
        state.input.remove();
        state.settings.remove();
        state.status.remove();
      }
      nav?.remove();
      notice?.remove();
      document.querySelector('.tm-agents-more')?.remove();
      style.remove();
      dockedComposer?.removeAttribute('data-tm-agents-docked');
      if (viewportMeta?.isConnected) {
        if (originalViewport === null) viewportMeta.removeAttribute('content');
        else viewportMeta.setAttribute('content', originalViewport);
      }
      document.documentElement.style.removeProperty('--tm-agents-height');
      document.documentElement.classList.remove('tm-agents-mobile');
      delete document.documentElement.dataset.tmAgentsView;
      delete window[instanceKey];
    },
  };
  scheduleRefresh();
})();
