import { describe, it, expect } from 'vitest';
import { parseSsaConflicts } from '../../../../src/main/utils/yamlConflictParser.js';

describe('yamlConflictParser', () => {
  it('parses structured conflict messages from SSA 409 body', () => {
    const errorBody = {
      message: 'Apply failed with 1 conflict: Conflict: .spec.replicas manager: hpa-controller',
    };
    const conflicts = parseSsaConflicts(errorBody);
    expect(conflicts.length).toEqual(1);
    expect(conflicts[0].field).toEqual('.spec.replicas');
    expect(conflicts[0].manager).toEqual('hpa-controller');
  });

  it('returns generic conflict when message pattern is unknown', () => {
    const conflicts = parseSsaConflicts('Generic 409 Conflict');
    expect(conflicts.length).toEqual(1);
    expect(conflicts[0].message).toEqual('Generic 409 Conflict');
  });

  it('parses real Kubernetes API server SSA 409 details.causes and conflict with manager strings', () => {
    const realK8sStatusBody = {
      kind: 'Status',
      apiVersion: 'v1',
      status: 'Failure',
      message: 'Apply failed with 1 conflict: conflict with "kubectl-client-side-apply" using apps/v1: .spec.template.spec.containers[name="web"].image',
      reason: 'Conflict',
      details: {
        causes: [
          {
            reason: 'Conflict',
            message: 'conflict with "kubectl-client-side-apply" using apps/v1: .spec.template.spec.containers[name="web"].image',
            field: '.spec.template.spec.containers[name="web"].image',
          },
        ],
      },
      code: 409,
    };
    const conflicts = parseSsaConflicts(realK8sStatusBody);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('.spec.template.spec.containers[name="web"].image');
    expect(conflicts[0].manager).toBe('kubectl-client-side-apply');
  });

  it('parses complex field paths with brackets, equals, commas, quotes and extracts manager correctly', () => {
    const rawMsg = 'Apply failed with 1 conflict: conflict with "kubectl-client-side-apply" using apps/v1: .spec.template.spec.containers[name="bi-base-script"].ports[containerPort=8000,protocol="TCP"].name';
    const conflicts = parseSsaConflicts(rawMsg);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('.spec.template.spec.containers[name="bi-base-script"].ports[containerPort=8000,protocol="TCP"].name');
    expect(conflicts[0].manager).toBe('kubectl-client-side-apply');
  });
});
