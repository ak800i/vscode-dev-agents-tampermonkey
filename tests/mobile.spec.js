const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'vscode-agents-mobile.user.js');

async function openFixture(page, context, { mobile = true, phoneLayout = false } = {}) {
  let script = '';
  try {
    script = await fs.readFile(scriptPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await page.addInitScript(({ mobile }) => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = original(query);
      if (/pointer:\s*coarse/.test(query)) Object.defineProperty(result, 'matches', { value: mobile });
      return result;
    };
  }, { mobile });
  await page.addInitScript({ content: script });
  await page.goto('http://127.0.0.1:31137/agents');
  await page.waitForFunction(() => window.fixture?.ready || window.fixtureError);
  expect(await page.evaluate(() => window.fixtureError)).toBeUndefined();
  if (phoneLayout) {
    await page.evaluate(() => document.querySelector('.monaco-workbench').classList.add('phone-layout'));
  }
}

test.beforeEach(async ({ page, context }) => {
  await openFixture(page, context);
});

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
  await page.getByRole('button', { name: 'Native editor', exact: true }).click();
  await page.keyboard.insertText(' plus native text');
  await expect.poll(() => page.evaluate(() => fixture.text())).toBe('Keep this draft plus native text');
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('inputarea'))).toBe(true);
  await page.getByRole('button', { name: 'Touch editor', exact: true }).click();
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

test('effort and context show native values and operate the native settings', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Effort: High', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Context: 200K', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Effort: High', exact: true }).click();
  expect(await page.evaluate(() => window.fixtureError)).toBeUndefined();
  await expect.poll(() => page.evaluate(() => fixture.detailsOpens)).toBe(1);
  await page.getByRole('button', { name: 'Low', exact: true }).click();
  await page.getByRole('button', { name: '1M', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Effort: Low', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Context: 1M', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => fixture.detailsOpens)).toBe(1);
});

test('model changes do not reuse stale effort or context values', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('.model-picker-name').setAttribute('aria-label', 'Models, Auto');
    document.querySelector('.model-picker-config').setAttribute('aria-label', 'Auto details, Optimize for: Balance');
  });
  await expect(page.getByRole('button', { name: 'Effort: Automatic', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Context: Automatic', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Effort: High', exact: true })).toHaveCount(0);
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
  await expect(page.getByRole('button', { name: 'Effort: High', exact: true })).toHaveCount(1);
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

test('native-phone rendering explicitly requests Desktop site instead of pretending settings work', async ({ page }) => {
  await page.evaluate(() => document.querySelector('.monaco-workbench').classList.add('phone-layout'));
  await expect(page.getByRole('status').filter({ hasText: 'Desktop site' })).toBeVisible();
});

test('a fine-pointer desktop is left unchanged', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await openFixture(page, context, { mobile: false });
    await expect(page.locator('.tm-agents-input')).toHaveCount(0);
    await expect(page.locator('.tm-agents-nav')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
