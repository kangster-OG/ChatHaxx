# ChatHaxx

ChatHaxx is our build of [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids).
`main` is upstream's history plus our own commits, so every upstream release merges in as an
ordinary merge.

## Updating

```bash
scripts/chathaxx-update.sh
```

It merges the latest upstream release into `main`, runs `npm ci`, the type check and the privacy
check, pushes `main` and the release tag here, builds the macOS arm64 app, and installs it once
the app has been idle for 15 minutes. It backs up the previous app and `config.json` to
`~/Developer/CoS-backups` first. A merge conflict stops it with exit code 10 and the merge left in
progress; resolve, commit and run it again.

The clone has two remotes: `origin` is this repository, and `upstream` is totec448-spec/chat-on-steroids.

## Notes

- Upstream's own GitHub workflows are disabled in this repository. They are built for upstream's
  release process.
- The app's update notice still points at upstream releases. Update with the script instead of
  downloading upstream's DMG.
- `legacy-2.1.12` keeps the earlier workspace changes (model picker, image and approval
  visibility) from before the move to 2.1.44.
