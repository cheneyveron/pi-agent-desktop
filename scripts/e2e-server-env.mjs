import { join } from "node:path";

/** Isolate the app server's filesystem defaults, not the Playwright installation. */
export function createE2EServerEnv(parentEnv, agentDir, mode) {
  const home = join(agentDir, "home");
  const env = {
    ...parentEnv,
    HOME: home,
    USERPROFILE: home,
    PI_AGENT_HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DOWNLOAD_DIR: join(home, "Downloads"),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    NODE_ENV: mode === "dev" ? "development" : "production",
    PI_WEB_PASSWORD: "",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  // Desktop shells export their serialized config; Next must read this checkout's
  // next.config.ts instead. An inherited offline flag also changes app behavior.
  delete env.__NEXT_PRIVATE_ORIGIN;
  delete env.__NEXT_PRIVATE_STANDALONE_CONFIG;
  delete env.PI_OFFLINE;
  return env;
}
