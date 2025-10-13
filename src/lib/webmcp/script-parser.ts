/**
 * WebMCP User Script Parser
 * Parses pragma directives and extracts metadata from tool scripts
 */

import type { UserScriptMetadata } from '../storage/config';

export interface ParsedScript {
  metadata: UserScriptMetadata;
  code: string; // Full code for injection
}

export class ScriptParsingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptParsingError';
  }
}

/**
 * Parses a user script with pragma directive and exported metadata
 * @param code - The full script code
 * @returns Parsed metadata and code
 * @throws ScriptParsingError if script is invalid
 */
export function parseUserScript(code: string, isUserScript = true): ParsedScript {
  // Check for pragma (first non-comment/whitespace statement)
  const pragmaMatch = code.match(/^\s*(?:\/\/.*\n|\s)*'use webmcp-tool v(\d+)';/);
  if (!pragmaMatch) {
    throw new ScriptParsingError('Missing pragma: script must start with "use webmcp-tool v1"');
  }

  const version = pragmaMatch[1];
  if (version !== '1') {
    throw new ScriptParsingError(`Unsupported pragma version: v${version}`);
  }

  // Quick validation via regex (production should use AST)
  const hasMetadata = /export\s+const\s+metadata\s*=/.test(code);
  const hasExecute = /export\s+(async\s+)?function\s+execute/.test(code);
  const hasShouldRegister = /export\s+(async\s+)?function\s+shouldRegister/.test(code);

  if (!hasMetadata) {
    throw new ScriptParsingError('Missing export: metadata');
  }
  if (!hasExecute) {
    throw new ScriptParsingError('Missing export: execute function');
  }

  // Validate shouldRegister if present (optional export)
  if (hasShouldRegister) {
    // Ensure it's not async
    if (/export\s+async\s+function\s+shouldRegister/.test(code)) {
      throw new ScriptParsingError('shouldRegister must be synchronous (not async)');
    }
  }

  // Extract metadata via regex (simplified; use AST in production)
  const metaMatch = code.match(/export\s+const\s+metadata\s*=\s*({[\s\S]*?});/);
  if (!metaMatch) {
    throw new ScriptParsingError('Could not parse metadata export');
  }

  try {
    // Parse metadata - this is a simplified parser
    // In production, we'd use a proper AST parser like acorn or @babel/parser
    const metadata = parseMetadataObject(metaMatch[1]);

    // Validate required fields
    if (!metadata.name || typeof metadata.name !== 'string') {
      throw new ScriptParsingError('Missing or invalid "name" in metadata');
    }
    if (!metadata.namespace || typeof metadata.namespace !== 'string') {
      throw new ScriptParsingError('Namespace is required for all tools');
    }
    if (!metadata.version || typeof metadata.version !== 'string') {
      throw new ScriptParsingError('Missing or invalid "version" in metadata');
    }
    if (!metadata.match) {
      throw new ScriptParsingError('Missing "match" patterns in metadata');
    }

    // Validate snake_case format for name and namespace
    const snakeCaseRegex = /^[a-z][a-z0-9_]*$/;
    if (!snakeCaseRegex.test(metadata.name)) {
      throw new ScriptParsingError(
        'Tool name must be snake_case (lowercase letters, numbers, underscores)'
      );
    }
    if (!snakeCaseRegex.test(metadata.namespace)) {
      throw new ScriptParsingError(
        'Namespace must be snake_case (lowercase letters, numbers, underscores)'
      );
    }

    // Check for reserved namespace (only for user scripts, not built-in tools)
    if (isUserScript && metadata.namespace === 'agentboard') {
      throw new ScriptParsingError('Reserved namespace: agentboard is reserved for built-in tools');
    }

    // Normalize match patterns to array
    if (typeof metadata.match === 'string') {
      metadata.match = [metadata.match];
    }
    if (metadata.exclude && typeof metadata.exclude === 'string') {
      metadata.exclude = [metadata.exclude];
    }

    return {
      metadata: metadata as unknown as UserScriptMetadata,
      code, // Keep full code for injection
    };
  } catch (e) {
    if (e instanceof ScriptParsingError) {
      throw e;
    }
    throw new ScriptParsingError(`Invalid script format: ${(e as Error).message}`);
  }
}

