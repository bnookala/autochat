export const APP_INSTALL_URL = 'https://github.com/bnookala/autochat#macos-menu-bar-app'
export const APP_INSTALL_STEPS = [
  'git clone https://github.com/bnookala/autochat && cd autochat',
  'macos/scripts/build-app.sh --install    # → ~/Applications/AutoChat.app',
  'open ~/Applications/AutoChat.app        # then turn on Launch at Login in its menu'
]

// Copilot CLI's hooks are part of its adapter now (src/harness/copilot.js).
export { hooksFile, legacyHooksFile, buildHooksConfig, installHooks, hooksInstalledAt, removeLegacyHooks, legacyHooksInstalled, uninstallHooks, hooksInstalled } from './harness/copilot.js'
