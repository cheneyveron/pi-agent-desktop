import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * t() 调用点门禁。
 *
 * registry.test.mjs 已保证三个语言包键集合一致;这里补上的是调用侧的两类缺口
 * (都是用户可见 bug,且 tsc / eslint 抓不到):
 *
 *   1. 静态键拼写错误 —— translateMessage() 找不到键时会把键名本身当文案返回,
 *      生产环境无任何告警,界面上直接出现 "i18n.packageInstalled" 这样的字符串。
 *   2. 占位符漏传 —— 消息里的 {token} 若未在调用点传入,interpolateMessage()
 *      会原样保留 "{token}" 字面量。
 *
 * 只断言能完全静态验证的调用:第一参为字符串字面量、参数对象为内联对象字面量
 * 且不含展开 / 计算属性(它们无法静态证明提供或没提供某个占位符)。其余调用
 * (变量键、变量参数)一律跳过,保证零误报。
 */

const require = createRequire(import.meta.url);
const ts = require("typescript");
const jiti = createJiti(import.meta.url);
const { enLocale } = await jiti.import("./messages/en.ts");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLACEHOLDER = /\{([\w.-]+)\}/g;
const placeholdersOf = (message) =>
  [...new Set([...String(message).matchAll(PLACEHOLDER)].map((match) => match[1]))];

/** 待扫描的源码根:walk 时跳过 demo(上游静态演示副本)与一切非产品代码。 */
const SCAN_ROOTS = ["app", "components", "hooks", "lib"];

function listSourceFiles() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "demo" || entry.startsWith(".") || entry === "__fixtures__") continue;
      const path = join(dir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) && !/\.bench\./.test(entry)) files.push(path);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(repoRoot, root));
  return files;
}

/**
 * 提取一个 t("…") 调用的静态信息。
 * @returns {{ key: string, params?: Set<string>, line: number } | null}
 *   动态键 / 变量参数 / 含展开或计算属性的对象 → null(不可静态验证,跳过)。
 */
function describeCall(sourceFile, call) {
  const [keyArg, paramsArg] = call.arguments;
  if (!ts.isStringLiteral(keyArg) && !ts.isNoSubstitutionTemplateLiteral(keyArg)) return null;
  const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;
  const described = { key: keyArg.text, line };
  if (paramsArg === undefined) return { ...described, params: new Set() };
  if (!ts.isObjectLiteralExpression(paramsArg)) return null;
  const params = new Set();
  for (const property of paramsArg.properties) {
    if (ts.isSpreadAssignment(property)) return null;
    if (ts.isShorthandPropertyAssignment(property)) {
      params.add(property.name.text);
      continue;
    }
    if (!ts.isPropertyAssignment(property)) return null;
    if (ts.isComputedPropertyName(property.name)) return null;
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
      params.add(property.name.text);
      continue;
    }
    return null;
  }
  return { ...described, params };
}

/** 收集全部可静态验证的 t() 调用点(任何名为 t 的函数被以字符串字面量首参调用即视为翻译调用)。 */
function collectTranslationCalls() {
  const calls = [];
  for (const file of listSourceFiles()) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t" && node.arguments.length >= 1) {
        const described = describeCall(sourceFile, node);
        if (described) calls.push({ file: file.slice(repoRoot.length + 1), ...described });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return calls;
}

test("every statically-known t() key exists in the English message pack", () => {
  const problems = collectTranslationCalls()
    .filter((call) => !(call.key in enLocale.messages))
    .map((call) => `${call.file}:${call.line} t("${call.key}") — key missing from en/zh-CN/zh-TW (renders the raw key in the UI)`);
  assert.deepEqual(problems, [], "unknown translation keys");
});

test("every placeholder required by a message is provided at the call site", () => {
  const problems = [];
  for (const call of collectTranslationCalls()) {
    const message = enLocale.messages[call.key];
    if (message === undefined) continue; // 上一条测试负责未知键
    const missing = placeholdersOf(message).filter((name) => !call.params.has(name));
    if (missing.length > 0) {
      problems.push(`${call.file}:${call.line} t("${call.key}") — missing {${missing.join(", ")}} (leaks the literal token into the UI)`);
    }
  }
  assert.deepEqual(problems, [], "calls missing interpolation params");
});
