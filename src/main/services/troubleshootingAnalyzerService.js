const { EXIT_CODE_MAP } = require('./troubleshootingConstants');

function analyzeOomKilled(ctx) {
  const findings = [];
  const containers = ctx.containers || [];
  for (const c of containers) {
    if (c.exitCode === 137 || c.signal === 9 || c.terminatedReason === 'OOMKilled' || c.waitingReason === 'OOMKilled') {
      findings.push({
        id: `oom-killed-${c.name}`,
        title: `Container ${c.name} killed due to Out Of Memory (OOMKilled)`,
        category: 'resource',
        confidence: 'high',
        summary: `Container ${c.name} exceeded memory limits or system memory was exhausted (OOMKilled / exit code 137).`,
        evidence: [
          `Container ${c.name} state: terminatedReason=${c.terminatedReason || 'OOMKilled'}, exitCode=${c.exitCode ?? 137}`,
          ctx.limits?.memory ? `Resource memory limit: ${ctx.limits.memory}` : 'Memory limit reached',
        ],
        suggestedFixes: [
          `Increase container memory limits in spec.containers[name=${c.name}].resources.limits.memory`,
          'Optimize application memory usage / fix memory leaks',
        ],
        commands: [`kubectl set resources pod ${ctx.podName} --limits=memory=512Mi -n ${ctx.namespace}`],
      });
    }
  }
  return findings;
}

function analyzeImagePull(ctx) {
  const findings = [];
  const containers = ctx.containers || [];
  for (const c of containers) {
    const reason = c.waitingReason || c.terminatedReason || '';
    if (reason.includes('ImagePullBackOff') || reason.includes('ErrImagePull') || reason.includes('InvalidImageName')) {
      findings.push({
        id: `image-pull-${c.name}`,
        title: `Container ${c.name} failed to pull image`,
        category: 'image',
        confidence: 'high',
        summary: `Kubernetes cannot pull container image for ${c.name} (${reason}).`,
        evidence: [
          `Container ${c.name} waitingReason: ${reason}`,
          ...(ctx.events || [])
            .filter((e) => e.message?.includes('Failed') || e.message?.includes('pull'))
            .map((e) => `Event: ${e.message}`),
        ].slice(0, 3),
        suggestedFixes: [
          'Verify image name and tag in pod manifest',
          'Check imagePullSecrets if pulling from a private registry',
        ],
        commands: [`kubectl describe pod ${ctx.podName} -n ${ctx.namespace}`],
      });
    }
  }
  return findings;
}

function analyzeConfigError(ctx) {
  const findings = [];
  const events = ctx.events || [];
  const configEvents = events.filter(
    (e) => e.reason === 'CreateContainerConfigError' || e.reason === 'FailedMount' || e.message?.includes('secret') || e.message?.includes('configmap')
  );

  if (configEvents.length > 0 || (ctx.missingRefs && ctx.missingRefs.length > 0)) {
    const evidence = [
      ...configEvents.map((e) => `Event [${e.reason}]: ${e.message}`),
      ...(ctx.missingRefs || []).map((r) => `Missing Reference: ${r}`),
    ];

    findings.push({
      id: 'config-error',
      title: 'Container Configuration or Volume Mount Error',
      category: 'config',
      confidence: 'high',
      summary: 'Pod failed to create container configuration or mount referenced ConfigMaps/Secrets.',
      evidence,
      suggestedFixes: [
        'Ensure referenced ConfigMap or Secret exists in namespace',
        'Verify key names referenced in envFrom or volumeMounts',
      ],
      commands: [`kubectl get configmap,secret -n ${ctx.namespace}`],
    });
  }

  return findings;
}

function analyzeExitCode(ctx) {
  const findings = [];
  const containers = ctx.containers || [];
  for (const c of containers) {
    const code = c.exitCode;
    if (code !== undefined && code !== 0 && code !== 137) {
      const desc = EXIT_CODE_MAP[code] || `Application exited with code ${code}`;
      findings.push({
        id: `exit-code-${c.name}-${code}`,
        title: `Container ${c.name} exited with code ${code}`,
        category: code === 126 || code === 127 ? 'config' : 'app',
        confidence: code === 126 || code === 127 ? 'high' : 'medium',
        summary: `Container entrypoint terminated: ${desc}`,
        evidence: [
          `Container ${c.name}: exitCode=${code}, reason=${c.terminatedReason || 'Error'}`,
          ctx.logsPrevious ? `Log tail: ${ctx.logsPrevious.split('\n').slice(-3).join(' ')}` : 'Check previous container logs',
        ],
        suggestedFixes: [
          code === 127 ? 'Verify container command/args and binary path' : 'Review application logs for unhandled errors/exceptions',
        ],
        commands: [`kubectl logs ${ctx.podName} -c ${c.name} --previous -n ${ctx.namespace}`],
      });
    }
  }
  return findings;
}

