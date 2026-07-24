const { z } = require('zod');

const ANALYSIS_SCHEMA_ZOD = z.object({
  rootCause: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  category: z.enum(['resource', 'image', 'config', 'app', 'probe', 'unknown']),
  evidence: z.array(z.string()).min(1),
  fixSteps: z.array(z.string()).min(1),
  commands: z.array(z.string()).optional().default([]),
  risk: z.string().optional().default(''),
  missingData: z.array(z.string()).optional().default([]),
});

const SYSTEM_PROMPT = `You are an expert Kubernetes Site Reliability Engineer (SRE).
Your task is to analyze a failing/crashing Kubernetes Pod (CrashLoopBackOff, ImagePullBackOff, OOMKilled, etc.) based ONLY on the provided context (pod status, exit code, events, logs, rule findings).

Rules:
1. Base your root cause strictly on the provided evidence. Do NOT hallucinate.
2. If evidence is missing, state what is missing and set confidence to "low".
3. Cite exact line(s) from logs/events in the evidence array.
4. Consider the provided rule engine findings as hints to verify or reject, not blindly repeat.
5. Provide actionable fix steps. If shell/kubectl commands are provided in commands, make them specific and non-destructive.
6. Do NOT attempt to execute commands yourself.
7. Return ONLY a single raw JSON object matching the requested schema. No markdown formatting outside JSON.`;

const EXIT_CODE_MAP = {
  0: 'Success (Exit 0)',
  1: 'Application Error (Exit 1)',
  2: 'Application Configuration Error (Exit 2)',
  126: 'Permission Denied / Non-executable Entrypoint (Exit 126)',
  127: 'Command Not Found / Invalid Entrypoint (Exit 127)',
  137: 'OOMKilled / SIGKILL (Exit 137)',
  139: 'Segmentation Fault / SIGSEGV (Exit 139)',
  143: 'Graceful Termination / SIGTERM (Exit 143)',
};

module.exports = {
  ANALYSIS_SCHEMA_ZOD,
  SYSTEM_PROMPT,
  EXIT_CODE_MAP,
};
