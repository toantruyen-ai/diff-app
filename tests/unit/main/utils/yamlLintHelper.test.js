import { describe, it, expect } from 'vitest';
import { lintYamlText } from '../../../../src/main/utils/yamlLintHelper.js';

describe('yamlLintHelper', () => {
  it('returns syntax error for invalid YAML (L0)', () => {
    const invalidYaml = `
apiVersion: v1
kind: Pod
metadata
  name: bad: yaml: [
`;
    const res = lintYamlText(invalidYaml);
    expect(res.ok).toBe(false);
    expect(res.level).toBe('L0');
    expect(res.error).toBeDefined();
  });

  it('returns validation error for missing essential fields (L1)', () => {
    const missingKind = `
apiVersion: v1
metadata:
  name: test-pod
`;
    const res = lintYamlText(missingKind);
    expect(res.ok).toBe(false);
    expect(res.level).toBe('L1');
  });

  it('returns policy warnings/infos for pod/deployment manifests (L2)', () => {
    const podYaml = `
apiVersion: v1
kind: Pod
metadata:
  name: app-pod
spec:
  containers:
    - name: web
      image: nginx:latest
      securityContext:
        privileged: true
`;
    const res = lintYamlText(podYaml);
    expect(res.ok).toBe(true);
    expect(res.issues.length).toBeGreaterThan(0);

    const latestWarning = res.issues.find((i) => i.rule === 'image-latest');
    expect(latestWarning).toBeDefined();
    expect(latestWarning.severity).toBe('warning');

    const privWarning = res.issues.find((i) => i.rule === 'privileged-container');
    expect(privWarning).toBeDefined();
    expect(privWarning.severity).toBe('warning');

    const limitsWarning = res.issues.find((i) => i.rule === 'missing-resource-limits');
    expect(limitsWarning).toBeDefined();
  });
});
