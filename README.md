# VS Code Agents: mobile input and controls

A standalone Tampermonkey userscript for `https://vscode.dev/agents`, aimed at
Firefox on Android.

**Version 0.3.2: keep Firefox's Desktop site OFF.** Desktop site can force a wide
viewport and shrink the entire interface, even when the page asks for device
width. The script now keeps the browser's real phone-width viewport and selects
VS Code's desktop-style controls at startup. This retains the native thinking
and context settings without the desktop zoom-out.

Main chat text and session titles use 16px text, the navigation and script
controls have at least 44px touch targets, and the Sessions tree fills the
available width. Inactive panes are fully hidden instead of allowing their
contents to show through.

Version 0.3.2 fixes touch selection in the Sessions host picker. Native menus
inside Shadow DOM retarget touch events to their outer picker button, which
can reopen the dropdown instead of selecting the PC. The script resolves the
actual touched menu row and invokes its native tap action once. Menu dragging
still uses native scrolling; cancelled touches and disabled actions do not
select a host. Mouse and keyboard handling are unchanged. No tunnel settings
or connection credentials are changed by the fix.

Version 0.3.1 fixes blank transcripts and broken jumps from the left prompt
timeline after changing panes or loading history in the background. Inactive
panes stay measurable by Monaco without being visible or accepting focus.

Version 0.3 removes the duplicate model/effort/context button row. Use the native
model picker and its adjacent effort/context summary below the input. The
optional native-editor switch is now under **More**, rather than taking a full
row in the composer.

## Install

1. Install and enable Tampermonkey in Firefox on Android.
2. Create a new script in Tampermonkey, replace its contents with
   [vscode-agents-mobile.user.js](vscode-agents-mobile.user.js), and save it.
   Approve its page-access grant if Tampermonkey asks.
3. Open `https://vscode.dev/agents` and turn **Desktop site OFF** in Firefox's menu.
4. Reload the page and sign in normally.

When upgrading from an older version, replace the existing script rather than leaving both
versions enabled. Save it, turn Desktop site off, and reload.

The script adds **Sessions / Chat / Files / More** navigation. If the desktop
zoom-out is still active or the script loaded too late to choose the app
renderer, it displays a setup reminder rather than claiming the controls work.

### Page-local presentation adjustment

On Android, the script removes the `Mobile` marker from the page's JavaScript
`navigator.userAgent` before VS Code chooses its renderer. It retains the
Android marker and the browser/version information, and adds the Linux marker
when needed for the correct keyboard bindings. This is limited to the Agents
page: it does not change HTTP request headers, the browser's Desktop site
setting, authentication, or tunnel configuration. The original JavaScript
property is restored when the script is disposed.

The `unsafeWindow` grant and Firefox's `exportFunction` bridge ensure this
adjustment reaches the page even when Tampermonkey falls back to a userscript
sandbox. Raw page execution is preferred. No cross-origin networking or storage
grants are requested.

This is a compatibility adjustment for VS Code's current renderer selection,
not a public VS Code extension API. If the browser refuses it, an explicit
warning is shown. A mouse-operated desktop is left unchanged.

There are no runtime libraries, external requests, or API keys to configure.
The script does not store prompts or send them to a new service. It uses VS
Code's existing authenticated interface.

## The six fixes

| Request | Behavior |
| --- | --- |
| See and set thinking/effort and context size | The original model picker and configuration summary remain visible. There are no duplicate model controls. |
| Select text in the chat input | A normal textarea provides browser-native caret placement, selection, copy/paste, and Android keyboard composition. Changes are checked against the native editor before submission. |
| Enter must not send | Enter and Shift+Enter insert newlines. Keyboard Enter events do not reach VS Code's send shortcut. Use the existing Send, Steer, or Queue action explicitly. |
| Collapse a parent session without opening it | A touch on the session/subagent chevron uses the native collapse action and suppresses the duplicate touch/click activation. |
| Tap a sent prompt to edit | A short tap opens VS Code's native editing flow. Scrolling, a long press, an existing text selection, and links do not activate editing. Tapping does not resend the prompt. |
| Fix long-press menus | Chat text, chat links, and the mobile input retain browser-native selection/context actions instead of VS Code's custom dropdown. Menus elsewhere remain available. |

### Model settings

- The choices and limits come from the selected model, provider, account, and
  session. The script cannot enable unsupported reasoning levels or extend a
  model beyond the context sizes VS Code offers.
- Labels and selected values are rendered by VS Code itself, not mirrored or
  guessed by the script.
- Context size is the configured window, not the percentage of context already
  consumed.
