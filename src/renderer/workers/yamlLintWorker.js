// Web Worker for L0-L2 Real-time YAML Validation and Linting
const { lintYamlText } = require('../../main/utils/yamlLintHelper');

if (typeof self !== 'undefined') {
  self.onmessage = function (e) {
    const { reqId, text } = e.data || {};
    if (!reqId) return;

    const result = lintYamlText(text);
    self.postMessage({ reqId, result });
  };
}

module.exports = {
  lintYamlText,
};
