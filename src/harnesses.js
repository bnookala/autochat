// Registering `autochat mcp` with each harness is part of its adapter now (src/harness/).
export { harnessContext, which, tilde, writeFileSafely } from './harness/util.js'
export { SERVER } from './harness/mcp-config.js'
export { ADAPTERS as HARNESSES, planAgents, unplanAgents, agentsStatus, describePlan, setupAgents, removeAgents } from './harness/index.js'
