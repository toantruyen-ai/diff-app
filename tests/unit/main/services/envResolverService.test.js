import { describe, it, expect, vi } from 'vitest';
import { loadEnvs } from '../../../../src/main/services/envResolverService.js';

describe('envResolverService', () => {
  it('resolves direct envs, envFrom configmap, and secrets correctly', async () => {
    const mockAppsApi = {
      readNamespacedDeployment: vi.fn().mockResolvedValue({
        body: {
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: 'web',
                    envFrom: [
                      { configMapRef: { name: 'app-cm' } },
                      { secretRef: { name: 'app-sec' } },
                    ],
                    env: [
                      { name: 'DIRECT_VAR', value: 'hello' },
                      { name: 'CM_KEY_VAR', valueFrom: { configMapKeyRef: { name: 'app-cm', key: 'SPECIAL_KEY' } } },
                      { name: 'SEC_KEY_VAR', valueFrom: { secretKeyRef: { name: 'app-sec', key: 'DB_PASS' } } },
                      { name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } },
                    ],
                  },
                ],
              },
            },
          },
        },
      }),
    };

    const mockCoreApi = {
      readNamespacedConfigMap: vi.fn().mockImplementation((name) => {
        if (name === 'app-cm') {
          return Promise.resolve({ body: { data: { CM_KEY1: 'val1', SPECIAL_KEY: 'special-val' } } });
        }
        return Promise.reject(new Error('NotFound'));
      }),
      readNamespacedSecret: vi.fn().mockImplementation((name) => {
        if (name === 'app-sec') {
          return Promise.resolve({
            body: { data: { SEC_KEY1: Buffer.from('sec-val1').toString('base64'), DB_PASS: Buffer.from('p@ssword').toString('base64') } },
          });
        }
        return Promise.reject(new Error('NotFound'));
      }),
    };

    const customApis = { appsApi: mockAppsApi, coreApi: mockCoreApi };

    const envMap = await loadEnvs('test-kc', 'test-ctx', 'default', 'web-dep', customApis);

    expect(envMap.CM_KEY1).toEqual({ value: 'val1', source: 'ConfigMap:app-cm' });
    expect(envMap.SEC_KEY1).toEqual({ value: 'sec-val1', source: 'Secret:app-sec' });
    expect(envMap.DIRECT_VAR).toEqual({ value: 'hello', source: 'Direct' });
    expect(envMap.CM_KEY_VAR).toEqual({ value: 'special-val', source: 'ConfigMap:app-cm[SPECIAL_KEY]' });
    expect(envMap.SEC_KEY_VAR).toEqual({ value: 'p@ssword', source: 'Secret:app-sec[DB_PASS]' });
    expect(envMap.POD_IP).toEqual({ value: 'fieldRef:status.podIP', source: 'FieldRef' });
  });
});
