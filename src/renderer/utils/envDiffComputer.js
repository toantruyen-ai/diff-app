/**
 * Masks a secret value if maskSecrets is enabled.
 * @param {string|null} val 
 * @param {string} source 
 * @param {boolean} maskSecrets 
 * @returns {string}
 */
function maskValue(val, source, maskSecrets = true) {
  if (!maskSecrets) return val ?? '';
  if (source && source.toLowerCase().includes('secret')) return val ? '••••••••' : '';
  return val ?? '';
}

/**
 * Returns CSS class name for a given source type.
 * @param {string} source 
 * @returns {string}
 */
function getSourceClass(source) {
  if (!source) return 'source-missing';
  const s = source.toLowerCase();
  if (s === 'direct') return 'source-direct';
  if (s.startsWith('configmap')) return 'source-configmap';
  if (s.startsWith('secret')) return 'source-secret';
  if (s.startsWith('fieldref') || s.startsWith('resourcefield')) return 'source-fieldref';
  return 'source-missing';
}

/**
 * Formats source string into concise UI label.
 * @param {string} source 
 * @returns {string}
 */
function formatSourceLabel(source) {
  if (!source) return '?';
  if (source === 'Direct') return 'Direct';
  if (source.startsWith('ConfigMap:')) return `CM: ${source.replace('ConfigMap:', '').split('[')[0]}`;
  if (source.startsWith('Secret:')) return `Sec: ${source.replace('Secret:', '').split('[')[0]}`;
  if (source === 'FieldRef') return 'FieldRef';
  return source;
}

/**
 * Computes env diff rows between two environment maps.
 * @param {object} leftEnvs 
 * @param {object} rightEnvs 
 * @param {object} [options] { filter: 'all'|'diff'|'same'|'missing', search: '', maskSecrets: true }
 * @returns {object} { rows, totalDiff, totalSame, totalMissing }
 */
function computeEnvDiffRows(leftEnvs = {}, rightEnvs = {}, options = {}) {
  const filter = options.filter || 'all';
  const search = (options.search || '').toLowerCase();
  const maskSecrets = options.maskSecrets !== false;

  const allKeys = Array.from(
    new Set([...Object.keys(leftEnvs), ...Object.keys(rightEnvs)])
  ).sort();

  const rows = [];
  let totalDiff = 0;
  let totalSame = 0;
  let totalMissing = 0;

  for (const key of allKeys) {
    const lEntry = leftEnvs[key];
    const rEntry = rightEnvs[key];
    const lVal = lEntry?.value;
    const rVal = rEntry?.value;

    let rowType;
    if (lEntry && rEntry) rowType = lVal === rVal ? 'same' : 'diff';
    else rowType = 'missing';

    if (rowType === 'diff') totalDiff++;
    else if (rowType === 'same') totalSame++;
    else totalMissing++;

    if (filter !== 'all' && filter !== rowType) continue;
    if (search && !key.toLowerCase().includes(search)) continue;

    const source = lEntry?.source || rEntry?.source || 'Unknown';
    rows.push({
      key,
      rowType,
      source,
      sourceLabel: formatSourceLabel(source),
      leftPresent: !!lEntry,
      rightPresent: !!rEntry,
      leftValue: lEntry ? maskValue(lVal, source, maskSecrets) : null,
      rightValue: rEntry ? maskValue(rVal, source, maskSecrets) : null,
    });
  }

  return { rows, totalDiff, totalSame, totalMissing };
}

module.exports = {
  maskValue,
  getSourceClass,
  formatSourceLabel,
  computeEnvDiffRows,
};
