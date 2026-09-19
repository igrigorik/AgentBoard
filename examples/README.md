# Example WebMCP Tools

This directory contains example user scripts that can be imported as WebMCP tools. These are **not** pre-installed — copy and paste them into your user scripts to use them.

To create your own tools, see [AGENTS.md](./AGENTS.md) for the full development guide.

Sites with a strict Content Security Policy (for example GitHub, which allows only its own scripts by hash) cannot run user scripts at all; tools for those sites ship as built-ins instead. `src/lib/webmcp/tools/github_pull_request/script.js` is a complete worked example of that path: the same `metadata`/`execute` shape as a user script, compiled into the extension so it is injected as a packaged file.
