# Codebase Standards Audit Report (Naming §1b & Security §1c)

**Date**: 2026-07-24  
**Target Repository**: `toantruyen-ai/diff-app` (`k8s-env-diff`)  
**Audit Scope**: Read-only audit against §1b (Naming Conventions) and §1c (Security Coding Standard) in `.agents/skills/implement-code-flow/SKILL.md` and `CLAUDE.md`.

---

## 1. Security Findings (§1c)

### High Severity

1. `src/main/services/azureService.js:73` · category `security` · severity `high`
   - **Description**: `spawn('az', ['login'], { shell: true, stdio: 'pipe' })` sets `shell: true`, enabling unnecessary shell command evaluation.
   - **Suggested Fix**: Change options to `{ shell: false, stdio: 'pipe' }` to prevent shell invocation (§1c: *"Use arg-array, shell: false"*).

2. `src/main/services/azureService.js:117` · category `security` · severity `high`
   - **Description**: `execSync` command string interpolates untrusted `name`, `resourceGroup`, and `tmpFile` variables into shell string: `` `az aks get-credentials --name "${name}" ...` ``.
   - **Suggested Fix**: Replace with `execFileSync('az', ['aks', 'get-credentials', '--name', name, '--resource-group', resourceGroup, '--file', tmpFile, '--overwrite-existing'], { encoding: 'utf8', timeout: 30000, stdio: 'pipe' })` (§1c: *"Never interpolate untrusted values into a shell string... Use arg-array execFileSync with shell: false"*).

3. `src/main/services/azureService.js:122` · category `security` · severity `high`
   - **Description**: `execSync` command string interpolates `tmpFile` variable: `` `kubelogin convert-kubeconfig -l azurecli --kubeconfig "${tmpFile}"` ``.
   - **Suggested Fix**: Replace with `execFileSync('kubelogin', ['convert-kubeconfig', '-l', 'azurecli', '--kubeconfig', tmpFile], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' })` (§1c: *"Use arg-array execFileSync with shell: false"*).

4. `src/main/services/azureService.js:169` · category `security` · severity `high`
   - **Description**: `execAsync` command string interpolates `account.name`: `` `az storage container list --account-name "${account.name}" ...` ``.
   - **Suggested Fix**: Replace with promisified `execFile` taking argument array `['storage', 'container', 'list', '--account-name', account.name, '--auth-mode', 'login', '--output', 'json']` and `{ shell: false }` (§1c: *"Use arg-array execFile with shell: false"*).

5. `src/main/services/azureService.js:217` · category `security` · severity `high`
   - **Description**: `execAsync` command string interpolates `ns.name` and `ns.resourceGroup`: `` `az servicebus queue list --namespace-name "${ns.name}" --resource-group "${ns.resourceGroup}" ...` ``.
   - **Suggested Fix**: Replace with promisified `execFile` taking argument array `['servicebus', 'queue', 'list', '--namespace-name', ns.name, '--resource-group', ns.resourceGroup, '--output', 'json']` and `{ shell: false }` (§1c: *"Use arg-array execFile with shell: false"*).

6. `src/main/services/azureService.js:114` · category `security` · severity `high`
   - **Description**: `getAksCredentials(name, resourceGroup)` does not validate `name` or `resourceGroup` format before CLI execution.
   - **Suggested Fix**: Validate `name` and `resourceGroup` against allow-list pattern `/^[a-z0-9][a-z0-9._-]*$/i` at top of function, returning `{ ok: false, reason: 'invalid-input' }` if invalid (§1c: *"Validate identifiers before use"*).

7. `src/main/services/azureService.js:166` · category `security` · severity `high`
   - **Description**: `listStorageContainers(accounts)` does not validate `account.name` format before passing to CLI execution.
   - **Suggested Fix**: Filter or validate `account.name` against `/^[a-z0-9][a-z0-9._-]*$/i` before passing to CLI execution (§1c: *"Validate identifiers before use"*).

8. `src/main/services/azureService.js:214` · category `security` · severity `high`
   - **Description**: `listServicebusQueues(namespaces)` does not validate `ns.name` or `ns.resourceGroup` format before CLI execution.
   - **Suggested Fix**: Validate `ns.name` and `ns.resourceGroup` against `/^[a-z0-9][a-z0-9._-]*$/i` before passing to CLI execution (§1c: *"Validate identifiers before use"*).

### Medium Severity

9. `src/main/index.js:35` · category `security` · severity `medium`
   - **Description**: `execSync` constructs shell execution string using template literal with `process.env.SHELL`: `` `${shell} -l -c 'echo $PATH'` ``.
   - **Suggested Fix**: Use `execFileSync(shell, ['-l', '-c', 'echo $PATH'], { encoding: 'utf8', timeout: 3000 })` to execute shell binary directly without shell string parsing (§1c: *"Use arg-array with shell: false"*).

