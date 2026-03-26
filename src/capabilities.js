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

const BUILTIN_PROFILES = {
  full: {
    name: 'full', label: 'Full', description: 'All tools enabled, default permissions', builtin: true,
    model: null, effort: null, permissionMode: 'default',
    disabledTools: [], disableSlashCommands: false,
    maxTurns: null, maxBudgetUsd: null, appendSystemPrompt: null, systemPrompt: null,
  },
  safe: {
    name: 'safe', label: 'Safe', description: 'No file writes or shell execution', builtin: true,
    model: null, effort: null, permissionMode: 'acceptEdits',
    disabledTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'CronCreate', 'CronDelete', 'EnterWorktree', 'ExitWorktree'],
    disableSlashCommands: false,
    maxTurns: null, maxBudgetUsd: null, appendSystemPrompt: null, systemPrompt: null,
  },
  readonly: {
    name: 'readonly', label: 'Read-only', description: 'Read and search only', builtin: true,
    model: null, effort: null, permissionMode: 'plan',
    disabledTools: KNOWN_TOOLS.filter(t => !['Read', 'Glob', 'Grep', 'AskUserQuestion'].includes(t)),
    disableSlashCommands: true,
    maxTurns: null, maxBudgetUsd: null, appendSystemPrompt: null, systemPrompt: null,
  },
  minimal: {
    name: 'minimal', label: 'Minimal', description: 'Absolute minimum for code reading', builtin: true,
    model: null, effort: null, permissionMode: 'plan',
    disabledTools: KNOWN_TOOLS.filter(t => !['Read', 'Glob', 'Grep'].includes(t)),
    disableSlashCommands: true,
    maxTurns: null, maxBudgetUsd: null, appendSystemPrompt: null, systemPrompt: null,
  },
};

// Backward compat alias
const PRESETS = BUILTIN_PROFILES;

const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop',
  'SessionStart', 'Notification', 'PreCompact', 'PostCompact',
];

// Events that support a matcher (tool name filter)
const MATCHER_EVENTS = ['PreToolUse', 'PostToolUse'];

const KNOWN_SKILLS = [
  { name: 'commit', description: 'Create a git commit with a well-crafted message' },
  { name: 'review-pr', description: 'Review a pull request from GitHub' },
  { name: 'create-pr', description: 'Create a GitHub pull request' },
  { name: 'simplify', description: 'Simplify and refactor selected code' },
  { name: 'pdf', description: 'Read and summarize PDF files' },
  { name: 'init', description: 'Initialize Claude Code configuration for a project' },
  { name: 'bug', description: 'Find and fix bugs in the codebase' },
  { name: 'memory', description: "Manage Claude's project memory (CLAUDE.md)" },
];

// --- Profile management (multi-profile) ---

const VALID_EFFORTS = ['low', 'medium', 'high', 'max'];
const VALID_PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'];

function profilesDir(baseDir) {
  return path.join(baseDir, 'capabilities', 'profiles');
}

function profileFilePath(baseDir, name) {
  return path.join(profilesDir(baseDir), `${name}.json`);
}

function activeFilePath(baseDir) {
  return path.join(baseDir, 'capabilities', 'active.json');
}

function listProfiles(baseDir) {
  const builtins = Object.values(BUILTIN_PROFILES).map(p => ({
    name: p.name, label: p.label, description: p.description, builtin: true,
  }));
  const dir = profilesDir(baseDir);
  let customs = [];
  try {
    if (fs.existsSync(dir)) {
      customs = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
            return { name: data.name, label: data.label || data.name, description: data.description || '', builtin: false };
          } catch { return null; }
        })
        .filter(Boolean)
        .filter(p => !BUILTIN_PROFILES[p.name]); // don't shadow builtins
    }
  } catch {}
  return [...builtins, ...customs];
}

function loadProfile(baseDir, name) {
  if (BUILTIN_PROFILES[name]) {
    return JSON.parse(JSON.stringify(BUILTIN_PROFILES[name]));
  }
  const file = profileFilePath(baseDir, name);
  try {
    if (fs.existsSync(file)) {
      return validateProfile(JSON.parse(fs.readFileSync(file, 'utf-8')));
    }
  } catch {}
  return null;
}

function loadActiveProfile(baseDir) {
  // Migration: old single-file profile.json
  const oldFile = path.join(baseDir, 'capabilities', 'profile.json');
  const actFile = activeFilePath(baseDir);
  if (fs.existsSync(oldFile) && !fs.existsSync(actFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(oldFile, 'utf-8'));
      const migrated = validateProfile({ ...old, name: old.name || 'custom', label: old.label || 'Custom (migrated)' });
      if (!BUILTIN_PROFILES[migrated.name]) {
        const dir = profilesDir(baseDir);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(profileFilePath(baseDir, migrated.name), JSON.stringify(migrated, null, 2));
        setActiveProfile(baseDir, migrated.name);
      } else {
        setActiveProfile(baseDir, migrated.name);
      }
      fs.unlinkSync(oldFile);
      return loadProfile(baseDir, migrated.name) || JSON.parse(JSON.stringify(BUILTIN_PROFILES.full));
    } catch {}
  }

  // Normal load
  try {
    if (fs.existsSync(actFile)) {
      const { active } = JSON.parse(fs.readFileSync(actFile, 'utf-8'));
      if (active) {
        const profile = loadProfile(baseDir, active);
        if (profile) return profile;
      }
    }
  } catch (err) { console.error('Error loading active profile:', err); }
  return JSON.parse(JSON.stringify(BUILTIN_PROFILES.full));
}

