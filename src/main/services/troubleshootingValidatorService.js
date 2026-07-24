const { ANALYSIS_SCHEMA_ZOD } = require('./troubleshootingConstants');
const { parseJsonLoose, executeCli } = require('./troubleshootingCliProviderService');
const { buildCorrectivePrompt } = require('./troubleshootingPromptService');

function validateAnalysisResult(rawText) {
  const json = parseJsonLoose(rawText);
  if (!json || typeof json !== 'object') {
    return { ok: false, error: new Error('Output is not a valid JSON object'), json: null };
  }

  const parseRes = ANALYSIS_SCHEMA_ZOD.safeParse(json);
  if (!parseRes.success) {
    return { ok: false, error: parseRes.error, json };
  }

  return { ok: true, data: parseRes.data };
}

async function analyzeWithRetry(userPrompt, options = {}) {
  const maxRetries = options.maxRetries ?? 2;
  const runner = options.cliRunner || executeCli;

  let currentPrompt = userPrompt;
  let attempt = 0;

  while (attempt <= maxRetries) {
    attempt++;
    const cliRes = await runner(currentPrompt, options);

    if (!cliRes.ok) {
      return { ok: false, error: cliRes.error || 'CLI execution failed' };
    }

    const valRes = validateAnalysisResult(cliRes.text);
    if (valRes.ok) {
      return { ok: true, data: valRes.data, attempts: attempt };
    }

    if (attempt <= maxRetries) {
      currentPrompt = buildCorrectivePrompt(userPrompt, cliRes.text, valRes.error);
    }
  }

  return { ok: false, error: 'Exceeded maximum retries for structured validation' };
}

module.exports = {
  validateAnalysisResult,
  analyzeWithRetry,
};
