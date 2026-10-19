import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  PluginSettingsFieldError,
  PluginSettingsInfo,
  PluginSettingsResponse,
  PluginSettingsSchema,
} from "./api-types";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { hasParentDirectorySegment, isPathWithinRoots } from "./path-security";
import {
  applyPluginSettings,
  maskPluginSettings,
  parsePluginSettingsSchema,
  PluginSettingsSchemaError,
} from "./plugin-settings-schema";
import { readRegularFileText } from "./regular-file";
import { userHome } from "./user-home";

// Generic plugin settings: a pi package declares, in its package.json,
//
//   "pi": { "settings": { "file": "~/.example/config.json", "schema": "./settings.schema.json" } }
//
// and Settings › Plugins renders a form from the schema and writes the file the
// plugin reads itself. This module resolves the declaration, reads and writes
// that file, and keeps both inside the user's home. The schema subset and the
// validation rules are in `plugin-settings-schema.ts`.

const SCHEMA_MAX_BYTES = 256 * 1024;
const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;

/** A refused request; `status` is the HTTP status the route answers with. */
export class PluginSettingsError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PluginSettingsError";
    this.status = status;
  }
}

/** A PUT whose values did not validate: nothing was written. */
export class PluginSettingsValidationError extends PluginSettingsError {
  readonly fieldErrors: Record<string, PluginSettingsFieldError>;

  constructor(fieldErrors: Record<string, PluginSettingsFieldError>) {
    super("Some settings are not valid", 422);
    this.name = "PluginSettingsValidationError";
    this.fieldErrors = fieldErrors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageDirectory(installedPath: string): string {
  try {
    return statSync(installedPath).isDirectory() ? installedPath : dirname(installedPath);
  } catch {
    return installedPath;
  }
}

interface SettingsDeclaration {
  file: string;
  schema: string;
}

/** The `pi.settings` of the package's package.json: undefined when it declares none. */
function readDeclaration(packageDir: string): SettingsDeclaration | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  const settings = isRecord(parsed) && isRecord(parsed.pi) ? parsed.pi.settings : undefined;
  if (settings === undefined) return undefined;
  if (!isRecord(settings)) throw new PluginSettingsError("pi.settings must be an object with file and schema");
  if (typeof settings.file !== "string" || !settings.file.trim()) {
    throw new PluginSettingsError("pi.settings.file must be a path");
  }
  if (typeof settings.schema !== "string" || !settings.schema.trim()) {
    throw new PluginSettingsError("pi.settings.schema must be a path");
  }
  return { file: settings.file.trim(), schema: settings.schema.trim() };
}

/** `~/…` and absolute paths only; the file must end in `.json` and sit under the user's home. */
export function expandSettingsFilePath(declared: string): string {
  let expanded: string;
  if (declared.startsWith("~/") || declared.startsWith("~\\")) {
    expanded = join(userHome(), declared.slice(2));
  } else if (isAbsolute(declared)) {
    expanded = declared;
  } else {
    throw new PluginSettingsError("pi.settings.file must be an absolute path or start with ~/");
  }
  if (hasParentDirectorySegment(declared)) throw new PluginSettingsError("pi.settings.file must not contain ..");
  if (!expanded.toLowerCase().endsWith(".json")) throw new PluginSettingsError("pi.settings.file must end in .json");
  const path = resolve(expanded);
  if (!isPathWithinRoots(path, new Set([resolve(userHome())]))) {
    throw new PluginSettingsError("pi.settings.file must be inside your home folder");
  }
  if (inProtectedDirectory(path, resolve(userHome()))) throw protectedDirectory();
  return path;
}

const PROTECTED_HOME_DIRS = [".pi", ".ssh"];

function protectedDirectory(): PluginSettingsError {
  return new PluginSettingsError("The settings file is in a protected directory (~/.pi or ~/.ssh)", 403);
}

/** Whether `path` is inside one of home's protected folders, pi's own config and credentials or SSH. */
function inProtectedDirectory(path: string, home: string): boolean {
  return isPathWithinRoots(path, new Set(PROTECTED_HOME_DIRS.map((dir) => join(home, dir))));
}

function outsideHome(): PluginSettingsError {
  return new PluginSettingsError("pi.settings.file resolves outside your home folder through a symbolic link", 403);
}

/**
 * The path to read and write for `path`: its real path when something is
 * there (a link inside home stays a link, as the plugin follows it), and for a
 * file not created yet the real path of the nearest existing folder plus the
 * rest. A link that leaves home, or points at nothing, is refused.
 */
function realSettingsTarget(path: string): string {
  const realHome = realpathSync(userHome());
  const within = (real: string) => isPathWithinRoots(real, new Set([realHome]));

  let existing = path;
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new PluginSettingsError("pi.settings.file has no existing parent folder");
      existing = parent;
    }
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    throw new PluginSettingsError("pi.settings.file is a symbolic link to nothing", 403);
  }
  if (!within(real)) throw outsideHome();
  // The real path too: a link in home may lead into ~/.pi, and ~/.pi itself may be a link.
  if (inProtectedDirectory(real, realHome)) throw protectedDirectory();
  if (existing === path) {
    if (!statSync(real).isFile()) throw new PluginSettingsError("pi.settings.file is not a regular file", 422);
    return real;
  }
  if (!statSync(real).isDirectory()) throw new PluginSettingsError("A parent of pi.settings.file is not a folder", 422);
  return join(real, relative(existing, path));
}

