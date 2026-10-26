const { chromium } = require('playwright')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const selectExecutable = ({ env = process.env, platform = process.platform, exists = existsSync, bundled = chromium.executablePath() } = {}) => {
  if (env.S2T_BROWSER_EXECUTABLE) {
    if (!exists(env.S2T_BROWSER_EXECUTABLE)) throw new Error('S2T_BROWSER_EXECUTABLE does not exist')
    return env.S2T_BROWSER_EXECUTABLE
  }
  if (exists(bundled)) return bundled
  const candidates = platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ] : platform === 'win32' ? [
    join(env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome']
  const found = candidates.find(exists)
  if (!found) throw new Error('No Playwright or local browser found. Install Chromium with npx playwright install chromium, or set S2T_BROWSER_EXECUTABLE.')
  return found
}
const browserOptions = (options = {}) => ({ headless: true, executablePath: options.executablePath || selectExecutable(), ...options })
module.exports = { chromium, browserOptions, selectExecutable }
