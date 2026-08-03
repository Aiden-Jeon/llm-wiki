import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function getPaths(env = process.env, platform = process.platform) {
  const home = os.homedir();
  const configBase = env.LLM_WIKI_CONFIG_HOME
    || (platform === 'win32'
      ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'llm-wiki')
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'llm-wiki'));
  const dataBase = env.LLM_WIKI_DATA_HOME
    || (platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'llm-wiki')
      : path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'llm-wiki'));

  return {
    packageRoot,
    configDir: configBase,
    registry: path.join(configBase, 'wikis.local.md'),
    skillsDir: path.join(configBase, 'skills'),
    templatesDir: path.join(packageRoot, 'templates', 'skills'),
    vaultTemplateDir: path.join(packageRoot, 'templates', 'vault'),
    workspace: path.join(dataBase, 'workspace'),
  };
}
