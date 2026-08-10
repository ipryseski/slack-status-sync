# Slack Status Sync — Super Productivity plugin

Updates your Slack status to reflect the task you're currently tracking time for,
and updates it again when you press "Finish Day".

## Install

1. In Super Productivity: **Settings → Plugins → Load Plugin from Folder** (or
   upload the zip, if you packaged one), and point it at this folder.
2. A new **"Slack Status Sync"** entry appears in the left-hand menu.

## One-time Slack setup (you need your own Slack app + token)

Slack retired the old "legacy token generator," so you create a small internal
Slack app for yourself:

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it anything (e.g. "My Status Sync"), pick your workspace.
3. Left sidebar → **OAuth & Permissions**.
4. Under **Scopes → User Token Scopes**, add `users.profile:write`. If you
   want the Do Not Disturb feature (see below), also add `dnd:write`.
5. Scroll up, click **Install to Workspace**, approve it.
6. Copy the **User OAuth Token** (starts with `xoxp-`) — not the Bot token.

## Configure the plugin

1. Click **Slack Status Sync** in the left menu.
2. Paste the `xoxp-...` token into the Slack token field and click **Save
   settings**. The token is stored locally on this device only — it is never
   synced, exported, or backed up.
3. Adjust the status text/emoji for "while tracking a task" and "end of day"
   as you like (`{title}` and `{project}` are available as placeholders in
   the tracking text).
4. Click **Send test status** to confirm it's wired up correctly — you should
   see your Slack status change within a couple of seconds.

## Focus Mode → pause Slack notifications (optional)

Does the same thing as clicking your profile photo in Slack → **"Pause
notifications"** while you're in Super Productivity's Focus Mode, and
**"Resume notifications"** when focus mode ends. This is what actually
changes your availability to teammates (a moon icon appears next to your
name, and desktop/mobile pushes stop) — it's the real, API-accessible
feature behind what most people mean by "focus mode" in Slack.

**One thing this can't do:** Slack also has a separate, purely client-side
"Focus mode" that just hides sidebar clutter in the Slack app itself. That
one has no public API at all, so no plugin (this one included) can toggle
it remotely — only "Pause/Resume notifications" is reachable via the API,
which is what this plugin uses.

**Why this needs a manual setup step:** Super Productivity's plugin API
doesn't have a dedicated "focus mode started/ended" hook. This plugin
instead listens to the generic `action` hook (every NgRx action the app
dispatches) and watches for Focus Mode's action `type` strings. The default
values in the settings screen (`[FocusMode] Start Session` /
`[FocusMode] Show Overlay` to start, a few candidates to end) are
best-effort guesses and may not exactly match your installed version.

To confirm/correct them, use the built-in diagnostics panel (no DevTools
needed):

1. Open the plugin settings and scroll to **Diagnostics** under "Pause
   Notifications (Focus Mode)".
2. Start a focus session in Super Productivity, then end/cancel it.
3. Back in the plugin settings, click **Refresh**.
   - If **"Actions seen"** stays at `0`, the plugin isn't receiving any app
     events at all — that's a different problem than wrong action names
     (try reloading the plugin, or removing and re-adding it).
   - If the counter goes up but the list below stays empty, Focus Mode's
     actions in your installed version don't contain the word "focus" in
     their type string. Fall back to DevTools (`F12` / `Ctrl+Shift+I` →
     Console) and check "Log Focus Mode actions to the console" — though
     at that point you may need to widen what you search the console for,
     since the type names apparently don't match the "focus" filter this
     panel uses.
   - If entries do show up, click **"Use as start"** / **"Use as end"**
     next to the right ones (the timestamps help you tell them apart), then
     **Save settings**.
4. Use **"Simulate focus start"** / **"Simulate focus end"** to test the
   Slack side (pause notifications + status) independently of the
   detection itself, then trigger a real focus session to confirm
   everything's connected end to end.

Notes on the notification-pausing behavior itself:

- Slack's `dnd.setSnooze` API (what powers "Pause notifications") always
  requires a fixed duration in minutes — there's no "on indefinitely"
  option, and the plugin doesn't have a reliable way to read your
  configured focus session length from the action payload. So "Pause for
  up to" is a ceiling; ending focus mode calls `dnd.endSnooze` ("Resume
  notifications") immediately to turn it back off regardless of how much
  of that duration is left, so it's safe to set generously.
- The custom focus status (if enabled) is separate — pausing notifications
  already shows a moon icon on your Slack profile automatically, on its
  own, without any status text change.



`PluginAPI.setSecret` / `getSecret` / `persistDataSynced` / `loadSyncedData`
aren't reliably reachable from inside the settings iframe (`index.html`) in
current Super Productivity builds, even though they're part of the
documented API surface. So all config/secret handling lives in `plugin.js`
(host-side, always running), which exposes a plain object on
`window.slackStatusBridge`. The iframe reaches it via
`window.parent.slackStatusBridge` — this works because iframe plugins render
with `allow-same-origin`. The iframe still uses `PluginAPI.showSnack`
directly for simple one-way notifications, which does work fine from inside
the iframe.

If a future SP release fixes iframe access to those APIs, the bridge can be
removed and `index.html` can call `PluginAPI` directly again — the UI code
is already written against a small `getBridge()`-shaped interface to make
that swap easy.

## Behavior

- **Start/switch a task** → Slack status becomes your tracking template
  (e.g. "Working on: Fix login bug").
- **Stop tracking** (no active task) → status clears, if "Clear Slack status
  when I stop tracking" is checked.
- **Press "Finish Day"** → status becomes your end-of-day text/emoji, and
  optionally auto-clears itself after N hours (Slack handles the expiry, not
  the plugin — so it works even if Super Productivity isn't running).

## Notes / limitations

- Uses Slack's `users.profile.set` Web API method directly from the app, so
  it only works while Super Productivity itself is running (there's no
  background server component).
- One Slack workspace/token per install of the plugin.
- If you use Super Productivity on multiple devices, you'll need to paste the
  token again on each device (secrets are intentionally per-device, not
  synced).
