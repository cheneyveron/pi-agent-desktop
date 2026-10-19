import { NextResponse } from "next/server";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  PluginSettingsError,
  PluginSettingsValidationError,
  readPluginSettings,
  writePluginSettings,
} from "@/lib/plugin-settings";
import type { PluginScope } from "@/lib/api-types";

export const dynamic = "force-dynamic";

// GET /api/plugins/settings?cwd=…&source=…&scope=…
// PUT /api/plugins/settings body: { cwd, source, scope, values }
//
// The form behind a package's `pi.settings` declaration (see
// lib/plugin-settings.ts). `cwd` is needed beside the package's source and
// scope: the package is looked up the way /api/plugins lists it, and a
// project-scoped package only exists once its folder is trusted.

type Located = { installedPath: string | undefined } | { response: NextResponse };

function fail(error: unknown): NextResponse {
  if (error instanceof PluginSettingsValidationError) {
    return NextResponse.json({ error: error.message, fieldErrors: error.fieldErrors }, { status: error.status });
  }
  if (error instanceof PluginSettingsError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

async function locatePackage(cwd: unknown, source: unknown, rawScope: unknown): Promise<Located> {
  if (typeof cwd !== "string" || !cwd) return { response: NextResponse.json({ error: "cwd required" }, { status: 400 }) };
  if (typeof source !== "string" || !source.trim()) {
    return { response: NextResponse.json({ error: "source required" }, { status: 400 }) };
  }
  const scope: PluginScope = rawScope === "project" ? "project" : "global";
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }
  const agentDir = getAgentDir();
  const projectTrust = getProjectTrustStatus(cwd, agentDir);
  if (scope === "project" && !projectTrust.trusted) {
    return {
      response: NextResponse.json(
        { error: "Project resources must be trusted before using project plugins" },
        { status: 403 },
      ),
    };
  }
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: projectTrust.trusted });
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const wanted = source.trim();
  const configured = packageManager
    .listConfiguredPackages()
    .find((pkg) => pkg.source === wanted && (pkg.scope === "project" ? "project" : "global") === scope);
  if (!configured) {
    return { response: NextResponse.json({ error: "Package is not configured" }, { status: 404 }) };
  }
  return { installedPath: configured.installedPath };
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const { searchParams } = new URL(req.url);
    const located = await locatePackage(searchParams.get("cwd"), searchParams.get("source"), searchParams.get("scope"));
    if ("response" in located) return located.response;
    return NextResponse.json(readPluginSettings(located.installedPath));
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { cwd?: unknown; source?: unknown; scope?: unknown; values?: unknown };
    const located = await locatePackage(body?.cwd, body?.source, body?.scope);
    if ("response" in located) return located.response;
    return NextResponse.json(writePluginSettings(located.installedPath, body.values));
  } catch (error) {
    return fail(error);
  }
}
