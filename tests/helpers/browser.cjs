const { chromium } = require('playwright')
const browserOptions = options => ({
  headless: true,
  ...(process.env.S2T_BROWSER_EXECUTABLE ? { executablePath: process.env.S2T_BROWSER_EXECUTABLE } : {}),
  ...options
})
module.exports = { chromium, browserOptions }
