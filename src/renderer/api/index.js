/**
 * Type-safe API wrapper for Renderer process interacting with window.k8sApi
 */

function getK8sApi() {
  if (typeof window !== 'undefined' && window.k8sApi) {
    return window.k8sApi;
  }
  throw new Error('window.k8sApi is not available');
}

module.exports = {
  getK8sApi,
};
