const path = require("node:path");
const fs = require("node:fs/promises");
const os = require('node:os');

const http = require("http");
const axios = require("axios");
const simpleGit = require('simple-git');
const nunjucks = require("nunjucks");
const xml = require("fast-xml-parser");
const ini = require('ini');

const ssh = require('ed25519-keygen/ssh');
const { randomBytes } = require('ed25519-keygen/utils');

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
  } catch (err) {
    console.log(err);
  }

  return content;
}

async function readFile(name) {
  const base = "files";
  return await fs.readFile(path.join(base, name)).catch(() => '');
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

// async function startServices() {
//   await runCommand('systemctl', { params: ['start', 'flux.target'] });
// }

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

async function createUsers(users) {
  if (!process.platform === 'linux') return;

  users.forEach(async (user) => {
    await linuxUser.addUser({ username: user, shell: null, system: true }).catch(noop);
  });
}

async function configureServices(fluxosUserConfig, fluxdContext) {
  const { fluxApiPort, fluxosRawConfig } = fluxosUserConfig;

  const base = "/usr/local";
  const services = ['syncthing', 'fluxos', 'fluxbenchd', 'fluxd'];
  const asUser = ['syncthing', 'fluxd'];

  await createUsers(asUser);

  services.forEach(async (service) => {
    const serviceDir = path.join(base, service);

    // rwx rx x = 0o751 - don't need this anymore I don't think
    await fs.mkdir(serviceDir, { recursive: true, mode: 0o751 }).catch(noop);

    if (asUser.includes(service)) {
      try {
        const { uid, gid } = await linuxUser.getUserInfo(service).catch(noop);
        await fs.chown(serviceDir, uid, gid);
      } catch {
        // create user?
      }
    }
  });

  const fluxbenchConf = "fluxbench.conf";
  const fluxdConf = "flux.conf";
  const fluxosUserConf = "userconfig.js"

  const fluxbenchContent = generateTemplate(fluxbenchConf, { fluxApiPort });

  const rpcUser = createRandomString(8);
  const rpcPassword = createRandomString(20);

  const fullFluxdContext = {
    rpcUser,
    rpcPassword,
    ...fluxdContext,
  };

  const fluxdContent = generateTemplate(fluxdConf, fullFluxdContext);

  await fs
    .writeFile(path.join(base, "fluxbenchd", fluxbenchConf), fluxbenchContent)
    .catch(noop);

  await fs
    .writeFile(path.join(base, "fluxd", fluxdConf), fluxdContent)
    .catch(noop);

  await fs
    .writeFile(path.join(base, 'fluxos', fluxosUserConf), fluxosRawConfig);

  return { rpcUser, rpcPassword };
}

async function installFluxOs(nodejsVersion, nodejsInstallDir) {
  const urlFluxLatestTag = 'https://api.github.com/repos/runonflux/flux/releases/latest';

  let fluxosTag = null;

  while (!fluxosTag) {
    const { data: { tag_name } } = await axios
      .get(urlFluxLatestTag, { timeout: 5_000 })
      .catch(() => ({ data: { tag_name: null } }));

    fluxosTag = tag_name ? tag_name : await sleep(10_000);
  }

  const fluxosDir = '/usr/local/fluxos';
  // could read the nodejs version file here instead of passing in the nodejs version
  const fluxosLibDir = path.join(fluxosDir, 'lib', nodejsVersion, fluxosTag);
  const versionFile = path.join(fluxosDir, 'version');
  const npm = path.join(nodejsInstallDir, 'bin/npm');

  const localVersion = await fs.readFile(versionFile, 'utf-8').catch(() => '');

  // for testing new branch
  fluxosTag = 'feature/migration';

  if (localVersion === fluxosTag) return fluxosLibDir;

  await fs.mkdir(fluxosLibDir, { recursive: true }).catch(noop);

  const git = simpleGit();
  const err = await git.clone('https://github.com/runonflux/flux.git', fluxosLibDir, { '--depth': 1, '--branch': fluxosTag }).catch((err) => err);
  // this is just a hack so that the node actually works (we update fluxService to point to this)
  await git.clone('https://github.com/runonflux/flux.git', path.join(fluxosDir, 'canonical'), { '--depth': 1 }).catch(noop);

  const fluxServiceFile = path.join(fluxosLibDir, 'ZelBack/src/services/fluxService.js');
  const fluxServiceContent = await fs.readFile(fluxServiceFile, 'utf-8');
  //   const fluxBackFolder = path.join(__dirname, '../../');
  const hackLine = `  const fluxBackFolder = '/usr/local/fluxos/canonical/ZelBack';`;
  const modifiedContent = fluxServiceContent.replace(/^\s+const fluxBackFolder = path\.join.*$/m, hackLine);
  fs.writeFile(fluxServiceFile, modifiedContent);

  if (err) {
    console.log(err);
    return fluxosLibDir;
  }

  await runCommand(npm, { cwd: fluxosLibDir, params: ['install'] });

  await fs.writeFile(versionFile, fluxosTag);

  return fluxosLibDir;
}

async function linkBinaries(options) {
  const fluxosLibDir = options.fluxosLibDir || null;
  const nodejsInstallDir = options.nodejsInstallDir || null;

  if (nodejsInstallDir) {
    const nodeExecutables = ['node', 'npm', 'npx'];
    const nodejsBinDir = '/opt/nodejs/bin'

    nodeExecutables.forEach(async (executable) => {
      const target = path.join(nodejsInstallDir, 'bin', executable);
      const name = path.join(nodejsBinDir, executable);

      await fs.rm(name, { force: true }).catch(noop);
      await fs.symlink(target, name).catch(noop);
    });
  }

  if (fluxosLibDir) {
    const fluxosBase = '/usr/local/fluxos';
    const fluxosUserConfigPath = path.join(fluxosBase, 'userconfig.js');
    const fluxosLinkDir = path.join(fluxosBase, 'current');
    const fluxosUserConfigLink = path.join(fluxosLinkDir, 'config', 'userconfig.js');

    await fs.rm(fluxosUserConfigLink, { force: true }).catch(noop);
    await fs.rm(fluxosLinkDir, { force: true }).catch(noop);

    await fs.symlink(fluxosLibDir, fluxosLinkDir).catch(noop);
    await fs.symlink(fluxosUserConfigPath, fluxosUserConfigLink);
  }
}

async function installNodeJs(baseInstallDir, version, platform, arch, compression) {
  const base = 'https://nodejs.org/dist';
  const fullVersion = `node-${version}-${platform}-${arch}`;
  const url = `${base}/${version}/${fullVersion}.tar.${compression}`;
  const extractDir = path.join(baseInstallDir, 'lib');
  const installDir = path.join(extractDir, fullVersion);
  const versionFile = path.join(baseInstallDir, 'version');
  const binDir = path.join(baseInstallDir, 'bin');


  const installedVersion = await fs.readFile(versionFile).catch(() => '');

  if (installedVersion === version) {
    console.log(`NodeJS version: ${version} already installed`);
    return installDir;
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

  await fs.writeFile(versionFile, version).catch(noop);

  return installDir;
}

async function generateSyncthingconfig(syncthingPort) {
  const syncthingDir = '/usr/local/syncthing';
  const configPath = path.join(syncthingDir, 'config.xml')

  if (await fs.stat(configPath).catch(() => false)) return;

  // just run this as gid, uid
  await runCommand('syncthing', { params: ['generate', '--home', syncthingDir, '--no-default-folder'] });

  const rawConfig = await fs.readFile(configPath);

  const options = {
    ignoreAttributes: false,
    format: true,
    // this is for the builder so that attrs get attr=bool instead of just attr
    suppressBooleanAttributes: false,
    attributeNamePrefix: "@_"
  };
  const parser = new xml.XMLParser(options);
  const parsedConfig = parser.parse(rawConfig);

  // this isn't actually the gui, it's the api port
  // parsedConfig.configuration.gui['@_enabled'] = false;
  parsedConfig.configuration.gui.address = '127.0.0.1:8384';
  parsedConfig.configuration.options.listenAddress = [`tcp://:${syncthingPort}`, `quic://:${syncthingPort}`];

  const builder = new xml.XMLBuilder(options);
  const xmlConfig = builder.build(parsedConfig);
  await fs.writeFile(configPath, xmlConfig).catch(noop);

  const { uid, gid } = await linuxUser.getUserInfo('syncthing').catch((err) => {
    console.log(err);
  })
  // this needs to be fixed (just runCommand as user)
  await fs.chown(syncthingDir, uid, gid).catch(noop);
  await fs.chown(path.join(syncthingDir, 'cert.pem'), uid, gid).catch(noop);
  await fs.chown(path.join(syncthingDir, 'key.pem'), uid, gid).catch(noop);
  await fs.chown(configPath, uid, gid).catch(noop);
}

async function getFluxosConfig(fluxosConfigPath) {
  let fluxosConfig;

  try {
    fluxosConfig = await import(fluxosConfigPath);
  } catch (err) {
    console.log(err);
    console.log('Unable to import fluxos config file, migration not possible');
    return null;
  }

  const { apiport: fluxApiPort } = fluxosConfig?.default?.initial || {};

  if (!fluxApiPort) {
    console.log('Unable to retrieve apiport, migration not possible');
    return null;
  }

  const fluxosRawConfig = await fs.readFile(fluxosConfigPath, 'utf-8').catch(noop);

  if (!fluxosRawConfig) {
    console.log('Unable to read raw fluxos config, migration not possbile.');
    return null;
  }

  return { fluxApiPort, fluxosRawConfig };
}

async function getFluxdConfig(fluxdConfigPath) {
  const rawConfig = await fs.readFile(fluxdConfigPath, 'utf-8').catch(noop);

  if (!rawConfig) {
    console.log('Fluxd config file not found, migration not possible.');
    return null;
  }

  let config;

  try {
    config = ini.parse(rawConfig);
  } catch (err) {
    console.log(err);
    console.log('Unable to parse fluxd file. Migration not possible');
    return null;
  }

  if (!config) {
    console.log('Fluxd config file empty, migration not possbile.');
    return null;
  }

  const {
    zelnodeprivkey: fluxPrivateKey,
    zelnodeoutpoint: fluxLockupTxid,
    zelnodeindex: fluxLockTxOutputId,
  } = config;

  if (!fluxPrivateKey || !fluxLockupTxid || !fluxLockTxOutputId) {
    console.log('Missing fluxnode information in fluxd config file, migration not possible.');
    return null;
  }

  const externalIp = config.externalip || await getExternalIp();

  return { fluxPrivateKey, fluxLockupTxid, fluxLockTxOutputId, externalIp };
}

/**
 *
 * @param {String} nodejsVersion The version of nodeJS to use
 * @param {{}} options Install options
 * @returns
 */
async function install(nodejsVersion, options = {}) {

  if (!nodejsVersion) return null;

  if (os.userInfo().uid) {
    console.log('Must be root to install fluxOS');
    return null;
  }

  const migrate = options.migrate || false;
  const fluxdConfigPath = options.fluxdConfigPath || '';
  const fluxosConfigPath = options.fluxosConfigPath || '';

  const { platform, arch } = process;
  const nodejsBaseDir = '/opt/nodejs';
  let fluxdRpcCredentials = null;

  if (migrate) {
    if (!fluxdConfigPath || !fluxosConfigPath) {
      console.log('If migrating, fluxd and fluxos config path must be provided');
      return null;
    }

    const fluxdConfig = await getFluxdConfig(fluxdConfigPath);

    if (!fluxdConfig) {
      console.log('no fluxd config')
      return null;
    }

    const fluxosUserConfig = await getFluxosConfig(fluxosConfigPath);

    if (!fluxosUserConfig) {
      console.log('no fluxos config')
      return null;
    }

    const syncthingPort = +fluxosUserConfig.fluxApiPort + 2;

    await generateSyncthingconfig(syncthingPort);

    fluxdRpcCredentials = await configureServices(fluxosUserConfig, fluxdConfig);

    await createServices();
    await systemdDaemonReload();
  }

  const nodejsInstallDir = await installNodeJs(nodejsBaseDir, nodejsVersion, platform, arch, 'gz');
  const fluxosLibDir = await installFluxOs(nodejsVersion, nodejsInstallDir);
  return { binaryTargets: { nodejsInstallDir, fluxosLibDir }, fluxdRpcCredentials }

  // reload fluxos service and the other correct services
}

async function copyChain(user, fluxdDataDir) {
  const homeDir = path.join('/home', user);
  const zcashParamsDir = path.join(homeDir, '.zcash-params');

  const folders = [
    'blocks',
    'chainstate',
    'determ_zelnodes',
  ];

  const foldersAbsolute = folders.map((f) => path.join(fluxdDataDir, f));
  foldersAbsolute.push(zcashParamsDir);

  const statPromises = foldersAbsolute.map(async (folder) => {
    try {
      const stats = await fs.stat(folder);
      return stats.isDirectory();
    } catch {
      return false;
    }
  });

  const foldersExist = await Promise.all(statPromises);
  const chainExists = foldersExist.every((x) => x);

  if (!chainExists) {
    console.log("Can't find chain to copy");
    return false;
  }

  await runCommand('systemctl', { logError: false, params: ['stop', 'zelcash.service'] });
  // in case it's not being run by systemd (so we don't torch the chain)
  await runCommand('pkill', { logError: false, params: ['fluxd'] });
  await runCommand('pkill', { logError: false, params: ['fluxbenchd'] });

  const renamePromises = foldersAbsolute.map(async (folder) => {
    const err = await fs.rename(folder, path.join('/usr/local/fluxd', path.basename(folder))).catch(() => true);
    return err;
  })

  const renameErrors = await Promise.all(renamePromises);
  const renameErrored = renameErrors.some((x) => x);

  if (renameErrored) return false;

  // Would have to walk the direectories to do this in process, or just copy the files instead
  // of moving them.
  await runCommand('chown', { params: ['-R', 'fluxd:fluxd', '/usr/local/fluxd'] });

  return true;
}

async function purgeExistingServices(user) {
  // this needs to be idempotent

  const homeDir = path.join('/home', user);
  const userConfigDir = path.join(homeDir, '.config');
  const pm2ConfigDir = path.join(homeDir, '.pm2');
  const systemdBaseDir = '/etc/systemd/system';

  const pm2ServiceName = `pm2-${user}.service`;
  const zelcashServiceName = 'zelcash.service';

  const pm2SystemdFile = path.join(systemdBaseDir, pm2ServiceName);
  const zelcashSystemdFile = path.join(systemdBaseDir, zelcashServiceName);

  await runCommand('runuser', { logError: false, params: ['-u', user, 'pm2', 'stop', 'watchdog'] });
  await runCommand('runuser', { logError: false, params: ['-u', user, 'pm2', 'stop', 'flux'] });

  await fs.rm(pm2ConfigDir, { recursive: true, force: true });

  await runCommand('systemctl', { logError: false, params: ['stop', pm2ServiceName] });
  await runCommand('systemctl', { logError: false, params: ['stop', zelcashServiceName] });

  // we don't need to disable the services here as we are removing them

  await fs.rm(pm2SystemdFile, { force: true });
  await fs.rm(zelcashSystemdFile, { force: true });

  await systemdDaemonReload();

  await runCommand('pkill', { logError: false, params: ['syncthing'] });

  await fs.rm(userConfigDir, { recursive: true, force: true });
}

async function allowOperatorFluxCliAccess(fluxdRpcCredentials, uid, gid) {
  const fluxdDir = '/home/operator/.flux';
  const fluxdConf = path.join(fluxdDir, 'flux.conf');
  const { rpcUser, rpcPassword } = fluxdRpcCredentials;

  const content = `rpcuser=${rpcUser}\nrpcpassword=${rpcPassword}\n`
  await fs.mkdir(fluxdDir, { recursive: true, }).catch(noop);
  await fs.writeFile(fluxdConf, content);
  await fs.chown(fluxdDir, uid, gid);
  await fs.chown(fluxdConf, uid, gid);
}

async function runMigration(existingUser, fluxdConfigPath, fluxosConfigPath) {
  // not using these right now, was using these to run the pm2 commands as a user, but that is
  // problematic as we need the env of the user to get the NVM_BIN dir. So just using `runuser`
  // this is still a good check to make sure the user exists though
  const { uid, gid } = await linuxUser.getUserInfo(existingUser).catch(noop);

  if (!uid || !gid) return false;

  // url -s https://nodejs.org/download/release/index.json | jq '.[] | select(.lts == "Iron")'
  // add in check for latest 20.x lts from https://nodejs.org/download/release/index.json.

  const { binaryTargets, fluxdRpcCredentials } = await install('v20.13.1', { migrate: true, fluxdConfigPath, fluxosConfigPath });

  if (!binaryTargets) return false;

  await purgeExistingServices(existingUser);

  await linkBinaries(binaryTargets);
  await copyChain(existingUser, path.dirname(fluxdConfigPath));

  await enableServices()
  // await startServices();

  // this still needs a bunch of work, configure recovery user etc.
  const operatorIds = await harden();
  await allowOperatorFluxCliAccess(fluxdRpcCredentials, operatorIds.uid, operatorIds.gid);
  return true;
}

async function harden() {
  // create operator, recovery
  const recoveryUser = 'recovery';
  const operatorUser = 'operator';
  const operatorHome = path.join('/home', operatorUser);
  const operatorBinDir = '/home/operator/bin';
  const operatorBashrc = path.join(operatorHome, '.bashrc');
  const operatorBashLogout = path.join(operatorHome, '.bash_logout');
  const sshdConfigDir = '/etc/ssh/sshd_config.d';
  const operatorSshDir = path.join(operatorHome, '.ssh');
  const oepratorAuthorizedKeys = path.join(operatorSshDir, 'authorized_keys');
  const operatorHelpFile = '/usr/local/sbin/help';

  // this is a default group that is installed, we remove it so it doesn't mess with our operator user
  await linuxUser.removeGroup(operatorUser).catch(noop);
  // we have to remove this first, if it exists and we try to remove the user, it will fail
  // as root can't delete the homdir with this file present. Fail silently
  await runCommand('chattr', { logError: false, params: ['-i', operatorBashrc] });

  await linuxUser.removeUser(operatorUser).catch(noop);
  await linuxUser.removeUser(recoveryUser).catch(noop);

  const { uid: operatorUid, gid: operatorGid } = await linuxUser
    .addUser({ username: operatorUser, shell: "/bin/rbash", create_home: true })
    .catch(() => ({}));

  if (!operatorUid || !operatorGid) {
    console.log('Unable to get operator uid and gui. Exiting.');
    return {};
  }

  await linuxUser.addUser({ username: recoveryUser, shell: '/bin/rbash', create_home: true }).catch(noop);

  const recoverPassoword = createRandomString(32);
  await linuxUser.setPassword(recoveryUser, recoverPassoword);

  await fs.mkdir(operatorBinDir).catch(noop);
  await fs.chown(operatorBinDir, operatorUid, operatorGid);

  const operatorHelpContent = await readFile('harden/help.sh');
  await fs.writeFile(operatorHelpFile, operatorHelpContent);
  await fs.chmod(operatorHelpFile, 0o755);

  // add to this
  const binaries = [
    operatorHelpFile,
    "/usr/local/bin/flux-cli",
    "/usr/local/bin/fluxbench-cli",
    "/usr/sbin/ip",
    "/usr/bin/sudo",
    "/usr/bin/clear_console",
  ];

  const linkPromises = binaries.map((binary) => {
    return fs.symlink(binary, path.join(operatorBinDir, path.basename(binary)));
  });

  await Promise.all(linkPromises);

  const sudoersContext = { user: operatorUser, allowedSudoCommands: ['/usr/sbin/ip'] };
  const sudoersContent = generateTemplate('harden/sudoers.conf', sudoersContext);
  await fs.writeFile(path.join('/etc/sudoers.d', operatorUser), sudoersContent).catch(noop);

  const operatorBashrcContent = await readFile('harden/.bashrc');
  await fs.writeFile(operatorBashrc, operatorBashrcContent);
  await fs.chown(operatorBashrc, operatorUid, operatorGid);

  const operatorBashLogoutContent = await readFile('harden/.bash_logout');
  await fs.writeFile(operatorBashLogout, operatorBashLogoutContent);
  await fs.chown(operatorBashLogout, operatorUid, operatorGid);

  // immutable. So the file can't be written to
  await runCommand('chattr', { params: ['+i', operatorBashrc] });

  const sshdConfigFiles = await fs.readdir(sshdConfigDir);

  const sshdConfigFilePromises = sshdConfigFiles.map((f) => fs.rm(path.join(sshdConfigDir, f)));
  await Promise.all(sshdConfigFilePromises);

  const sshdConfigContext = { forceUser: operatorUser };
  const sshdConfigContent = generateTemplate('harden/sshd_config.conf', sshdConfigContext);
  await fs.writeFile('/etc/ssh/sshd_config.d/force.conf', sshdConfigContent).catch(noop);

  const sshSeed = randomBytes(32);
  const sshKeys = ssh.getKeys(sshSeed, `${operatorUser}@fluxnode.local`);

  await fs.mkdir(operatorSshDir, { recursive: true });
  await fs.writeFile(oepratorAuthorizedKeys, sshKeys.publicKey);
  await fs.chown(operatorSshDir, operatorUid, operatorGid);
  await fs.chown(oepratorAuthorizedKeys, operatorUid, operatorGid);


  console.log('\nCONSOLE RECOVERY USER:', recoveryUser)
  console.log('CONSOLE RECOVERY PASSWORD:', recoverPassoword, '\n');
  console.log('NODE OPERATOR USER:', operatorUser);
  console.log('NODE OPERATOR PRIVATE KEY:\n')
  console.log(sshKeys.privateKey);

  return { uid: operatorUid, gid: operatorGid };
}

if (require.main === module) {
  const args = process.argv.slice(2, 5);

  // just do this properly: const { parseArgs } = require('node:util');

  if (args.length === 1 && args[0] === 'CLEAN_INSTALL') {
    // do a full install. Download chain blah blah.
  }
  else if (args.length !== 3) {
    // we've been forked from fluxOS as root (using sudo), and are migrating.
    console.log('not enough args to run migration.');
    return
  }

  runMigration(...args);
}