- VS Code may warn that changing settings mid-session resets the prompt cache
  and increases cost. That native warning is preserved.
- No effort, context, model, or permission setting is changed automatically.

### Input and recovery

The original attachment, mode, permissions, dictation, and submission controls
remain available. **More > Native editor** switches back to Monaco for features such
as inline `@` and slash-command suggestions; tap suggestion entries to use them.
**More > Touch editor** returns to the selectable textarea. Native-editor handoff puts
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

### Transcript scrolling and rendering

Monaco's transcript is a virtualized list with `overflow: hidden`; it is not a
normal browser-scrolling container. Version 0.3 routes touch pans through the
native gesture engine using a stable list target, retaining its scrolling and
inertia while keeping browser text selection separate. Tap-to-edit is suppressed
when the touch moves, and the native-editor textarea keeps its normal touch
handling.

Version 0.3 hid inactive panes with `display: none`. Monaco continues measuring
dynamic-height messages during background updates, so it could cache every
message at zero height. The history and left-hand prompt list still existed,
but the transcript was blank and native prompt jumps could not reveal the
requested bubble. Version 0.3.1 hides panes and their descendants without
removing their layout. The left timeline keeps using VS Code's own reveal
action, with valid row heights. After a touch selection, the script also clears
the native popup's lingering mouse-hover state so it does not keep covering the
chosen message; mouse and keyboard activation keep their native behavior.
Reload after updating to discard measurements cached by the old script.

Transcript-only DOM changes no longer trigger full-document layout scans.
Line-aware input fingerprints also avoid repeatedly focusing/copying the
native editor when its rendered text has not changed. In the controlled
20-update regression, full-document scans dropped from 20 to 0. This measures
userscript rendering overhead, not server/network history-fetch time.

## Validation

The tests use the real Monaco editor and virtualized List, not mock text or
scroll models, and exercise
Firefox and Chromium. The script has no access to Monaco's global API in the
fixture. Coverage includes multiline/Unicode input, selection replacement,
IME composition, explicit submission, failed-update submission guards, native
editor handoff, model controls, native gesture duplication, long press,
rerenders, navigation, virtual-keyboard viewport changes, real-list touch
scrolling, small pans, pointer capture across recycled rows, and transcript
mutation overhead. The Firefox suite
uses an Android Firefox user agent to exercise the Android input path. Layout
tests cover fixed-width native pane wrappers, explicit visibility on hidden
descendants, normal mobile startup, unchanged HTTP identity, and a real 980px
mobile zoom-out in Chromium's device emulation.
Dynamic-height transcript tests also cover history arriving while Chat is
hidden, background remeasurement, and touch activation of the prompt timeline
after switching panes. They check that the requested bubble is actually
rendered at the top of the transcript, not just that a scroll offset changed.

```powershell
npm ci
$env:PLAYWRIGHT_SKIP_BROWSER_GC = '1'
npx playwright install firefox chromium
npm run check
npm test
```

The test runner bundles the Monaco test fixture in memory using esbuild, then
starts and stops a local fixture server on
`http://127.0.0.1:31137`. No account or live agent is used by these tests.
Production installation requires only the userscript, not Node.js or the test
dependencies.

The earlier 0.1 checks resized a desktop viewport but did not reproduce
Firefox's forced desktop zoom-out; the physical-phone screenshot exposed that
gap. Version 0.2 removes the Desktop site requirement and tests that failure
separately. Browser emulation is **not** a physical Android Firefox device.
Automated Firefox tests run on desktop Firefox. Native Android selection
handles and OS long-press UI cannot be established by desktop emulation (a
plain-HTML control test does not produce them either). Tests verify that the
browser's selection/context defaults are not cancelled. Physical selection
handles, browser chrome, and Tampermonkey startup still require checking on the
phone.

VS Code's web DOM is not a public extension API. A site update can require
selector/event updates; unavailable controls and input synchronization failures
are surfaced rather than silently pretending to work.

## References

- [Official language-model and thinking-effort documentation](https://code.visualstudio.com/docs/agent-customization/language-models)
- [VS Code phone input presenter](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/widget/input/chatPhoneInputPresenter.ts)
- [VS Code desktop/mobile renderer selection](https://github.com/microsoft/vscode/blob/main/src/vs/sessions/browser/workbenchFactory.ts)
- [VS Code model picker implementation](https://github.com/microsoft/vscode/tree/main/src/vs/workbench/contrib/chat/browser/widget/input/modelPicker)
- [Tampermonkey execution contexts](https://www.tampermonkey.net/documentation.php?locale=en&q=sandbox)
