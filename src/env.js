// AUTOCHAT_<name>, falling back to LOLCHAT_<name> from before the lolchat → autochat rename.
// An AUTOCHAT_ variable that is set (even to '') always wins.
export function envVar (name, env = process.env) {
  const v = env['AUTOCHAT_' + name]
  return v !== undefined ? v : env['LOLCHAT_' + name]
}
