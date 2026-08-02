# Browser tests

The browser suites exercise the built extension in Chrome rather than source modules in a simulated DOM.

- `pnpm run test:browser` builds and tests the compiled `agentboard_read_page` tool.
- `pnpm run test:browser:mv3` builds and tests extension loading, settings migration, WebMCP execution, storage serialization, and fail-closed configuration handling.

Use the corresponding `:built` script to test an existing `dist/` build. Set `CHROME_BIN` for the read-page suite and `CHROME_FOR_TESTING_BIN` for the MV3 suite when Chrome is not found automatically.

## Manual Local Workspace check

Local Workspace application logic is covered by source-level tests. Native picker, operating-system filesystem, permission restoration, and side-panel teardown require a visible browser and a real folder. Before releasing Local Workspace changes:

1. Build the release candidate, load its exact `dist/` directory as an unpacked extension, and configure an agent to use a local test endpoint that records requests.
2. Connect a disposable folder through the operating-system picker and confirm AgentBoard initializes `MEMORY.md` and `memory/` without changing unrelated files.
3. Add unique values to `IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`, and `MEMORY.md`; start a chat and confirm one request contains every value in its fixed role.
4. Edit those files externally and confirm another turn in the same chat retains the original bootstrap.
5. Clear the chat and confirm the next request contains the freshest files.
6. Close and reopen the side panel and confirm the next request contains the freshest files rather than the prior in-memory bootstrap.
7. Switch between agents connected to different roots and confirm history is retained while each agent receives only its newly captured workspace bootstrap.
8. Have the endpoint request a visible write to `memory/YYYY-MM-DD.md`, then confirm the expected bytes appear in the real folder and standing files remain unchanged.
9. Restart the browser. If AgentBoard reports that access must be restored, confirm a fresh chat is blocked before provider traffic, restore access from Settings, and retry successfully.
10. Disconnect Local Workspace and confirm the next request has no workspace content or file tools, then confirm every original file remains on disk.
