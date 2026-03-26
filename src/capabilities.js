const fs = require('fs');
const path = require('path');

const KNOWN_TOOLS = [
  'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep',
  'Bash',
  'Agent', 'Skill',
  'WebSearch', 'WebFetch',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput', 'TaskStop',
  'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'AskUserQuestion',
  'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger',
];

const PRESETS = {
  full: {
    name: 'full',
    label: 'Full',
    description: 'All tools enabled',
    disabledTools: [],
    disableSlashCommands: false,
    model: null,
    maxTurns: null,
    appendSystemPrompt: null,
  },
  safe: {
    name: 'safe',
    label: 'Safe',
    description: 'No file writes or shell execution',
    disabledTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'CronCreate', 'CronDelete', 'EnterWorktree', 'ExitWorktree'],
    disableSlashCommands: false,
    model: null,
    maxTurns: null,
    appendSystemPrompt: null,
  },
  readonly: {
    name: 'readonly',
    label: 'Read-only',
    description: 'Read and search only',
    disabledTools: KNOWN_TOOLS.filter(t => !['Read', 'Glob', 'Grep', 'AskUserQuestion'].includes(t)),
    disableSlashCommands: true,
    model: null,
    maxTurns: null,
    appendSystemPrompt: null,
  },
  minimal: {
    name: 'minimal',
    label: 'Minimal',
    description: 'Absolute minimum for code reading',
    disabledTools: KNOWN_TOOLS.filter(t => !['Read', 'Glob', 'Grep'].includes(t)),
    disableSlashCommands: true,
    model: null,
    maxTurns: null,
    appendSystemPrompt: null,
  },
};

const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop',
  'SessionStart', 'Notification', 'PreCompact', 'PostCompact',
];

// Events that support a matcher (tool name filter)
const MATCHER_EVENTS = ['PreToolUse', 'PostToolUse'];

// --- Profile management ---

function profilePath(baseDir) {
  return path.join(baseDir, 'capabilities', 'profile.json');
}

function loadProfile(baseDir) {
  const p = profilePath(baseDir);
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return validateProfile(data);
    }
  } catch {}
  return { ...PRESETS.full };
}

function saveProfile(baseDir, profile) {
  const dir = path.join(baseDir, 'capabilities');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(profilePath(baseDir), JSON.stringify(profile, null, 2));
}

function validateProfile(p) {
  return {
    name: p.name || 'custom',
    model: p.model || null,
    disabledTools: Array.isArray(p.disabledTools) ? p.disabledTools.filter(t => KNOWN_TOOLS.includes(t)) : [],
    disableSlashCommands: !!p.disableSlashCommands,
    maxTurns: typeof p.maxTurns === 'number' && p.maxTurns > 0 ? p.maxTurns : null,
    appendSystemPrompt: typeof p.appendSystemPrompt === 'string' && p.appendSystemPrompt.trim() ? p.appendSystemPrompt.trim() : null,
  };
}

// --- Command CRUD ---

function commandsDir(cwd) {
  return path.join(cwd, '.claude', 'commands');
}

function listCommands(cwd) {
  const dir = commandsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const name = f.replace(/\.md$/, '');
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const desc = extractFrontmatterField(content, 'description') || '';
      return { name, description: desc, content };
    });
}

