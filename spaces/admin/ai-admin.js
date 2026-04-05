/**
 * AlpaClaw Configuration - Admin page for managing AlpaClaw chatbot (OpenClaw gateway)
 */

import { supabase } from '../../shared/supabase.js';
import { initAdminPage, showToast } from '../../shared/admin-shell.js';

// =============================================
// STATE
// =============================================

let authState = null;
let config = null;
let activeWorkspaceFile = 'soul_md';

const WORKSPACE_FILES = ['soul_md', 'user_md', 'identity_md', 'agents_md', 'heartbeat_md', 'memory_md', 'tools_md', 'boot_md'];

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  authState = await initAdminPage({
    activeTab: 'openclaw',
    requiredRole: 'admin',
    section: 'admin',
    onReady: async (state) => {
      await loadConfig();
      setupEventListeners();
    }
  });
});

// =============================================
// DATA LOADING
// =============================================

async function loadConfig() {
  try {
    const { data, error } = await supabase
      .from('openclaw_config')
      .select('*')
      .eq('id', 1)
      .single();

    if (error) throw error;
    config = data;
    populateFields();
  } catch (err) {
    console.error('Error loading AlpaClaw config:', err);
    showToast('Failed to load AlpaClaw configuration', 'error');
  }
}

function populateFields() {
  if (!config) return;

  // Server status
  const ipEl = document.getElementById('serverIp');
  const domainEl = document.getElementById('serverDomain');
  const portEl = document.getElementById('serverPort');
  const lastDeployedEl = document.getElementById('lastDeployed');
  const statusBadge = document.getElementById('serverStatusBadge');

  if (ipEl) ipEl.textContent = config.server_ip || '-';
  if (domainEl) {
    domainEl.textContent = config.domain || '-';
    domainEl.href = config.domain ? `https://${config.domain}` : '#';
  }
  if (portEl) portEl.textContent = config.gateway_port || '-';
  if (lastDeployedEl) {
    lastDeployedEl.textContent = config.last_deployed_at
      ? new Date(config.last_deployed_at).toLocaleString()
      : 'Never';
  }
  if (statusBadge) {
    statusBadge.textContent = config.is_active ? 'Active' : 'Inactive';
    statusBadge.className = `settings-badge ${config.is_active ? 'active' : 'inactive'}`;
  }

  // Dirty state warning
  const dirtyWarning = document.getElementById('deployDirtyWarning');
  if (dirtyWarning && config.updated_at && config.last_deployed_at) {
    const updated = new Date(config.updated_at);
    const deployed = new Date(config.last_deployed_at);
    dirtyWarning.style.display = updated > deployed ? '' : 'none';
  }

  // General settings
  setVal('agentName', config.agent_name);
  setVal('timezone', config.timezone);
  setVal('gatewayToken', config.gateway_token);
  setChecked('isActive', config.is_active);
  setVal('notes', config.notes);

  // LLM config
  setVal('geminiApiKey', config.gemini_api_key);
  setVal('primaryModel', config.primary_model);
  setVal('fallbackModel', config.fallback_model);
  setVal('reasoningModel', config.reasoning_model);

  // Channels
  setVal('whatsappNumber', config.whatsapp_number);
  setChecked('whatsappEnabled', config.whatsapp_enabled);
  setBadge('whatsappStatusBadge', config.whatsapp_enabled);

  setVal('discordBotToken', config.discord_bot_token);
  setChecked('discordEnabled', config.discord_enabled);
  setBadge('discordStatusBadge', config.discord_enabled);

  setVal('telegramBotToken', config.telegram_bot_token);
  setChecked('telegramEnabled', config.telegram_enabled);
  setBadge('telegramStatusBadge', config.telegram_enabled);

  setVal('slackBotToken', config.slack_bot_token);
  setChecked('slackEnabled', config.slack_enabled);
  setBadge('slackStatusBadge', config.slack_enabled);

  // Security + partitioning
  setVal('discordStaffGuildIds', config.discord_staff_guild_ids);
  setVal('discordStaffChannelIds', config.discord_staff_channel_ids);
  setVal('discordResidentGuildIds', config.discord_resident_guild_ids);
  setVal('discordResidentChannelIds', config.discord_resident_channel_ids);
  setVal('discordDmPolicy', config.discord_dm_policy || 'open');
  setVal('telegramDmPolicy', config.telegram_dm_policy || 'open');
  setChecked('residentModeEnabled', config.resident_mode_enabled);
  setVal('residentAllowedCommands', config.resident_allowed_commands);
  setChecked('allowInsecureAuth', config.allow_insecure_auth);
  setChecked('allowHostHeaderOriginFallback', config.allow_host_header_origin_fallback);
  setChecked('disableDeviceAuth', config.disable_device_auth);
  setChecked('recordPaymentStaffOnly', config.record_payment_staff_only ?? true);

  // Workspace files - load active tab
  loadWorkspaceFile(activeWorkspaceFile);

  // Update server IP in deploy steps
  document.querySelectorAll('.server-ip-display').forEach(el => {
    el.textContent = config.server_ip || '93.188.164.224';
  });
}

