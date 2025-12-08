'use webmcp-tool v1';

export const metadata = {
  name: "document_context",
  namespace: "google_docs",
  version: "0.2.0",
  description: "Extract content from the current Google Doc as markdown. Use this tool to get the complete document context for analysis or editing suggestions.",
  match: "https://docs.google.com/document/*",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export async function execute() {
  const docId = getDocId();
  if (!docId) {
    throw new Error("Could not extract document ID from URL. Are you on a Google Docs page?");
  }

  const response = await fetch(
    `https://docs.google.com/document/d/${docId}/export?format=md`
  );

  if (!response.ok) {
    throw new Error(`Failed to export document: ${response.status} ${response.statusText}`);
  }

  const content = await response.text();

  return {
    content: [{ type: 'text', text: content }],
    metadata: {
      docId,
      length: content.length,
      url: window.location.href
    }
  };
}

function getDocId() {
  const match = window.location.href.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}
