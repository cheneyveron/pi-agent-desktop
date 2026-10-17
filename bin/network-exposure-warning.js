"use strict";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * What to say when the server listens beyond loopback, or null when it does
 * not. Shared by `bin/pi-web.js` and the `dev:lan` / `start:lan` scripts,
 * which start Next directly and would otherwise expose the terminal and file
 * APIs without a word.
 *
 * `fatal` means the launcher must not start: a listener beyond loopback with no
 * password hands a shell to anyone who can reach the port, so that needs an
 * explicit `PI_WEB_ALLOW_UNAUTHENTICATED=1`, not just a warning that scrolls by.
 */
function checkNetworkExposure(hostname, env = process.env) {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return null;
  if (env.PI_WEB_PASSWORD) {
    return {
      fatal: false,
      message: `Warning: pi-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
    };
  }
  if (env.PI_WEB_ALLOW_UNAUTHENTICATED === "1") {
    return {
      fatal: false,
      message: `Warning: pi-web is listening on ${hostname} without authentication. Anyone who can reach this port can run shell commands and read files as you. Set PI_WEB_PASSWORD, or only use this on a trusted network.`,
    };
  }
  return {
    fatal: true,
    message: `Refusing to listen on ${hostname} without authentication: anyone who can reach this port could run shell commands and read files as you. Set PI_WEB_PASSWORD, or set PI_WEB_ALLOW_UNAUTHENTICATED=1 to accept that on a trusted network.`,
  };
}

function getNetworkExposureWarning(hostname, env = process.env) {
  return checkNetworkExposure(hostname, env)?.message ?? null;
}

module.exports = { checkNetworkExposure, getNetworkExposureWarning };

// `node bin/network-exposure-warning.js <hostname>` prints the warning (if any)
// and exits 1 when the listener must not start.
if (require.main === module) {
  const exposure = checkNetworkExposure(process.argv[2] ?? "");
  if (exposure) console.warn(exposure.message);
  if (exposure?.fatal) process.exitCode = 1;
}
