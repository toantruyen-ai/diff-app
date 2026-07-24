const k8s = require('@kubernetes/client-node');

function lintYamlText(yamlText) {
  if (!yamlText || typeof yamlText !== 'string') {
    return { ok: false, level: 'L0', error: 'Empty YAML text' };
  }

  let doc;
  try {
    doc = k8s.loadYaml(yamlText);
  } catch (e) {
    return { ok: false, level: 'L0', error: e.message };
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, level: 'L0', error: 'Expected a single YAML object' };
  }

  if (!doc.apiVersion || typeof doc.apiVersion !== 'string') {
    return { ok: false, level: 'L1', error: 'Missing apiVersion' };
  }
  if (!doc.kind || typeof doc.kind !== 'string') {
    return { ok: false, level: 'L1', error: 'Missing kind' };
  }
  if (!doc.metadata || typeof doc.metadata !== 'object' || !doc.metadata.name) {
    return { ok: false, level: 'L1', error: 'Missing metadata.name' };
  }

  const issues = [];
  const podSpec = doc.kind === 'Pod' ? doc.spec : doc.spec?.template?.spec;

  if (doc.kind === 'Deployment' && doc.spec?.replicas === 1) {
    issues.push({
      rule: 'single-replica',
      severity: 'info',
      message: 'Single replica deployment has no high availability',
      path: ['spec', 'replicas'],
    });
  }

  if (podSpec && Array.isArray(podSpec.containers)) {
    podSpec.containers.forEach((container, idx) => {
      const containerPath = doc.kind === 'Pod'
        ? ['spec', 'containers', idx]
        : ['spec', 'template', 'spec', 'containers', idx];

      if (container.image) {
        if (container.image.endsWith(':latest') || !container.image.includes(':')) {
          issues.push({
            rule: 'image-latest',
            severity: 'warning',
            message: `Container "${container.name || idx}" uses :latest or untagged image`,
            path: [...containerPath, 'image'],
          });
        }
      }

      if (!container.resources || !container.resources.limits) {
        issues.push({
          rule: 'missing-resource-limits',
          severity: 'warning',
          message: `Container "${container.name || idx}" is missing resource limits`,
          path: [...containerPath, 'resources', 'limits'],
        });
      }

      if (!container.resources || !container.resources.requests) {
        issues.push({
          rule: 'missing-resource-requests',
          severity: 'info',
          message: `Container "${container.name || idx}" is missing resource requests`,
          path: [...containerPath, 'resources', 'requests'],
        });
      }

      if (!container.readinessProbe) {
        issues.push({
          rule: 'missing-readiness-probe',
          severity: 'info',
          message: `Container "${container.name || idx}" is missing readinessProbe`,
          path: [...containerPath, 'readinessProbe'],
        });
      }

      if (container.securityContext && container.securityContext.privileged === true) {
        issues.push({
          rule: 'privileged-container',
          severity: 'warning',
          message: `Container "${container.name || idx}" is privileged`,
          path: [...containerPath, 'securityContext', 'privileged'],
        });
      }
    });
  }

  return {
    ok: true,
    issues,
  };
}

module.exports = {
  lintYamlText,
};
