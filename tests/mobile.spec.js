const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'vscode-agents-mobile.user.js');
const androidFirefoxUA = 'Mozilla/5.0 (Android 15; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0';
const desktopFirefoxUA = 'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0';

function initializeFixture({ mobile, wideDesktop, lockUserAgent }) {
  const original = window.matchMedia.bind(window);
  window.matchMedia = query => {
    const result = original(query);
    if (/pointer:\s*coarse/.test(query)) Object.defineProperty(result, 'matches', { value: mobile });
    return result;
  };
  if (lockUserAgent) {
    Object.defineProperty(navigator, 'userAgent', { value: navigator.userAgent, configurable: false });
  }
  if (wideDesktop) {
    new MutationObserver(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      if (meta && meta.content !== 'width=980') meta.content = 'width=980';
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['content'] });
  }
}

async function openFixture(page, context, { mobile = true, phoneLayout = false, wideDesktop = false, lockUserAgent = false } = {}) {
  let script = '';
  try {
    script = await fs.readFile(scriptPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await page.addInitScript({
    content: `(${initializeFixture.toString()})(${JSON.stringify({ mobile, wideDesktop, lockUserAgent })});\n${script}`,
  });
  await page.goto(`http://127.0.0.1:31137/agents${wideDesktop ? '?desktopViewport=980' : ''}`);
  await page.waitForFunction(() => window.fixture?.ready || window.fixtureError);
  expect(await page.evaluate(() => window.fixtureError)).toBeUndefined();
  if (phoneLayout) {
    await page.evaluate(() => document.querySelector('.monaco-workbench').classList.add('phone-layout'));
  }
}

test.beforeEach(async ({ page, context }) => {
  await openFixture(page, context);
});

async function chooseEditor(page, label) {
  await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

test('provides a native selectable textarea, without accessing Monaco globals', async ({ page }) => {
  const input = page.locator('.tm-agents-input');
  await expect(input).toHaveCount(1);
  await expect(page.locator('.tm-agents-status')).toHaveText('');
  await input.fill('First line\nSecond line \u{1F600}');
  await expect.poll(() => page.evaluate(() => fixture.text())).toBe('First line\nSecond line \u{1F600}');
  await input.evaluate(element => element.setSelectionRange(6, 10));
  await page.keyboard.insertText('paragraph');
  await expect(input).toHaveValue('First paragraph\nSecond line \u{1F600}');
  await expect.poll(() => page.evaluate(() => fixture.text())).toBe('First paragraph\nSecond line \u{1F600}');
});

test('Enter, Shift+Enter, and Ctrl+Enter never send from the mobile input', async ({ page }) => {
  const input = page.locator('.tm-agents-input');
  await input.fill('one');
  await input.press('Enter');
  await page.keyboard.insertText('two');
  await input.press('Shift+Enter');
  await page.keyboard.insertText('three');
  await input.press('Control+Enter');
  await expect(input).toHaveValue('one\ntwo\nthree');
  await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
  await expect.poll(() => page.evaluate(() => fixture.text())).toBe('one\ntwo\nthree');
});

test('only an explicit Send sends once and native clearing reaches the textarea', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Explicit send only');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => fixture.sends)).toEqual(['Explicit send only']);
  await expect(page.locator('.tm-agents-input')).toHaveValue('');
});

test('retains an existing multiline draft and tracks external native changes', async ({ page }) => {
  await page.evaluate(() => fixture.setText('Existing\nmultiline\nprompt'));
  await expect(page.locator('.tm-agents-input')).toHaveValue('Existing\nmultiline\nprompt');
  await page.evaluate(() => fixture.setText(''));
  await expect(page.locator('.tm-agents-input')).toHaveValue('');
});

test('native-editor handoff preserves the draft and does not steal native focus', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Keep this draft');
  await chooseEditor(page, 'Native editor');
  await page.keyboard.insertText(' plus native text');
  await expect.poll(() => page.evaluate(() => fixture.text())).toBe('Keep this draft plus native text');
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('inputarea'))).toBe(true);
  await chooseEditor(page, 'Touch editor');
  await expect(page.locator('.tm-agents-input')).toHaveValue('Keep this draft plus native text');
});

test('empty replacement, Unicode, and replacing a selection round trip', async ({ page }) => {
  const input = page.locator('.tm-agents-input');
  for (const value of ['hello\nworld', '', 'caf\u00e9 \u{1F600}\n\u6d4b\u8bd5', 'final\n']) {
    await input.fill(value);
    await expect.poll(() => page.evaluate(() => fixture.text())).toBe(value);
  }
});

test('IME composition is not mirrored or sent until composition finishes', async ({ page }) => {
  const input = page.locator('.tm-agents-input');
  await input.fill('before');
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.value = 'before\u6d4b';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => fixture.text())).toBe('before');
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await expect.poll(() => page.evaluate(() => fixture.text())).toBe('before\u6d4b');
  await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
});

test('only native model controls remain and their settings still work', async ({ page }) => {
  await expect(page.locator('.tm-agents-settings')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Models, Example Model', exact: true })).toBeVisible();
  const details = page.locator('.model-picker-config-summary');
  await expect(details).toBeVisible();
  await details.click();
  expect(await page.evaluate(() => window.fixtureError)).toBeUndefined();
  await expect.poll(() => page.evaluate(() => fixture.detailsOpens)).toBe(1);
  await page.getByRole('button', { name: 'Low', exact: true }).click();
  await page.getByRole('button', { name: '1M', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(details).toHaveText('Low - 1M');
  await expect(details).toHaveAttribute('aria-label', /Thinking Level: Low, Context Size: 1M/);
  await expect.poll(() => page.evaluate(() => fixture.detailsOpens)).toBe(1);
});

test('model changes do not create mirrored model controls', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('.model-picker-name').setAttribute('aria-label', 'Models, Auto');
    document.querySelector('.model-picker-config').setAttribute('aria-label', 'Auto details, Optimize for: Balance');
  });
  await expect(page.locator('.tm-agents-settings')).toHaveCount(0);
  await expect(page.locator('.model-picker-config-summary')).toBeVisible();
  await expect(page.locator('.model-picker-config-summary')).toHaveAttribute('aria-label', 'Auto details, Optimize for: Balance');
});

