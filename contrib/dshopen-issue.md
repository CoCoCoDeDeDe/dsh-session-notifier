# Open Plugin Market submission (https://github.com/polang233/dsh-plugin-index)

Open a new issue with the "提交插件" template after the npm release:

https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml

Suggested body:

---

**Plugin name / 插件名**

`dsh-session-notifier`

**Repository / 仓库**

https://github.com/CoCoCoDeDeDe/dsh-session-notifier

**npm package / npm 包**

https://www.npmjs.com/package/dsh-session-notifier

**License / 许可证**

MIT

**Description / 描述**

Desktop notifications for DSH Web sessions: browser notifications plus Windows toast when a session finishes, fails, needs an approval, or asks a question.

为 DSH Web 会话提供桌面通知：会话完成、失败、需要审批或提问时发送浏览器通知，在 Windows/WSL 下同时弹出系统 Toast。

**Install / 安装**

```bash
dsh plugin --profile web add dsh-session-notifier
```

**Notes**

- Declares `dsh.bundle` in `package.json` and ships `cordis.patch.yml`.
- Windows toast delivery uses `powershell.exe` from WSL; other platforms get browser notifications only.
- No additional services, API keys, or network destinations are required.
