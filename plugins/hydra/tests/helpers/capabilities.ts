import type { ClaudeCapabilities } from '../../src/domain.js';

export const TEST_CAPABILITIES: ClaudeCapabilities = {
  flags: {
    print: true,
    model: true,
    effort: true,
    outputFormat: true,
    verbose: true,
    permissionMode: true,
    tools: true,
    settings: true,
    settingSources: true,
    jsonSchema: true,
    resume: true,
    sessionId: true,
    mcpConfig: true,
    strictMcpConfig: true,
  },
  supportsCliMaxTurns: false,
  supportsDirectSandboxFlag: false,
};
