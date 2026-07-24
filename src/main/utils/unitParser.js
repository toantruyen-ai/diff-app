/**
 * Parses CPU resource strings into millicores.
 * e.g. '250m' -> 250, '1' -> 1000, '1500000000n' -> 1500, '2000u' -> 2
 * @param {string|number} cpu 
 * @returns {number}
 */
function parseCpuMillis(cpu) {
  const s = String(cpu || '0');
  if (s.endsWith('n')) return parseFloat(s) / 1e6;
  if (s.endsWith('u')) return parseFloat(s) / 1e3;
  if (s.endsWith('m')) return parseFloat(s);
  return parseFloat(s) * 1000;
}

/**
 * Parses memory resource strings into bytes.
 * e.g. '128974848' -> bytes, '512Ki'/'256Mi'/'1Gi', '500K'/'2M' -> bytes
 * @param {string|number} mem 
 * @returns {number}
 */
function parseMemoryBytes(mem) {
  const match = String(mem || '0').match(/^(\d+(?:\.\d+)?)([A-Za-z]*)$/);
  if (!match) return 0;
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1000, M: 1000 ** 2, G: 1000 ** 3 };
  return parseFloat(match[1]) * (units[match[2]] || 1);
}

module.exports = {
  parseCpuMillis,
  parseMemoryBytes,
};