/** The schema file inside the package: no `..`, no absolute path, no link that leaves the package. */
function loadSchema(packageDir: string, declared: string): PluginSettingsSchema {
  if (isAbsolute(declared) || hasParentDirectorySegment(declared)) {
    throw new PluginSettingsSchemaError("pi.settings.schema must be a path inside the package");
  }
  const path = resolve(packageDir, declared);
  let realPackage: string;
  let realSchema: string;
  try {
    realPackage = realpathSync(packageDir);
    realSchema = realpathSync(path);
  } catch {
    throw new PluginSettingsSchemaError(`The settings schema ${declared} was not found in the package`);
  }
  if (!isPathWithinRoots(realSchema, new Set([realPackage]))) {
    throw new PluginSettingsSchemaError("pi.settings.schema must be a path inside the package");
  }
  let text: string | undefined;
  try {
    text = readRegularFileText(realSchema, SCHEMA_MAX_BYTES);
  } catch (error) {
    throw new PluginSettingsSchemaError(error instanceof Error ? error.message : String(error));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    throw new PluginSettingsSchemaError(`The settings schema ${declared} is not valid JSON`);
  }
  return parsePluginSettingsSchema(raw);
}

interface ResolvedSettings {
  schema: PluginSettingsSchema;
  /** The lexical path, as the plugin names it. */
  file: string;
  /** Where reads and writes go. */
  target: string;
}

function resolveSettings(installedPath: string | undefined): ResolvedSettings {
  if (!installedPath) throw new PluginSettingsError("Package is not installed", 404);
  const packageDir = packageDirectory(installedPath);
  const declaration = readDeclaration(packageDir);
  if (!declaration) throw new PluginSettingsError("Package declares no settings", 404);
  let schema: PluginSettingsSchema;
  try {
    schema = loadSchema(packageDir, declaration.schema);
  } catch (error) {
    if (error instanceof PluginSettingsSchemaError) throw new PluginSettingsError(error.message, 422);
    throw error;
  }
  const file = expandSettingsFilePath(declaration.file);
  return { schema, file, target: realSettingsTarget(file) };
}

/**
 * What the package listing says about a package's settings: undefined when
 * it declares none, otherwise whether the form can be shown. Reads the schema
 * and checks the path, never the settings file's contents.
 */
export function describePluginSettings(installedPath: string | undefined): PluginSettingsInfo | undefined {
  if (!installedPath) return undefined;
  let declaration: SettingsDeclaration | undefined;
  try {
    declaration = readDeclaration(packageDirectory(installedPath));
  } catch (error) {
    return { file: "", available: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!declaration) return undefined;
  try {
    const file = expandSettingsFilePath(declaration.file);
    realSettingsTarget(file);
    loadSchema(packageDirectory(installedPath), declaration.schema);
    return { file, available: true };
  } catch (error) {
    return { file: declaration.file, available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readStored(target: string): { stored: Record<string, unknown>; exists: boolean } {
  let text: string | undefined;
  try {
    text = readRegularFileText(target, SETTINGS_FILE_MAX_BYTES);
  } catch (error) {
    throw new PluginSettingsError(error instanceof Error ? error.message : String(error), 422);
  }
  if (text === undefined) return { stored: {}, exists: false };
  if (!text.trim()) return { stored: {}, exists: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PluginSettingsError(`${target} is not valid JSON; fix or remove it first`, 422);
  }
  if (!isRecord(parsed)) throw new PluginSettingsError(`${target} does not hold a JSON object`, 422);
  return { stored: parsed, exists: true };
}

function toResponse(resolved: ResolvedSettings, stored: Record<string, unknown>, exists: boolean): PluginSettingsResponse {
  return {
    schema: resolved.schema,
    values: maskPluginSettings(resolved.schema, stored),
    file: resolved.file,
    exists,
  };
}

/** The schema and the file's current values; secrets are reported as set / not set, never sent. */
export function readPluginSettings(installedPath: string | undefined): PluginSettingsResponse {
  const resolved = resolveSettings(installedPath);
  const { stored, exists } = readStored(resolved.target);
  return toResponse(resolved, stored, exists);
}

/**
 * Applies a PUT body's `values` to the file and writes it atomically with
 * mode 600 (its folder is created with mode 700 when missing). Keys of the
 * file that the schema does not name are written back untouched. Throws a
 * `PluginSettingsValidationError`, writing nothing, when a value is refused.
 */
export function writePluginSettings(installedPath: string | undefined, input: unknown): PluginSettingsResponse {
  if (!isRecord(input)) throw new PluginSettingsError("values must be an object");
  const resolved = resolveSettings(installedPath);
  const { stored } = readStored(resolved.target);
  const result = applyPluginSettings(resolved.schema, stored, input);
  if (!result.ok) throw new PluginSettingsValidationError(result.errors);
  mkdirSync(dirname(resolved.target), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(resolved.target, `${JSON.stringify(result.values, null, 2)}\n`);
  return toResponse(resolved, result.values, true);
}
