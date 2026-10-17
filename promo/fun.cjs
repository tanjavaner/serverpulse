// Eğlenceli paylaşım görselini üretir: npm run promo:fun
//   promo/out/fun-{tr,en}.png (1080x1350, 2x)
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const out = join(__dirname, 'out')
mkdirSync(out, { recursive: true })
process.on('uncaughtException', (e) => { console.error(e.stack); app.exit(1) })

app.on('window-all-closed', () => {})
;(async () => {
  await app.whenReady()
  for (const lang of ['tr', 'en']) {
    const win = new BrowserWindow({ show: false, width: 1080, height: 1350, webPreferences: { backgroundThrottling: false } })
    await win.loadFile(join(__dirname, 'fun.html'), { query: { lang } })
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r })))))')
    win.setContentSize(2160, 2700)
    win.webContents.setZoomFactor(2)
    await new Promise((r) => setTimeout(r, 500))
    writeFileSync(join(out, `fun-${lang}.png`), (await win.webContents.capturePage()).toPNG())
    win.destroy()
  }
  app.quit()
})()
