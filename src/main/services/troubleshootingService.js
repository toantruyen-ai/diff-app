const { collectPodContext } = require('./troubleshootingCollectorService');
const { runAnalyzers, findingsToResult } = require('./troubleshootingAnalyzerService');
const { buildUserPrompt } = require('./troubleshootingPromptService');
const { analyzeWithRetry } = require('./troubleshootingValidatorService');
const troubleshootingDb = require('../db/troubleshootingDb');

async function analyzePod(ref, contextName, namespace, podName, options = {}) {
  let ctx;
  const collector = options.collector || collectPodContext;
  try {
    ctx = await collector(ref, contextName, namespace, podName, options);
  } catch (e) {
    return { ok: false, error: `Failed to collect pod context: ${e.message}` };
  }

  const findings = runAnalyzers(ctx);
  const userPrompt = buildUserPrompt(ctx, findings);

  const retryResult = await analyzeWithRetry(userPrompt, options);

  let finalResult;
  if (retryResult.ok && retryResult.data) {
    finalResult = {
      ...retryResult.data,
      degraded: false,
    };
  } else {
    // Graceful degradation fallback to rule engine findings
    const fallbackResult = findingsToResult(findings, ctx);
    finalResult = {
      ...fallbackResult,
      fallbackReason: retryResult.error || 'LLM execution failed or unavailable',
    };
  }

  // Persist to database
  try {
    const dbSaver = options.dbSaver || troubleshootingDb.saveAnalysisRecord;
    await dbSaver(ref, contextName, {
      namespace,
      podName,
      result: finalResult,
    });
  } catch (err) {
    console.error('Failed to persist AI analysis record:', err.message);
  }

  return {
    ok: true,
    result: finalResult,
  };
}

async function getAnalysisHistory(ref, contextName, namespace, podName) {
  try {
    const history = await troubleshootingDb.getAnalysisHistory(ref, contextName, namespace, podName);
    return { ok: true, history };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deleteAnalysis(ref, contextName, id) {
  try {
    const res = await troubleshootingDb.deleteAnalysisById(ref, contextName, id);
    return { ok: true, changes: res.changes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function clearAnalysisHistory(ref, contextName, namespace) {
  try {
    const res = await troubleshootingDb.clearAnalysisHistory(ref, contextName, namespace);
    return { ok: true, changes: res.changes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const { testCli } = require('./troubleshootingCliProviderService');

async function testAiCli(provider, options = {}) {
  try {
    const tester = options.cliTester || testCli;
    return await tester(provider, options);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  analyzePod,
  getAnalysisHistory,
  deleteAnalysis,
  clearAnalysisHistory,
  testAiCli,
};
