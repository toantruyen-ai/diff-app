const { spawn } = require('child_process');
const { SYSTEM_PROMPT } = require('./troubleshootingConstants');

function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractResultText(stdout) {
  const outer = parseJsonLoose(stdout);
  if (outer && typeof outer === 'object' && outer.result !== undefined) {
    return typeof outer.result === 'string' ? outer.result : JSON.stringify(outer.result);
  }
  return stdout;
}

function getEnhancedEnv() {
  const userPath = [
    process.env.PATH,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    `${process.env.HOME}/.nvm/versions/node/${process.version}/bin`,
    `${process.env.HOME}/.npm-global/bin`,
    `${process.env.HOME}/.cargo/bin`,
  ].filter(Boolean).join(':');
  return { ...process.env, PATH: userPath };
}

function resolveCommand(options = {}) {
  if (options.cliCommand) return options.cliCommand;
  const provider = (options.cliProvider || 'claude').toLowerCase();
  if (provider === 'antigravity' || provider === 'agy') return 'agy';
  return 'claude';
}

function getInstallInstructions(provider = 'claude') {
  const isAntigravity = provider.toLowerCase() === 'antigravity' || provider.toLowerCase() === 'agy';
  if (isAntigravity) {
    return {
      provider: 'antigravity',
      name: 'Google Antigravity CLI / Gemini CLI',
      installCmd: 'npm install -g @google/antigravity-cli',
      authCmd: 'agy login',
      docUrl: 'https://github.com/google-gemini/antigravity-cli',
      steps: [
        '1. Open terminal and install CLI: npm install -g @google/antigravity-cli',
        '2. Login or set key: agy login (or export GEMINI_API_KEY="your-api-key")',
        '3. Verify in terminal: agy -p "hello"',
      ],
    };
  }
  return {
    provider: 'claude',
    name: 'Anthropic Claude CLI',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    authCmd: 'claude',
    docUrl: 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview',
    steps: [
      '1. Open terminal and install CLI: npm install -g @anthropic-ai/claude-code',
      '2. Authenticate: run claude in terminal and login via browser',
      '3. Verify in terminal: claude -p "hello"',
    ],
  };
}

function testCli(provider = 'claude', options = {}) {
  return new Promise((resolve) => {
    const cmd = resolveCommand({ cliProvider: provider, ...options });
    const spawnEnv = getEnhancedEnv();
    const args = ['-p', 'Say hello in one short sentence'];
    const timeoutMs = options.timeoutMs || 15000;

    let child;
    let stdoutData = '';
    let stderrData = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child) child.kill('SIGTERM');
    }, timeoutMs);

    const spawnOptions = { shell: false, env: spawnEnv };

    try {
      child = spawn(cmd, args, spawnOptions);

      if (child.stdin) {
        child.stdin.on('error', () => {});
      }

      child.stdout.on('data', (chunk) => {
        stdoutData += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if ((cmd === 'agy' || cmd === 'antigravity') && err.code === 'ENOENT') {
          // Try fallback to 'antigravity' or 'gemini' if 'agy' binary is not found
          return testCliFallbackAntigravityOrGemini(options).then(resolve);
        }
        resolve({
          ok: false,
          error: `CLI executable '${cmd}' was not found in PATH (${err.message}).`,
          installGuide: getInstallInstructions(provider),
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          return resolve({
            ok: false,
            error: `CLI '${cmd}' timed out after 15s.`,
            installGuide: getInstallInstructions(provider),
          });
        }
        if (code !== 0 && !stdoutData.trim()) {
          return resolve({
            ok: false,
            error: `CLI '${cmd}' exited with code ${code}: ${stderrData.trim() || 'No output'}`,
            installGuide: getInstallInstructions(provider),
          });
        }
        const text = extractResultText(stdoutData) || stdoutData.trim() || 'Hello! CLI is ready.';
        resolve({ ok: true, text, command: cmd });
      });

      if (child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.write('Say hello');
          child.stdin.end();
        } catch {
          // ignore EPIPE / stream write error
        }
      }
    } catch (e) {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: `CLI execution failed: ${e.message}`,
        installGuide: getInstallInstructions(provider),
      });
    }
  });
}

