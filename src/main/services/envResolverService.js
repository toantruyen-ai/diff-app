const k8s = require('@kubernetes/client-node');
const { buildKubeConfig } = require('../utils/k8sHelper');
const { withTimeout } = require('../utils/timeout');

/**
 * Resolves environment variables for containers in a Kubernetes deployment.
 * Supports:
 * - envFrom (ConfigMap / Secret bulk import)
 * - env[].value (Direct)
 * - env[].valueFrom.configMapKeyRef
 * - env[].valueFrom.secretKeyRef
 * - env[].valueFrom.fieldRef / resourceFieldRef
 *
 * @param {string} kubeconfigPath
 * @param {string} contextName
 * @param {string} namespace
 * @param {string} deploymentName
 * @param {object} [customApis] Optional injection for unit testing
 * @returns {Promise<object>} envMap
 */
async function loadEnvs(kubeconfigPath, contextName, namespace, deploymentName, customApis) {
  let appsApi;
  let coreApi;

  if (customApis) {
    appsApi = customApis.appsApi;
    coreApi = customApis.coreApi;
  } else {
    const kc = buildKubeConfig(kubeconfigPath, contextName);
    appsApi = kc.makeApiClient(k8s.AppsV1Api);
    coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  const depRes = await withTimeout(
    appsApi.readNamespacedDeployment(deploymentName, namespace),
    20000,
    'Timed out reading deployment — kubelogin may need re-authentication'
  );
  const containers = depRes.body?.spec?.template?.spec?.containers || [];

  const envMap = {};

  for (const container of containers) {
    // 1. envFrom: configmap / secret bulk import
    for (const envFrom of container.envFrom || []) {
      if (envFrom.configMapRef) {
        const cmName = envFrom.configMapRef.name;
        try {
          const cmRes = await coreApi.readNamespacedConfigMap(cmName, namespace);
          const data = cmRes.body?.data || {};
          const prefix = envFrom.prefix || '';
          for (const [k, v] of Object.entries(data)) {
            envMap[prefix + k] = { value: v, source: `ConfigMap:${cmName}` };
          }
        } catch {
          envMap[`<${cmName}>`] = { value: '<error reading configmap>', source: `ConfigMap:${cmName}` };
        }
      }
      if (envFrom.secretRef) {
        const secName = envFrom.secretRef.name;
        try {
          const secRes = await coreApi.readNamespacedSecret(secName, namespace);
          const data = secRes.body?.data || {};
          const prefix = envFrom.prefix || '';
          for (const [k, v] of Object.entries(data)) {
            const decoded = Buffer.from(v, 'base64').toString('utf-8');
            envMap[prefix + k] = { value: decoded, source: `Secret:${secName}` };
          }
        } catch {
          envMap[`<${secName}>`] = { value: '<error reading secret>', source: `Secret:${secName}` };
        }
      }
    }

    // 2. Direct env / valueFrom
    for (const envVar of container.env || []) {
      if (envVar.value !== undefined) {
        envMap[envVar.name] = { value: envVar.value, source: 'Direct' };
      } else if (envVar.valueFrom) {
        const vf = envVar.valueFrom;
        if (vf.configMapKeyRef) {
          const cmName = vf.configMapKeyRef.name;
          const cmKey = vf.configMapKeyRef.key;
          try {
            const cmRes = await coreApi.readNamespacedConfigMap(cmName, namespace);
            const val = (cmRes.body?.data || {})[cmKey];
            envMap[envVar.name] = { value: val ?? '<key not found>', source: `ConfigMap:${cmName}[${cmKey}]` };
          } catch {
            envMap[envVar.name] = { value: '<error reading configmap>', source: `ConfigMap:${cmName}[${cmKey}]` };
          }
        } else if (vf.secretKeyRef) {
          const secName = vf.secretKeyRef.name;
          const secKey = vf.secretKeyRef.key;
          try {
            const secRes = await coreApi.readNamespacedSecret(secName, namespace);
            const raw = (secRes.body?.data || {})[secKey];
            const val = raw ? Buffer.from(raw, 'base64').toString('utf-8') : '<key not found>';
            envMap[envVar.name] = { value: val, source: `Secret:${secName}[${secKey}]` };
          } catch {
            envMap[envVar.name] = { value: '<error reading secret>', source: `Secret:${secName}[${secKey}]` };
          }
        } else if (vf.fieldRef) {
          envMap[envVar.name] = { value: `fieldRef:${vf.fieldRef.fieldPath}`, source: 'FieldRef' };
        } else if (vf.resourceFieldRef) {
          envMap[envVar.name] = { value: `resourceField:${vf.resourceFieldRef.resource}`, source: 'ResourceFieldRef' };
        }
      }
    }
  }

  return envMap;
}

module.exports = {
  loadEnvs,
};
