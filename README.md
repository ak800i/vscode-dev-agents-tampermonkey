# VS Code Agents: mobile input and controls

A standalone Tampermonkey userscript for `https://vscode.dev/agents`, aimed at
Firefox on Android.

**Use Firefox's Desktop site mode.** VS Code's native phone interface omits the
thinking-effort and context-size controls. This script adapts the desktop
interface to a phone instead of inventing model settings or changing the
backend. It activates only for a coarse pointer or an Android user agent, so a
normal mouse-operated desktop is left alone.

## Install

1. Install and enable Tampermonkey in Firefox on Android.
2. Create a new script in Tampermonkey, replace its contents with
   [vscode-agents-mobile.user.js](vscode-agents-mobile.user.js), and save it.
3. Open `https://vscode.dev/agents` and enable **Desktop site** in Firefox's menu.
4. Reload the page and sign in normally.

The script adds **Sessions / Chat / Files / More** navigation. If it detects VS
Code's native phone renderer, it displays a Desktop site reminder.

There are no runtime libraries, external requests, API keys, or additional
permissions to configure. The script does not store prompts or send them to a
new service. It uses VS Code's existing authenticated interface.

## The six fixes

| Request | Behavior |
| --- | --- |
| See and set thinking/effort and context size | Persistent buttons show the native model configuration. Tapping either opens VS Code's real model-details picker. |
| Select text in the chat input | A normal textarea provides browser-native caret placement, selection, copy/paste, and Android keyboard composition. Changes are checked against the native editor before submission. |
| Enter must not send | Enter and Shift+Enter insert newlines. Keyboard Enter events do not reach VS Code's send shortcut. Use the existing Send, Steer, or Queue action explicitly. |
| Collapse a parent session without opening it | A touch on the session/subagent chevron uses the native collapse action and suppresses the duplicate touch/click activation. |
| Tap a sent prompt to edit | A short tap opens VS Code's native editing flow. Scrolling, a long press, an existing text selection, and links do not activate editing. Tapping does not resend the prompt. |
| Fix long-press menus | Chat text, chat links, and the mobile input retain browser-native selection/context actions instead of VS Code's custom dropdown. Menus elsewhere remain available. |

### Model settings

- The choices and limits come from the selected model, provider, account, and
  session. The script cannot enable unsupported reasoning levels or extend a
  model beyond the context sizes VS Code offers.
- **Automatic** means Auto model selection controls that setting.
  **Not exposed** means VS Code has not provided a value; it is not a guessed
  default.
- Context size is the configured window, not the percentage of context already
  consumed.
- VS Code may warn that changing settings mid-session resets the prompt cache
  and increases cost. That native warning is preserved.
- No effort, context, model, or permission setting is changed automatically.

### Input and recovery

The original attachment, mode, permissions, dictation, and submission controls
remain available. **Native editor** switches back to Monaco for features such
as inline `@` and slash-command suggestions; tap suggestion entries to use them.
**Touch editor** returns to the selectable textarea. Native-editor handoff puts
the caret at the end of the draft.

If a native update cannot be confirmed, a **Not synced** message is displayed
and submission from that composer is blocked. The text remains in the
textarea: copy it before navigating away or reloading. If the native input
cannot be connected at all, the native editor remains visible with an explicit
warning.

If the native draft changes just before submission, the script asks you to
review the updated text and tap Send again. Both mouse clicks and VS Code's
touch-gesture submission path are guarded.

When a virtual keyboard shrinks only the visible viewport, the focused
composer is moved above it rather than merely shrinking its outer panel.

Disable the script in Tampermonkey and reload to remove the adaptation.

## Validation

The tests use the real Monaco editor, not a mock text model, and exercise
Firefox and Chromium. The script has no access to Monaco's global API in the
fixture. Coverage includes multiline/Unicode input, selection replacement,
IME composition, explicit submission, failed-update submission guards, native
editor handoff, model controls, native gesture duplication, long press,
rerenders, navigation, and virtual-keyboard viewport changes.

```powershell
npm ci
$env:PLAYWRIGHT_SKIP_BROWSER_GC = '1'
npx playwright install firefox chromium
npm run check
npm test
```

The test runner starts and stops a local fixture server on
`http://127.0.0.1:31137`. No account or live agent is used by these tests.
Production installation requires only the userscript, not Node.js or the test
dependencies.

The authenticated site was also inspected with touch input and portrait metrics,
both before and after refreshing into its Android/mobile rendering path.
Browser user-agent emulation is **not** a real Android Firefox engine. Automated
Firefox tests run on desktop Firefox; physical-device keyboard selection
handles, browser chrome, and Tampermonkey installation still require checking
on the phone.

VS Code's web DOM is not a public extension API. A site update can require
selector/event updates; unavailable controls and input synchronization failures
are surfaced rather than silently pretending to work.

## References

- [Official language-model and thinking-effort documentation](https://code.visualstudio.com/docs/agent-customization/language-models)
- [VS Code phone input presenter](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/widget/input/chatPhoneInputPresenter.ts)
- [VS Code model picker implementation](https://github.com/microsoft/vscode/tree/main/src/vs/workbench/contrib/chat/browser/widget/input/modelPicker)
