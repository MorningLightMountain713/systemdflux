const path = require("node:path");
const fs = require("node:fs/promises");
const os = require('node:os');

const http = require("http");
const axios = require("axios");
const simpleGit = require('simple-git');
const userid = require('userid');
const nunjucks = require("nunjucks");
const xml = require("fast-xml-parser");


const zlib = require('node:zlib');
const tar = require('tar-fs');
const stream = require('node:stream/promises');

let linuxUser;

if (process.platform === 'linux') {
  linuxUser = require('linux-sys-user').promise();
}

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
    timeout: 5_000,
    httpAgent,
  };

  while (true) {
    const provider = providers.slice(providerIndex, 1);
    const { data } = await axios
      .get(`${scheme}://${provider}`, config)
      .catch(() => ({ data: null }));

    if (data && validIpv4Address(data)) {
      return data;
    }

    providerIndex = (providerIndex + 1) % providerLength;
    await sleep(10_000);
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
  const templateName = `${name}.njk`;

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

async function writeService(serviceName, options = {}) {
  const isTarget = options.isTarget || false;
  const context = options.context || null;

  const name = isTarget ? `${serviceName}.target` : `${serviceName}.service`;

  const content = context ? generateTemplate(name, context) : await readFile(name);

  await writeServiceFile(name, content);
}

async function enableServices() {
  const services = ['syncthing', 'fluxos', 'fluxbenchd', 'fluxd'];
  services.forEach(async (service) => {
    await runCommand('systemctl', { params: ['enable', service] });
  })
};

async function createServices() {
  await writeService("syncthing");
  await writeService("fluxos");
  await writeService("fluxbenchd", {
    context: { datadir: "/usr/local/fluxbenchd" },
  });
  await writeService("fluxd", {
    context: { datadir: "/usr/local/fluxd" },
  });
  await writeService("flux", {
    isTarget: true,
  });
}

async function createFluxdContext() {
  const rpcUser = createRandomString(8);
  const rpcPassword = createRandomString(20);
  // this will hang forever.
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
  if (!process.platform === 'linux') return;

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

async function installFluxOs(nodejsVersion) {
  const urlFluxLatestTag = 'https://api.github.com/repos/runonflux/flux/releases/latest';
  const fluxosDir = '/usr/local/fluxos';
  const versionFile = path.join(fluxosDir, 'version');
  const npm = '/opt/nodejs/bin/npm';

  let fluxosTag = null;

  while (!fluxosTag) {
    const { data: { tag_name } } = await axios
      .get(urlFluxLatestTag, { timeout: 5_000 })
      .catch(() => ({ data: { tag_name: null } }));

    fluxosTag = tag_name ? tag_name : await sleep(10_000);
  }

  const localVersion = await fs.readFile(versionFile).catch(() => '');

  if (localVersion === fluxosTag) return;

  // could read the nodejs version file here instead of passing in the nodejs version
  const fluxosLibDir = path.join(fluxosDir, 'lib', nodejsVersion, fluxosTag);
  await fs.mkdir(fluxosLibDir, { recursive: true }).catch(noop);

  const git = simpleGit();
  const err = await git.clone('https://github.com/runonflux/flux.git', fluxosLibDir, { '--depth': 1, '--branch': 'feature/migration' }).catch((err) => err);
  delete git;

  if (err) return;

  await runCommand(npm, { cwd: fluxosLibDir, params: ['install'] });

  console.log('about to symlink')
  await fs.symlink(fluxosLibDir, '/usr/local/fluxos/current').catch(noop);
}

async function installNodeJs(baseInstallDir, version, platform, arch, compression) {
  const base = 'https://nodejs.org/dist';
  const fullVersion = `node-${version}-${platform}-${arch}`;
  const url = `${base}/${version}/${fullVersion}.tar.${compression}`;
  const extractDir = path.join(baseInstallDir, 'lib');
  const installDir = path.join(extractDir, fullVersion);
  const versionFile = path.join(baseInstallDir, 'version');
  const binDir = path.join(baseInstallDir, 'bin');
  const nodeExecutables = ['node', 'npm', 'npx'];

  const installedVersion = await fs.readFile(versionFile).catch(() => '');

  if (installedVersion === version) {
    console.log(`NodeJS version: ${version} already installed`);
    return;
  }

  await fs.mkdir(extractDir, { recursive: true, mode: 0o751 }).catch(noop);
  await fs.mkdir(binDir, { recursive: true, mode: 0o751 }).catch(noop);

  let remainingAttempts = 3;

  while (remainingAttempts) {
    remainingAttempts -= 1;

    const workflow = [];
    const { data: readStream } = await axios({
      method: "get",
      url,
      responseType: "stream"
    });

    workflow.push(readStream);
    workflow.push(zlib.createGunzip());
    workflow.push(tar.extract(extractDir));

    const work = stream.pipeline.apply(null, workflow);

    let error = false;

    try {
      await work;
    } catch (err) {
      console.log(`Stream error: ${err.code}`);
      error = true;
    }

    if (!error) break;
  }

  // we haven't checked the above error
  nodeExecutables.forEach(async (executable) => {
    const target = path.join(installDir, 'bin', executable);
    const name = path.join(binDir, executable);

    await fs.rm(name, { force: true }).catch(noop);
    await fs.symlink(target, name).catch(noop);
  });

  await fs.writeFile(versionFile, version).catch(noop);
}

async function generateSyncthingconfig() {
  const apiPort = process.env.FLUX_API_PORT;
  const syncthingDir = '/usr/local/syncthing';
  const configPath = path.join(syncthingDir, 'config.xml')

  if (await fs.stat(configPath).catch(() => false)) return;

  await runCommand('syncthing', { params: ['generate', '--home', syncthingDir, '--no-default-folder'] });

  const rawConfig = await fs.readFile(configPath);

  const options = {
    ignoreAttributes: false,
    format: true,
    attributeNamePrefix: "@_"
  };
  const parser = new xml.XMLParser(options);
  const parsedConfig = parser.parse(rawConfig);
  parsedConfig.configuration.gui['@_enabled'] = false;

  parsedConfig.configuration.options.listenAddress = [`tcp://:${apiPort}`, `quic://:${apiPort}`];

  const builder = new xml.XMLBuilder(options);
  const xmlConfig = builder.build(parsedConfig);
  await fs.writeFile(configPath, xmlConfig).catch(noop);

  const { uid, gid } = userid.ids('syncthing');
  await fs.chown(configPath, uid, gid).catch(noop);
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

  const { platform, arch } = process;

  await installNodeJs('/opt/nodejstest', 'v20.13.1', platform, arch, 'gz');
  await generateSyncthingconfig();
  await configureServices();
  await createServices();
  await systemdDaemonReload();
  await enableServices()
  // await startServices();
  // copy userconfig
}

// migrate();
installFluxOs('v20.13.1');


// issues to fix

// userconfig
// it's looking for flux config file...
