// Tanıtım görsellerini üretir: npm run promo
//   promo/out/carousel-{tr,en}.pdf, promo/out/slides-{tr,en}/NN.png, docs/assets/social-{tr,en}.png
const { app, BrowserWindow } = require('electron')
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const here = __dirname
const out = join(here, 'out')
const assets = join(here, '..', 'docs', 'assets')
mkdirSync(out, { recursive: true })
// Windows'ta Electron stdout'u konsola yansıtmaz: ilerleme promo/out/render.log dosyasına da yazılır
const log = (...a) => { const s = a.join(' '); appendFileSync(join(out, 'render.log'), `${s}\n`); console.log(s) }
process.on('uncaughtException', (e) => { log('HATA', e.stack); app.exit(1) })
mkdirSync(assets, { recursive: true })

async function open(file, lang, width, height) {
  const win = new BrowserWindow({ show: false, width, height, webPreferences: { backgroundThrottling: false, offscreen: false } })
  await win.loadFile(join(here, file), { query: { lang } })
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r })))))')
  return win
}

/** Yalnızca i. slaytı gösterir (diğerleri gizli), işi yapar, sonra hepsini geri getirir (PDF için). */
async function only(win, i, fn) {
  await win.webContents.executeJavaScript(`document.querySelectorAll('.slide').forEach((el, j) => { el.style.display = j === ${i} ? 'flex' : 'none' })`)
  const r = await fn()
  await win.webContents.executeJavaScript("document.querySelectorAll('.slide').forEach((el) => { el.style.display = '' })")
  return r
}

async function shot(win, width, height, scale) {
  win.setContentSize(width * scale, height * scale)
  win.webContents.setZoomFactor(scale)
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage()
  return img.toPNG()
}

app.on('window-all-closed', () => {}) // pencereler arası geçişte uygulama kapanmasın
;(async () => {
await app.whenReady()
log('ready')
for (const lang of ['tr', 'en']) {
  const slides = await open('slides.html', lang, 1080, 1350)
  log('slides yüklendi')
  const n = await slides.webContents.executeJavaScript('document.querySelectorAll(".slide").length')
  const dir = join(out, `slides-${lang}`)
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < n; i++) {
    log('slayt', i + 1)
    writeFileSync(join(dir, `${String(i + 1).padStart(2, '0')}.png`), await only(slides, i, () => shot(slides, 1080, 1350, 2)))
  }
  slides.webContents.setZoomFactor(1)
  slides.setContentSize(1080, 1350)
  const pdf = await slides.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } })
  writeFileSync(join(out, `carousel-${lang}.pdf`), pdf)
  slides.destroy()

  const social = await open('social.html', lang, 1280, 640)
  writeFileSync(join(assets, `social-${lang}.png`), await shot(social, 1280, 640, 1))
  social.destroy()
  log(`${lang}: ${n} slayt, PDF ve sosyal önizleme hazır`)
}
app.quit()
})()