function saveProfile(baseDir, profile) {
  const validated = validateProfile(profile);
  if (!isValidName(validated.name)) return false;
  // Cannot overwrite builtin names
  if (BUILTIN_PROFILES[validated.name]) return false;
  const dir = profilesDir(baseDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(profileFilePath(baseDir, validated.name), JSON.stringify(validated, null, 2));
  return true;
}

function deleteProfile(baseDir, name) {
  if (!isValidName(name)) return false;
  if (BUILTIN_PROFILES[name]) return false;
  const file = profileFilePath(baseDir, name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  // If deleted profile was active, reset to full
  try {
    const actFile = activeFilePath(baseDir);
    if (fs.existsSync(actFile)) {
      const { active } = JSON.parse(fs.readFileSync(actFile, 'utf-8'));
      if (active === name) setActiveProfile(baseDir, 'full');
    }
  } catch (err) { console.error('Error resetting active profile after delete:', err); }
  return true;
}

function setActiveProfile(baseDir, name) {
  if (!BUILTIN_PROFILES[name] && !isValidName(name)) return false;
  const dir = path.join(baseDir, 'capabilities');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(activeFilePath(baseDir), JSON.stringify({ active: name }, null, 2));
}

function duplicateProfile(baseDir, sourceName, newName) {
  if (!isValidName(newName)) return false;
  if (BUILTIN_PROFILES[newName]) return false;
  const source = loadProfile(baseDir, sourceName);
  if (!source) return false;
  const copy = { ...source, name: newName, label: newName, builtin: false };
  return saveProfile(baseDir, copy);
}

function validateProfile(p) {
  return {
    name: p.name || 'custom',
    label: typeof p.label === 'string' ? p.label : (p.name || 'Custom'),
    description: typeof p.description === 'string' ? p.description : '',
    builtin: !!p.builtin,
    model: p.model || null,
    effort: VALID_EFFORTS.includes(p.effort) ? p.effort : null,
    permissionMode: VALID_PERMISSIONS.includes(p.permissionMode) ? p.permissionMode : 'default',
    disabledTools: Array.isArray(p.disabledTools) ? p.disabledTools.filter(t => KNOWN_TOOLS.includes(t)) : [],
    disableSlashCommands: !!p.disableSlashCommands,
    maxTurns: typeof p.maxTurns === 'number' && p.maxTurns > 0 ? p.maxTurns : null,
    maxBudgetUsd: typeof p.maxBudgetUsd === 'number' && p.maxBudgetUsd > 0 ? p.maxBudgetUsd : null,
    appendSystemPrompt: typeof p.appendSystemPrompt === 'string' && p.appendSystemPrompt.trim() ? p.appendSystemPrompt.trim() : null,
    systemPrompt: typeof p.systemPrompt === 'string' && p.systemPrompt.trim() ? p.systemPrompt.trim() : null,
    mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers.filter(s => typeof s === 'string') : [],
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

// --- Skill CRUD (.claude/skills/<name>/SKILL.md) ---

function skillsDir(cwd) {
  return path.join(cwd, '.claude', 'skills');
}

function listSkills(cwd) {
  const dir = skillsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => {
      const skillFile = path.join(dir, f, 'SKILL.md');
      return fs.existsSync(skillFile) && fs.statSync(path.join(dir, f)).isDirectory();
    })
    .map(f => {
      const content = fs.readFileSync(path.join(dir, f, 'SKILL.md'), 'utf-8');
      const desc = extractFrontmatterField(content, 'description') || '';
      return { name: f, description: desc.split('\n')[0].trim(), content };
    });
}

function readSkill(cwd, name) {
  const file = path.join(skillsDir(cwd), name, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function saveSkill(cwd, name, content, extraFiles) {
  if (!isValidName(name)) return false;
  const dir = path.join(skillsDir(cwd), name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  // Write extra files (templates, scripts, etc.)
  if (Array.isArray(extraFiles)) {
    for (const f of extraFiles) {
      if (!f.name || typeof f.content !== 'string') continue;
      // Prevent path traversal — resolve and verify containment
      const clean = path.normalize(f.name);
      const filePath = path.resolve(dir, clean);
      if (!filePath.startsWith(dir + path.sep) && filePath !== dir) continue;
      const fileDir = path.dirname(filePath);
      if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
      fs.writeFileSync(filePath, f.content);
    }
  }
  return true;
}

function deleteSkill(cwd, name) {
  const dir = path.join(skillsDir(cwd), name);
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  // Remove the directory if empty
  try {
    const remaining = fs.readdirSync(dir);
    if (remaining.length === 0) fs.rmdirSync(dir);
  } catch {}
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
  BUILTIN_PROFILES,
  PRESETS, // backward compat alias
  KNOWN_SKILLS,
  HOOK_EVENTS,
  MATCHER_EVENTS,
  listProfiles,
  loadProfile,
  loadActiveProfile,
  saveProfile,
  deleteProfile,
  setActiveProfile,
  duplicateProfile,
  validateProfile,
  listCommands,
  readCommand,
  saveCommand,
  deleteCommand,
  listSkills,
  readSkill,
  saveSkill,
  deleteSkill,
  listAgents,
  readAgent,
  saveAgent,
  deleteAgent,
  listHooks,
  saveHook,
  deleteHook,
};