test('native model-detail options have readable text and touch-sized targets', async ({ page }) => {
  await page.locator('.model-picker-config-summary').click();
  const metrics = await page.getByRole('button', { name: 'Low', exact: true }).evaluate(e => ({
    font: parseFloat(getComputedStyle(e).fontSize),
    height: e.getBoundingClientRect().height,
  }));
  expect(metrics.font).toBeGreaterThanOrEqual(16);
  expect(metrics.height).toBeGreaterThanOrEqual(44);
});

test('touching the parent chevron toggles only once and does not open a session', async ({ page }) => {
  await page.locator('.session-chat-twistie').evaluate(element => {
    const event = (name, extra = {}) => element.dispatchEvent(new PointerEvent(name, {
      bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 1, isPrimary: true,
      clientX: 20, clientY: 120, ...extra,
    }));
    event('pointerdown');
    element.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    event('pointerup');
    element.dispatchEvent(new Event('-monaco-gesturetap', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
  await expect(page.locator('[role="treeitem"][aria-label="Parent session"]')).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => page.evaluate(() => fixture.openedSessions)).toBe(0);
});

test('touch selects a host in a native shadow menu instead of reopening the picker', async ({ page }) => {
  await page.evaluate(() => fixture.mountHostPicker());
  await page.getByRole('button', { name: 'Sessions', exact: true }).tap();
  await page.getByRole('button', { name: 'Change host', exact: true }).tap();
  await page.getByRole('menuitem', { name: 'Host 1', exact: true }).tap();
  await expect.poll(() => page.evaluate(() => fixture.hostSelections)).toEqual([1]);
  await expect(page.locator('.context-view-block')).toHaveCount(0);
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await expect(page.locator('.agent-host-filter-label')).toHaveText('Host 1');
  expect(await page.evaluate(() => fixture.openedSessions)).toBe(0);
  expect(await page.evaluate(() => fixture.hostMenuOpens)).toBe(1);
  await page.getByRole('button', { name: 'Change host', exact: true }).tap();
  await page.getByRole('menuitem', { name: 'Host 0', exact: true }).tap();
  await expect.poll(() => page.evaluate(() => fixture.hostSelections)).toEqual([1, 0]);
  await expect(page.locator('.context-view-block')).toHaveCount(0);
  expect(await page.evaluate(() => fixture.openedSessions)).toBe(0);
  await expect(page.locator('html')).toHaveAttribute('data-tm-agents-view', 'sessions');
  await page.getByRole('button', { name: 'Change host', exact: true }).tap();
  await page.getByRole('menuitem', { name: 'Unavailable host', exact: true }).dispatchEvent('pointerdown', {
    pointerType: 'touch', pointerId: 42, isPrimary: true,
  });
  await page.getByRole('menuitem', { name: 'Unavailable host', exact: true }).dispatchEvent('pointerup', {
    pointerType: 'touch', pointerId: 42, isPrimary: true,
  });
  expect(await page.evaluate(() => fixture.hostSelections)).toEqual([1, 0]);
  await expect(page.locator('html')).toHaveAttribute('data-tm-agents-view', 'sessions');
});

test('tapping the native host menu backdrop dismisses it without reopening or selecting', async ({ page }) => {
  await page.evaluate(() => fixture.mountHostPicker());
  await page.getByRole('button', { name: 'Sessions', exact: true }).tap();
  await page.getByRole('button', { name: 'Change host', exact: true }).tap();
  await page.locator('.context-view-block').tap({ position: { x: 350, y: 420 } });
  await expect(page.locator('.context-view-block')).toHaveCount(0);
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  expect(await page.evaluate(() => fixture.hostSelections)).toEqual([]);
  expect(await page.evaluate(() => fixture.hostMenuOpens)).toBe(1);
});

test('host menu mouse and keyboard selection stay native', async ({ page }) => {
  await page.evaluate(() => fixture.mountHostPicker());
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Change host', exact: true }).click();
  // Monaco intentionally delays menu mouse-up activation for 100ms after opening.
  await page.waitForTimeout(150);
  await page.getByRole('menuitem', { name: 'Host 1', exact: true }).click();
  await expect.poll(() => page.evaluate(() => fixture.hostSelections)).toEqual([1]);
  await expect(page.locator('.context-view-block')).toHaveCount(0);
  await page.getByRole('button', { name: 'Change host', exact: true }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => fixture.hostSelections)).toEqual([1, 0]);
});

test('persistent connection toasts leave the footer host picker reachable', async ({ page }) => {
  await page.evaluate(() => {
    fixture.mountHostPicker(2, { footer: true });
    fixture.showConnectionToasts();
  });
  await page.getByRole('button', { name: 'Sessions', exact: true }).tap();
  const picker = page.getByRole('button', { name: 'Change host', exact: true });
  expect(await picker.evaluate(element => {
    const r = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'unavailable-host-0' })).toBeVisible();
  await picker.tap();
  await page.getByRole('menuitem', { name: 'Host 1', exact: true }).tap();
  await expect.poll(() => page.evaluate(() => fixture.hostSelections)).toEqual([1]);
  await expect(page.locator('.context-view-block')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connection details 0', exact: true }).tap();
  expect(await page.evaluate(() => fixture.notificationActions)).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'unavailable-host-0' })).toBeVisible();
});

