// What the tool definitions and calls share.

export const STATES = ['exploring', 'editing', 'testing', 'blocked', 'done', 'idle']
export const KINDS = ['note', 'question', 'reply', 'proposal', 'decision', 'handoff']
export const names = (description) => ({ type: 'array', items: { type: 'string' }, maxItems: 16, description })
export const local = { openWorldHint: false, destructiveHint: false }

export const toList = (v) => typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : v
export const toInt = (v) => typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v
export const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]))

export class ToolError extends Error {
  constructor (message, extra = {}) {
    super(message)
    this.extra = extra
  }
}
