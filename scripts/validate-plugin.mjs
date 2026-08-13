import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(workspaceRoot, process.argv[2] ?? 'plugins/hydra');

function fail(message) {
  throw new Error(`plugin validation failed: ${message}`);
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || value.includes('\0')) {
    fail(`${label} must be a non-empty relative path`);
  }
  const target = resolve(pluginRoot, value);
  if (target !== pluginRoot && !target.startsWith(`${pluginRoot}/`)) {
    fail(`${label} escapes the plugin root`);
  }
  return target;
}

const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
const manifest = await json(manifestPath);
const packageManifest = await json(join(workspaceRoot, 'package.json'));
if (manifest.name !== 'hydra') {
  fail('manifest name must be hydra');
}
if (!/^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version ?? '')) {
  fail('manifest version must be SemVer with optional build metadata');
}
if (manifest.version.split('+', 1)[0] !== packageManifest.version) {
  fail('manifest base version must equal package.json version');
}
if (manifest.license !== packageManifest.license || manifest.license !== 'MIT') {
  fail('manifest and package licenses must both be MIT');
}
for (const key of ['description', 'license', 'skills', 'mcpServers']) {
  if (typeof manifest[key] !== 'string' || manifest[key].length === 0) {
    fail(`manifest ${key} is required`);
  }
}
if (typeof manifest.author?.name !== 'string' || manifest.author.name.length === 0) {
  fail('manifest author.name is required');
}
if (manifest.author.name !== packageManifest.author) {
  fail('manifest author.name must equal package.json author');
}
if (manifest.interface?.developerName !== manifest.author.name) {
  fail('manifest interface.developerName must equal manifest author.name');
}
if (manifest.author.url !== `https://github.com/${manifest.author.name}`) {
  fail('manifest author.url must point to the declared GitHub author');
}
for (const [label, value] of [
  ['repository.url', packageManifest.repository?.url],
  ['bugs.url', packageManifest.bugs?.url],
  ['homepage', packageManifest.homepage],
]) {
  if (typeof value !== 'string' || !value.includes('github.com/azixxxxx/Hydra')) {
    fail(`package ${label} must point to the public Hydra repository`);
  }
}
const skillsRoot = safeRelativePath(manifest.skills, 'skills');
const mcpPath = safeRelativePath(manifest.mcpServers, 'mcpServers');
const mcp = await json(mcpPath);
const server = mcp.mcpServers?.hydra;
if (
  server?.command !== 'node' ||
  !Array.isArray(server.args) ||
  server.args.length !== 1 ||
  server.args[0] !== './dist/server.js' ||
  server.cwd !== '.'
) {
  fail('MCP server must launch node ./dist/server.js from the plugin root');
}
await access(join(pluginRoot, 'dist', 'server.js'));
await access(join(pluginRoot, 'dist', 'worker.js'));
const pluginLicensePath = join(pluginRoot, 'LICENSE');
await access(pluginLicensePath);
await access(join(pluginRoot, 'THIRD_PARTY_NOTICES.md'));
if ((await readFile(pluginLicensePath, 'utf8')) !== (await readFile(join(workspaceRoot, 'LICENSE'), 'utf8'))) {
  fail('root and plugin licenses must match byte-for-byte');
}

const skillEntries = await readdir(skillsRoot, { withFileTypes: true });
const expected = new Set(['hydra-orchestrate', 'hydra-panel', 'hydra-review']);
for (const entry of skillEntries) {
  if (!entry.isDirectory()) {
    fail(`unexpected non-directory skill entry ${entry.name}`);
  }
  if (!expected.delete(entry.name)) {
    fail(`unexpected skill ${entry.name}`);
  }
  const content = await readFile(join(skillsRoot, entry.name, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/u.exec(content);
  if (frontmatter?.[1] !== entry.name || frontmatter[2].trim().length === 0) {
    fail(`${entry.name}/SKILL.md has invalid frontmatter`);
  }
  await access(join(skillsRoot, entry.name, 'agents', 'openai.yaml'));
}
if (expected.size > 0) {
  fail(`missing skills: ${[...expected].join(', ')}`);
}

const authoredFiles = [
  manifestPath,
  mcpPath,
  join(pluginRoot, 'LICENSE'),
  join(pluginRoot, 'THIRD_PARTY_NOTICES.md'),
  ...skillEntries.flatMap((entry) => [
    join(skillsRoot, entry.name, 'SKILL.md'),
    join(skillsRoot, entry.name, 'agents', 'openai.yaml'),
  ]),
];
for (const path of authoredFiles) {
  const content = await readFile(path, 'utf8');
  if (/\b(?:TODO|FIXME)\b/u.test(content)) {
    fail(`${path} contains unfinished markers`);
  }
}

process.stdout.write(`plugin validation passed: ${manifest.name}@${manifest.version}\n`);
