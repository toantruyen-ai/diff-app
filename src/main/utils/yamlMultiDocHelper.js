const k8s = require('@kubernetes/client-node');

const KIND_APPLY_ORDER = {
  Namespace: 0,
  ResourceQuota: 1,
  LimitRange: 1,
  CustomResourceDefinition: 2,
  ServiceAccount: 3,
  Secret: 4,
  ConfigMap: 4,
  ClusterRole: 5,
  ClusterRoleBinding: 6,
  Role: 5,
  RoleBinding: 6,
  PersistentVolume: 7,
  PersistentVolumeClaim: 8,
  Service: 9,
  Deployment: 10,
  StatefulSet: 10,
  DaemonSet: 10,
  Job: 10,
  CronJob: 10,
  Pod: 10,
  HorizontalPodAutoscaler: 11,
  Ingress: 11,
};

function splitYamlDocs(yamlText) {
  if (!yamlText || typeof yamlText !== 'string') return [];
  const lines = yamlText.split(/\r?\n/);
  const docBlocks = [];
  let currentLines = [];
  let startLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') {
      if (currentLines.length > 0) {
        docBlocks.push({
          text: currentLines.join('\n'),
          startLine,
          endLine: i,
        });
        currentLines = [];
      }
      startLine = i + 2;
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    docBlocks.push({
      text: currentLines.join('\n'),
      startLine,
      endLine: lines.length,
    });
  }

  const results = [];
  for (const block of docBlocks) {
    if (!block.text.trim()) continue;
    try {
      const doc = k8s.loadYaml(block.text);
      if (doc && typeof doc === 'object') {
        results.push({
          doc,
          text: block.text,
          startLine: block.startLine,
          endLine: block.endLine,
        });
      }
    } catch {
      // Ignore empty or invalid comments in separator block
    }
  }

  return results;
}

function sortDocsForApply(docs) {
  if (!Array.isArray(docs)) return [];
  return [...docs].sort((a, b) => {
    const kindA = a?.doc?.kind || a?.kind;
    const kindB = b?.doc?.kind || b?.kind;
    const orderA = KIND_APPLY_ORDER[kindA] ?? 99;
    const orderB = KIND_APPLY_ORDER[kindB] ?? 99;
    return orderA - orderB;
  });
}

module.exports = {
  splitYamlDocs,
  sortDocsForApply,
  KIND_APPLY_ORDER,
};