function readCommand(cwd, name) {
  const file = path.join(commandsDir(cwd), `${name}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function saveCommand(cwd, name, content) {
  if (!isValidName(name)) return false;
  const dir = commandsDir(cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content);
  return true;
}

function deleteCommand(cwd, name) {
  const file = path.join(commandsDir(cwd), `${name}.md`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

// --- Agent CRUD ---

function agentsDir(cwd) {
  return path.join(cwd, '.claude', 'agents');
}

function listAgents(cwd) {
  const dir = agentsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const name = f.replace(/\.md$/, '');
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const desc = extractFrontmatterField(content, 'description') || '';
      return { name, description: desc.split('\n')[0].trim(), content };
    });
}

function readAgent(cwd, name) {
  const file = path.join(agentsDir(cwd), `${name}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function saveAgent(cwd, name, content) {
  if (!isValidName(name)) return false;
  const dir = agentsDir(cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content);
  return true;
}

function deleteAgent(cwd, name) {
  const file = path.join(agentsDir(cwd), `${name}.md`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

// --- Hook CRUD ---

function settingsLocalPath(cwd) {
  return path.join(cwd, '.claude', 'settings.local.json');
}

function readSettingsLocal(cwd) {
  const p = settingsLocalPath(cwd);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return {};
}

function writeSettingsLocal(cwd, settings) {
  const dir = path.join(cwd, '.claude');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsLocalPath(cwd), JSON.stringify(settings, null, 2));
}

function listHooks(cwd) {
  const settings = readSettingsLocal(cwd);
  const hooks = settings.hooks || {};
  const result = [];
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const innerHooks = entry.hooks || [];
      for (let j = 0; j < innerHooks.length; j++) {
        const h = innerHooks[j];
        result.push({
          event,
          entryIndex: i,
          hookIndex: j,
          matcher: entry.matcher || '',
          type: h.type || 'command',
          command: h.command || h.prompt || '',
          timeout: h.timeout || 30,
        });
      }
    }
  }
  return result;
}

function saveHook(cwd, hook) {
  const settings = readSettingsLocal(cwd);
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks[hook.event]) settings.hooks[hook.event] = [];

  const newEntry = {
    hooks: [{
      type: hook.type || 'command',
      [hook.type === 'prompt' ? 'prompt' : 'command']: hook.command,
      timeout: hook.timeout || 30,
    }],
  };
  if (hook.matcher && MATCHER_EVENTS.includes(hook.event)) {
    newEntry.matcher = hook.matcher;
  }

  // If editing existing (has entryIndex + hookIndex), replace it
  if (hook.entryIndex !== undefined && hook.hookIndex !== undefined) {
    const entries = settings.hooks[hook.event];
    if (entries[hook.entryIndex]) {
      // Replace the entire entry (simplified: one hook per entry)
      entries[hook.entryIndex] = newEntry;
    } else {
      settings.hooks[hook.event].push(newEntry);
    }
  } else {
    settings.hooks[hook.event].push(newEntry);
  }

  writeSettingsLocal(cwd, settings);
  return true;
}

function deleteHook(cwd, event, entryIndex) {
  const settings = readSettingsLocal(cwd);
  if (!settings.hooks?.[event]) return false;
  const entries = settings.hooks[event];
  if (entryIndex < 0 || entryIndex >= entries.length) return false;
  entries.splice(entryIndex, 1);
  if (entries.length === 0) delete settings.hooks[event];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettingsLocal(cwd, settings);
  return true;
}

// --- Helpers ---

function isValidName(name) {
  return /^[a-z][a-z0-9-]*$/.test(name) && name.length >= 2 && name.length <= 50;
}

function extractFrontmatterField(content, field) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = match[1];
  // Handle multi-line fields (YAML block scalar)
  const lines = fm.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^${field}:\\s*(.*)$`));
    if (m) {
      const val = m[1].trim();
      // If value starts with | or >, it's a block scalar — read indented lines
      if (val === '|' || val === '>') {
        let block = '';
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].match(/^\s+/)) {
            block += lines[j].trim() + ' ';
          } else break;
        }
        return block.trim();
      }
      return val.replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

module.exports = {
  KNOWN_TOOLS,
  PRESETS,
  HOOK_EVENTS,
  MATCHER_EVENTS,
  loadProfile,
  saveProfile,
  validateProfile,
  listCommands,
  readCommand,
  saveCommand,
  deleteCommand,
  listAgents,
  readAgent,
  saveAgent,
  deleteAgent,
  listHooks,
  saveHook,
  deleteHook,
};
