import { describe, it, expect, vi } from 'vitest';
import { isAzureAuthError, handleAzureAuthError } from '../../../src/renderer/utils/azureAuthHelper.js';

describe('azureAuthHelper', () => {
  it('detects AADSTS token expiry and refresh token errors', () => {
    const aadstsErr = 'Error: failed to get token: AzureCLICredential: ERROR: AADSTS70043: The refresh token has expired or is invalid due to sign-in frequency checks by conditional access.';
    expect(isAzureAuthError(aadstsErr)).toBe(true);
    expect(isAzureAuthError(new Error(aadstsErr))).toBe(true);
  });

  it('detects general az login / token expired / 401 Unauthorized errors', () => {
    expect(isAzureAuthError('Please run az login to re-authenticate')).toBe(true);
    expect(isAzureAuthError('Azure token is expired')).toBe(true);
    expect(isAzureAuthError('HTTP 401 Unauthorized')).toBe(true);
    expect(isAzureAuthError('kubelogin timed out after 15s — token may be expired')).toBe(true);
    expect(isAzureAuthError('random error')).toBe(false);
    expect(isAzureAuthError(null)).toBe(false);
  });

  it('triggers showAuthModal on azure auth error', () => {
    const mockShowModal = vi.fn();
    const aadstsErr = 'Error: failed to get token: AzureCLICredential: ERROR: AADSTS70043: The refresh token has expired';
    const handled = handleAzureAuthError(aadstsErr, mockShowModal);

    expect(handled).toBe(true);
    expect(mockShowModal).toHaveBeenCalledWith(expect.stringContaining('Azure CLI session or refresh token has expired'));
  });

  it('returns false and does not trigger modal for non-auth errors', () => {
    const mockShowModal = vi.fn();
    const handled = handleAzureAuthError('Connection timeout', mockShowModal);

    expect(handled).toBe(false);
    expect(mockShowModal).not.toHaveBeenCalled();
  });
});
