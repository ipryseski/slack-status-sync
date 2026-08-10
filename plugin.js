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
 * toggles) goes through PluginAPI.persistDataSynced(). The bridge below
 * deliberately never exposes the token itself — only whether one is set.
 *
 * Notes on facts verified against Super Productivity 18.19.0's bundle
 * rather than guessed, since several of them used to be guesses:
 *  - The ACTION hook payload is `{ action: <NgRx action object> }` (SP's
 *    own ActionPayload type says `action: string`; the implementation
 *    passes the object, so we accept both).
 *  - currentTaskChange payload is `{ current: Task|null, previous: Task|null }`.
 *  - Focus Mode's real action type strings are enumerated in
 *    DEFAULT_CFG/LEGACY_FOCUS_DEFAULTS below.
 *  - `[FocusMode] Start Session` carries `{ duration?: number (ms), taskId? }`.
 *  - PluginAPI.request() is the sanctioned HTTP path and is gated by the
 *    "http" permission plus "allowedHosts" in the manifest (fail-closed).
 */
(function () {
  'use strict';

  // Bumped when DEFAULT_CFG changes in a way that must reach installs which
  // already persisted the previous values. See migrateConfig().
  const CFG_VERSION = 2;

  const SLACK_API_BASE = 'https://slack.com/api/';
  // Slack rejects/truncates status text past 100 characters.
  const STATUS_TEXT_MAX = 100;
  // currentTaskChange can fire a few times in quick succession while SP
  // settles (select task -> start timer -> attach). users.profile.set is a
  // Tier 3 method (~50 requests/min), so collapse bursts rather than
  // spending a call on each intermediate state.
  const TASK_CHANGE_DEBOUNCE_MS = 2000;
  // Used when we can't read Slack's Retry-After (see slackPost()).
  const RETRY_FALLBACK_SECONDS = 30;
  const MAX_RETRIES = 2;
  const RETRYABLE_HTTP = [429, 500, 502, 503, 504];
  const MAX_FOCUS_ACTION_TYPES = 20;

  const DEFAULT_CFG = {
    cfgVersion: CFG_VERSION,

    trackingEnabled: true,
    trackingTextTemplate: 'Working on: {title}',
    trackingEmoji: ':computer:',
    clearOnStop: true,
    // 0 = the tracking status never auto-expires. Set this if you'd rather
    // not risk a stale "Working on: …" sticking around after a crash — Slack
    // clears it on its own, so it works even if SP isn't running.
    trackingExpireHours: 0,

    endOfDayEnabled: true,
    endOfDayText: 'Done for today',
    endOfDayEmoji: ':palm_tree:',
    // 0 = status never auto-expires
    endOfDayExpireHours: 12,

    // --- Focus Mode -> Slack "Pause notifications" ---
    dndEnabled: false,
    // Fallback pause length, in minutes. `[FocusMode] Start Session` carries
    // the real session length, so this is only used when the payload has no
    // duration (Flowtime mode, or the "Simulate focus start" button).
    // Ending focus mode calls dnd.endSnooze immediately regardless.
    dndDurationMinutes: 25,
    // Also set a custom status text/emoji while in focus mode (separate
    // from pausing notifications itself, which Slack shows as a moon
    // icon next to your name — this is the same feature you'd trigger by
    // clicking your profile photo → "Pause notifications" in Slack; there
    // is no separate API for Slack's client-side sidebar "Focus mode").
    focusStatusEnabled: true,
    focusStatusText: 'In focus mode 🎯',
    focusStatusEmoji: ':no_entry:',
    // Comma-separated NgRx action "type" strings marking session start/end.
    // These are the real strings from SP's focus-mode actions, not guesses:
    // a session starts with Start Session, and ends via Complete Session
    // (ran to completion), Cancel Session (aborted), or End Flowtime Session.
    // Show/Hide Overlay are deliberately NOT included — they're pure UI
    // events that also fire when you merely open or close the focus screen.
    focusStartActionTypes: '[FocusMode] Start Session',
    focusEndActionTypes:
      '[FocusMode] Complete Session, [FocusMode] Cancel Session, [FocusMode] End Flowtime Session',
    debugLogFocusActions: false,
  };

  // v1 shipped best-guess action types. Two of them ('[FocusMode] Session
  // Done', '[FocusMode] Unload') never existed in any SP version, and the
  // list was missing '[FocusMode] Complete Session' — the action a normally
  // finishing session dispatches — so notifications were never resumed when
  // a session ran its course instead of being cancelled. On the start side,
  // '[FocusMode] Show Overlay' fired DND on merely opening the focus screen.
  // migrateConfig() replaces these, but only when left untouched, so anyone
  // who already corrected them by hand keeps their values.
  const LEGACY_FOCUS_DEFAULTS = {
    focusStartActionTypes: ['[FocusMode] Start Session, [FocusMode] Show Overlay'],
    focusEndActionTypes: [
      '[FocusMode] Cancel Session, [FocusMode] Session Done, [FocusMode] Hide Overlay, [FocusMode] Unload',
    ],
  };

  const CONFIG_KEYS = Object.keys(DEFAULT_CFG);

  let cfg = Object.assign({}, DEFAULT_CFG);
  let slackToken = '';
  let configReady = false;
  let configPromise = null;
  // { key, expiresAt } for the status we last successfully pushed;
  // expiresAt is a unix second, 0 meaning "no expiry".
  let lastStatus = null;
  let inFocusMode = false;
  // Last currentTaskChange payload, kept even while focus mode owns the
  // status so focus end can restore the correct tracking status.
  let lastTaskPayload = null;
  let taskChangeTimer = null;
  // Set by "Finish Day" so a focus session that ends afterwards doesn't
  // restore a tracking status over the top of the end-of-day one.
  let dayFinished = false;
  // Derived, never persisted: who the saved token actually belongs to.
  let tokenIdentity = null; // { user, team }
  let tokenError = '';

  // Diagnostics for the ACTION hook, surfaced in the settings UI so users
  // can confirm the hook is firing at all and see real action type strings
  // without needing DevTools.
  let totalActionsSeen = 0;
  let lastActionType = '';
  let lastActionTs = 0;
  // Grouped by type rather than a flat ring buffer: '[FocusMode] Timer Tick'
  // fires once a second during a session, so a last-N list would be nothing
  // but ticks by the time anyone clicks Refresh — hiding the start/end
  // actions the panel exists to reveal.
  const focusActionStats = new Map(); // type -> { type, ts, count }

  const apiLog =
    typeof PluginAPI !== 'undefined' && PluginAPI.log ? PluginAPI.log : null;

  function log() {
    const args = Array.prototype.slice.call(arguments);
    if (apiLog && typeof apiLog.info === 'function') {
      apiLog.info.apply(apiLog, args);
    } else {
      console.log.apply(console, ['[SlackStatusSync]'].concat(args));
    }
  }

  function logErr() {
    const args = Array.prototype.slice.call(arguments);
    if (apiLog && typeof apiLog.err === 'function') {
      apiLog.err.apply(apiLog, args);
    } else {
      console.error.apply(console, ['[SlackStatusSync]'].concat(args));
    }
  }

  function snack(msg, type) {
    try {
      PluginAPI.showSnack({ msg: 'Slack Status Sync: ' + msg, type: type || 'INFO' });
    } catch (e) {
      logErr('showSnack failed', e);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ------------------------------------------------------------------
  // Config & secret persistence (host-side only — this is the part that
  // reliably works)
  // ------------------------------------------------------------------

  // Keep only known config keys. Without this, the settings iframe round
  // trips getConfig()'s derived extras (hasToken, inFocusMode, tokenIdentity)
  // straight back into persisted — and therefore synced — data.
  function pickConfig(obj) {
    const out = {};
    CONFIG_KEYS.forEach((key) => {
      out[key] =
        obj && obj[key] !== undefined && obj[key] !== null ? obj[key] : DEFAULT_CFG[key];
    });
    return out;
  }

  function migrateConfig(saved) {
    const next = pickConfig(Object.assign({}, DEFAULT_CFG, saved));
    const savedVersion = Number(saved && saved.cfgVersion) || 1;

    if (savedVersion < 2) {
      const replaced = [];
      Object.keys(LEGACY_FOCUS_DEFAULTS).forEach((key) => {
        const current = String((saved && saved[key]) || '').trim();
        if (LEGACY_FOCUS_DEFAULTS[key].indexOf(current) !== -1) {
          next[key] = DEFAULT_CFG[key];
          replaced.push(key);
        }
      });
      if (replaced.length) {
        log('migrated to verified focus action types: ' + replaced.join(', '));
      }
    }

    next.cfgVersion = CFG_VERSION;
    return next;
  }

  async function loadConfig() {
    try {
      const raw = await PluginAPI.loadSyncedData();
      const saved = raw ? JSON.parse(raw) : null;
      const migrated = migrateConfig(saved || {});
      // Also treat a missing/old cfgVersion as needing a write, so the
      // version gets stamped once instead of re-migrating on every load.
      const changed =
        Number(saved && saved.cfgVersion) !== CFG_VERSION ||
        JSON.stringify(migrated) !== JSON.stringify(pickConfig(saved));
      cfg = migrated;
      // Persist the migration so the corrected values show up in the
      // settings UI and survive the next load.
      if (saved && changed) {
        try {
          await saveConfig();
        } catch (e) {
          logErr('could not persist migrated config', e);
        }
      }
    } catch (e) {
      logErr('config load error', e);
      cfg = Object.assign({}, DEFAULT_CFG);
    }

    try {
      const secret = await PluginAPI.getSecret('slackToken');
      if (secret) slackToken = secret;
    } catch (e) {
      logErr('getSecret error', e);
    }

    configReady = true;
    log('config ready. token:', slackToken ? 'set' : 'not set');

    // Fire and forget: confirms the saved token still works and gives the
    // settings UI something better than "a token exists" to show.
    if (slackToken) {
      verifySavedToken().catch((e) => logErr('token verification failed', e));
    }
  }

  // Memoized so a burst of hook events on a cold start can't each kick off
  // their own load: configReady is only set after two awaits, so every
  // action arriving in that window used to start a competing loadConfig().
  function ensureConfig() {
    if (!configPromise) configPromise = loadConfig();
    return configPromise;
  }

  async function saveConfig() {
    await PluginAPI.persistDataSynced(JSON.stringify(cfg));
  }

  async function saveToken(token) {
    await PluginAPI.setSecret('slackToken', token);
    slackToken = token;
  }

  async function clearToken() {
    await PluginAPI.deleteSecret('slackToken');
    slackToken = '';
    tokenIdentity = null;
    tokenError = '';
  }

  // ------------------------------------------------------------------
  // Slack API
  // ------------------------------------------------------------------

  const SLACK_ERROR_HINTS = {
    invalid_auth: 'the saved token is not valid',
    not_authed: 'no token was sent',
    account_inactive: 'that Slack account is deactivated',
    token_revoked: 'the token was revoked — create a new one',
    token_expired: 'the token has expired — create a new one',
    missing_scope:
      'the token is missing a scope (needs users.profile:write, plus dnd:write for pausing notifications)',
    ratelimited: 'Slack is rate limiting — try again in a moment',
    bot_token: 'that is a Bot token (xoxb-…); use the User OAuth Token (xoxp-…)',
  };

  const FATAL_TOKEN_ERRORS = [
    'invalid_auth',
    'not_authed',
    'account_inactive',
    'token_revoked',
    'token_expired',
    'bot_token',
  ];

  function describeError(e) {
    const code = (e && e.message) || String(e);
    return SLACK_ERROR_HINTS[code] ? SLACK_ERROR_HINTS[code] + ' (' + code + ')' : code;
  }

  /**
   * One Slack POST. Returns the parsed JSON body; throws on transport or
   * HTTP failure with `status` attached when we know it.
   *
   * Prefers PluginAPI.request(): that's the sanctioned path, it's what the
   * manifest's "http" permission + "allowedHosts" actually gate, it applies
   * SP's SSRF/private-network guards, and it runs host-side so it keeps
   * working if the renderer's CSP is ever tightened. It resolves to the
   * parsed body (not a Response) and throws with `status` on non-2xx.
   * Older SP builds don't have it, hence the fetch fallback — which is why
   * minSupVersion stays at 14.0.0.
   */
  async function slackPost(method, params, token) {
    const body = new URLSearchParams();
    body.set('token', token);
    Object.keys(params).forEach((key) => body.set(key, String(params[key])));

    const url = SLACK_API_BASE + method;
    // Keep this a "simple" CORS request on the fetch path (form body, no
    // custom headers beyond Content-Type, token in the body) so no preflight
    // is triggered.
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const payload = body.toString();

    if (typeof PluginAPI !== 'undefined' && typeof PluginAPI.request === 'function') {
      try {
        return await PluginAPI.request(url, { method: 'POST', headers, body: payload });
      } catch (e) {
        if (e && e.status) {
          const err = new Error('http_' + e.status);
          err.status = e.status;
          throw err;
        }
        throw e;
      }
    }

    const res = await fetch(url, { method: 'POST', headers, body: payload });
    if (!res.ok) {
      const err = new Error('http_' + res.status);
      err.status = res.status;
      // Retry-After is not a CORS-safelisted response header, so this is
      // only readable when Slack explicitly exposes it. 0 => use the
      // fixed fallback backoff instead.
      err.retryAfterSeconds = Number(res.headers.get('Retry-After')) || 0;
      throw err;
    }
    return await res.json();
  }

  /** slackPost + retries for rate limits and transient 5xx. */
  async function slackCall(method, params, token, attempt) {
    attempt = attempt || 0;
    let data;

    try {
      data = await slackPost(method, params, token);
    } catch (e) {
      const retryable = e && RETRYABLE_HTTP.indexOf(e.status) !== -1;
      if (retryable && attempt < MAX_RETRIES) {
        const waitS = Math.min(e.retryAfterSeconds || RETRY_FALLBACK_SECONDS, 60);
        log(method + ' failed with ' + e.status + ', retrying in ' + waitS + 's');
        await sleep(waitS * 1000);
        return slackCall(method, params, token, attempt + 1);
      }
      throw e;
    }

    if (!data || !data.ok) {
      const code = (data && data.error) || 'unknown_slack_error';
      // Slack also signals rate limiting as ok:false in a 200 response.
      if (code === 'ratelimited' && attempt < MAX_RETRIES) {
        await sleep(RETRY_FALLBACK_SECONDS * 1000);
        return slackCall(method, params, token, attempt + 1);
      }
      throw new Error(code);
    }
    return data;
  }

  // Every Slack write goes through here, so concurrent triggers (a focus
  // transition landing at the same moment as a debounced task change) can't
  // apply out of order — whatever is queued last is what Slack ends up with.
  let slackChain = Promise.resolve();
  function serialize(fn) {
    const run = slackChain.then(fn);
    slackChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  function requireToken(what) {
    if (slackToken) return true;
    snack('no Slack token saved yet — open "Slack Status Sync" in the menu to add one.', 'WARNING');
    log('skipped ' + what + ': no token');
    return false;
  }

  function fillTemplate(tpl, task, project) {
    return String(tpl || '')
      .replace(/\{title\}/g, task ? task.title : '')
      .replace(/\{project\}/g, project ? project.title : '');
  }

  function truncateStatus(text) {
    const str = String(text == null ? '' : text);
    return str.length > STATUS_TEXT_MAX
      ? str.slice(0, STATUS_TEXT_MAX - 1) + '…'
      : str;
  }

  async function setSlackStatus(rawText, emoji, expireInHours, force) {
    if (!requireToken('status update')) return false;

    const text = truncateStatus(rawText);
    const key = text + '|' + (emoji || '');

    return serialize(async () => {
      const nowSec = Math.floor(Date.now() / 1000);

      // Skip the call only if Slack should still be showing this status.
      // Checked inside the queue so it sees writes queued ahead of it.
      // The expiry half matters: without it, a status we set with an
      // expiration (end of day) still looks "already applied" long after
      // Slack cleared it, so pressing Finish Day again the next day — with
      // SP left running across the expiry — would silently do nothing.
      if (
        !force &&
        lastStatus &&
        lastStatus.key === key &&
        (!lastStatus.expiresAt || lastStatus.expiresAt > nowSec)
      ) {
        return true;
      }

      const expiration =
        expireInHours > 0 ? nowSec + Math.round(expireInHours * 3600) : 0;

      try {
        await slackCall(
          'users.profile.set',
          {
            profile: JSON.stringify({
              status_text: text,
              status_emoji: emoji || '',
              status_expiration: expiration,
            }),
          },
          slackToken,
        );
        lastStatus = { key: key, expiresAt: expiration };
        return true;
      } catch (e) {
        logErr('failed to update Slack status', e);
        snack('failed to update status (' + describeError(e) + ')', 'ERROR');
        return false;
      }
    });
  }

  async function setSlackDnd(numMinutes) {
    if (!requireToken('pausing notifications')) return false;
    const minutes = Math.max(1, Math.round(numMinutes));
    return serialize(async () => {
      try {
        await slackCall('dnd.setSnooze', { num_minutes: minutes }, slackToken);
        return true;
      } catch (e) {
        logErr('failed to pause Slack notifications', e);
        snack('failed to pause notifications (' + describeError(e) + ')', 'ERROR');
        return false;
      }
    });
  }

  async function endSlackDnd() {
    if (!slackToken) return false;
    return serialize(async () => {
      try {
        await slackCall('dnd.endSnooze', {}, slackToken);
        return true;
      } catch (e) {
        logErr('failed to resume Slack notifications', e);
        snack('failed to resume notifications (' + describeError(e) + ')', 'ERROR');
        return false;
      }
    });
  }

  /**
   * Confirm a token works before we rely on it, and resolve who it belongs
   * to. `fatal` distinguishes "Slack positively rejected this" from "we
   * couldn't reach Slack", which are very different for the caller.
   */
  async function checkToken(token) {
    try {
      const data = await slackCall('auth.test', {}, token);
      // auth.test succeeds for bot tokens too, but a bot token can't set a
      // human's profile — catch it here rather than at the first real call.
      if (data.bot_id) {
        return {
          ok: false,
          error: 'bot_token',
          fatal: true,
          message: describeError({ message: 'bot_token' }),
        };
      }
      return { ok: true, user: data.user || '', team: data.team || '' };
    } catch (e) {
      const code = (e && e.message) || String(e);
      return {
        ok: false,
        error: code,
        fatal: FATAL_TOKEN_ERRORS.indexOf(code) !== -1,
        message: describeError(e),
      };
    }
  }

  async function verifySavedToken() {
    const result = await checkToken(slackToken);
    if (result.ok) {
      tokenIdentity = { user: result.user, team: result.team };
      tokenError = '';
    } else {
      tokenIdentity = null;
      // Only surface a definitive rejection. A transport failure (offline,
      // VPN, Slack blip) says nothing about whether the token is good.
      tokenError = result.fatal ? result.message : '';
    }
  }

  // ------------------------------------------------------------------
  // Hooks
  // ------------------------------------------------------------------

  async function applyTrackingStatus(payload, force) {
    if (!cfg.trackingEnabled) return true;

    const task = payload && payload.current;
    if (task) {
      let project = null;
      if (task.projectId) {
        try {
          const projects = await PluginAPI.getAllProjects();
          project = (projects || []).find((p) => p.id === task.projectId) || null;
        } catch (e) {
          // non-fatal, {project} just won't be substituted
        }
      }
      return setSlackStatus(
        fillTemplate(cfg.trackingTextTemplate, task, project),
        cfg.trackingEmoji,
        cfg.trackingExpireHours,
        force,
      );
    }

    if (cfg.clearOnStop) return setSlackStatus('', '', 0, force);
    return true;
  }

  async function flushTaskChange() {
    try {
      if (!configReady) await ensureConfig();
      // Focus mode's status outranks task tracking. Without this, starting,
      // switching or stopping a task mid-session would overwrite the focus
      // status — or with clearOnStop, wipe it — while still in focus mode.
      // handleFocusEnd() reapplies the tracking status afterwards.
      if (inFocusMode && cfg.focusStatusEnabled) return;
      // Tracking a task again means the day is back underway.
      if (lastTaskPayload && lastTaskPayload.current) dayFinished = false;
      await applyTrackingStatus(lastTaskPayload, false);
    } catch (e) {
      logErr('task change handling failed', e);
    }
  }

  function handleCurrentTaskChange(payload) {
    // Record every payload, even while suppressed by focus mode, so focus
    // end knows what to restore.
    lastTaskPayload = payload || null;
    if (taskChangeTimer) clearTimeout(taskChangeTimer);
    taskChangeTimer = setTimeout(function () {
      taskChangeTimer = null;
      flushTaskChange();
    }, TASK_CHANGE_DEBOUNCE_MS);
  }

  async function handleFinishDay() {
    if (!configReady) await ensureConfig();
    if (!cfg.endOfDayEnabled) return;
    // Finishing the day should win over a stale focus status.
    if (taskChangeTimer) {
      clearTimeout(taskChangeTimer);
      taskChangeTimer = null;
    }
    inFocusMode = false;
    dayFinished = true;
    await setSlackStatus(cfg.endOfDayText, cfg.endOfDayEmoji, cfg.endOfDayExpireHours, true);
  }

  function splitTypes(str) {
    return String(str || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function handleFocusStart(sessionDurationMs) {
    if (inFocusMode) return; // already on, don't double-fire
    inFocusMode = true;
    // Starting a focus session means you're working, so the end-of-day
    // status is stale and focus end should restore tracking as usual.
    dayFinished = false;

    if (cfg.dndEnabled) {
      // '[FocusMode] Start Session' carries the real session length in ms,
      // so prefer it over the configured ceiling; fall back when the payload
      // has none (Flowtime mode, or the simulate button).
      const fromPayload =
        sessionDurationMs > 0 ? Math.ceil(sessionDurationMs / 60000) : 0;
      await setSlackDnd(fromPayload || cfg.dndDurationMinutes);
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
    // Restore the tracking status rather than just clearing it: task changes
    // are suppressed while focused, so there's no guarantee another
    // currentTaskChange will arrive to fix the status up. Skipped after
    // "Finish Day" so a session ending later doesn't clobber that status.
    if (cfg.focusStatusEnabled && !dayFinished) {
      await applyTrackingStatus(lastTaskPayload, true);
    }
  }

  function recordFocusAction(type, ts) {
    const existing = focusActionStats.get(type);
    if (existing) {
      existing.ts = ts;
      existing.count++;
      return;
    }
    focusActionStats.set(type, { type: type, ts: ts, count: 1 });
    if (focusActionStats.size > MAX_FOCUS_ACTION_TYPES) {
      let oldest = null;
      focusActionStats.forEach((entry) => {
        if (!oldest || entry.ts < oldest.ts) oldest = entry;
      });
      if (oldest) focusActionStats.delete(oldest.type);
    }
  }

  PluginAPI.registerHook(PluginAPI.Hooks.CURRENT_TASK_CHANGE, handleCurrentTaskChange);
  PluginAPI.registerHook(PluginAPI.Hooks.FINISH_DAY, handleFinishDay);

  PluginAPI.registerHook(PluginAPI.Hooks.ACTION, async (wrapper) => {
    try {
      // SP dispatches { action: <the NgRx action object> }, while its own
      // ActionPayload type declares `action: string`. Accept either, so a
      // future release that makes the implementation match its types can't
      // silently break focus detection.
      const raw = wrapper && wrapper.action;
      const type = typeof raw === 'string' ? raw : raw && raw.type;
      if (!type) return;

      if (!configReady) await ensureConfig();

      // Always record diagnostics (cheap) so the settings UI can show
      // whether the ACTION hook is firing at all, independent of whether
      // debug console logging or DND/status handling are turned on.
      totalActionsSeen++;
      lastActionType = type;
      lastActionTs = Date.now();
      if (String(type).toLowerCase().indexOf('focus') !== -1) {
        recordFocusAction(type, lastActionTs);
        if (cfg.debugLogFocusActions) {
          log('action:', type);
        }
      }

      if (!cfg.dndEnabled && !cfg.focusStatusEnabled) return;

      if (splitTypes(cfg.focusStartActionTypes).indexOf(type) !== -1) {
        const durationMs =
          raw && typeof raw === 'object' ? Number(raw.duration) || 0 : 0;
        await handleFocusStart(durationMs);
      } else if (splitTypes(cfg.focusEndActionTypes).indexOf(type) !== -1) {
        await handleFocusEnd();
      }
    } catch (e) {
      // If anything above throws, log it loudly instead of failing silently.
      logErr('ACTION hook handler threw:', e);
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
    // Single source of truth for defaults, so the iframe doesn't keep its
    // own copy to drift out of sync.
    getDefaults: () => Object.assign({}, DEFAULT_CFG),
    getConfig: () =>
      Object.assign({}, cfg, {
        hasToken: !!slackToken,
        tokenIdentity: tokenIdentity ? Object.assign({}, tokenIdentity) : null,
        tokenError: tokenError,
        inFocusMode: inFocusMode,
      }),
    saveSettings: async (newCfg, token) => {
      cfg = pickConfig(Object.assign({}, cfg, newCfg || {}));
      await saveConfig();

      let tokenCheck = null;
      if (token) {
        tokenCheck = await checkToken(token);
        // Don't store a token Slack positively rejected. A transport
        // failure is inconclusive, so keep it and let the UI say as much.
        if (!tokenCheck.fatal) {
          await saveToken(token);
          if (tokenCheck.ok) {
            tokenIdentity = { user: tokenCheck.user, team: tokenCheck.team };
            tokenError = '';
          }
        }
      }
      return { ok: true, tokenCheck: tokenCheck };
    },
    clearToken: async () => {
      await clearToken();
      return true;
    },
    verifyToken: async () => {
      if (!slackToken) return { ok: false, error: 'no_token', fatal: true, message: 'no token saved' };
      const result = await checkToken(slackToken);
      if (result.ok) {
        tokenIdentity = { user: result.user, team: result.team };
        tokenError = '';
      } else if (result.fatal) {
        tokenIdentity = null;
        tokenError = result.message;
      }
      return result;
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
      await handleFocusStart(0);
      return true;
    },
    sendTestFocusEnd: async () => {
      await handleFocusEnd();
      return true;
    },
    getDiagnostics: () => ({
      totalActionsSeen: totalActionsSeen,
      lastActionType: lastActionType,
      lastActionTs: lastActionTs,
      // Newest first.
      focusActions: Array.from(focusActionStats.values())
        .slice()
        .sort((a, b) => b.ts - a.ts),
      inFocusMode: inFocusMode,
    }),
  };

  if (typeof window !== 'undefined') {
    window.slackStatusBridge = slackStatusBridge;
  }

  ensureConfig();
  log('loaded');
})();