function testCliFallbackAntigravityOrGemini(options = {}, fallbackIndex = 0) {
  const fallbacks = ['antigravity', 'gemini'];
  if (fallbackIndex >= fallbacks.length) {
    return Promise.resolve({
      ok: false,
      error: `Neither 'agy', 'antigravity' nor 'gemini' CLI executable was found in PATH.`,
      installGuide: getInstallInstructions('antigravity'),
    });
  }
  const cmd = fallbacks[fallbackIndex];
  return new Promise((resolve) => {
    const spawnEnv = getEnhancedEnv();
    const args = ['-p', 'Say hello in one short sentence'];
    let child;
    let stdoutData = '';
    let stderrData = '';

    try {
      child = spawn(cmd, args, { shell: false, env: spawnEnv });
      if (child.stdin) {
        child.stdin.on('error', () => {});
      }
      child.stdout.on('data', (chunk) => { stdoutData += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });
      child.on('error', () => {
        resolve(testCliFallbackAntigravityOrGemini(options, fallbackIndex + 1));
      });
      child.on('close', (code) => {
        if (code !== 0 && !stdoutData.trim()) {
          return resolve({
            ok: false,
            error: `CLI '${cmd}' exited with code ${code}: ${stderrData.trim()}`,
            installGuide: getInstallInstructions('antigravity'),
          });
        }
        const text = extractResultText(stdoutData) || stdoutData.trim() || `Hello! ${cmd} CLI is ready.`;
        resolve({ ok: true, text, command: cmd });
      });
      if (child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.write('Say hello');
          child.stdin.end();
        } catch {
          // ignore EPIPE
        }
      }
    } catch {
      resolve(testCliFallbackAntigravityOrGemini(options, fallbackIndex + 1));
    }
  });
}

function getCommandCandidates(options = {}) {
  if (options.cliCommand) return [options.cliCommand];
  const provider = (options.cliProvider || 'claude').toLowerCase();
  if (provider === 'antigravity' || provider === 'agy') {
    return ['agy', 'antigravity', 'gemini'];
  }
  return ['claude'];
}

function executeCliCandidate(userPrompt, options, candidates, candidateIndex = 0) {
  if (candidateIndex >= candidates.length) {
    return Promise.resolve({
      ok: false,
      error: `CLI execution failed: No candidate executable found in PATH (${candidates.join(', ')})`,
    });
  }
  const command = candidates[candidateIndex];
  const systemPrompt = options.systemPrompt || SYSTEM_PROMPT;
  const timeoutMs = options.timeoutMs || 60000;
  const spawnEnv = getEnhancedEnv();

  const args = [
    '-p',
    '--output-format',
    'json',
    '--append-system-prompt',
    systemPrompt,
    '--allowedTools',
    '',
  ];

  return new Promise((resolve) => {
    let child;
    let stdoutData = '';
    let stderrData = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child) child.kill('SIGTERM');
    }, timeoutMs);

    try {
      child = spawn(command, args, { shell: false, env: spawnEnv });

      if (child.stdin) {
        child.stdin.on('error', () => {});
      }

      child.stdout.on('data', (chunk) => {
        stdoutData += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT' && candidateIndex + 1 < candidates.length) {
          return executeCliCandidate(userPrompt, options, candidates, candidateIndex + 1).then(resolve);
        }
        resolve({
          ok: false,
          error: `CLI spawn error: ${err.message}`,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          return resolve({ ok: false, error: 'CLI process timed out after 60s' });
        }
        if (code !== 0 && !stdoutData.trim()) {
          return resolve({ ok: false, error: `CLI exited with code ${code}: ${stderrData}` });
        }
        const text = extractResultText(stdoutData);
        resolve({ ok: true, text, rawStdout: stdoutData, command });
      });

      if (child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.write(userPrompt);
          child.stdin.end();
        } catch {
          // ignore EPIPE
        }
      }
    } catch (e) {
      clearTimeout(timer);
      if (candidateIndex + 1 < candidates.length) {
        return executeCliCandidate(userPrompt, options, candidates, candidateIndex + 1).then(resolve);
      }
      resolve({ ok: false, error: `CLI execution failed: ${e.message}` });
    }
  });
}

function executeCli(userPrompt, options = {}) {
  const candidates = getCommandCandidates(options);
  return executeCliCandidate(userPrompt, options, candidates, 0);
}

module.exports = {
  parseJsonLoose,
  extractResultText,
  executeCli,
  testCli,
  getInstallInstructions,
  resolveCommand,
};
