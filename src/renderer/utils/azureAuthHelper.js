function isAzureAuthError(err) {
  if (!err) return false;
  const msg = typeof err === 'string' ? err : (err.message || String(err));
  return /AADSTS|AzureCLICredential|refresh token has expired|sign-in frequency|re-authenticate|az login|token is expired|token expired|401 Unauthorized|Unauthorized|token may be expired/i.test(msg);
}

function handleAzureAuthError(err, showAuthModalFn, customMsg) {
  if (isAzureAuthError(err)) {
    if (typeof showAuthModalFn === 'function') {
      const defaultMsg = 'Azure CLI session or refresh token has expired. Please login again to re-authenticate.';
      showAuthModalFn(customMsg || defaultMsg);
    }
    return true;
  }
  return false;
}

module.exports = {
  isAzureAuthError,
  handleAzureAuthError,
};
