const path = require("node:path");
const fs = require("node:fs/promises");
const os = require('node:os');

const http = require("http");
const axios = require("axios");
const userid = require('userid');
const nunjucks = require("nunjucks");

const zlib = require('node:zlib');
const tar = require('tar-fs');
const stream = require('node:stream/promises');

const linuxUser = require('linux-sys-user').promise();

const env = nunjucks.configure("templates", { autoescape: true });

const runCommand = require("./utils/runCommand");

const noop = () => { };

async function sleep(ms) {
  return new Promise((r) => {
    setTimeout(r), ms;
  });
}

function randomIntFromInterval(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// fsPromises.chown(path, uid, gid)

/**
 *
 * @param {string} ip ip address to check
 * @returns {Boolean}
 */
function validIpv4Address(ip) {
  // first octet must start with 1-9, then next 3 can be 0.
  const ipv4Regex = /^[1-9]\d{0,2}\.(\d{0,3}\.){2}\d{0,3}$/;

  if (!ipv4Regex.test(ip)) return false;

  const octets = ip.split(".");
  const isValid = octets.every((octet) => parseInt(octet, 10) < 256);
  return isValid;
}

/**
 * Loops forever until external ip address is found. Chooses a random
 * provider from the provider list, then loops the list.
 * @returns {Promise<String>}
 */
async function getExternalIp() {
  const scheme = "https";
  const providers = ["ifconfig.me", "api.ipify.org"];
  const providerLength = providers.length;
  let providerIndex = randomIntFromInterval(0, providerLength);

  const httpAgent = new http.Agent({ family: 4 });

  const config = {
    timeout: 5000,
    httpAgent,
  };

  let ip = null;

  while (!ip) {
    const provider = providers.slice(providerIndex, 1);
    const { data } = await axios
      .get(`${scheme}://${provider}`, config)
      .catch(() => ({ data: null }));

    providerIndex = (providerIndex + 1) % providerLength;

    if (!data) {
      sleep(10_000);
    } else if (validIpv4Address(data)) ip = data;
  }
}

function createRandomString(length) {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array(length)
    .join()
    .split(",")
    .map(() => {
      return chars.charAt(Math.floor(Math.random() * chars.length));
    })
    .join("");
}

async function systemdDaemonReload() {
  await runCommand("systemctl", { params: ["daemon-reload"] });
}

/**
 *
 * @param {string} name Full service name. i.e. myservice.service.
 * @param {string} content The content of the service file.
 * @returns {Promise<Error|undefined>}
 */
async function writeServiceFile(name, content) {
  // this always exists
  const serviceDir = "/etc/systemd/system";
  const target = path.join(serviceDir, name);
  const error = await fs.writeFile(target, content).catch((err) => err);

  return error;
}

function generateTemplate(name, context) {
  const templateName = path.join(name, ".njk");

  let content = "";
  try {
    content = env.render(templateName, context);
  } catch { }

  return content;
}

async function readFile(name) {
  const base = "files";
  return await fs.readFile(path.join(base, name)).catch(() => "");
}

async function writeService(name, options = {}) {
  const isTemplate = options.isTemplate || false;
  const context = options.context || {};

  const content = isTemplate ? generateTemplate(name) : await readFile(name);

  await writeServiceFile(name, content);
}

async function createServices() {
  await writeService("syncthing");
  await writeService("fluxos");
  await writeService("fluxbenchd", {
    isTemplate: true,
    context: { datadir: "/usr/local/fluxbenchd" },
  });
  await writeService("fluxd", {
    isTemplate: true,
    context: { datadir: "/usr/local/fluxd" },
  });
}

async function createFluxdContext() {
  const rpcUser = createRandomString(8);
  const rpcPassword = createRandomString(20);
  const externalIp = await getExternalIp();
  const fluxPrivateKey = process.env.FLUX_PRIVATE_KEY;
  const fluxLockupTxid = process.env.FLUX_LOCKUP_TXID;
  const fluxLockupTxOutputId = process.env.FLUX_LOCKUP_TX_OUTPUT_ID;

  const context = {
    rpcUser,
    rpcPassword,
    externalIp,
    fluxPrivateKey,
    fluxLockupTxid,
    fluxLockupTxOutputId,
  };

  return context;
}

async function createUsers(users) {
  users.forEach(async (user) => {
    await linuxUser.addUser({ username: user, shell: null, system: true }).catch(noop);
  });
}

async function configureServices() {
  const base = "/usr/local";
  const services = ['syncthing', 'fluxos', 'fluxbenchd', 'fluxd'];
  const asUser = ['syncthing', 'fluxd'];

  await createUsers(asUser);

  services.forEach(async (service) => {
    const serviceDir = path.join(base, service);

    // rwx rx x = 0o751
    await fs.mkdir(serviceDir, { recursive: true, mode: 0o751 }).catch(noop);

    if (asUser.includes(service)) {
      try {
        const { uid, gid } = userid.ids(service);
        await fs.chown(serviceDir, uid, gid);
      } catch {
        // create user?
      }
    }
  });

  const fluxbenchConf = "fluxbench.conf";
  const fluxConf = "flux.conf";

  const fluxbenchContent = generateTemplate(fluxbenchConf, {
    fluxApiPort: process.env.FLUX_API_PORT,
  });

  const fluxdContext = await createFluxdContext();
  const fluxdContent = generateTemplate(fluxConf, fluxdContext);

  await fs
    .writeFile(path.join(base, "fluxbenchd", fluxbenchConf), fluxbenchContent)
    .catch(noop);

  await fs
    .writeFile(path.join(base, "fluxd", fluxConf), fluxdContent)
    .catch(noop);
}

async function installNodeJs(baseInstallDir, version, platform, arch, compression) {
  const base = 'https://nodejs.org/dist';
  const url = `${base}/${version}/node-${version}-${platform}-${arch}.tar.${compression}`;
  const installDir = path.join(baseInstallDir, 'lib', version);

  await fs.mkdir(installDir, { recursive: true, mode: 0o751 }).catch(noop);

  let error = false;
  let remainingAttempts = 3;

  const workflow = [];

  while (!error && remainingAttempts) {
    remainingAttempts -= 1;
    const stream = await axios({
      method: "get",
      url,
      responseType: "stream"
    });

    workflow.push(stream);
    workflow.push(zlib.createGunzip());
    workflow.push(tar.extract(installDir));

    const work = stream.pipeline.apply(null, workflow);

    try {
      await work;
    } catch (err) {
      log.warn(`Stream error: ${err.code}`);
      error = true;
    }
  }
}

async function migrate() {
  const requiredEnvVars = [
    "FLUX_API_PORT",
    "FLUX_PRIVATE_KEY",
    "FLUX_LOCKUP_TXID",
    "FLUX_LOCKUP_TX_OUTPUT_ID",
  ];

  if (os.userInfo().uid) {
    console.log('NOT ROOT')
    return;
  }

  const ok = requiredEnvVars.every((envVar) => process.env[envVar]);

  if (!ok) {
    console.log('MISSING ENV VAR')
    return;
  }

  await configureServices();
  await createServices();
  await systemdDaemonReload();
}

installNodeJs('/opt/nodejstest', 'v20.13.1', 'linux', 'x64', 'gz');
