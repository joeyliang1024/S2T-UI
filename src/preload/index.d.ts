import type { DesktopBridge } from '../shared/contracts/desktop'
export {}
declare global { interface Window { s2t?: DesktopBridge } }
