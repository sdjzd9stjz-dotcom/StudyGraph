// 渲染进程与主进程之间唯一的桥。
//
// 为什么需要它：讲义 PDF 由 Chromium 的 printToPDF 生成（中文排版零依赖，
// 不用打包字体），而 printToPDF 只有主进程能调。渲染进程跑在
// contextIsolation 下，没有 require —— 所以通过 contextBridge 暴露**一个函数**，
// 而不是把 ipcRenderer 整个丢进页面。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studygraph', {
  /**
   * 把一段完整 HTML 打成 PDF 并让用户选保存位置。
   * 返回 `{ ok: true, filePath }` 或 `{ ok: false, canceled }` / `{ ok: false, error }`。
   */
  savePdf: (html, suggestedName) => ipcRenderer.invoke('studygraph:save-pdf', html, suggestedName),
})
