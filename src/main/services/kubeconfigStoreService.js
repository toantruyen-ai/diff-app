// In-memory kubeconfig store (AKS credentials)
const aksKcStore = new Map();
let aksKcIdSeq = 0;

const AKS_KC_STORE_MAX = 20;

function storeAksKc(raw) {
  const kcId = `aks:${++aksKcIdSeq}`;
  aksKcStore.set(kcId, raw);
  while (aksKcStore.size > AKS_KC_STORE_MAX) {
    aksKcStore.delete(aksKcStore.keys().next().value);
  }
  return kcId;
}

function touchAksKc(ref) {
  const raw = aksKcStore.get(ref);
  aksKcStore.delete(ref);
  aksKcStore.set(ref, raw);
  return raw;
}

function hasAksKc(ref) {
  return aksKcStore.has(ref);
}

function clearAksKcStore() {
  aksKcStore.clear();
  aksKcIdSeq = 0;
}

module.exports = {
  aksKcStore,
  storeAksKc,
  touchAksKc,
  hasAksKc,
  clearAksKcStore,
};
