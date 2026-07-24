import { describe, it, expect } from 'vitest';
import { mapPathToPosition } from '../../../../src/main/utils/yamlPosHelper.js';

describe('yamlPosHelper', () => {
  it('returns line and column for existing field path', () => {
    const yamlText = `apiVersion: v1
kind: Pod
metadata:
  name: my-pod
spec:
  containers:
    - name: app
      image: nginx:1.25`;

    const posName = mapPathToPosition(yamlText, ['metadata', 'name']);
    expect(posName).toEqual({ line: 4, column: 3 });

    const posImage = mapPathToPosition(yamlText, ['spec', 'containers', 'name=app', 'image']);
    expect(posImage).toEqual({ line: 8, column: 7 });
  });

  it('returns null for server-injected fields absent in user YAML', () => {
    const yamlText = `apiVersion: v1
kind: Pod
metadata:
  name: my-pod`;

    const pos = mapPathToPosition(yamlText, ['spec', 'containers', '0', 'imagePullPolicy']);
    expect(pos).toBeNull();
  });
});
