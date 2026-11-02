import { sanitize, sanitizeMultiline, charCount } from '../text.js'
import { findSecret } from '../secrets.js'
import { fail, isStr } from './limits.js'

// Guardrails: the secret scan, text and size checks, and the per-agent post budgets.
// See docs/agent-room/guardrails.md.

export const methods = {
  _scan (text) {
    const kind = findSecret(text)
    if (kind) fail(`blocked: looks like a secret (${kind})`)
  },

  _text (value, max, field = 'text') {
    if (!isStr(value)) fail(`${field} must be a string`)
    // Escape sequences can make raw text longer than the result, but not by this much.
    if (value.length > max * 4 + 256) fail(`${field} too long (max ${max} characters)`)
    const text = sanitizeMultiline(value)
    if (!text) fail(`${field} is empty`)
    if (charCount(text) > max) fail(`${field} too long (max ${max} characters)`)
    this._scan(text)
    return text
  },

  _title (value) {
    if (!isStr(value)) fail('title must be a string')
    if (value.length > this.limits.title * 4 + 256) fail(`title too long (max ${this.limits.title} characters)`)
    const title = sanitize(value, Infinity)
    if (!title) fail('title is empty')
    if (charCount(title) > this.limits.title) fail(`title too long (max ${this.limits.title} characters)`)
    this._scan(title)
    return title
  },

  _budget (agent, which) {
    const L = this.limits
    const now = this.now()
    const list = agent.posts[which]
    while (list.length && now - list[0] >= L.budgetWindowMs) list.shift()
    const max = which === 'main' ? L.mainPosts : L.threadPosts
    return list.length < max ? null : list[0] + L.budgetWindowMs - now
  },

  _spend (agent, which) {
    agent.posts[which].push(this.now())
  }
}
