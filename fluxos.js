const unix = require('unix-dgram');

/**
 * systemctl stop:
 *   By default, a SIGTERM is sent, followed by 90 seconds of waiting followed by a SIGKILL . Killing processes with systemd is very customizable and well-documented.
 *
 * sudo apt edit-sources (cat /etc/apt/sources.list)
 *
 * deb http://deb.debian.org/debian bookworm-backports main contrib non-free
 *
 * the -t below works when you've added the above source
 *
 * Systemd 253 added a service type of notify-reload. Bookwork has 252 by default.
 *
 * ON debian can get systemd 254 with sudo apt-get install -t bookworm-backports systemd
 */

/**
 * Behavior of notify-reload is similar to notify, with one difference: the SIGHUP UNIX process signal is sent to the service's main process when the service is asked to reload and the manager will wait for a notification about the reload being finished.

When initiating the reload process the service is expected to reply with a notification message via sd_notify(3) that contains the "RELOADING=1" field in combination with "MONOTONIC_USEC=" set to the current monotonic time (i.e. CLOCK_MONOTONIC in clock_gettime(2)) in μs, formatted as decimal string. Once reloading is complete another notification message must be sent, containing "READY=1". Using this service type and implementing this reload protocol is an efficient alternative to providing an ExecReload= command for reloading of the service's configuration.

The signal to send can be tweaked via ReloadSignal=, see below.
 */

const noop = () => { };

function sendReloadingIfSupported(target, context) {
  // const {name, addInitializer} = context;

  async function inner(...args) {
    if (this.inbandReload) {
      console.log("INBAND RELOAD")
      const start = Math.round(Number(process.hrtime.bigint()) / 1000);
      await this.notify(['RELOADING=1', `MONOTONIC_USEC=${start}`]);
    }

    const res = await target.call(this, ...args);

    if (this.inbandReload) {
      await this.notify(['READY=1']);
    }

    return res;
  }

  return inner;
};

class SystemdNotify {
  socketPath = process.env.NOTIFY_SOCKET;

  watchdogHalflifeMs = 0;
  watchdogTimer = null;

  connected = false;
  client = null;

  /**
   * @param {Boolean} inbandReload If service is running in systemd-notify mode
   */
  constructor(startFunc, reloadFunc, options = {}) {
    this.startFunc = startFunc;
    this.reloadFunc = reloadFunc;

    this.inbandReload = options.inbandReload || false;
    this.reloadSignal = options.reloadSignal || 'SIGHUP';

    if (!this.socketPath) return;

    if (process.env.WATCHDOG_USEC) {
      this.watchdogHalflifeMs = process.env.WATCHDOG_USEC / 1000 / 2
    }

    // call using arrow function to maintain this
    process.on(this.reloadSignal, () => this.reloadHandler());
  }

  @sendReloadingIfSupported
  async reloadHandler() {
    await this.reloadFunc();
  }

  /**
 * @returns {Promise<Socket>}
 */
  connect() {
    return new Promise((resolve, reject) => {
      this.client = unix.createSocket('unix_dgram');
      // set timeout reject.
      this.client.on('error', function (err) {
        console.error(err);
        reject(err);
      });

      this.client.once('connect', () => {
        this.connected = true;
        console.log('connected');
        // recv buffer full
        this.client.on('congestion', () => {
          console.log('congestion');
          /* The server is not accepting data */
        });

        // recv buffer cleared out
        this.client.on('writable', () => {
          console.log('writable');
          /* The server can accept data */
        });
        resolve(this.client);
        // this.client.send(message);
      });

      this.client.connect(this.socketPath);
    })
  }

  /**
   * @param {Socket} client The unix dgram socket client
   * @param {Array<String>} message Message to send
   */
  async notify(message) {
    if (!this.client || !this.connected) return;

    const formatted = `${message.join('\n')}\n`;
    const payload = Buffer.from(formatted, 'utf8');

    this.client.send(payload);
  }

  startWatchdog() {
    this.watchdogTimer = setInterval(async () => {
      // not sure if await is right here, it probably doesn't matter.
      console.log('WATCHDOGGING...');
      await this.notify(['WATCHDOG=1']);
    }, this.watchdogHalflifeMs);
  }

  async start() {
    // need some retry logic here. If we can't connect to the socket,
    // we should just start anyway though. Then systemd would hang on start, maybe it times out?
    // need to test.
    await this.connect().catch((err) => {
      console.log(err);
    });

    await this.startFunc();

    await this.notify(['READY=1']);

    if (this.watchdogHalflifeMs) this.startWatchdog();
  }
}

async function startFunction() {
  console.log('MOCK INIT MAIN FUNCTION (SLEEP 3 SECONDS)');
  await new Promise(r => setTimeout(r, 3_000));
  console.log('MOCK MAIN FUNCTION RUNNING');
}

async function reloadFunction() {
  console.log('MOCK RELOAD MAIN FUNCTION (SLEEP 3 SECONDS');
  await new Promise(r => setTimeout(r, 3_000));
  console.log('MOCK MAIN FUNCTION RELOADED');
}

async function init() {
  const notifier = new SystemdNotify(startFunction, reloadFunction);
  notifier.start();
}

init();