10. `src/main/db/auditDb.js:195` · category `security` · severity `medium`
    - **Description**: `getVersions` query string-concatenates `limit` clause: `FETCH NEXT ${Math.min(limit || 50, 200)} ROWS ONLY`.
    - **Suggested Fix**: Pass `limit` via parameterized input `req.input('fetchLimit', sql.Int, Math.min(limit || 50, 200))` and reference `@fetchLimit` in query string (§1c: *"SQL (audit DB): always use mssql parameterized queries (request.input(...))"*).

11. `src/main/db/auditDb.js:236` · category `security` · severity `medium`
    - **Description**: `getDeletedResources` query string-concatenates `limit` clause: `FETCH NEXT ${Math.min(limit || 100, 200)} ROWS ONLY`.
    - **Suggested Fix**: Pass `limit` via parameterized input `req.input('fetchLimit', sql.Int, Math.min(limit || 100, 200))` and reference `@fetchLimit` in query string (§1c: *"SQL (audit DB): always use mssql parameterized queries (request.input(...))"*).

12. `src/main/ipc/auditHandler.js:33` · category `security` · severity `medium`
    - **Description**: IPC handlers in `auditHandler.js` (`get-resource-versions`, `get-deleted-resources`, `restore-deleted-resource`, `restore-resource-version`, `get-local-events`) pass untrusted renderer arguments directly to DB/K8s services without input shape and identifier validation.
    - **Suggested Fix**: Validate type/shape and check identifiers (`namespace`, `kind`, `name`) against pattern `/^[a-z0-9][a-z0-9._-]*$/i` at top of handlers, returning `{ ok: false, reason: 'invalid-input' }` if invalid (§1c: *"Validate IPC input"*).

### Low Severity / Documented Exceptions

13. `src/main/index.js:71` · category `security` · severity `low`
    - **Description**: `BrowserWindow` sets `sandbox: false` in `webPreferences`.
    - **Suggested Fix**: Retain as documented exception if preload requirements mandate it, or migrate preload to enable `sandbox: true` (§1c: *"Prefer sandbox: true; if a preload dependency forces sandbox: false, that is a documented exception"*). *(Known Exception)*

14. `src/main/ipc/appHandler.js:6` · category `security` · severity `low`
    - **Description**: `trigger-update` handler executes hardcoded update pipeline `curl -fsSL https://... | bash`.
    - **Suggested Fix**: Retain static URL execution without renderer inputs (§1c: *"Special trust point: must be hardcoded, never take renderer input"*). *(Known Exception)*

---

## 2. Naming Findings (§1b)

### Medium Severity

1. `src/main/ipc/appHandler.js:13` · category `naming` · severity `medium`
   - **Description**: IPC channel `get-app-version` is registered in `appHandler.js` but omitted from `window.k8sApi` in `src/preload/index.js`.
   - **Suggested Fix**: Expose `getAppVersion: () => ipcRenderer.invoke('get-app-version')` in `src/preload/index.js`, or clean up if obsolete (§1b: *"Preload request key mirrors IPC verb-noun 1:1"*).

### Low Severity

2. `src/main/ipc/auditHandler.js:10` · category `naming` · severity `low`
   - **Description**: IPC channel `audit-db-discover` uses `discoverAuditDb` in preload instead of 1:1 mirrored `auditDbDiscover`.
   - **Suggested Fix**: Update preload key to `auditDbDiscover` or align IPC channel to `discover-audit-db` (§1b: *"1:1 rule: IPC kebab-case ↔ preload camelCase verb-noun"*).

3. `src/preload/index.js:81` · category `naming` · severity `low`
   - **Description**: IPC channels `start-pod-logs` / `stop-pod-logs` use verb-first prefix instead of domain-first `<domain>-start` / `<domain>-stop`.
   - **Suggested Fix**: Retain as legacy streaming pattern (§1b: *"Streaming lifecycle — prefer <domain>-start / <domain>-stop pair for NEW streaming domains"*). *(Known Exception)*

---

## 3. Summary

| Severity | Security (§1c) | Naming (§1b) | Total |
|---|---|---|---|
| **High** | 8 | 0 | **8** |
| **Medium** | 4 | 1 | **5** |
| **Low / Known Exceptions** | 2 | 2 | **4** |
| **Total Findings** | **14** | **3** | **17** |

- **Newly Introduced Findings**: 13 (8 High, 5 Medium)
- **Pre-existing / Documented Exceptions**: 4 (`sandbox: false`, `trigger-update` script, `start-pod-logs` legacy channels, `audit-db-discover` family channel)
- **Unit Test Status**: All 39 unit tests currently pass.
