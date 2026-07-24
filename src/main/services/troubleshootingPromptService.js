function buildUserPrompt(ctx, findings = []) {
  const containerSummary = (ctx.containers || [])
    .map(
      (c) =>
        `- Container: ${c.name} | restarts: ${c.restartCount} | exitCode: ${c.exitCode ?? 'N/A'} | terminatedReason: ${
          c.terminatedReason || 'N/A'
        } | waitingReason: ${c.waitingReason || 'N/A'}`
    )
    .join('\n');

  const eventsSummary = (ctx.events || [])
    .slice(-15)
    .map((e) => `- [${e.type || 'Warning'}] ${e.reason}: ${e.message}`)
    .join('\n');

  const prevLogTail = (ctx.logsPrevious || '')
    .split('\n')
    .slice(-60)
    .join('\n')
    .trim();

  const currLogTail = (ctx.logsCurrent || '')
    .split('\n')
    .slice(-30)
    .join('\n')
    .trim();

  const findingsSummary = findings
    .map(
      (f) =>
        `- Finding [${f.confidence.toUpperCase()}]: ${f.title} (${f.summary})\n  Evidence: ${f.evidence.join('; ')}`
    )
    .join('\n');

  return `
Target Pod: ${ctx.podName} (Namespace: ${ctx.namespace})

--- Containers ---
${containerSummary || 'No container data'}

--- Rule Engine Pre-Analysis Findings ---
${findingsSummary || 'No automated rules matched'}

--- Recent Events (Last 15) ---
${eventsSummary || 'No recent events recorded'}

--- Previous Container Log (Crash Log Tail - Last 60 lines) ---
${prevLogTail || '(No previous log available)'}

--- Current Container Log (Current Tail - Last 30 lines) ---
${currLogTail || '(No current log available)'}

Analyze the root cause, confidence, category, evidence, fix steps, commands, and potential risks based strictly on the above.
Output must be a valid JSON object matching the AnalysisResult schema.
`.trim();
}

function buildCorrectivePrompt(userPrompt, rawResponse, zodError) {
  const issues = Array.isArray(zodError?.issues)
    ? zodError.issues.map((i) => `Field '${i.path.join('.')}': ${i.message}`).join('; ')
    : String(zodError);

  return `
Your previous output failed JSON Schema validation.

Validation Errors:
${issues}

Previous Invalid Output:
${typeof rawResponse === 'string' ? rawResponse.slice(0, 500) : JSON.stringify(rawResponse)}

Original Analysis Prompt:
${userPrompt}

Please re-output ONLY a single valid JSON object fixing all validation errors above. Do not include markdown code blocks or extra text outside JSON.
`.trim();
}

module.exports = {
  buildUserPrompt,
  buildCorrectivePrompt,
};
