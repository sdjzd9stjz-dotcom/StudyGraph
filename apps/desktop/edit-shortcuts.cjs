// Electron 的编辑菜单先于网页处理这些组合键。交给页面，输入框仍走 Chromium 的原生编辑。
function enableEditShortcuts(contents) {
  contents.on('before-input-event', (_event, input) => {
    contents.setIgnoreMenuShortcuts(Boolean((input.control || input.meta) && !input.alt && ['z','y','a'].includes(input.key.toLowerCase())))
  })
}
module.exports = { enableEditShortcuts }
