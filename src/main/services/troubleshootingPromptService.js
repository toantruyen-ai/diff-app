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
    .slice(-70)
    .join('\n')
    .trim();

  const currLogTail = (ctx.logsCurrent || '')
    .split('\n')
    .slice(-40)
    .join('\n')
    .trim();

  const findingsSummary = findings
    .map(
      (f) =>
        `- Finding [${f.confidence.toUpperCase()}]: ${f.title} (${f.summary})\n  Evidence: ${f.evidence.join('; ')}`
    )
    .join('\n');

  let grafanaSummary = '';
  if (ctx.grafanaTelemetry) {
    const lokiStr = (ctx.grafanaTelemetry.lokiLogs || [])
      .map((stream) => stream.lines.join('\n'))
      .filter(Boolean)
      .join('\n');
    const mimirStr = (ctx.grafanaTelemetry.mimirMetrics || [])
      .map((m) => `${m.metric.container || 'container'}: ${m.samples.map((s) => s[1]).join(', ')}`)
      .join('\n');

    grafanaSummary = `
--- Grafana Observability Telemetry (Loki / Mimir) ---
Grafana Instance: ${ctx.grafanaTelemetry.grafanaUrl}
Loki Logs:
${lokiStr || '(No Loki log streams found)'}

Mimir / Prometheus Metrics:
${mimirStr || '(No Mimir metric samples found)'}
`.trim();
  }

  return `
Target Pod: ${ctx.podName} (Namespace: ${ctx.namespace})

--- Containers ---
${containerSummary || 'No container data'}

--- Rule Engine Pre-Analysis Findings ---
${findingsSummary || 'No automated rules matched'}

--- PRIMARY LOG SOURCE: Previous Container Crash Log (--previous) ---
[PRIORITY]: If previous crash logs exist below, treat them as the primary evidence for container failure/crash.
${prevLogTail || '(No previous crash log recorded - container has not restarted or has no previous log)'}

--- Recent Container Log (Current Stream - Last 40 lines) ---
${currLogTail || '(No current log available)'}

--- Recent Kubernetes Events (Last 15) ---
${eventsSummary || 'No recent events recorded'}
${grafanaSummary ? `\n${grafanaSummary}\n` : ''}
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
