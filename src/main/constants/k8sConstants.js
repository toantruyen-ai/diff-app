const MANAGE_KINDS = [
  'pods', 'deployments', 'statefulsets', 'daemonsets', 'replicasets',
  'services', 'ingresses', 'configmaps', 'secrets',
  'jobs', 'cronjobs', 'pvcs', 'hpas',
  'nodes', 'pvs', 'namespaces', 'events',
  'serviceaccounts', 'roles', 'rolebindings', 'clusterroles', 'clusterrolebindings',
  'networkpolicies', 'storageclasses', 'resourcequotas', 'limitranges',
];

const ALL_NAMESPACES = '__all__';

const MANAGE_CLUSTER_SCOPED_KINDS = ['nodes', 'pvs', 'namespaces', 'clusterroles', 'clusterrolebindings', 'storageclasses'];

const RESTORABLE_KINDS = new Set([
  'deployments', 'statefulsets', 'daemonsets', 'services', 'ingresses', 'configmaps',
  'jobs', 'cronjobs', 'pvcs', 'hpas', 'namespaces',
  'serviceaccounts', 'roles', 'rolebindings', 'clusterroles', 'clusterrolebindings',
  'networkpolicies', 'storageclasses', 'resourcequotas', 'limitranges',
]);

const WATCH_ENABLED_KINDS = ['pods', 'deployments', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'events'];

const KIND_WATCH_META = {
  pods: { namespaced: true, path: (ns) => ns ? `/api/v1/namespaces/${ns}/pods` : '/api/v1/pods' },
  events: { namespaced: true, path: (ns) => ns ? `/api/v1/namespaces/${ns}/events` : '/api/v1/events' },
  deployments: { namespaced: true, path: (ns) => ns ? `/apis/apps/v1/namespaces/${ns}/deployments` : '/apis/apps/v1/deployments' },
  replicasets: { namespaced: true, path: (ns) => ns ? `/apis/apps/v1/namespaces/${ns}/replicasets` : '/apis/apps/v1/replicasets' },
  statefulsets: { namespaced: true, path: (ns) => ns ? `/apis/apps/v1/namespaces/${ns}/statefulsets` : '/apis/apps/v1/statefulsets' },
  daemonsets: { namespaced: true, path: (ns) => ns ? `/apis/apps/v1/namespaces/${ns}/daemonsets` : '/apis/apps/v1/daemonsets' },
  jobs: { namespaced: true, path: (ns) => ns ? `/apis/batch/v1/namespaces/${ns}/jobs` : '/apis/batch/v1/jobs' },
};

const MANAGE_ACCESS_VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'];

const MANAGE_KIND_LABEL = {
  pods: 'Pod', deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet',
  replicasets: 'ReplicaSet', services: 'Service', ingresses: 'Ingress', configmaps: 'ConfigMap',
  secrets: 'Secret', jobs: 'Job', cronjobs: 'CronJob', pvcs: 'PersistentVolumeClaim',
  hpas: 'HorizontalPodAutoscaler', nodes: 'Node', pvs: 'PersistentVolume', namespaces: 'Namespace', events: 'Event',
  serviceaccounts: 'ServiceAccount', roles: 'Role', rolebindings: 'RoleBinding',
  clusterroles: 'ClusterRole', clusterrolebindings: 'ClusterRoleBinding',
  networkpolicies: 'NetworkPolicy', storageclasses: 'StorageClass',
  resourcequotas: 'ResourceQuota', limitranges: 'LimitRange',
};

const MANAGE_KIND_GVR = {
  pods: { group: '', resource: 'pods' }, deployments: { group: 'apps', resource: 'deployments' },
  statefulsets: { group: 'apps', resource: 'statefulsets' }, daemonsets: { group: 'apps', resource: 'daemonsets' },
  replicasets: { group: 'apps', resource: 'replicasets' }, services: { group: '', resource: 'services' },
  ingresses: { group: 'networking.k8s.io', resource: 'ingresses' }, configmaps: { group: '', resource: 'configmaps' },
  secrets: { group: '', resource: 'secrets' }, jobs: { group: 'batch', resource: 'jobs' },
  cronjobs: { group: 'batch', resource: 'cronjobs' }, pvcs: { group: '', resource: 'persistentvolumeclaims' },
  hpas: { group: 'autoscaling', resource: 'horizontalpodautoscalers' }, nodes: { group: '', resource: 'nodes' },
  pvs: { group: '', resource: 'persistentvolumes' }, namespaces: { group: '', resource: 'namespaces' },
  events: { group: '', resource: 'events' },
  serviceaccounts: { group: '', resource: 'serviceaccounts' }, roles: { group: 'rbac.authorization.k8s.io', resource: 'roles' },
  rolebindings: { group: 'rbac.authorization.k8s.io', resource: 'rolebindings' },
  clusterroles: { group: 'rbac.authorization.k8s.io', resource: 'clusterroles' },
  clusterrolebindings: { group: 'rbac.authorization.k8s.io', resource: 'clusterrolebindings' },
  networkpolicies: { group: 'networking.k8s.io', resource: 'networkpolicies' },
  storageclasses: { group: 'storage.k8s.io', resource: 'storageclasses' },
  resourcequotas: { group: '', resource: 'resourcequotas' },
  limitranges: { group: '', resource: 'limitranges' },
};

module.exports = {
  MANAGE_KINDS,
  ALL_NAMESPACES,
  MANAGE_CLUSTER_SCOPED_KINDS,
  RESTORABLE_KINDS,
  WATCH_ENABLED_KINDS,
  KIND_WATCH_META,
  MANAGE_ACCESS_VERBS,
  MANAGE_KIND_LABEL,
  MANAGE_KIND_GVR,
};
