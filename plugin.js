/**
 * Slack Status Sync — host-side plugin script.
 *
 * Architecture:
 *  - plugin.js = credential manager + Slack API caller + hook listener
 *    (runs in the host renderer, always alive, survives the settings iframe
 *    opening/closing).
 *  - index.html (iframe) = UI only. It talks to this script via
 *    window.parent.slackStatusBridge rather than calling
 *    PluginAPI.setSecret/getSecret/persistDataSynced/loadSyncedData
 *    directly — those aren't reliably available inside the sandboxed
 *    iframe. Iframe plugins get `allow-same-origin`, so window.parent.<x>
 *    is a safe, documented-in-practice way to bridge over.
 *
 * SECURITY: the Slack token only ever lives in PluginAPI.setSecret()
 * (local-only, never synced/exported). Everything else (templates,
 * toggles) goes through PluginAPI.persistDataSynced().
 */
(function () {
  const DEFAULT_CFG = {
    trackingEnabled: true,
    trackingTextTemplate: 'Working on: {title}',
    trackingEmoji: ':computer:',
    clearOnStop: true,
    endOfDayEnabled: true,
    endOfDayText: 'Done for today',
    endOfDayEmoji: ':palm_tree:',
    // 0 = status never auto-expires
    endOfDayExpireHours: 12,

    // --- Focus Mode -> Slack "Pause notifications" ---
    dndEnabled: false,
    // How long to pause notifications for when focus mode starts. Slack's
    // "Pause notifications" (dnd.setSnooze) API always needs a duration; we
    // don't rely on reading the actual focus session length out of the
    // action payload since that field isn't documented/stable, so this is
    // a fixed ceiling. Ending focus mode calls dnd.endSnooze ("Resume
    // notifications") immediately regardless of this value.
    dndDurationMinutes: 25,
    // Also set a custom status text/emoji while in focus mode (separate
    // from pausing notifications itself, which Slack shows as a moon
    // icon next to your name — this is the same feature you'd trigger by
    // clicking your profile photo → "Pause notifications" in Slack; there
    // is no separate API for Slack's client-side sidebar "Focus mode").
    focusStatusEnabled: true,
    focusStatusText: 'In focus mode 🎯',
    focusStatusEmoji: ':no_entry:',
    // Comma-separated NgRx action "type" strings that mark the start/end
    // of a focus session. These are BEST-GUESS defaults — Focus Mode's
    // exact action names can vary by app version. Use "Log Focus actions
    // to console" below to confirm/correct them for your install.
    focusStartActionTypes: '[FocusMode] Start Session, [FocusMode] Show Overlay',
    focusEndActionTypes:
      '[FocusMode] Cancel Session, [FocusMode] Session Done, [FocusMode] Hide Overlay, [FocusMode] Unload',
    debugLogFocusActions: false,
  };

  let cfg = Object.assign({}, DEFAULT_CFG);
  let slackToken = '';
  let configReady = false;
  let lastStatusKey = null;
  let inFocusMode = false;
  let preFocusStatusKey = null; // status to (best-effort) restore after focus ends

  // Diagnostics for the ACTION hook, surfaced in the settings UI so users
  // can confirm the hook is firing at all and see real action type strings
  // without needing DevTools.
  let totalActionsSeen = 0;
  let lastActionType = '';
  let lastActionTs = 0;
  const recentFocusActions = []; // { type, ts } — only entries containing "focus"
  const MAX_RECENT_FOCUS_ACTIONS = 20;

  function log(...args) {
    console.log('[SlackStatusSync]', ...args);
  }

  // ------------------------------------------------------------------
  // Config & secret persistence (host-side only — this is the part that
  // reliably works)
  // ------------------------------------------------------------------

  async function loadConfig() {
    try {
      const raw = await PluginAPI.loadSyncedData();
      if (raw) {
        cfg = Object.assign({}, DEFAULT_CFG, JSON.parse(raw));
      }
    } catch (e) {
      log('config load error', e);
    }

    try {
      const secret = await PluginAPI.getSecret('slackToken');
      if (secret) slackToken = secret;
    } catch (e) {
      log('getSecret error', e);
    }

    configReady = true;
    log('config ready. token:', slackToken ? 'set' : 'not set');
  }

  async function saveConfig() {
    try {
      await PluginAPI.persistDataSynced(JSON.stringify(cfg));
    } catch (e) {
      log('config save error', e);
    }
  }

  async function saveToken(token) {
    slackToken = token;
    try {
      await PluginAPI.setSecret('slackToken', token);
    } catch (e) {
      log('setSecret error', e);
    }
  }

  async function clearToken() {
    slackToken = '';
    try {
      await PluginAPI.deleteSecret('slackToken');
    } catch (e) {
      log('deleteSecret error', e);
    }
  }

  // ------------------------------------------------------------------
  // Slack API
  // ------------------------------------------------------------------

  function fillTemplate(tpl, task, project) {
    return String(tpl || '')
      .replace(/\{title\}/g, task ? task.title : '')
      .replace(/\{project\}/g, project ? project.title : '');
  }

  async function setSlackStatus(text, emoji, expireInHours, force) {
    if (!slackToken) {
      PluginAPI.showSnack({
        msg: 'Slack Status Sync: no Slack token saved yet. Open "Slack Status Sync" in the menu to add one.',
        type: 'WARNING',
      });
      return false;
    }

    const key = text + '|' + emoji;
    if (!force && key === lastStatusKey) {
      return true; // nothing changed, skip the call
    }

    const expiration =
      expireInHours && expireInHours > 0
        ? Math.floor(Date.now() / 1000) + expireInHours * 3600
        : 0;

    const profile = JSON.stringify({
      status_text: text || '',
      status_emoji: emoji || '',
      status_expiration: expiration,
    });

    const body = new URLSearchParams();
    body.set('token', slackToken);
    body.set('profile', profile);

    try {
      const res = await fetch('https://slack.com/api/users.profile.set', {
        method: 'POST',
        // Keep this a "simple" CORS request (form body, no custom headers,
        // token in the body) so no preflight is triggered.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || 'unknown_slack_error');
      }
      lastStatusKey = key;
      return true;
    } catch (e) {
      log('failed to update Slack status', e);
      PluginAPI.showSnack({
        msg: 'Slack Status Sync: failed to update status (' + (e.message || e) + ')',
        type: 'ERROR',
      });
      return false;
    }
  }

  async function setSlackDnd(numMinutes) {
    if (!slackToken) {
      PluginAPI.showSnack({
        msg: 'Slack Status Sync: no Slack token saved yet — cannot pause notifications.',
        type: 'WARNING',
      });
      return false;
    }
    const body = new URLSearchParams();
    body.set('token', slackToken);
    body.set('num_minutes', String(Math.max(1, Math.round(numMinutes))));
    try {
      const res = await fetch('https://slack.com/api/dnd.setSnooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'unknown_slack_error');
      return true;
    } catch (e) {
      log('failed to pause Slack notifications', e);
      PluginAPI.showSnack({
        msg: 'Slack Status Sync: failed to pause notifications (' + (e.message || e) + ')',
        type: 'ERROR',
      });
      return false;
    }
  }

  async function endSlackDnd() {
    if (!slackToken) return false;
    const body = new URLSearchParams();
    body.set('token', slackToken);
    try {
      const res = await fetch('https://slack.com/api/dnd.endSnooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'unknown_slack_error');
      return true;
    } catch (e) {
      log('failed to resume Slack notifications', e);
      PluginAPI.showSnack({
        msg: 'Slack Status Sync: failed to resume notifications (' + (e.message || e) + ')',
        type: 'ERROR',
      });
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Hooks
  // ------------------------------------------------------------------

  async function handleCurrentTaskChange(payload) {
    if (!configReady) await loadConfig();
    if (!cfg.trackingEnabled) return;

    const task = payload && payload.current;

    if (task) {
      let project = null;
      if (task.projectId) {
        try {
          const projects = await PluginAPI.getAllProjects();
          project = projects.find((p) => p.id === task.projectId) || null;
        } catch (e) {
          // non-fatal, {project} just won't be substituted
        }
      }
      const text = fillTemplate(cfg.trackingTextTemplate, task, project);
      await setSlackStatus(text, cfg.trackingEmoji, 0);
    } else if (cfg.clearOnStop) {
      await setSlackStatus('', '', 0);
    }
  }

  async function handleFinishDay() {
    if (!configReady) await loadConfig();
    if (!cfg.endOfDayEnabled) return;
    await setSlackStatus(cfg.endOfDayText, cfg.endOfDayEmoji, cfg.endOfDayExpireHours);
  }

  function splitTypes(str) {
    return String(str || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function handleFocusStart() {
    if (inFocusMode) return; // already on, don't double-fire
    inFocusMode = true;
    preFocusStatusKey = lastStatusKey;

    if (cfg.dndEnabled) {
      await setSlackDnd(cfg.dndDurationMinutes);
    }
    if (cfg.focusStatusEnabled) {
      await setSlackStatus(cfg.focusStatusText, cfg.focusStatusEmoji, 0, true);
    }
  }

  async function handleFocusEnd() {
    // Deliberately NOT gated on `if (!inFocusMode) return`. inFocusMode is
    // only in-memory, so it resets to false whenever plugin.js reloads
    // (app restart, plugin toggled off/on, plugin re-uploaded) — if that
    // reload happens mid-session, a fresh instance never saw the matching
    // "start" and would otherwise silently ignore the real "end" action
    // forever. Calling dnd.endSnooze / clearing status when there's
    // nothing to undo is a harmless no-op on Slack's side, so it's safe
    // to always run this when the end action type matches.
    inFocusMode = false;

    if (cfg.dndEnabled) {
      await endSlackDnd();
    }
    if (cfg.focusStatusEnabled) {
      // Best-effort: clear the focus status. We don't know what the
      // "correct" status to restore is (task tracking may have also
      // changed while focused), so the next currentTaskChange/finishDay
      // event will set the right one; this just clears the focus banner.
      await setSlackStatus('', '', 0, true);
    }
  }

  PluginAPI.registerHook(PluginAPI.Hooks.CURRENT_TASK_CHANGE, handleCurrentTaskChange);
  PluginAPI.registerHook(PluginAPI.Hooks.FINISH_DAY, handleFinishDay);

  // The ACTION hook's payload is shaped { action: {...} }, not the action
  // object directly — confirmed via logging the raw payload during
  // debugging (an earlier attempt logging `action.type` looked like
  // `undefined` because that property genuinely doesn't exist one level
  // up, not because the hook wasn't firing).
  PluginAPI.registerHook(PluginAPI.Hooks.ACTION, async (wrapper) => {
    const action = wrapper && wrapper.action;

    try {
      if (!action || !action.type) return;
      if (!configReady) await loadConfig();

      // Always record diagnostics (cheap) so the settings UI can show
      // whether the ACTION hook is firing at all, independent of whether
      // debug console logging or DND/status handling are turned on.
      totalActionsSeen++;
      lastActionType = action.type;
      lastActionTs = Date.now();
      if (String(action.type).toLowerCase().includes('focus')) {
        recentFocusActions.push({ type: action.type, ts: lastActionTs });
        if (recentFocusActions.length > MAX_RECENT_FOCUS_ACTIONS) {
          recentFocusActions.shift();
        }
        if (cfg.debugLogFocusActions) {
          log('action:', action.type);
        }
      }

      if (!cfg.dndEnabled && !cfg.focusStatusEnabled) return;

      const startTypes = splitTypes(cfg.focusStartActionTypes);
      const endTypes = splitTypes(cfg.focusEndActionTypes);

      if (startTypes.includes(action.type)) {
        await handleFocusStart();
      } else if (endTypes.includes(action.type)) {
        await handleFocusEnd();
      }
    } catch (e) {
      // If anything above throws, log it loudly instead of failing silently.
      console.error('[SlackStatusSync] ACTION hook handler threw:', e);
    }
  });

  // ------------------------------------------------------------------
  // Menu entry / config icon — both just show the settings iframe
  // ------------------------------------------------------------------

  PluginAPI.registerMenuEntry({
    label: 'Slack Status Sync',
    icon: 'chat',
    onClick: () => {
      PluginAPI.showIndexHtmlAsView();
    },
  });

  PluginAPI.registerConfigHandler(() => {
    PluginAPI.showIndexHtmlAsView();
  });

  // ------------------------------------------------------------------
  // Bridge exposed to the settings iframe
  // ------------------------------------------------------------------

  const slackStatusBridge = {
    isReady: () => configReady,
    getConfig: () => Object.assign({}, cfg, { hasToken: !!slackToken, inFocusMode }),
    saveSettings: async (newCfg, token) => {
      cfg = Object.assign({}, DEFAULT_CFG, newCfg || {});
      await saveConfig();
      if (token) await saveToken(token);
      return true;
    },
    clearToken: async () => {
      await clearToken();
      return true;
    },
    sendTestStatus: async () => {
      return await setSlackStatus(
        '🔧 Slack Status Sync test — this worked!',
        cfg.trackingEmoji || ':wave:',
        1,
        true,
      );
    },
    sendTestFocusStart: async () => {
      await handleFocusStart();
      return true;
    },
    sendTestFocusEnd: async () => {
      await handleFocusEnd();
      return true;
    },
    getDiagnostics: () => ({
      totalActionsSeen,
      lastActionType,
      lastActionTs,
      recentFocusActions: recentFocusActions.slice().reverse(), // newest first
      inFocusMode,
    }),
  };

  if (typeof window !== 'undefined') {
    window.slackStatusBridge = slackStatusBridge;
  }

  loadConfig();
  log('loaded');
})();
