import { describe, it, expect } from 'vitest';
import { resolveListMeta } from '../../../../src/main/utils/listTypeResolver.js';

describe('listTypeResolver', () => {
  it('resolves known core list types by field name', () => {
    expect(resolveListMeta(['spec', 'template', 'spec', 'containers'])).toEqual({
      type: 'map',
      keys: ['name'],
    });

    expect(resolveListMeta(['spec', 'template', 'spec', 'containers', '0', 'ports'])).toEqual({
      type: 'map',
      keys: ['containerPort', 'protocol'],
    });

    expect(resolveListMeta(['metadata', 'finalizers'])).toEqual({
      type: 'set',
    });

    expect(resolveListMeta(['spec', 'template', 'spec', 'containers', '0', 'command'])).toEqual({
      type: 'atomic',
    });
  });

  it('defaults unknown arrays to atomic if not in schema or fallback table', () => {
    expect(resolveListMeta(['spec', 'unknownList'])).toEqual({
      type: 'atomic',
    });
  });
});
