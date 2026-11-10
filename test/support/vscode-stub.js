'use strict';
// A small stand-in for the vscode module: enough for activation, the editable custom editor, the Pro tools panel and
// the license facade. Tests script the dialogs through `ui` and read what happened from `log`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function create() {
  const log = { info: [], warn: [], error: [], status: [], opened: [], external: [], commands: [], saved: [], panels: [], changes: [] };
  const ui = { open: [], save: [], input: [], quick: [], info: [] };
  const commands = new Map();
  const providers = new Map();
  const state = new Map();
  const config = { showProTools: true, showSupportLinks: true, askForRating: true, jpegQuality: 92, webpQuality: 90 };
  class EventEmitter { constructor() { this.l = new Set(); this.event = (f) => { this.l.add(f); return { dispose: () => this.l.delete(f) }; }; } fire(v) { for (const f of this.l) f(v); } dispose() { this.l.clear(); } }
  class Uri {
    constructor(scheme, p) { this.scheme = scheme; this.path = p; this.fsPath = p; }
    static file(p) { return new Uri('file', path.resolve(p)); }
    static parse(s) { const m = /^([a-z][\w+.-]*):\/\/(.*)$/i.exec(s); return m ? new Uri(m[1], m[2]) : new Uri(s.split(':')[0], s); }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.join(u.path, ...parts)); }
    toString() { return `${this.scheme}://${this.path}`; }
    with(o) { return new Uri(o.scheme || this.scheme, o.path || this.path); }
  }
  class CancellationError extends Error { constructor() { super('Canceled'); this.name = 'Canceled'; } }
  const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
  const nextOf = (q, dflt) => (q.length ? q.shift() : dflt);
  const msg = (kind) => async (text, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : {};
    log[kind].push({ text, opts, buttons: rest.map((b) => (typeof b === 'string' ? b : b.title)) });
    return kind === 'info' ? nextOf(ui.info, undefined) : undefined;
  };
  const notFound = (p) => { const e = new Error(`not found: ${p}`); e.code = 'FileNotFound'; e.name = 'EntryNotFound (FileSystemError)'; return e; };
  /** Webview panels made by createWebviewPanel; a test sets panelHandler to answer their messages. */
  const stub = { panelHandler: null };
  const vscode = {
    version: '1.90.2',
    EventEmitter, Uri, CancellationError, FileType,
    ViewColumn: { Beside: -2, Active: -1, One: 1 },
    ProgressLocation: { Notification: 15, Window: 10 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    env: { appName: 'Visual Studio Code', uriScheme: 'vscode', machineId: 'test', clipboard: { readText: async () => '', writeText: async (t) => { log.clipboard = t; } }, openExternal: async (u) => { log.external.push(String(u)); return true; }, asExternalUri: async (u) => u },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), update: async () => {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      fs: {
        stat: async (u) => { if (!fs.existsSync(u.fsPath)) throw notFound(u.fsPath); const s = fs.statSync(u.fsPath); return { size: s.size, type: s.isDirectory() ? 2 : 1 }; },
        readFile: async (u) => { if (!fs.existsSync(u.fsPath)) throw notFound(u.fsPath); return new Uint8Array(fs.readFileSync(u.fsPath)); },
        writeFile: async (u, b) => { fs.mkdirSync(path.dirname(u.fsPath), { recursive: true }); fs.writeFileSync(u.fsPath, b); log.saved.push(u.fsPath); },
        readDirectory: async (u) => fs.readdirSync(u.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? 2 : 1]),
        createDirectory: async (u) => { fs.mkdirSync(u.fsPath, { recursive: true }); },
        delete: async (u) => { fs.rmSync(u.fsPath, { force: true, recursive: true }); },
      },
      openTextDocument: async (o) => ({ uri: Uri.parse('untitled:doc'), getText: () => (o && o.content) || '', o }),
      isTrusted: true,
    },
    window: {
      state: { focused: true },
      tabGroups: { activeTabGroup: { activeTab: undefined } },
      onDidChangeWindowState: () => ({ dispose() {} }),
      registerCustomEditorProvider: (vt, p) => { providers.set(vt, p); return { dispose() {} }; },
      registerUriHandler: () => ({ dispose() {} }),
      showInformationMessage: msg('info'), showWarningMessage: msg('warn'), showErrorMessage: msg('error'),
      setStatusBarMessage: (t) => { log.status.push(t); return { dispose() {} }; },
      showOpenDialog: async (o) => { log.lastOpen = o; return nextOf(ui.open, undefined); },
      showSaveDialog: async (o) => { log.lastSave = o; return nextOf(ui.save, undefined); },
      showInputBox: async (o) => { const v = nextOf(ui.input, undefined); if (v !== undefined && o && o.validateInput) { const e = o.validateInput(v); if (e) throw new Error(e); } return v; },
      showQuickPick: async (items, o) => { log.lastQuick = { items: await items, o }; const f = nextOf(ui.quick, undefined); return typeof f === 'function' ? f(await items) : f; },
      showTextDocument: async (d) => { log.opened.push(d); return {}; },
      withProgress: async (o, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createWebviewPanel: (viewType, title) => {
        const listeners = new Set(); const disposeL = new Set();
        const panel = {
          viewType, title, posted: [],
          webview: {
            options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u,
            postMessage: async (m) => { panel.posted.push(m); if (stub.panelHandler) setImmediate(() => stub.panelHandler(m, panel)); return true; },
            onDidReceiveMessage: (f) => { listeners.add(f); return { dispose() {} }; },
          },
          reveal() {}, onDidDispose: (f) => { disposeL.add(f); return { dispose() {} }; }, dispose() { for (const f of disposeL) f(); },
          send: (m) => { for (const f of listeners) f(m); },
        };
        log.panels.push(panel);
        setImmediate(() => panel.send({ type: 'ready' }));
        return panel;
      },
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...a) => { log.commands.push([id, ...a]); if (commands.has(id)) return commands.get(id)(...a); return undefined; },
    },
    extensions: { all: [], getExtension: () => undefined, onDidChange: () => ({ dispose() {} }) },
    authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose() {} }) },
    l10n: { t: (s) => s },
  };
  const secrets = new Map();
  const context = {
    subscriptions: [],
    extensionUri: Uri.file(path.join(__dirname, '..', '..')),
    extensionPath: path.join(__dirname, '..', '..'),
    extension: undefined,
    globalStorageUri: Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'imgedit-gs-'))),
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()], setKeysForSync() {} },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); }, onDidChange: () => ({ dispose() {} }) },
  };
  return Object.assign(stub, { vscode, context, log, ui, commands, providers, state, config });
}