// =============================================
// HELPERS
// =============================================

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value || '';
}

function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function setChecked(id, checked) {
  const el = document.getElementById(id);
  if (el) el.checked = !!checked;
}

function getChecked(id) {
  const el = document.getElementById(id);
  return el ? el.checked : false;
}

function setBadge(id, enabled) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = enabled ? 'Enabled' : 'Disabled';
  el.className = `settings-badge ${enabled ? 'active' : 'inactive'}`;
}

// =============================================
// SAVE FUNCTIONS
// =============================================

async function saveGeneral() {
  try {
    const updates = {
      agent_name: getVal('agentName'),
      timezone: getVal('timezone'),
      gateway_token: getVal('gatewayToken'),
      is_active: getChecked('isActive'),
      notes: getVal('notes'),
    };

    const { error } = await supabase
      .from('openclaw_config')
      .update(updates)
      .eq('id', 1);

    if (error) throw error;
    Object.assign(config, updates);
    showToast('General settings saved', 'success');
  } catch (err) {
    console.error('Error saving general settings:', err);
    showToast('Failed to save general settings', 'error');
  }
}

async function saveLlm() {
  try {
    const updates = {
      gemini_api_key: getVal('geminiApiKey'),
      primary_model: getVal('primaryModel'),
      fallback_model: getVal('fallbackModel'),
      reasoning_model: getVal('reasoningModel'),
    };

    const { error } = await supabase
      .from('openclaw_config')
      .update(updates)
      .eq('id', 1);

    if (error) throw error;
    Object.assign(config, updates);
    showToast('LLM configuration saved', 'success');
  } catch (err) {
    console.error('Error saving LLM config:', err);
    showToast('Failed to save LLM configuration', 'error');
  }
}

async function saveChannels() {
  try {
    const updates = {
      whatsapp_number: getVal('whatsappNumber'),
      whatsapp_enabled: getChecked('whatsappEnabled'),
      discord_bot_token: getVal('discordBotToken'),
      discord_enabled: getChecked('discordEnabled'),
      telegram_bot_token: getVal('telegramBotToken'),
      telegram_enabled: getChecked('telegramEnabled'),
      slack_bot_token: getVal('slackBotToken'),
      slack_enabled: getChecked('slackEnabled'),
    };

    const { error } = await supabase
      .from('openclaw_config')
      .update(updates)
      .eq('id', 1);

    if (error) throw error;
    Object.assign(config, updates);

    // Update badges
    setBadge('whatsappStatusBadge', updates.whatsapp_enabled);
    setBadge('discordStatusBadge', updates.discord_enabled);
    setBadge('telegramStatusBadge', updates.telegram_enabled);
    setBadge('slackStatusBadge', updates.slack_enabled);

    showToast('Channel configuration saved', 'success');
  } catch (err) {
    console.error('Error saving channels:', err);
    showToast('Failed to save channel configuration', 'error');
  }
}

