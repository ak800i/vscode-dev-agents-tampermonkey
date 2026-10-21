import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import { List } from 'monaco-editor/base/browser/ui/list/listWidget.js';
import { ObjectTree } from 'monaco-editor/base/browser/ui/tree/objectTree.js';
import { Gesture } from 'monaco-editor/base/browser/touch.js';
import { Action } from 'monaco-editor/base/common/actions.js';
import { ContextMenuHandler } from 'monaco-editor/platform/contextview/browser/contextMenuHandler.js';
import { ContextViewService } from 'monaco-editor/platform/contextview/browser/contextViewService.js';

window.MonacoEnvironment = {
  getWorker: () => new Worker('/editor.worker.js'),
};

window.initializeFixtureRuntime(monaco, List, Gesture, Action, ContextMenuHandler, ContextViewService, ObjectTree);
