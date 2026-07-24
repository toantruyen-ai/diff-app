import { describe, it, expect } from 'vitest';
import { splitYamlDocs, sortDocsForApply } from '../../../../src/main/utils/yamlMultiDocHelper.js';

describe('yamlMultiDocHelper', () => {
  it('splits multi-doc YAML string into array of doc entries', () => {
    const multiDoc = `
apiVersion: v1
kind: Namespace
metadata:
  name: prod
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
`;
    const docs = splitYamlDocs(multiDoc);
    expect(docs.length).toEqual(2);
    expect(docs[0].doc.kind).toEqual('Namespace');
    expect(docs[1].doc.kind).toEqual('Service');
  });

  it('sorts docs in Kubernetes dependency order', () => {
    const docs = [
      { doc: { kind: 'Deployment', metadata: { name: 'app' } } },
      { doc: { kind: 'Namespace', metadata: { name: 'ns' } } },
      { doc: { kind: 'ConfigMap', metadata: { name: 'cfg' } } },
    ];
    const sorted = sortDocsForApply(docs);
    expect(sorted.map((d) => d.doc.kind)).toEqual(['Namespace', 'ConfigMap', 'Deployment']);
  });
});
