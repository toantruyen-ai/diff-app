/**
 * Wraps a promise with a timeout in milliseconds.
 * @param {Promise<any>} promise 
 * @param {number} ms 
 * @param {string} [message] 
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || `Request timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

module.exports = {
  withTimeout,
};
