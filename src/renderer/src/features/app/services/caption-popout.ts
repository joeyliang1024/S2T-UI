import { activeTranslate } from '../../../shared/i18n'

type PictureInPictureApi = { requestWindow(options: { width: number; height: number }): Promise<Window> }
export type CaptionPopout = { window: Window; pictureInPicture: boolean; dispose: () => void }

// Invoke directly from a click: both APIs require user activation.
export const openCaptionPopout = async (onClose: () => void, forcePopup = false): Promise<CaptionPopout> => {
  const api = (window as Window & { documentPictureInPicture?: PictureInPictureApi }).documentPictureInPicture
  const pictureInPicture = !!api && !forcePopup
  const child = pictureInPicture && api
    ? await api.requestWindow({ width: 640, height: 360 })
    : window.open(new URL('caption-window.html', window.location.origin).href, 's2t-live-captions', forcePopup
      ? `popup,left=${(screen as Screen & { availLeft?: number }).availLeft ?? 0},top=${(screen as Screen & { availTop?: number }).availTop ?? 0},width=${screen.availWidth},height=${screen.availHeight}`
      : 'popup,width=640,height=360')
  if (!child || child.closed) throw new Error(activeTranslate('svcCaptionPopoutBlocked'))
  if (!pictureInPicture) {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => { child.removeEventListener('load', loaded); reject(new Error(activeTranslate('svcCaptionPopoutLoadTimeout'))) }, 10000)
      const loaded = (): void => { window.clearTimeout(timeout); resolve() }
      child.addEventListener('load', loaded, { once: true })
    })
  }
  const doc = child.document
  doc.title = activeTranslate('svcCaptionPopoutTitle')
  doc.head.replaceChildren()
  doc.body.replaceChildren()
  for (const sheet of document.querySelectorAll('link[rel="stylesheet"], link[rel="icon"], style')) {
    const copy = sheet.cloneNode(true) as HTMLElement
    if (copy instanceof HTMLLinkElement) copy.href = (sheet as HTMLLinkElement).href
    doc.head.append(copy)
  }
  const style = doc.createElement('style')
  style.textContent = 'html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #080808; }'
  doc.head.append(style)
  const syncTheme = (): void => { doc.documentElement.dataset.theme = document.documentElement.dataset.theme || ''; doc.documentElement.lang = document.documentElement.lang }
  syncTheme()
  const observer = new MutationObserver(syncTheme)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] })
  let disposed = false
  const dispose = (): void => { if (disposed) return; disposed = true; observer.disconnect(); child.removeEventListener('pagehide', closed) }
  const closed = (): void => { dispose(); onClose() }
  child.addEventListener('pagehide', closed, { once: true })
  return { window: child, pictureInPicture, dispose }
}