async function saveHardening() {
  try {
    const updates = {
      discord_staff_guild_ids: getVal('discordStaffGuildIds'),
      discord_staff_channel_ids: getVal('discordStaffChannelIds'),
      discord_resident_guild_ids: getVal('discordResidentGuildIds'),
      discord_resident_channel_ids: getVal('discordResidentChannelIds'),
      discord_dm_policy: getVal('discordDmPolicy') || 'open',
      telegram_dm_policy: getVal('telegramDmPolicy') || 'open',
      resident_mode_enabled: getChecked('residentModeEnabled'),
      resident_allowed_commands: getVal('residentAllowedCommands'),
      allow_insecure_auth: getChecked('allowInsecureAuth'),
      allow_host_header_origin_fallback: getChecked('allowHostHeaderOriginFallback'),
      disable_device_auth: getChecked('disableDeviceAuth'),
      record_payment_staff_only: getChecked('recordPaymentStaffOnly'),
    };

    const { error } = await supabase
      .from('openclaw_config')
      .update(updates)
      .eq('id', 1);

    if (error) throw error;
    Object.assign(config, updates);
    showToast('Security settings saved', 'success');
  } catch (err) {
    console.error('Error saving security settings:', err);
    showToast('Failed to save security settings', 'error');
  }
}

// =============================================
// WORKSPACE FILES
// =============================================

function loadWorkspaceFile(fileKey) {
  activeWorkspaceFile = fileKey;
  const textarea = document.getElementById('workspaceFileContent');
  if (!textarea || !config) return;

  textarea.value = config[fileKey] || '';

  // Update tab buttons
  document.querySelectorAll('.workspace-tab-btn').forEach(btn => {
    const isActive = btn.dataset.file === fileKey;
    btn.classList.toggle('btn-primary', isActive);
    btn.classList.toggle('active', isActive);
  });

  document.getElementById('workspaceFileStatus').textContent = '';
}

async function saveWorkspaceFile() {
  const textarea = document.getElementById('workspaceFileContent');
  const statusEl = document.getElementById('workspaceFileStatus');
  if (!textarea) return;

  try {
    const updates = { [activeWorkspaceFile]: textarea.value };
    const { error } = await supabase
      .from('openclaw_config')
      .update(updates)
      .eq('id', 1);

    if (error) throw error;
    config[activeWorkspaceFile] = textarea.value;
    if (statusEl) statusEl.textContent = 'Saved!';
    showToast(`${activeWorkspaceFile.replace('_md', '.md').toUpperCase()} saved`, 'success');
  } catch (err) {
    console.error('Error saving workspace file:', err);
    if (statusEl) statusEl.textContent = 'Error saving';
    showToast('Failed to save workspace file', 'error');
  }
}

// =============================================
// DEPLOY
// =============================================