function analyzeLivenessProbe(ctx) {
  const findings = [];
  const events = ctx.events || [];
  const probeEvents = events.filter((e) => e.message?.includes('Liveness probe failed') || e.message?.includes('Readiness probe failed'));
  const containers = ctx.containers || [];

  for (const c of containers) {
    if ((c.restartCount || 0) > 3 && probeEvents.length > 0) {
      findings.push({
        id: `liveness-probe-${c.name}`,
        title: `Container ${c.name} failing health probe`,
        category: 'probe',
        confidence: 'high',
        summary: `Container has restarted ${c.restartCount} times, accompanied by health probe failure events.`,
        evidence: probeEvents.map((e) => `Event: ${e.message}`),
        suggestedFixes: [
          'Increase initialDelaySeconds or failureThreshold in probe spec',
          'Ensure application health endpoint responds within timeoutSeconds',
        ],
        commands: [`kubectl get pod ${ctx.podName} -n ${ctx.namespace} -o yaml`],
      });
    }
  }
  return findings;
}

function analyzeLogSignal(ctx) {
  const findings = [];
  const logs = ctx.logsPrevious || ctx.logsCurrent || '';
  if (!logs) return findings;

  const errorPatterns = [
    { pattern: /panic:/i, msg: 'Go panic detected in logs' },
    { pattern: /NullPointerException|java\.lang\./i, msg: 'Java Exception detected in logs' },
    { pattern: /Fatal error|UnhandledPromiseRejection/i, msg: 'Fatal application error detected' },
    { pattern: /ECONNREFUSED|connection refused/i, msg: 'Database or external service connection refused' },
  ];

  for (const item of errorPatterns) {
    if (item.pattern.test(logs)) {
      findings.push({
        id: `log-signal-${item.msg.replace(/\s+/g, '-').toLowerCase()}`,
        title: item.msg,
        category: 'app',
        confidence: 'low',
        summary: `Application logs contain pattern indicating runtime crash: ${item.msg}`,
        evidence: [logs.split('\n').find((line) => item.pattern.test(line)) || item.msg],
        suggestedFixes: ['Inspect application source code and environment configuration'],
      });
    }
  }
  return findings;
}

function runAnalyzers(ctx) {
  if (!ctx) return [];
  const findings = [
    ...analyzeOomKilled(ctx),
    ...analyzeImagePull(ctx),
    ...analyzeConfigError(ctx),
    ...analyzeExitCode(ctx),
    ...analyzeLivenessProbe(ctx),
    ...analyzeLogSignal(ctx),
  ];

  const confidenceOrder = { high: 3, medium: 2, low: 1 };
  return findings.sort((a, b) => (confidenceOrder[b.confidence] || 0) - (confidenceOrder[a.confidence] || 0));
}

function findingsToResult(findings, ctx = {}) {
  if (!findings || findings.length === 0) {
    return {
      rootCause: 'Pod is experiencing unexpected crashes or restarts. No deterministic rule matched.',
      confidence: 'low',
      category: 'unknown',
      evidence: ['Container in CrashLoopBackOff or non-zero exit state.'],
      fixSteps: ['Inspect container logs with kubectl logs --previous', 'Check pod events and describe output'],
      commands: [
        `kubectl describe pod ${ctx.podName || '<pod>'} -n ${ctx.namespace || 'default'}`,
        `kubectl logs ${ctx.podName || '<pod>'} --previous -n ${ctx.namespace || 'default'}`,
      ],
      risk: 'Manual investigation required.',
      missingData: ['Detailed runtime trace'],
      degraded: true,
    };
  }

  const top = findings[0];
  const allEvidence = findings.flatMap((f) => f.evidence || []);
  const allFixes = findings.flatMap((f) => f.suggestedFixes || []);
  const allCmds = findings.flatMap((f) => f.commands || []);

  return {
    rootCause: top.summary || top.title,
    confidence: top.confidence || 'medium',
    category: top.category || 'app',
    evidence: allEvidence.length > 0 ? Array.from(new Set(allEvidence)) : [top.title],
    fixSteps: allFixes.length > 0 ? Array.from(new Set(allFixes)) : ['Check pod configuration'],
    commands: allCmds.length > 0 ? Array.from(new Set(allCmds)) : [],
    risk: 'Rule-based evaluation generated without LLM enhancement.',
    missingData: [],
    degraded: true,
  };
}

module.exports = {
  analyzeOomKilled,
  analyzeImagePull,
  analyzeConfigError,
  analyzeExitCode,
  analyzeLivenessProbe,
  analyzeLogSignal,
  runAnalyzers,
  findingsToResult,
};
