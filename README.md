# Slack Status Sync — Super Productivity plugin

Updates your Slack status to reflect the task you're currently tracking time for,
and updates it again when you press "Finish Day". Optionally pauses your Slack
notifications while you're in Focus Mode.

## Install

Super Productivity installs plugins from a ZIP file — there's no
load-from-folder option, and no way to install one via its REST API, so this
is the only route.

1. Get `slack-status-sync.zip`, either by downloading it from the
   [latest release](https://github.com/ipryseski/slack-status-sync/releases/latest)
   or by building it from the repo root:

   ```sh
   npm run package
   ```

   The files must be at the **top level** of the archive, not inside a folder —
   Super Productivity looks up `manifest.json` by exact name and won't find it
   under a directory. That's what `npm run package` (and the release workflow)
   guarantees; if you build the zip by hand, it's
   `zip -j slack-status-sync.zip manifest.json plugin.js index.html icon.svg`.

2. In Super Productivity: **Settings → Plugins → Install Plugin**, choose the
   zip, and accept the permission prompt.
3. A new **"Slack Status Sync"** entry appears in the left-hand menu.

To pick up later changes, rebuild the zip, install it again, then toggle the
plugin off and on. There is no hot reload.

## One-time Slack setup (you need your own Slack app + token)

Slack retired the old "legacy token generator," so you create a small internal
Slack app for yourself:

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it anything (e.g. "My Status Sync"), pick your workspace.
3. Left sidebar → **OAuth & Permissions**.
4. Under **Scopes → User Token Scopes**, add `users.profile:write`. If you
   want the notification-pausing feature (see below), also add `dnd:write`.
5. Scroll up, click **Install to Workspace**, approve it.
6. Copy the **User OAuth Token** (starts with `xoxp-`) — not the Bot token.

## Configure the plugin

1. Click **Slack Status Sync** in the left menu.
2. Paste the `xoxp-...` token into the Slack token field and click **Save
   settings**. The token is stored locally on this device only — it is never
   synced, exported, or backed up.
   - On save the plugin calls Slack's `auth.test` to confirm the token works,
     and shows which user and workspace it resolved to. A token Slack
     positively rejects (invalid, revoked, expired, or a Bot token pasted by
     mistake) is reported and **not** saved. If Slack simply can't be reached,
     the token is saved and the panel says it couldn't be verified.
   - **Verify token** re-runs that check at any time.
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

**Why this needs action-type strings:** Super Productivity's plugin API
doesn't have a dedicated "focus mode started/ended" hook. This plugin
instead listens to the generic `action` hook (every NgRx action the app
dispatches) and watches for Focus Mode's action `type` strings.

The defaults are taken from Super Productivity's actual focus-mode actions
(verified against 18.19.0) rather than guessed:

|       | Action types                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------ |
| Start | `[FocusMode] Start Session`                                                                      |
| End   | `[FocusMode] Complete Session`, `[FocusMode] Cancel Session`, `[FocusMode] End Flowtime Session` |

A session that runs to completion dispatches **Complete Session**; one you
abort dispatches **Cancel Session**. `Show Overlay` / `Hide Overlay` are
deliberately _not_ used — they're pure UI events that also fire when you
merely open or close the focus screen, so triggering DND from them would
pause your notifications just for looking at the focus tab.

If your installed version differs, use the built-in diagnostics panel (no
DevTools needed) rather than editing the fields blind:

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
     next to the right ones, then **Save settings**. Entries are grouped by
     type with an occurrence count, so `[FocusMode] Timer Tick` — which
     fires once a second during a session — doesn't bury the start/end
     actions you're looking for.
   - **Reset to defaults** puts the table above back if you want to start over.
4. Use **"Simulate focus start"** / **"Simulate focus end"** to test the
   Slack side (pause notifications + status) independently of the
   detection itself, then trigger a real focus session to confirm
   everything's connected end to end.

Notes on the notification-pausing behavior itself:

- Slack's `dnd.setSnooze` API (what powers "Pause notifications") always
  requires a fixed duration in minutes. `[FocusMode] Start Session` carries
  the real session length, so the plugin uses that. The **fallback pause
  length** setting is only used when a session reports no duration (Flowtime
  mode, or the "Simulate focus start" button). Ending focus mode calls
  `dnd.endSnooze` ("Resume notifications") immediately either way, so the
  snooze length is a ceiling rather than a commitment.
- The custom focus status (if enabled) is separate — pausing notifications
  already shows a moon icon on your Slack profile automatically, on its
  own, without any status text change.
- While a session is running the focus status takes precedence over task
  tracking, so starting or switching tasks won't overwrite it. When the
  session ends, your tracking status is restored.

## Implementation note: the iframe bridge

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
that swap easy. The bridge deliberately never hands the token itself to the
iframe — only whether one is set, and who it belongs to.

Slack calls go through `PluginAPI.request()` where available, which is the
sanctioned HTTP path: it's gated by the `"http"` permission plus
`"allowedHosts": ["slack.com"]` in the manifest (both fail-closed), and it
applies Super Productivity's own URL/private-network protections. Older
builds without `request()` fall back to `fetch`, which is why
`minSupVersion` stays at `14.0.0`.

## Behavior

- **Start/switch a task** → Slack status becomes your tracking template
  (e.g. "Working on: Fix login bug"), optionally auto-clearing after N hours
  so a crash can't leave it stuck.
- **Stop tracking** (no active task) → status clears, if "Clear Slack status
  when I stop tracking" is checked.
- **Focus session starts** → notifications pause, focus status applied, and
  task changes stop touching your status until the session ends.
- **Focus session ends** → notifications resume and the tracking status is
  restored.
- **Press "Finish Day"** → status becomes your end-of-day text/emoji, and
  optionally auto-clears itself after N hours (Slack handles the expiry, not
  the plugin — so it works even if Super Productivity isn't running). This
  outranks focus mode: a session ending afterwards won't overwrite it.

## Notes / limitations

- Uses Slack's Web API directly from the app, so it only works while Super
  Productivity itself is running (there's no background server component).
- Status text is capped at 100 characters (Slack's limit) — longer task
  titles are truncated with an ellipsis.
- `users.profile.set` is a Tier 3 method (~50 requests/minute). Task changes
  are debounced by 2 seconds so a burst of rapid switches costs one call, and
  rate-limited or transient 5xx responses are retried with a backoff.
- Slack writes are serialized, so a focus transition and a task change
  landing at the same moment can't apply out of order.
- One Slack workspace/token per install of the plugin.
- If you use Super Productivity on multiple devices, you'll need to paste the
  token again on each device (secrets are intentionally per-device, not
  synced).

## Development

```sh
npm install          # ESLint + Prettier (needs Node >= 18.18)
npm run lint         # ESLint over *.js
npm run lint:fix
npm run format       # Prettier over js/html/json/md/yaml
npm run format:check
npm run package      # build slack-status-sync.zip
```

ESLint only sees `plugin.js` — it can't parse the inline `<script>` in
`index.html` — so logic belongs in `plugin.js`, where it gets checked.
Prettier does format the whole file, inline script included.

### Pre-commit hook

The repo ships a [pre-commit](https://pre-commit.com) config that runs Prettier
and ESLint (plus JSON/YAML sanity checks) on the files you're committing:

```sh
pre-commit install            # once, to enable the git hook
pre-commit run --all-files    # run everything on demand
```

Both hooks auto-fix and pin their own Node, so they work even if your shell's
active Node is too old for ESLint 9. When a hook rewrites a file the commit is
aborted — re-stage the fixes and commit again.

### CI

`.github/workflows/ci.yml` runs ESLint, `prettier --check` and a `manifest.json`
sanity check on every push and pull request.

On pull requests it additionally builds the ZIP as a test build and posts a
download link as a single comment that's edited in place on each push, so you
can install the exact build under review. The shipped ZIP is only ever built by
the release workflow — the PR build is a packaging check, not a deliverable.

### Cutting a release

Bump `version` in `manifest.json`, commit, then tag it:

```sh
git tag v1.2.1 && git push origin v1.2.1
```

`.github/workflows/release.yml` verifies the tag matches `manifest.json`, lints,
builds the ZIP, asserts its entries sit at the archive root, and publishes it as
a GitHub release asset. A tag that disagrees with the manifest fails instead of
publishing.

## What changed in 1.2.0

Mostly correctness fixes; two of them change behavior you may have worked
around already:

- **Focus sessions that finished normally never resumed your notifications.**
  The shipped end-action list was missing `[FocusMode] Complete Session` and
  contained two action names that never existed in any SP version
  (`[FocusMode] Session Done`, `[FocusMode] Unload`). Existing installs are
  migrated automatically — but only if you never edited those fields, so
  hand-corrected values are preserved.
- **`[FocusMode] Show Overlay` no longer starts a focus session**, so simply
  opening the focus screen doesn't pause your notifications.
- Task changes no longer overwrite the focus status mid-session, and the
  tracking status is restored when a session ends.
- Pause length now comes from the real session duration.
- End-of-day status is no longer clobbered by a session ending after it.
- Token is verified against Slack on save; Bot tokens are caught explicitly.
- Status text is truncated to Slack's 100-character limit.
- Task-change debouncing, rate-limit retries, and serialized writes.
- A status set with an expiry is re-sent once Slack has cleared it, instead
  of being suppressed forever as "already applied".
- Derived UI fields (`hasToken`, `inFocusMode`) no longer leak into synced
  config data.
- Manifest declares the `http` permission and `slack.com` in `allowedHosts`,
  so its network access is visible in Super Productivity's plugin UI.

## Security

The plugin holds a Slack user token, so what it can and can't reach is
documented in [SECURITY.md](SECURITY.md), along with how to report a
vulnerability privately.

## License

[MIT](LICENSE) © Diane Pryseski