test('stacked toasts stay between the navigation and host footer on small viewports', async ({ page }) => {
  for (const height of [644, 844]) {
    await page.setViewportSize({ width: 390, height });
    await page.evaluate(() => {
      fixture.mountHostPicker(2, { footer: true });
      fixture.showConnectionToasts(12, 'top-right');
    });
    await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Sessions', exact: true }).tap();
    const metrics = await page.locator('.notifications-toasts').evaluate(element => {
      const r = element.getBoundingClientRect();
      const picker = document.querySelector('.agent-host-filter-button');
      const p = picker.getBoundingClientRect();
      return {
        top: r.top, bottom: r.bottom, pickerTop: p.top,
        scrollable: element.scrollHeight > element.clientHeight,
        hit: picker.contains(document.elementFromPoint(p.x + p.width / 2, p.y + p.height / 2)),
      };
    });
    expect(metrics.top).toBeGreaterThanOrEqual(44);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.pickerTop - 4);
    expect(metrics.scrollable).toBe(true);
    expect(metrics.hit).toBe(true);
    await page.getByRole('button', { name: 'Connection details 11', exact: true }).tap();
    expect(await page.evaluate(() => fixture.notificationActions)).toBe(1);
    await page.getByRole('button', { name: 'Change host', exact: true }).tap();
    await page.getByRole('menuitem', { name: 'Host 1', exact: true }).tap();
    await expect.poll(() => page.evaluate(() => fixture.hostSelections)).toEqual([1]);
    await page.evaluate(() => {
      document.querySelector('.notifications-toasts').remove();
      document.querySelector('.agent-host-filter-button').remove();
    });
  }
});

test('toast recovery placement is limited to Sessions and is removed on disposal', async ({ page }) => {
  await page.evaluate(() => fixture.showConnectionToasts());
  const toasts = page.locator('.notifications-toasts');
  expect(await toasts.evaluate(e => getComputedStyle(e).bottom)).toBe('4px');
  const nav = page.getByRole('navigation', { name: 'Mobile workspace' });
  await nav.getByRole('button', { name: 'Sessions', exact: true }).tap();
  expect(parseFloat(await toasts.evaluate(e => getComputedStyle(e).bottom))).toBeGreaterThanOrEqual(56);
  await nav.getByRole('button', { name: 'Chat', exact: true }).tap();
  expect(await toasts.evaluate(e => getComputedStyle(e).bottom)).toBe('4px');
  await nav.getByRole('button', { name: 'Sessions', exact: true }).tap();
  await page.evaluate(() => window.__vscodeAgentsMobile.dispose());
  expect(await toasts.evaluate(e => getComputedStyle(e).bottom)).toBe('4px');
  await expect(page.getByRole('button', { name: 'Connection details 0', exact: true })).toBeVisible();
});

test('selected page text does not block a host menu tap', async ({ page }) => {
  await page.evaluate(() => fixture.mountHostPicker());
  await page.getByRole('button', { name: 'Sessions', exact: true }).tap();
  await page.getByRole('button', { name: 'Change host', exact: true }).tap();
  await page.locator('.session-title').evaluate(e => {
    const range = document.createRange();
    range.selectNodeContents(e);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
  await page.getByRole('menuitem', { name: 'Host 1', exact: true }).tap();
  await expect.poll(() => page.evaluate(() => fixture.hostSelections)).toEqual([1]);
});

test('dragging or cancelling a host menu touch never selects a PC', async ({ page }) => {
  await page.evaluate(() => fixture.mountHostPicker(60));
  await page.getByRole('button', { name: 'Sessions', exact: true }).tap();
  await page.getByRole('button', { name: 'Change host', exact: true }).tap();
  const result = await page.getByRole('menuitem', { name: 'Host 1', exact: true }).evaluate(async element => {
    const emit = (type, y) => element.dispatchEvent(new PointerEvent(type, {
      composed: true, bubbles: true, cancelable: true, pointerType: 'touch',
      pointerId: 51, isPrimary: true, clientX: 80, clientY: y,
    }));
    emit('pointerdown', 210);
    emit('pointercancel', 210);
    emit('pointerup', 210);
    element.dispatchEvent(new MouseEvent('click', { composed: true, bubbles: true, cancelable: true, detail: 1 }));
    const menu = element.closest('.monaco-menu');
    emit('pointerdown', 210);
    for (let y = 190; y >= 70; y -= 20) {
      await new Promise(requestAnimationFrame);
      emit('pointermove', y);
    }
    emit('pointerup', 70);
    return { selections: fixture.hostSelections, scrollTop: menu.scrollTop };
  });
  expect(result.selections).toEqual([]);
  expect(result.scrollTop).toBeGreaterThan(60);
  await page.getByRole('menuitem', { name: 'Host 12', exact: true }).tap();
  await expect.poll(() => page.evaluate(() => fixture.hostSelections)).toEqual([12]);
});

test('real touch swipes in a host menu scroll without selecting or clicking through', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Trusted touch movement uses Chromium CDP.');
  await page.evaluate(() => fixture.mountHostPicker(60));
  await page.getByRole('button', { name: 'Sessions', exact: true }).tap();
  await page.getByRole('button', { name: 'Change host', exact: true }).tap();
  const point = await page.getByRole('menuitem', { name: 'Host 8', exact: true }).evaluate(e => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...point }] });
    for (let i = 1; i <= 5; i++) {
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ id: 0, x: point.x, y: point.y - i * 28 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.locator('.monaco-menu').evaluate(e => e.scrollTop)).toBeGreaterThan(90);
    expect(await page.evaluate(() => fixture.hostSelections)).toEqual([]);
    expect(await page.evaluate(() => fixture.openedSessions)).toBe(0);
    await expect(page.locator('html')).toHaveAttribute('data-tm-agents-view', 'sessions');
  } finally {
    await cdp.detach();
  }
});

