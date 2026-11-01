import { appInstalled, pickMethod } from './launcher.js'
import { loadConfig, saveConfig } from './config.js'

export const APP_INSTALL_URL = 'https://github.com/bnookala/autochat#macos-menu-bar-app'
export const APP_INSTALL_STEPS = [
  'git clone https://github.com/bnookala/autochat && cd autochat',
  'macos/scripts/build-app.sh --install    # → ~/Applications/AutoChat.app',
  'autochat setup                          # then switches to launch=app'
]

// Copilot CLI's hooks are part of its adapter now (src/harness/copilot.js).
export { hooksFile, legacyHooksFile, buildHooksConfig, installHooks, hooksInstalledAt, removeLegacyHooks, legacyHooksInstalled, uninstallHooks, hooksInstalled } from './harness/copilot.js'

// On macOS with AutoChat.app installed, hooks should wake the app (launch=app), never a terminal.
// `off` is left alone: it's the app's own Pause switch. Returns what setup should report.
export function configureLaunch ({ platform = process.platform, env = process.env } = {}) {
  const before = loadConfig()
  const app = platform === 'darwin' ? appInstalled(env) : null
  const cfg = app && !['app', 'off'].includes(before.launch) ? saveConfig({ launch: 'app' }) : before
  return { app, launch: cfg.launch, previous: before.launch, method: pickMethod(cfg, env, platform) }
}
