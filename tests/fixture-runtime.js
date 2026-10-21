import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import { List } from 'monaco-editor/base/browser/ui/list/listWidget.js';
import { Gesture } from 'monaco-editor/base/browser/touch.js';
import { Menu } from 'monaco-editor/base/browser/ui/menu/menu.js';
import { Action } from 'monaco-editor/base/common/actions.js';

window.MonacoEnvironment = {
  getWorker: () => new Worker('/editor.worker.js'),
};

window.initializeFixtureRuntime(monaco, List, Gesture, Menu, Action);