test('a gesture cancelled while scrolling does not collapse or edit anything', async ({ page }) => {
  await page.locator('.interactive-request p').evaluate(element => {
    for (const [type, y] of [['pointerdown', 100], ['pointermove', 150], ['pointerup', 150]]) {
      element.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 2, isPrimary: true, clientX: 50, clientY: y,
      }));
    }
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
  await expect.poll(() => page.evaluate(() => fixture.edits)).toBe(0);
});

test('a short tap opens the native sent-message editor without sending', async ({ page }) => {
  await page.locator('.interactive-request p').evaluate(element => {
    for (const type of ['pointerdown', 'pointerup']) {
      element.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 3, isPrimary: true, clientX: 50, clientY: 100,
      }));
    }
    element.dispatchEvent(new Event('-monaco-gesturetap', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
  await expect.poll(() => page.evaluate(() => fixture.edits)).toBe(1);
  await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
});

test('keyboard-only native message editing does not synthesize Enter', async ({ page }) => {
  await page.locator('.interactive-request .rendered-markdown').evaluate(element => {
    element.classList.remove('clickable');
    for (const type of ['pointerdown', 'pointerup']) {
      element.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 12, isPrimary: true, clientX: 50, clientY: 100,
      }));
    }
  });
  await expect.poll(() => page.evaluate(() => fixture.editKeys)).toEqual([' ']);
  await expect.poll(() => page.evaluate(() => fixture.edits)).toBe(1);
  await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
});

test('links and text selections do not enter message editing', async ({ page }) => {
  await page.locator('.interactive-request a').click();
  await expect.poll(() => page.evaluate(() => fixture.edits)).toBe(0);
  await page.locator('.interactive-request p').evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 4 }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 4 }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => page.evaluate(() => fixture.edits)).toBe(0);
});

test('long press retains the browser context action and blocks the app dropdown', async ({ page }) => {
  const result = await page.locator('.interactive-response p').evaluate(element => {
    element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerType: 'touch', pointerId: 5, isPrimary: true, clientX: 50, clientY: 100,
    }));
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, menus: fixture.menus };
  });
  expect(result).toEqual({ defaultPrevented: false, menus: 0 });
});

test('rerendering the same composer does not duplicate the textarea or controls', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Keep this draft');
  await page.evaluate(() => {
    for (let i = 0; i < 15; i++) document.querySelector('.model-picker-config').setAttribute('title', String(i));
  });
  await expect(page.locator('.tm-agents-input')).toHaveCount(1);
  await expect(page.locator('.tm-agents-settings')).toHaveCount(0);
  await expect(page.locator('.model-picker-config-summary')).toHaveCount(1);
  await expect(page.locator('.tm-agents-input')).toHaveValue('Keep this draft');
});

test('Monaco focus rerenders do not move the input or model controls', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Stable layout');
  const heights = await page.evaluate(async () => {
    const values = [];
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      values.push(document.querySelector('.interactive-input-editor').getBoundingClientRect().height);
    }
    return values;
  });
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
});

test('EditContext input uses native CRLF offsets without corrupting Unicode', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'EditContext is a Chromium-specific input path.');
  await page.evaluate(() => fixture.editor.updateOptions({ editContext: true }));
  await expect(page.locator('.native-edit-context')).toHaveCount(1);
  const input = page.locator('.tm-agents-input');
  for (const value of ['one\ntwo \u{1F600}', 'short\n', 'caf\u00e9\n\u6d4b\u8bd5', '']) {
    await input.fill(value);
    await expect.poll(() => page.evaluate(() => fixture.text())).toBe(value);
    await expect(page.locator('.tm-agents-status')).toHaveText('');
  }
});

test('EditContext replacements do not depend on a render frame between inputs', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'EditContext is a Chromium-specific input path.');
  await page.evaluate(() => fixture.editor.updateOptions({ editContext: true }));
  await expect(page.locator('.native-edit-context')).toHaveCount(1);
  const values = ['first\nsecond', 'short\n', 'caf\u00e9\n\u6d4b\u8bd5', '', 'last'];
  const result = await page.evaluate(values => {
    const input = document.querySelector('.tm-agents-input');
    return values.map(value => {
      input.value = value;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return fixture.text();
    });
  }, values);
  expect(result).toEqual(values);
  await expect(page.locator('.tm-agents-status')).toHaveText('');
});

test('a failed native update blocks both Send and Steer with Message', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Confirmed draft');
  await page.evaluate(() => {
    const native = document.querySelector('.inputarea');
    native.addEventListener('input', event => event.stopImmediatePropagation(), true);
    document.querySelector('.native-send').setAttribute('aria-label', 'Steer with Message');
  });
  await page.locator('.tm-agents-input').fill('Unsynced draft');
  await expect(page.getByRole('status')).toContainText('Not synced');
  await page.getByRole('button', { name: 'Steer with Message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
  await expect(page.locator('.tm-agents-input')).toHaveValue('Unsynced draft');
});

test('native gesture activation cannot send an unsynced draft', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Confirmed draft');
  await page.evaluate(() => document.querySelector('.inputarea')
    .addEventListener('input', event => event.stopImmediatePropagation(), true));
  await page.locator('.tm-agents-input').fill('Unsynced draft');
  await page.locator('.native-send').evaluate(element => {
    const event = new Event('-monaco-gesturetap', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'initialTarget', { value: element });
    element.dispatchEvent(event);
    element.click();
  });
  await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
});

