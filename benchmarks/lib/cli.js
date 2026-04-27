'use strict';

/**
 * Shared CLI argument parsing utilities
 */

/**
 * Parse command-line arguments
 * Supports:
 * - --flag value (sets flag to "value")
 * - --flag=value (sets flag to "value")
 * - --flag (sets flag to true)
 *
 * @param {string[]} argv - Array of command-line arguments
 * @returns {Object} Parsed arguments as key-value pairs
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      // Handle --flag=value
      if (arg.includes('=')) {
        const eqIndex = arg.indexOf('=');
        const key = arg.slice(2, eqIndex);
        const value = arg.slice(eqIndex + 1);
        args[key] = value;
      }
      // Handle --flag value or --flag (boolean)
      else {
        const key = arg.slice(2);
        const nextArg = argv[i + 1];
        // If next arg exists and doesn't start with --, it's the value
        if (nextArg && !nextArg.startsWith('--')) {
          args[key] = nextArg;
          i++; // Skip next arg since we consumed it
        } else {
          // Boolean flag
          args[key] = true;
        }
      }
    }
  }
  return args;
}

module.exports = {
  parseArgs,
};
