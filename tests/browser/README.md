# Browser tests

The browser suites exercise the built extension in Chrome rather than source modules in a simulated DOM.

- `pnpm run test:browser` builds and tests the compiled `agentboard_read_page` tool.
- `pnpm run test:browser:mv3` builds and tests extension loading, settings migration, WebMCP execution, storage serialization, and fail-closed configuration handling.

Use the corresponding `:built` script to test an existing `dist/` build. Set `CHROME_BIN` for the read-page suite and `CHROME_FOR_TESTING_BIN` for the MV3 suite when Chrome is not found automatically.

## Manual Local Memory check

Local Memory application logic is covered by source-level tests. The remaining native picker, operating-system filesystem, and permission boundary requires a visible browser and a real folder. Before releasing changes to Local Memory:

1. Build the release candidate, load its `dist/` directory as an unpacked extension, and configure an agent to use a local test endpoint that records requests.
2. Connect a disposable folder through the operating-system picker and confirm AgentBoard initializes `MEMORY.md` and `memory/` without changing unrelated files.
3. Put a unique value in `MEMORY.md`, start a new conversation, send a request, and confirm the local endpoint receives that value.
4. Have the endpoint request a foreground write to `memory/YYYY-MM-DD.md`, then confirm the expected bytes appear in the real folder.
5. Restart the browser. If AgentBoard reports that access must be restored, confirm a request is blocked before provider traffic, restore access from Settings, and retry successfully.
6. Disconnect Local Memory, start a new conversation, and confirm the next request has no Local Memory content or tools.
7. Reconnect through the picker, disconnect again, and confirm every file remains on disk.