test('native line-break changes reach the visible draft', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('onetwo');
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
  await page.evaluate(() => fixture.setText('one\ntwo'));
  await expect(page.locator('.tm-agents-input')).toHaveValue('one\ntwo');
});

test('a native change immediately before submission requires reviewing the updated draft', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Visible draft');
  await page.evaluate(() => {
    fixture.setText('Native update');
    const send = document.querySelector('.native-send');
    send.dispatchEvent(new Event('-monaco-gesturetap', { bubbles: true, cancelable: true }));
    send.click();
  });
  await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
  await expect(page.locator('.tm-agents-input')).toHaveValue('Native update');
  await expect(page.getByRole('status')).toContainText('Review');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => fixture.sends)).toEqual(['Native update']);
});

test('long press on a chat link keeps the browser link menu', async ({ page }) => {
  const result = await page.locator('.interactive-request a').evaluate(element => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, menus: fixture.menus };
  });
  expect(result).toEqual({ defaultPrevented: false, menus: 0 });
});

test('desktop-site adaptation keeps device width and permits browser zoom', async ({ page }) => {
  const content = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(content).toContain('width=device-width');
  expect(content).not.toMatch(/user-scalable=no|maximum-scale|minimum-scale/);
});

test('the composer area fits above a resized virtual keyboard viewport', async ({ page }) => {
  await page.locator('.tm-agents-input').focus();
  await page.evaluate(() => {
    const composer = document.querySelector('.interactive-input-part');
    composer.style.position = 'absolute';
    composer.style.top = '550px';
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 480 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => page.locator('.interactive-input-part').evaluate(e => e.getBoundingClientRect().bottom)).toBeLessThanOrEqual(480);
});

test('navigation exposes sessions, chat, and files without losing a draft', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Retain across tabs');
  const nav = page.getByRole('navigation', { name: 'Mobile workspace' });
  await nav.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Sessions' })).toBeVisible();
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.locator('.part.editor')).toBeVisible();
  await nav.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.tm-agents-input')).toHaveValue('Retain across tabs');
});

test('native session list wrappers fill the phone width', async ({ page }) => {
  await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect.poll(() => page.getByRole('tree', { name: 'Sessions' }).evaluate(e => e.getBoundingClientRect().width)).toBeGreaterThanOrEqual(366);
  await expect.poll(() => page.locator('.session-title').evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
});

test('inactive chat descendants cannot bleed through the Sessions view', async ({ page }) => {
  await page.locator('.interactive-response .rendered-markdown').evaluate(e => { e.style.visibility = 'visible'; });
  await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(page.getByText('Response text to select.')).not.toBeVisible();
});

test('a hidden composer is resynchronized when returning to Chat', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Before switching');
  const nav = page.getByRole('navigation', { name: 'Mobile workspace' });
  await nav.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.evaluate(() => fixture.setText('Changed while hidden'));
  await nav.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.tm-agents-input')).toHaveValue('Changed while hidden');
  await expect(page.locator('.tm-agents-status')).toHaveText('');
});

test('modal editors stay visible and usable independently of the selected workspace pane', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Mobile workspace' });
  for (const pane of ['Sessions', 'Chat', 'Files']) {
    await nav.getByRole('button', { name: pane, exact: true }).tap();
    await page.evaluate(() => fixture.openModalEditor());
    const dialog = page.getByRole('dialog', { name: 'Agent Customizations', exact: true });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(e => getComputedStyle(e).position)).toBe('relative');
    await expect(dialog.getByRole('button', { name: 'Customize agents', exact: true })).toBeVisible();
    await expect.poll(() => dialog.getByRole('tree').evaluate(e => e.getBoundingClientRect().width)).toBe(120);
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).tap();
    await expect(page.locator('.monaco-modal-editor-block')).toHaveCount(0);
  }
});

test('a late-loaded phone renderer requests a reload in normal browser mode', async ({ page }) => {
  await page.evaluate(() => document.querySelector('.monaco-workbench').classList.add('phone-layout'));
  await expect(page.getByRole('status').filter({ hasText: 'Desktop site OFF' })).toBeVisible();
});

