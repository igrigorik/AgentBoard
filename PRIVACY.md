# Privacy Policy

Last updated: August 20, 2026

AgentBoard is a browser extension that connects your browser to services and tools you choose. This policy explains what stays on your device, what is sent to AgentBoard, and what may be sent to third parties.

## Data sent to AgentBoard

The extension does not send your activity or content to us. AgentBoard does not operate an account system, analytics service, advertising service, telemetry collector, or backend that receives extension data.

We do not sell extension data or use it for advertising.

## Data on your device

AgentBoard stores its settings in your browser. These settings may include service credentials, endpoints, model and tool configuration, command templates, scripts, and interface preferences.

Conversations, attachments, page content, and tool activity may be held in memory while the extension is running, but AgentBoard does not automatically persist conversation transcripts.

You may optionally connect a local folder to an agent as a Local Workspace. AgentBoard stores the folder connection in your browser; the files remain in the folder you selected.

Settings backups are plaintext and may contain credentials or other sensitive configuration. Treat them as secrets. Backups do not include Local Workspace connections or folder contents. Importing settings clears existing Local Workspace connections, so folders must be reconnected afterward.

## Data sent to third parties

AgentBoard may make limited third-party requests to load its interface. Those services receive ordinary network information, such as your IP address and request headers.

When you configure or use a provider, server, tool, or script, AgentBoard or that tool may send data to the relevant third-party services. These services can include model providers, proxies, MCP servers, websites, and services contacted by tools or scripts.

Depending on the action, shared data may include content you provide, attachments, Local Workspace file contents, URL and title context from current or earlier conversation turns, page content, tool definitions and instructions, tool inputs and results, model settings, and credentials or browser-session data needed to access the selected service.

AgentBoard requests the `<all_urls>` host permission, which Chrome describes as access to your data on all websites. You can restrict or revoke site access at any time from `chrome://extensions`.

The `agentboard_read_page` tool includes reduced-resolution page visuals by default for connection APIs that support media in tool results: one screenshot of the currently visible browser viewport for HTML pages, or full-page images for PDFs. These images can disclose material absent from extracted text, including photographs, signatures, handwriting, annotations, visual redactions, charts, diagrams, layout relationships, and anything else on screen at that moment such as chat widgets, notifications, and form contents as rendered. Screenshots are delivered only while that page's tab is the active tab of its window, so switching tabs during a read yields no image. A tool call can set `includePageImages` to `false` for text-only extraction. Raw PDF bytes are not sent to the model provider, and images are not stored in sidebar history or browser storage, but images delivered to a configured model service are processed under that service's terms and privacy policy.

Reading a local `file://` PDF requires you to enable Chrome’s “Allow access to file URLs” toggle for AgentBoard. Chrome grants this permission at the file-scheme level, but AgentBoard uses it only when `agentboard_read_page` is invoked against the exact current top-level PDF. Model-authored Markdown links and images reject `file:`, extension, data, and other privileged URL schemes so they cannot exercise that browser permission. Local bytes are read inside the capability-authenticated PDF worker path and are not sent through the extension service worker, generic runtime messages, logs, or storage. As with any attached tab, the configured AI endpoint can receive the local tab’s URL and title in page context; the tool’s public result does not duplicate the filesystem path.

At the start of each new chat for an agent with a connected workspace, AgentBoard automatically reads recognized `IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`, and `MEMORY.md` files and sends their contents to that agent’s configured AI service. Other files in the selected folder may be read and sent through visible tool calls. Permitted memory writes and deletions also occur through visible tool calls. Switching a conversation to another configured agent may send its existing history, the selected agent’s Local Workspace content, and page context to the newly selected service.

The exact data sent through configured services depends on the provider and the features, tools, and scripts used for your request. Third-party services process data under their own terms and privacy policies; AgentBoard does not control their logging, retention, caching, or use of data after they receive it.

## Your choices

You control which providers, endpoints, tools, scripts, and Local Workspace folders you configure and use.

Disconnecting a Local Workspace, deleting an agent, clearing extension data, or uninstalling AgentBoard removes browser-held folder connections but does not delete files in the selected folders. Delete folder contents with your normal filesystem tools. Files in a synchronized folder may also be retained by that synchronization service.

Deleting local data does not delete exported backups or data already received by third parties.

## Contact

For privacy or security questions, open an issue at <https://github.com/igrigorik/agentboard/issues>.
