# Security

## Reporting a vulnerability

Please report security issues privately via
[GitHub's private vulnerability reporting](https://github.com/ipryseski/slack-status-sync/security/advisories/new)
rather than opening a public issue.

This is a personal project maintained in spare time, so there's no response-time
guarantee — but reports are read and taken seriously.

## What this plugin has access to

Worth understanding before you install it, since it holds a credential to your
Slack account:

- **Your Slack user token** (`xoxp-…`), which you create and paste in yourself.
  It's stored via Super Productivity's `PluginAPI.setSecret()`, which is
  local-only: it is never written to synced storage and never included in an
  export. The settings iframe can ask _whether_ a token is set, but the bridge
  in `plugin.js` deliberately never hands the token itself back to the UI.
- **The scopes you grant it.** `users.profile:write` to set your status, and
  `dnd:write` only if you enable the notification-pausing feature. Nothing here
  reads your messages, and the plugin has no scope to do so.
- **Your task titles and project names**, which are sent to Slack as status
  text when you enable that. Keep in mind that your Slack status is visible to
  your whole workspace — if a task title is sensitive, it will be too.
- **Network access to `slack.com` only.** The manifest declares
  `allowedHosts: ["slack.com"]` and requests go through `PluginAPI.request()`,
  which enforces that allowlist. There is no server component and no telemetry;
  the plugin talks to Slack's API and nothing else.

## Scope

Reports about this plugin's own code are in scope. Issues in Super Productivity
itself belong upstream at
[johannesjo/super-productivity](https://github.com/johannesjo/super-productivity),
and Slack API issues with Slack.
