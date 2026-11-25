function installSaveBeforeClose(window, dialog, onApproved) {
  let pending = false, approved = false
  window.on('close', event => {
    if (approved) return
    event.preventDefault()
    if (pending) return
    pending = true
    const wc = window.webContents
    const check = wc.isCrashed() ? Promise.reject(Error('renderer unavailable')) :
      wc.executeJavaScript('window.studyGraphLeave ? window.studyGraphLeave() : true')
    check.catch(async () => (await dialog.showMessageBox(window, { type:'warning', message:'无法确认画布已保存。仍要退出吗？', buttons:['留在应用','仍然退出'], cancelId:0, defaultId:0 })).response === 1)
      .then(ok => { pending = false; if (ok) { approved = true; onApproved(); window.close() } })
  })
}
module.exports = { installSaveBeforeClose }
