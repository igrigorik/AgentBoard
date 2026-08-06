# Browser tests

The browser suites exercise the built extension in Chrome rather than source modules in a simulated DOM.

- `pnpm run test:browser` builds and tests the compiled `agentboard_read_page` tool.
- `pnpm run test:browser:mv3` builds and tests extension loading, settings migration, WebMCP execution, storage serialization, and fail-closed configuration handling.

Use the corresponding `:built` script to test an existing `dist/` build. Set `CHROME_BIN` for the read-page suite and `CHROME_FOR_TESTING_BIN` for the MV3 suite when Chrome is not found automatically.

## Manual Local Workspace check

Local Workspace application logic is covered by source-level tests. Native picker, operating-system filesystem, permission restoration, and side-panel teardown require a visible browser and a real folder. Before releasing Local Workspace changes:

1. Build the release candidate, load its exact `dist/` directory as an unpacked extension, and configure an agent to use a local test endpoint that records requests.
2. Connect a disposable folder through the operating-system picker and confirm AgentBoard initializes `MEMORY.md` and `memory/` without changing unrelated files.
3. Connect the same exact folder to a second agent, verify both observe the shared workspace, and confirm disconnecting one leaves the other mounted.
4. With the first agent still mounted, attempt to connect its parent and then a child folder to the second agent; verify both attempts fail and the first binding remains intact.
5. Reconnect the exact shared root to both agents, import a valid settings backup, verify both device-local bindings are removed, and reconnect the primary agent.
6. Add unique values to `IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`, and `MEMORY.md`; start a chat and confirm one request contains every value in its fixed role.
7. Edit those files externally and confirm another turn in the same chat retains the original bootstrap.
8. Clear the chat and confirm the next request contains the freshest files.
9. Close and reopen the side panel and confirm the next request contains the freshest files rather than the prior in-memory bootstrap.
10. Switch between agents connected to different roots and confirm history is retained while each agent receives only its newly captured workspace bootstrap.
11. Have the endpoint request a visible write to `memory/YYYY-MM-DD.md`, then confirm the expected bytes appear in the real folder and standing files remain unchanged.
12. Restart the service worker and then the browser.
13. Verify a stored handle in `prompt` state blocks a fresh chat before a provider request; if permission remains granted, revoke it through the browser first.
14. Verify **Restore folder access** renews that same handle under a user gesture and allows the chat to retry successfully.
15. Disconnect Local Workspace and confirm the next request has no workspace content or file tools, then confirm every original file remains on disk.
16. Reconnect explicitly through the native picker, verify mounted behavior returns, disconnect again, and confirm every user file remains on disk.
