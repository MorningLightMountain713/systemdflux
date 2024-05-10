const util = require('node:util');
const execFile = util.promisify(require('node:child_process').execFile);

const asyncLock = require('./asyncLock');

const log = { info: console.log, debug: console.log, warn: console.log, error: console.log };

/**
 * The max time a child process can run for (15 minutes)
 */
const MAX_CHILD_PROCESS_TIME = 15 * 60 * 1000;

/**
 * Allows for exclusive locks when running child processes
 */
const locks = new Map();

/**
 * Runs a command as a child process, without a shell by default.
 * Using a shell is possible with the `shell` option.
 * @param {string} cmd The binary to run. Must be in PATH
 * @param {{params?: string[], runAsRoot?: Boolean, exclusive?: Boolean, logError?: Boolean, cwd?: string, timeout?: number, signal?: AbortSignal, shell?: (Boolean|string)}} options
   @returns {Promise<{error: (Error|null), stdout: (string|null), stderr: (string|null)}>}
 */
async function runCommand(userCmd, options = {}) {
  const res = { error: null, stdout: '', stderr: '' };
  const {
    runAsRoot, logError, exclusive, ...execOptions
  } = options;

  const params = options.params || [];
  delete execOptions.params;

  // Default max of 15 minutes
  if (!Object.prototype.hasOwnProperty.call(execOptions, 'timeout')) {
    execOptions.timeout = MAX_CHILD_PROCESS_TIME;
  }

  if (!userCmd) {
    res.error = new Error('Command must be present');
    return res;
  }

  // number seems to get coerced to string in the execFile command, so have allowed
  if (!Array.isArray(params) || !params.every((p) => typeof p === 'string' || typeof p === 'number')) {
    res.error = new Error('Invalid params for command, must be an Array of strings');
    return res;
  }

  let cmd;
  if (runAsRoot) {
    params.unshift(userCmd);
    cmd = 'sudo';
  } else {
    cmd = userCmd;
  }

  log.debug(`Run Cmd: ${cmd} ${params.join(' ')}`);

  // delete the locks after no waiters?
  if (exclusive) {
    if (!locks.has(userCmd)) {
      locks.set(userCmd, new asyncLock.AsyncLock());
    }
    await locks.get(userCmd).enable();

    log.info(`Exclusive lock enabled for command: ${userCmd}`);
  }

  const { stdout, stderr } = await execFile(cmd, params, execOptions).catch((err) => {
    // do this so we can standardize the return value for errors vs non errors
    const { stdout: errStdout, stderr: errStderr } = err;

    // eslint-disable-next-line no-param-reassign
    delete err.stdout;
    // eslint-disable-next-line no-param-reassign
    delete err.stderr;

    res.error = err;
    if (logError !== false) log.error(err);
    return { stdout: errStdout, stderr: errStderr };
  });

  if (exclusive) {
    locks.get(userCmd).disable();
    log.info(`Exclusive lock disabled for command: ${userCmd}`);
  }

  res.stdout = stdout;
  res.stderr = stderr;

  return res;
}

module.exports = runCommand;
