/**
 * Project labels stay short normally, but add parent segments when two projects
 * share a basename. Selection surfaces must resolve them the same way so a
 * project's identity does not change between sidebar, composer and menus.
 */
export function getProjectDisplayName(
  projectPath: string,
  allProjectPaths: readonly string[],
): string {
  const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return projectPath;
  const parts = normalized.split("/");
  const name = parts.at(-1) ?? normalized;
  const normalizedPeers = allProjectPaths.map((path) => path.replace(/\\/g, "/").replace(/\/+$/, ""));

  if (normalizedPeers.filter((path) => path === name || path.endsWith(`/${name}`)).length <= 1) {
    return name;
  }

  for (let depth = 2; depth <= parts.length; depth += 1) {
    const suffix = parts.slice(-depth).join("/");
    const peersWithSuffix = normalizedPeers.filter((path) => path === suffix || path.endsWith(`/${suffix}`));
    if (peersWithSuffix.length <= 1) return suffix;
  }
  return normalized;
}

export function getProjectDisplayNames(projectPaths: readonly string[]): Map<string, string> {
  return new Map(projectPaths.map((path) => [path, getProjectDisplayName(path, projectPaths)]));
}
