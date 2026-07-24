import { describe, it, expect } from 'vitest';
import {
  maskValue,
  getSourceClass,
  formatSourceLabel,
  computeEnvDiffRows,
} from '../../../src/renderer/utils/envDiffComputer.js';

describe('envDiffComputer', () => {
  it('maskValue masks secrets when enabled', () => {
    expect(maskValue('secret-pass', 'Secret:my-sec', true)).toBe('••••••••');
    expect(maskValue('secret-pass', 'Secret:my-sec', false)).toBe('secret-pass');
    expect(maskValue('normal-val', 'Direct', true)).toBe('normal-val');
  });

  it('getSourceClass maps source strings to CSS classes', () => {
    expect(getSourceClass('Direct')).toBe('source-direct');
    expect(getSourceClass('ConfigMap:cm-1')).toBe('source-configmap');
    expect(getSourceClass('Secret:sec-1')).toBe('source-secret');
  });

  it('formatSourceLabel produces clean UI labels', () => {
    expect(formatSourceLabel('ConfigMap:app-config[KEY]')).toBe('CM: app-config');
    expect(formatSourceLabel('Secret:app-secret[PASS]')).toBe('Sec: app-secret');
    expect(formatSourceLabel('Direct')).toBe('Direct');
  });

  it('computeEnvDiffRows correctly categorizes diff, same, and missing rows', () => {
    const leftEnvs = {
      VAR_SAME: { value: '123', source: 'Direct' },
      VAR_DIFF: { value: 'a', source: 'ConfigMap:cm1' },
      VAR_ONLY_LEFT: { value: 'x', source: 'Direct' },
    };
    const rightEnvs = {
      VAR_SAME: { value: '123', source: 'Direct' },
      VAR_DIFF: { value: 'b', source: 'ConfigMap:cm1' },
      VAR_ONLY_RIGHT: { value: 'y', source: 'Direct' },
    };

    const res = computeEnvDiffRows(leftEnvs, rightEnvs);
    expect(res.totalSame).toBe(1);
    expect(res.totalDiff).toBe(1);
    expect(res.totalMissing).toBe(2);
    expect(res.rows).toHaveLength(4);
  });
});