function generateEnvFile() {
  if (!config) return;

  const lines = [
    `PORT=${config.gateway_port || 43414}`,
    `TZ=${config.timezone || 'America/Phoenix'}`,
    `OPENCLAW_GATEWAY_TOKEN=${config.gateway_token || ''}`,
  ];

  if (config.whatsapp_number) lines.push(`WHATSAPP_NUMBER=${config.whatsapp_number}`);
  if (config.gemini_api_key) lines.push(`GEMINI_API_KEY=${config.gemini_api_key}`);
  if (config.telegram_bot_token && config.telegram_enabled) {
    lines.push(`TELEGRAM_BOT_TOKEN=${config.telegram_bot_token}`);
    lines.push(`TELEGRAM_DM_POLICY=${config.telegram_dm_policy || 'open'}`);
  }
  if (config.discord_bot_token && config.discord_enabled) {
    lines.push(`DISCORD_BOT_TOKEN=${config.discord_bot_token}`);
    lines.push(`DISCORD_DM_POLICY=${config.discord_dm_policy || 'open'}`);
  }
  if (config.slack_bot_token && config.slack_enabled) {
    lines.push(`SLACK_BOT_TOKEN=${config.slack_bot_token}`);
  }

  // Hardening + partitioning policy values.
  lines.push(`OPENCLAW_ALLOW_INSECURE_AUTH=${config.allow_insecure_auth ? 'true' : 'false'}`);
  lines.push(`OPENCLAW_ALLOW_HOST_HEADER_ORIGIN_FALLBACK=${config.allow_host_header_origin_fallback ? 'true' : 'false'}`);
  lines.push(`OPENCLAW_DISABLE_DEVICE_AUTH=${config.disable_device_auth ? 'true' : 'false'}`);
  lines.push(`OPENCLAW_RECORD_PAYMENT_STAFF_ONLY=${config.record_payment_staff_only === false ? 'false' : 'true'}`);
  if (config.discord_staff_guild_ids) lines.push(`OPENCLAW_STAFF_GUILD_IDS=${config.discord_staff_guild_ids}`);
  if (config.discord_staff_channel_ids) lines.push(`OPENCLAW_STAFF_CHANNEL_IDS=${config.discord_staff_channel_ids}`);
  if (config.discord_resident_guild_ids) lines.push(`OPENCLAW_RESIDENT_GUILD_IDS=${config.discord_resident_guild_ids}`);
  if (config.discord_resident_channel_ids) lines.push(`OPENCLAW_RESIDENT_CHANNEL_IDS=${config.discord_resident_channel_ids}`);
  if (config.resident_mode_enabled) lines.push(`OPENCLAW_RESIDENT_MODE_ENABLED=true`);
  if (config.resident_allowed_commands) lines.push(`OPENCLAW_RESIDENT_ALLOWED_COMMANDS=${config.resident_allowed_commands}`);

  const envContent = lines.join('\n');

  const outputSection = document.getElementById('envOutputSection');
  const outputTextarea = document.getElementById('envOutput');
  if (outputSection) outputSection.style.display = '';
  if (outputTextarea) outputTextarea.value = envContent;
}

async function copyToClipboard() {
  const textarea = document.getElementById('envOutput');
  if (!textarea) return;

  try {
    await navigator.clipboard.writeText(textarea.value);
    showToast('Copied to clipboard', 'success');
  } catch {
    // Fallback
    textarea.select();
    document.execCommand('copy');
    showToast('Copied to clipboard', 'success');
  }
}

async function markAsDeployed() {
  try {
    const now = new Date().toISOString();
    const deployedBy = authState?.appUser?.display_name || authState?.appUser?.email || 'unknown';

    const { error } = await supabase
      .from('openclaw_config')
      .update({
        last_deployed_at: now,
        last_deployed_by: deployedBy,
      })
      .eq('id', 1);

    if (error) throw error;
    config.last_deployed_at = now;
    config.last_deployed_by = deployedBy;

    const el = document.getElementById('lastDeployed');
    if (el) el.textContent = new Date(now).toLocaleString();

    const statusEl = document.getElementById('deployStatus');
    if (statusEl) statusEl.textContent = `Deployed by ${deployedBy}`;

    const dirtyWarning = document.getElementById('deployDirtyWarning');
    if (dirtyWarning) dirtyWarning.style.display = 'none';

    showToast('Marked as deployed', 'success');
  } catch (err) {
    console.error('Error marking deployed:', err);
    showToast('Failed to mark as deployed', 'error');
  }
}

// =============================================
// EVENT LISTENERS
// =============================================

function setupEventListeners() {
  // General
  document.getElementById('saveGeneralBtn')?.addEventListener('click', saveGeneral);

  // LLM
  document.getElementById('saveLlmBtn')?.addEventListener('click', saveLlm);

  // Channels
  document.getElementById('saveChannelsBtn')?.addEventListener('click', saveChannels);
  document.getElementById('saveHardeningBtn')?.addEventListener('click', saveHardening);

  // Workspace file tabs
  document.getElementById('workspaceFileTabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.workspace-tab-btn');
    if (btn && btn.dataset.file) loadWorkspaceFile(btn.dataset.file);
  });

  // Save workspace file
  document.getElementById('saveWorkspaceFileBtn')?.addEventListener('click', saveWorkspaceFile);

  // Deploy
  document.getElementById('generateEnvBtn')?.addEventListener('click', generateEnvFile);
  document.getElementById('copyEnvBtn')?.addEventListener('click', copyToClipboard);
  document.getElementById('markDeployedBtn')?.addEventListener('click', markAsDeployed);
}