test('a fine-pointer desktop is left unchanged', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    screen: { width: 1440, height: 1000 },
    hasTouch: false,
    userAgent: desktopFirefoxUA,
  });
  const page = await context.newPage();
  try {
    await openFixture(page, context, { mobile: false });
    await expect(page.locator('.tm-agents-input')).toHaveCount(0);
    await expect(page.locator('.tm-agents-nav')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test.describe('Android Firefox normal mode', () => {
  test.use({ userAgent: androidFirefoxUA, screen: { width: 390, height: 844 } });

  test('selects desktop app controls at startup without a desktop-sized viewport', async ({ page }) => {
    await expect.poll(() => page.evaluate(() => fixture.initialLayout)).toBe('desktop');
    const metrics = await page.evaluate(() => {
      const button = document.querySelector('.tm-agents-nav button');
      const scale = visualViewport.scale;
      return {
        width: innerWidth,
        effectiveHeight: button.getBoundingClientRect().height * scale,
        effectiveFont: parseFloat(getComputedStyle(button).fontSize) * scale,
        ua: navigator.userAgent,
      };
    });
    expect(metrics.width).toBe(390);
    expect(metrics.effectiveHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.effectiveFont).toBeGreaterThanOrEqual(16);
    expect(metrics.ua).toContain('Android');
    expect(metrics.ua).toContain('Linux');
    expect(metrics.ua).toContain('Firefox/157.0');
    expect(metrics.ua).not.toContain('Mobi');
    await expect(page.locator('.model-picker-config-summary')).toBeVisible();
  });

  test('keeps HTTP browser identity unchanged and restores the page identity on disposal', async ({ page }) => {
    const networkUA = await page.evaluate(async () => (await (await fetch('/request-headers')).json()).userAgent);
    expect(networkUA).toBe(androidFirefoxUA);
    await page.evaluate(() => window.__vscodeAgentsMobile.dispose());
    expect(await page.evaluate(() => navigator.userAgent)).toBe(androidFirefoxUA);
  });

  test('reports a refused presentation override rather than claiming controls are available', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: androidFirefoxUA });
    try {
      const page = await context.newPage();
      await openFixture(page, context, { lockUserAgent: true });
      await expect(page.getByRole('status')).toContainText('could not select');
      await expect(page.locator('.tm-agents-nav')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test('wide desktop zoom-out gives a legible instruction to turn Desktop site off', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium supplies the physical mobile page-scale emulation.');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: desktopFirefoxUA,
  });
  try {
    const page = await context.newPage();
    await openFixture(page, context, { wideDesktop: true });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(980);
    const notice = page.getByRole('status').filter({ hasText: 'Desktop site OFF' });
    await expect(notice).toBeVisible();
    const metrics = await notice.evaluate(e => ({
      textSize: parseFloat(getComputedStyle(e).fontSize) * visualViewport.scale,
      width: e.getBoundingClientRect().width * visualViewport.scale,
    }));
    expect(metrics.textSize).toBeGreaterThanOrEqual(15.9);
    expect(metrics.width).toBeLessThanOrEqual(390);
  } finally {
    await context.close();
  }
});

test('a physical-width mobile viewport renders readable Sessions and Chat without scaling down', async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chromium supplies the physical mobile page-scale emulation.');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: androidFirefoxUA,
  });
  try {
    const page = await context.newPage();
    await openFixture(page, context);
    await expect.poll(() => page.evaluate(() => fixture.initialLayout)).toBe('desktop');
    await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Sessions', exact: true }).tap();
    const metrics = await page.evaluate(() => {
      const nav = document.querySelector('.tm-agents-nav button');
      const tree = document.querySelector('[role="tree"]');
      const scale = visualViewport.scale;
      return {
        scale,
        navHeight: nav.getBoundingClientRect().height * scale,
        titleFont: parseFloat(getComputedStyle(document.querySelector('.session-title')).fontSize) * scale,
        treeWidth: tree.getBoundingClientRect().width * scale,
      };
    });
    expect(metrics.scale).toBeCloseTo(1, 2);
    expect(metrics.navHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.titleFont).toBeGreaterThanOrEqual(16);
    expect(metrics.treeWidth).toBeGreaterThanOrEqual(366);
    await page.screenshot({ path: testInfo.outputPath('phone-sessions.png') });
    await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Chat', exact: true }).tap();
    await page.locator('.tm-agents-input').fill('Phone-sized input\nEnter stays a newline.');
    await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('phone-chat.png') });
  } finally {
    await context.close();
  }
});

test('sandbox startup changes the provided page navigator rather than its own world', async ({ page }) => {
  await page.evaluate(ua => {
    window.__vscodeAgentsMobile.dispose();
    window.fixtureParentAgent = navigator.userAgent;
    const iframe = document.createElement('iframe');
    iframe.id = 'page-world-fixture';
    document.body.append(iframe);
    Object.defineProperty(iframe.contentWindow.navigator, 'userAgent', { configurable: true, value: ua });
    window.unsafeWindow = iframe.contentWindow;
    window.exportFunction = (getter, target) => {
      window.fixtureExportTargetCorrect = target === iframe.contentWindow;
      return getter;
    };
  }, androidFirefoxUA);
  await page.addScriptTag({ path: scriptPath });
  const result = await page.evaluate(() => ({
    pageAgent: unsafeWindow.navigator.userAgent,
    ownAgentUnchanged: navigator.userAgent === window.fixtureParentAgent,
    exportedToPage: window.fixtureExportTargetCorrect,
  }));
  expect(result.pageAgent).toContain('Linux; Android');
  expect(result.pageAgent).not.toContain('Mobi');
  expect(result.ownAgentUnchanged).toBe(true);
  expect(result.exportedToPage).toBe(true);
  await page.evaluate(() => window.__vscodeAgentsMobile.dispose());
  expect(await page.evaluate(() => unsafeWindow.navigator.userAgent)).toBe(androidFirefoxUA);
});

test('sandbox gesture guards resolve the page event and cross-realm target', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Confirmed draft');
  await page.evaluate(() => document.querySelector('.inputarea')
    .addEventListener('input', event => event.stopImmediatePropagation(), true));
  await page.locator('.tm-agents-input').fill('Unsynced draft');
  await page.evaluate(() => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const send = iframe.contentDocument.createElement('button');
    send.className = 'native-send';
    send.setAttribute('aria-label', 'Send');
    send.textContent = 'Send';
    document.querySelector('.native-send').replaceWith(send);
    const container = send.parentElement;
    container.addEventListener('-monaco-gesturetap', () => fixture.sends.push(fixture.text()));
    const event = new Event('-monaco-gesturetap', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'wrappedJSObject', { value: { initialTarget: send } });
    container.dispatchEvent(event);
  });
  await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
});

