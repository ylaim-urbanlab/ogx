const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("explorerApi", {
  pickRoot: () => ipcRenderer.invoke("pick-root"),
  getTestenvPath: () => ipcRenderer.invoke("get-testenv-path"),
  resolveDir: (inputPath, basePath) => ipcRenderer.invoke("resolve-dir", inputPath, basePath),
  loadData: (rootDir) => ipcRenderer.invoke("load-data", rootDir),
  saveTags: (rootDir, tags) => ipcRenderer.invoke("save-tags", rootDir, tags),
  loadCards: (folderPath) => ipcRenderer.invoke("load-cards", folderPath),
  saveCards: (folderPath, cards) => ipcRenderer.invoke("save-cards", folderPath, cards),
  fileCardPreview: (rootDir, fullPath, sectionNames) =>
    ipcRenderer.invoke("file-card-preview", rootDir, fullPath, sectionNames || []),
  graphContextMenu: (opts) => ipcRenderer.invoke("graph-context-menu", opts),
  fileHeadTail: (rootDir, fullPath, headN, tailN) =>
    ipcRenderer.invoke("file-head-tail", rootDir, fullPath, headN, tailN),
  fileSnippet: (rootDir, fullPath, maxBytes) =>
    ipcRenderer.invoke("file-snippet", rootDir, fullPath, maxBytes),
  csvPreview: (rootDir, fullPath) => ipcRenderer.invoke("csv-preview", rootDir, fullPath),
  grepFile: (rootDir, fullPath, pattern, maxBytes) =>
    ipcRenderer.invoke("grep-file", rootDir, fullPath, pattern, maxBytes),
  openBrowseTab: (opts) => ipcRenderer.invoke("open-browse-tab", opts),
  browseTabLoad: (opts) => ipcRenderer.invoke("browse-tab-load", opts),
  browseTabThumb: (opts) => ipcRenderer.invoke("browse-tab-thumb", opts),
  openPathExternal: (fullPath) => ipcRenderer.invoke("open-path-external", fullPath),
  browseTabParent: (opts) => ipcRenderer.invoke("browse-tab-parent", opts),
  readerSelectionSaveCopy: (opts) => ipcRenderer.invoke("reader-selection-save-copy", opts),
  readerSelectionSaveList: (opts) => ipcRenderer.invoke("reader-selection-save-list", opts),
  buildContentLinks: (opts) => ipcRenderer.invoke("build-content-links", opts),
  appendHistory: (rootDir, lines) => ipcRenderer.invoke("append-history", rootDir, lines),
  readFilesBatch: (rootDir, relPaths) => ipcRenderer.invoke("read-files-batch", rootDir, relPaths),
  loadConcepts: (rootDir) => ipcRenderer.invoke("load-concepts", rootDir),
  saveConcepts: (rootDir, data) => ipcRenderer.invoke("save-concepts", rootDir, data),
  loadMediaIndex: (rootDir) => ipcRenderer.invoke("load-media-index", rootDir),
  saveMediaIndex: (rootDir, data) => ipcRenderer.invoke("save-media-index", rootDir, data),
});