/** Load src/extension.js with a fresh stub; returns the stub and the module. */
function loadExtension() {
  const stub = create();
  const orig = Module._load;
  const hook = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  Module._load = hook;
  const root = path.join(__dirname, '..', '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
  stub.ext = require(path.join(root, 'extension.js'));
  stub.restore = () => { Module._load = orig; };
  return stub;
}

/**
 * Open a file in the custom editor. The fake webview answers like media/editor.js: 'encode' requests get the bytes
 * of `encodeWith(mime)` back in chunks. Returns { doc, posted, send, waitFor }.
 */
async function openInEditor(stub, file, o = {}) {
  const posted = [];
  let onMsg;
  const panel = {
    active: true, visible: true,
    webview: {
      options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u,
      postMessage: async (m) => {
        posted.push(m);
        if (m.type === 'encode' && o.encodeWith) setImmediate(() => {
          const bytes = o.encodeWith(m.mime, m.quality);
          onMsg({ type: 'chunk', tx: 'w1', seq: 0, last: true, data: bytes });
          onMsg({ type: 'encoded', id: m.id, tx: 'w1', mime: o.actualMime || m.mime, w: 10, h: 8 });
        });
        return true;
      },
      onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; },
    },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
  };
  const p = stub.providers.get('imageEditor.edit');
  const doc = await p.openCustomDocument(stub.vscode.Uri.file(file), o.openContext || {});
  p.resolveCustomEditor(doc, panel);
  await onMsg({ type: 'ready' });
  const waitFor = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = posted.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); } return null; };
  return { doc, panel, posted, send: (m) => onMsg(m), waitFor, provider: p };
}

module.exports = { create, loadExtension, openInEditor };