async function panTranscript(page, distance) {
  return page.evaluate(async distance => {
    const rows = document.querySelector('.interactive-list .monaco-list-rows');
    const target = rows.querySelector('.rendered-markdown p');
    const bounds = target.getBoundingClientRect();
    const x = bounds.x + 40;
    const startY = bounds.y + 30;
    const pointerId = 17;
    const touchId = 4;
    const pointer = (type, y, element) => element.dispatchEvent(new PointerEvent(type, {
      pointerId, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
      bubbles: true, cancelable: true,
    }));
    const touchEvent = (type, y, element) => {
      const touch = new Touch({ identifier: touchId, target, clientX: x, clientY: y, pageX: x, pageY: y });
      const ending = type === 'touchend';
      const event = new TouchEvent(type, {
        bubbles: true, cancelable: true, changedTouches: [touch],
        touches: ending ? [] : [touch], targetTouches: ending ? [] : [touch],
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    pointer('pointerdown', startY, target);
    const startPrevented = touchEvent('touchstart', startY, target);
    for (let step = 1; step <= 4; step++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const y = startY - distance * step / 4;
      pointer('pointermove', y, rows);
      touchEvent('touchmove', y, rows);
    }
    pointer('pointerup', startY - distance, rows);
    touchEvent('touchend', startY - distance, rows);
    return { startPrevented, scrollTop: fixture.transcript.scrollTop, edits: fixture.edits };
  }, distance);
}

test('the composer has no added control row and keeps the native picker visible', async ({ page }) => {
  await expect(page.locator('.tm-agents-settings')).toHaveCount(0);
  await expect(page.locator('.model-picker-config-summary')).toBeVisible();
  await expect.poll(() => page.locator('.interactive-input-part').evaluate(e => e.getBoundingClientRect().height)).toBeLessThan(190);
  await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Native editor', exact: true })).toBeVisible();
});

test('touch swipes scroll the real virtualized transcript without editing a message', async ({ page }) => {
  await page.evaluate(() => fixture.mountTranscript(400));
  const result = await panTranscript(page, 180);
  expect(result.startPrevented).toBe(false);
  expect(result.scrollTop).toBeGreaterThan(100);
  expect(result.edits).toBe(0);
  await page.evaluate(() => { fixture.transcript.scrollTop = 1200; });
  const reverse = await panTranscript(page, -180);
  expect(reverse.scrollTop).toBeLessThan(1150);
  expect(reverse.edits).toBe(0);
});

test('dynamic transcript loaded while Chat is inactive remains rendered and scrollable', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Mobile workspace' });
  await nav.getByRole('button', { name: 'Sessions', exact: true }).tap();
  await page.evaluate(() => fixture.mountTranscript(90, { dynamicHeights: true }));
  await nav.getByRole('button', { name: 'Chat', exact: true }).tap();
  expect(await page.evaluate(() => fixture.transcript.contentHeight)).toBeGreaterThan(1000);
  const first = page.locator('.interactive-list .rendered-markdown p').first();
  await expect(first).toBeVisible();
  await expect(first).toBeInViewport();
  const before = await page.locator('.interactive-list .monaco-list-row').first().getAttribute('data-index');
  const result = await panTranscript(page, 220);
  expect(result.scrollTop).toBeGreaterThan(100);
  expect(result.edits).toBe(0);
  await expect.poll(() => page.locator('.interactive-list .monaco-list-row').first().getAttribute('data-index')).not.toBe(before);
});

test('timeline jump reveals the requested bubble after hidden dynamic transcript updates', async ({ page }) => {
  await page.evaluate(() => fixture.mountTranscript(90, { dynamicHeights: true, timeline: true }));
  const nav = page.getByRole('navigation', { name: 'Mobile workspace' });
  for (const pane of ['Files', 'Sessions']) {
    await nav.getByRole('button', { name: pane, exact: true }).tap();
    await page.evaluate(() => fixture.transcript.rerender());
    await nav.getByRole('button', { name: 'Chat', exact: true }).tap();
    for (const index of [54, 0, 84]) {
      await page.getByRole('button', { name: 'Show prompts', exact: true }).tap();
      await page.getByRole('button', { name: `Prompt ${index}`, exact: true }).tap();
      expect(await page.evaluate(() => fixture.timelineJumps.at(-1))).toBe(index);
      await expect(page.locator('.prompt-timeline-gutter-panel')).toBeHidden();
      const target = page.locator(`.interactive-list [data-message-index="${index}"]`);
      await expect(target).toBeVisible();
      await expect(target).toBeInViewport({ ratio: 1 });
      const offset = await target.evaluate(element =>
        element.closest('.monaco-list-row').getBoundingClientRect().top -
        element.closest('.interactive-list').getBoundingClientRect().top);
      expect(Math.abs(offset)).toBeLessThan(1);
    }
  }
  await expect.poll(() => page.evaluate(() => fixture.edits)).toBe(0);
  await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
});

test('mouse and keyboard timeline jumps retain native behavior', async ({ page }) => {
  await page.evaluate(() => fixture.mountTranscript(90, { dynamicHeights: true, timeline: true }));
  await page.getByRole('button', { name: 'Show prompts', exact: true }).hover();
  await page.getByRole('button', { name: 'Prompt 54', exact: true }).click();
  await expect(page.locator('.prompt-timeline-gutter-panel')).toBeVisible();
  await expect(page.locator('.interactive-list [data-message-index="54"]')).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: 'Prompt 0', exact: true }).press('Enter');
  expect(await page.evaluate(() => fixture.timelineJumps)).toEqual([54, 0]);
  await expect(page.locator('.interactive-list [data-message-index="0"]')).toBeInViewport({ ratio: 1 });
});