/**
 * Simple parser for JavaScript object literal to extract metadata
 * This is a simplified version - production should use a proper AST parser
 */
function parseMetadataObject(objectStr: string): Record<string, unknown> {
  try {
    // Clean up the object string for JSON parsing
    // This is a simplified approach - proper AST parsing is recommended
    let jsonStr = objectStr
      // Remove trailing commas before } or ]
      .replace(/,(\s*[}\]])/g, '$1')
      // Quote unquoted keys
      .replace(/(\s*)(['"])?(\w+)(['"])?\s*:/g, '$1"$3":')
      // Convert single quotes to double quotes (careful with apostrophes in strings)
      .replace(/'/g, '"')
      // Handle template literals (convert to regular strings)
      .replace(/`([^`]*)`/g, '"$1"')
      // Remove comments
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    // Special handling for functions and complex values
    // For inputSchema and other complex objects, we need more careful parsing
    const inputSchemaMatch = jsonStr.match(/"inputSchema"\s*:\s*({[\s\S]*?})(?=,\s*"|\s*})/);
    if (inputSchemaMatch) {
      // Parse nested object more carefully
      const schemaStr = inputSchemaMatch[1];
      // This is still simplified - real implementation should handle all JSON Schema constructs
      jsonStr = jsonStr.replace(inputSchemaMatch[0], `"inputSchema": ${schemaStr}`);
    }

    // Parse as JSON
    const parsed = JSON.parse(jsonStr);

    return parsed;
  } catch {
    // Fallback to a more manual parsing for common patterns
    const result: Record<string, unknown> = {};

    // Extract simple string fields
    const stringFields = ['name', 'namespace', 'version', 'description'];
    for (const field of stringFields) {
      const match = objectStr.match(new RegExp(`${field}\\s*:\\s*["'\`]([^"'\`]*?)["'\`]`));
      if (match) {
        result[field] = match[1];
      }
    }

    // Extract match patterns (can be string or array)
    const matchMatch = objectStr.match(/match\s*:\s*(\[[\s\S]*?\]|["'`][^"'`]*["'`])/);
    if (matchMatch) {
      const matchValue = matchMatch[1].trim();
      if (matchValue.startsWith('[')) {
        // Array of patterns
        const patterns = matchValue.match(/["'`]([^"'`]*?)["'`]/g);
        if (patterns) {
          result.match = patterns.map((p) => p.slice(1, -1));
        }
      } else {
        // Single pattern
        result.match = matchValue.slice(1, -1);
      }
    }

    // Extract exclude patterns (optional)
    const excludeMatch = objectStr.match(/exclude\s*:\s*(\[[\s\S]*?\]|["'`][^"'`]*["'`])/);
    if (excludeMatch) {
      const excludeValue = excludeMatch[1].trim();
      if (excludeValue.startsWith('[')) {
        const patterns = excludeValue.match(/["'`]([^"'`]*?)["'`]/g);
        if (patterns) {
          result.exclude = patterns.map((p) => p.slice(1, -1));
        }
      } else {
        result.exclude = excludeValue.slice(1, -1);
      }
    }

    // Extract inputSchema if present
    const schemaMatch = objectStr.match(/inputSchema\s*:\s*({[\s\S]*?})(?=,\s*\w+\s*:|$)/);
    if (schemaMatch) {
      try {
        // Try to parse as JSON
        const schemaStr = schemaMatch[1]
          .replace(/(\s*)(['"])?(\w+)(['"])?\s*:/g, '$1"$3":')
          .replace(/'/g, '"');
        result.inputSchema = JSON.parse(schemaStr);
      } catch {
        // If JSON parsing fails, store as string for now
        result.inputSchema = schemaMatch[1];
      }
    }

    return result;
  }
}

/**
 * Check if a script matches a given URL
 * @param url - The URL to check
 * @param metadata - The script metadata with match patterns
 * @returns true if the script should run on this URL
 */
export function matchesUrl(url: string, metadata: UserScriptMetadata): boolean {
  const urlObj = new URL(url);

  // Normalize match and exclude to arrays
  const matchPatterns = Array.isArray(metadata.match) ? metadata.match : [metadata.match];
  const excludePatterns = metadata.exclude
    ? Array.isArray(metadata.exclude)
      ? metadata.exclude
      : [metadata.exclude]
    : [];

  // Check match patterns (at least one must match)
  const matches = matchPatterns.some((pattern) => {
    return matchPattern(pattern, urlObj);
  });

  if (!matches) return false;

  // Check exclude patterns (none must match)
  const excluded = excludePatterns.some((pattern) => {
    return matchPattern(pattern, urlObj);
  });

  return !excluded;
}

/**
 * Check if a URL matches a Chrome extension match pattern
 * @param pattern - The match pattern (e.g., "*://*.example.com/*")
 * @param url - The URL object to test
 * @returns true if the pattern matches the URL
 */
function matchPattern(pattern: string, url: URL): boolean {
  // Handle special patterns
  if (pattern === '<all_urls>') {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  // Parse the pattern components
  const patternMatch = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)?$/);
  if (!patternMatch) {
    return false;
  }

  const [, scheme, host, path] = patternMatch;

  // Check scheme
  if (scheme !== '*' && `${scheme}:` !== url.protocol) {
    return false;
  }

  // Check host
  const hostRegex = host.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');

  if (!new RegExp(`^${hostRegex}$`).test(url.hostname)) {
    return false;
  }

  // Check path
  if (path) {
    const pathRegex = path.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');

    if (!new RegExp(`^${pathRegex}$`).test(url.pathname)) {
      return false;
    }
  }

  return true;
}

/**
 * Create a starter template for new user scripts
 */
export function createScriptTemplate(): string {
  return `'use webmcp-tool v1';

export const metadata = {
  name: "my_tool",
  namespace: "custom", // Required: use snake_case, 'agentboard' is reserved
  version: "0.1.0",
  description: "Description of what this tool does",
  match: "<all_urls>",
  // Optional: restrict to specific sites
  // match: ["https://example.com/*"],
  // exclude: ["*://localhost/*"],
  
  // Optional: define input schema for the tool
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" }
    },
    required: ["query"],
    additionalProperties: false
  }
};

// Optional: conditionally register based on runtime checks
// export function shouldRegister() {
//   // Return true to register, false to skip
//   // Example: Check for specific global object
//   return typeof window.someGlobalObject !== 'undefined';
// }

export async function execute(args) {
  // Your tool logic here
  // args will be validated against inputSchema if provided
  
  // Return structured content or simple values
  return \`Processed: \${args.query}\`;
  
  // Or return MCP-style content blocks:
  // return {
  //   content: [
  //     { type: 'text', text: 'Result text' },
  //     { type: 'json', json: { data: 'value' } }
  //   ]
  // };
}`;
}

/**
 * Validate that a script has all required exports and proper structure
 */
export function validateScript(code: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    const parsed = parseUserScript(code);

    // Additional validation beyond parsing
    if (!parsed.metadata.description) {
      errors.push('Warning: No description provided');
    }

    // Validate semver format (simplified)
    if (!/^\d+\.\d+\.\d+/.test(parsed.metadata.version)) {
      errors.push('Version should follow semver format (e.g., 1.0.0)');
    }

    return { valid: errors.length === 0, errors };
  } catch (e) {
    if (e instanceof ScriptParsingError) {
      errors.push(e.message);
    } else {
      errors.push(`Unexpected error: ${(e as Error).message}`);
    }
    return { valid: false, errors };
  }
}
