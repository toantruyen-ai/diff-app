const { registerAppHandlers } = require('./appHandler');
const { registerK8sHandlers } = require('./k8sHandler');
const { registerAzureHandlers } = require('./azureHandler');
const { registerResourceHandlers } = require('./resourceHandler');
const { registerWatchHandlers } = require('./watchHandler');
const { registerLogExecHandlers } = require('./logExecHandler');
const { registerMultiPodLogHandlers } = require('./multiPodLogHandler');
const { registerAuditHandlers } = require('./auditHandler');
const { registerYamlHandler } = require('./yamlHandler');
const { registerDebugHandlers } = require('./debugHandler');
const { registerTroubleshootingHandlers } = require('./troubleshootingHandler');

function registerAllIpcHandlers(getMainWindow) {
  registerAppHandlers();
  registerK8sHandlers();
  registerAzureHandlers();
  registerResourceHandlers();
  registerWatchHandlers(getMainWindow);
  registerLogExecHandlers(getMainWindow);
  registerMultiPodLogHandlers(getMainWindow);
  registerAuditHandlers();
  registerYamlHandler();
  registerDebugHandlers(getMainWindow);
  registerTroubleshootingHandlers();
}

module.exports = {
  registerAllIpcHandlers,
};