test('inactive dynamic transcript keeps its layout without exposing or focusing descendants', async ({ page }) => {
  await page.evaluate(() => fixture.mountTranscript(60, { dynamicHeights: true }));
  await page.locator('.interactive-list .rendered-markdown').first().evaluate(e => { e.style.visibility = 'visible'; });
  await page.locator('.native-send').evaluate(e => { e.style.visibility = 'visible'; });
  await page.getByRole('navigation', { name: 'Mobile workspace' }).getByRole('button', { name: 'Sessions', exact: true }).tap();
  expect(await page.locator('.interactive-list').evaluate(e => e.clientHeight)).toBe(340);
  await expect(page.locator('.interactive-list .rendered-markdown').first()).not.toBeVisible();
  await expect(page.locator('.native-send')).not.toBeVisible();
  expect(await page.locator('.native-send').evaluate(e => { e.focus(); return e === document.activeElement; })).toBe(false);
});

test('small transcript pans do not turn into prompt edits', async ({ page }) => {
  await page.evaluate(() => fixture.mountTranscript(40));
  const result = await panTranscript(page, 8);
  expect(result.scrollTop).toBeGreaterThan(0);
  expect(result.edits).toBe(0);
});

test('long-press selection stays native inside the real virtualized transcript', async ({ page }) => {
  await page.evaluate(() => fixture.mountTranscript(40));
  const result = await page.evaluate(() => {
    const target = document.querySelector('.interactive-list .rendered-markdown p');
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 21, pointerType: 'touch', isPrimary: true, clientX: rect.x + 20, clientY: rect.y + 10, bubbles: true,
    }));
    const touch = new Touch({ identifier: 3, target, clientX: rect.x + 20, clientY: rect.y + 10 });
    const start = new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] });
    target.dispatchEvent(start);
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    target.dispatchEvent(menu);
    target.dispatchEvent(new PointerEvent('pointerup', { pointerId: 21, pointerType: 'touch', isPrimary: true, bubbles: true }));
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [touch] }));
    return { startPrevented: start.defaultPrevented, menuPrevented: menu.defaultPrevented, menus: fixture.menus, edits: fixture.edits, selected: selection.toString().length > 0 };
  });
  expect(result).toEqual({ startPrevented: false, menuPrevented: false, menus: 0, edits: 0, selected: true });
});

test('transcript updates do not trigger full-document layout rescans', async ({ page }) => {
  await page.evaluate(() => fixture.mountTranscript(3000));
  const scans = await page.evaluate(async () => {
    for (let i = 0; i < 6; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    const original = document.querySelectorAll;
    let count = 0;
    document.querySelectorAll = function(selector) {
      if ((selector.includes('.part.sidebar') && selector.includes('.part.editor')) ||
          (selector.includes('monaco-editor') && selector.includes('sessions-chat-editor'))) count++;
      return original.call(this, selector);
    };
    try {
      const paragraph = document.querySelector('.interactive-list .rendered-markdown p');
      for (let i = 0; i < 20; i++) {
        paragraph.textContent = `Streaming transcript update ${i}`;
        paragraph.setAttribute('aria-label', `Transcript update ${i}`);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
      return count;
    } finally {
      delete document.querySelectorAll;
    }
  });
  console.log(`Transcript-only full-document scans: ${scans}`);
  expect(scans).toBe(0);
});

test('new inline editors are still discovered inside transcript messages', async ({ page }) => {
  await page.evaluate(() => fixture.mountInlineEditor());
  const input = page.locator('.interactive-request .tm-agents-input');
  await expect(input).toHaveValue('Earlier prompt');
  await input.fill('Edited from the touch input');
  await expect.poll(() => page.evaluate(() => fixture.inlineEditor.getValue())).toBe('Edited from the touch input');
  await expect.poll(() => page.evaluate(() => fixture.sends.length)).toBe(0);
});

test('real touch input keeps scrolling after the starting row is virtualized away', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Trusted touch injection uses Chromium CDP.');
  await page.evaluate(() => {
    fixture.mountTranscript(500);
    fixture.transcript.scrollTop = 60;
  });
  const point = await page.evaluate(() => {
    const body = document.querySelector('.interactive-list .rendered-markdown');
    const r = body.getBoundingClientRect();
    return { x: r.left + 40, y: r.bottom - 4 };
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...point }] });
    for (let i = 1; i <= 4; i++) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 0, x: point.x, y: point.y - i * 18 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(() => fixture.transcript.scrollTop)).toBeGreaterThan(120);
    await expect.poll(() => page.evaluate(() => fixture.edits)).toBe(0);
    await expect(page.locator('html')).toHaveAttribute('data-tm-agents-view', 'chat');
  } finally {
    await cdp.detach();
  }
});

test('idle input rerenders do not repeatedly copy or focus the native editor', async ({ page }) => {
  await page.locator('.tm-agents-input').fill('Same input');
  const copies = await page.evaluate(async () => {
    for (let i = 0; i < 6; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    let count = 0;
    const capture = () => count++;
    document.addEventListener('copy', capture, true);
    try {
      const line = document.querySelector('.interactive-input-editor .view-line');
      for (let i = 0; i < 12; i++) {
        if (line.firstChild) line.replaceChild(line.firstChild.cloneNode(true), line.firstChild);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
      return count;
    } finally {
      document.removeEventListener('copy', capture, true);
    }
  });
  expect(copies).toBe(0);
});
