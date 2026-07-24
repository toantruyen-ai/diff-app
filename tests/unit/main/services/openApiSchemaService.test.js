import { describe, it, expect } from 'vitest';
import {
  findRootSchemaName,
  resolveSchemaListMeta,
  cacheGvkSchema,
  getCachedGvkSchema,
} from '../../../../src/main/services/openApiSchemaService.js';

describe('openApiSchemaService', () => {
  const mockComponentsSchemas = {
    'io.k8s.api.apps.v1.Deployment': {
      'x-kubernetes-group-version-kind': [
        { group: 'apps', version: 'v1', kind: 'Deployment' },
      ],
      properties: {
        spec: {
          $ref: '#/components/schemas/io.k8s.api.apps.v1.DeploymentSpec',
        },
      },
    },
    'io.k8s.api.apps.v1.DeploymentSpec': {
      properties: {
        containers: {
          type: 'array',
          'x-kubernetes-list-type': 'map',
          'x-kubernetes-list-map-keys': ['name'],
        },
      },
    },
  };

  it('finds root schema name by group-version-kind', () => {
    const rootName = findRootSchemaName(mockComponentsSchemas, 'apps/v1', 'Deployment');
    expect(rootName).toBe('io.k8s.api.apps.v1.Deployment');
  });

  it('resolves x-kubernetes-list-type from OpenAPI component schemas', () => {
    const meta = resolveSchemaListMeta(
      mockComponentsSchemas,
      'io.k8s.api.apps.v1.Deployment',
      ['spec', 'containers']
    );
    expect(meta).toEqual({
      type: 'map',
      keys: ['name'],
    });
  });

  it('caches and retrieves schema with TTL', () => {
    cacheGvkSchema('cluster1:apps/v1:Deployment', mockComponentsSchemas);
    const cached = getCachedGvkSchema('cluster1:apps/v1:Deployment');
    expect(cached).toBeDefined();
    expect(cached).toEqual(mockComponentsSchemas);
  });
});
