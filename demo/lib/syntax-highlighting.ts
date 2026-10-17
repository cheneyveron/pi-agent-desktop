"use client";

// Shared PrismLight instance with a curated language set. The default
// `Prism` export pulls in refractor/all (~300 languages, several hundred KB
// gzipped into the main bundle); PrismLight only bundles what we register.
// Unregistered languages fall back to plain text rendering — no crash.
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql";
import hcl from "react-syntax-highlighter/dist/esm/languages/prism/hcl";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import less from "react-syntax-highlighter/dist/esm/languages/prism/less";
import makefile from "react-syntax-highlighter/dist/esm/languages/prism/makefile";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import powershell from "react-syntax-highlighter/dist/esm/languages/prism/powershell";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

// Keys are the names looked up by the `language` prop: values produced by the
// files API's EXT_TO_LANGUAGE map plus common markdown fence spellings.
const LANGUAGES: Record<string, unknown> = {
  bash, sh: bash, shell: bash, zsh: bash,
  c, h: c,
  cpp,
  csharp, cs: csharp,
  css,
  diff, patch: diff,
  docker, dockerfile: docker,
  go, golang: go,
  graphql, gql: graphql,
  hcl, terraform: hcl,
  ini,
  java,
  javascript, js: javascript,
  json, jsonc: json, jsonl: json,
  jsx,
  kotlin, kt: kotlin,
  less,
  makefile,
  markdown, md: markdown,
  markup, html: markup, xml: markup, svg: markup,
  php,
  powershell, ps1: powershell,
  python, py: python,
  ruby, rb: ruby,
  rust, rs: rust,
  scss,
  sql,
  swift,
  toml,
  tsx,
  typescript, ts: typescript,
  yaml, yml: yaml,
};

for (const [name, language] of Object.entries(LANGUAGES)) {
  SyntaxHighlighter.registerLanguage(name, language);
}

export { SyntaxHighlighter };
export { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
