const { registerAppHandlers } = require('./appHandler');
const { registerK8sHandlers } = require('./k8sHandler');
const { registerAzureHandlers } = require('./azureHandler');
const { registerResourceHandlers } = require('./resourceHandler');
const { registerWatchHandlers } = require('./watchHandler');
const { registerLogExecHandlers } = require('./logExecHandler');
const { registerAuditHandlers } = require('./auditHandler');

function registerAllIpcHandlers(getMainWindow) {
  registerAppHandlers();
  registerK8sHandlers();
  registerAzureHandlers();
  registerResourceHandlers();
  registerWatchHandlers(getMainWindow);
  registerLogExecHandlers(getMainWindow);
  registerAuditHandlers();
}

module.exports = {
  registerAllIpcHandlers,
};
