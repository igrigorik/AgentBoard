/**
 * WebMCP Tool Compiler Plugin for Vite
 *
 * Compiles WebMCP tool scripts from src/lib/webmcp/tools/ into self-registering
 * files in dist/tools/ that can be injected via chrome.scripting.executeScript
 * with files:[] to bypass Content Security Policy.
 *
 * Key transformations:
 * - Removes ES module syntax (export const, export function)
 * - Wraps tool code in self-registering IIFE
 * - Adds retry logic for window.agent availability
 * - Generates static registry with metadata for lifecycle injection
 *
 * Why: Files injected via files:[] bypass CSP script-src restrictions,
 * enabling tools to work on strict CSP sites like ChatGPT.com and GitHub.com
 */

import type { Plugin } from 'vite';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tool metadata extracted from script
 */
interface ToolMetadata {
  name: string;
  namespace: string;
  version: string;
  description: string;
  match: string[];
  inputSchema?: unknown;
}

/**
 * Compiled tool information for registry
 */
interface CompiledToolInfo {
  id: string; // Full tool ID: namespace_name
  file: string; // Relative path from dist: tools/agentboard_page_info.js
  match: string[]; // URL patterns to match
  version: string;
  description: string; // Tool description for UI display
}

/**
 * Configuration for the plugin
 */
interface PluginConfig {
  toolsSourceDir: string; // Source directory: src/lib/webmcp/tools
  toolsOutputDir: string; // Output directory: dist/tools
  registryOutputPath: string; // Registry file: src/lib/webmcp/tools/registry.ts
  sourcesOutputPath: string; // Sources file: src/lib/webmcp/builtin-sources.ts
}

const DEFAULT_CONFIG: PluginConfig = {
  toolsSourceDir: 'src/lib/webmcp/tools',
  toolsOutputDir: 'dist/tools',
  registryOutputPath: 'src/lib/webmcp/tools/registry.ts',
  sourcesOutputPath: 'src/lib/webmcp/builtin-sources.ts',
};

/**
 * Main plugin function
 */
export function webmcpCompilerPlugin(userConfig?: Partial<PluginConfig>): Plugin {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  let compiledTools: CompiledToolInfo[] = [];
  const compiledToolsMap: Map<string, string> = new Map(); // Store compiled code for generateBundle

  return {
    name: 'webmcp-compiler',
    enforce: 'pre',

    /**
     * Runs before Vite starts building
     * Scans tools, compiles them, and stores in memory for later emission
     */
    async buildStart() {
      // eslint-disable-next-line no-console
      console.log('[WebMCP Compiler] Starting tool compilation...');

      try {
        // Scan tool directories
        const toolDirs = fs.readdirSync(config.toolsSourceDir).filter((name) => {
          const fullPath = path.join(config.toolsSourceDir, name);
          return fs.statSync(fullPath).isDirectory();
        });

        // eslint-disable-next-line no-console
        console.log(`[WebMCP Compiler] Found ${toolDirs.length} tool directories`);

        compiledTools = [];
        compiledToolsMap.clear();

        // Compile each tool
        for (const toolDir of toolDirs) {
          try {
            const scriptPath = path.join(config.toolsSourceDir, toolDir, 'script.js');

            if (!fs.existsSync(scriptPath)) {
              console.warn(`[WebMCP Compiler] No script.js found in ${toolDir}, skipping`);
              continue;
            }

            const { info, code } = await compileTool(scriptPath);
            compiledTools.push(info);
            compiledToolsMap.set(info.file, code);
            // eslint-disable-next-line no-console
            console.log(`[WebMCP Compiler] ✅ Compiled ${info.id}`);
          } catch (error) {
            console.error(`[WebMCP Compiler] ❌ Failed to compile ${toolDir}:`, error);
            throw error; // Fail build on tool compilation errors
          }
        }

        // Generate static registry
        generateRegistry(compiledTools, config.registryOutputPath);
        // eslint-disable-next-line no-console
        console.log(`[WebMCP Compiler] ✅ Generated registry with ${compiledTools.length} tools`);

        // Generate source bundle for Options UI
        generateBuiltinSources(config.toolsSourceDir, config.sourcesOutputPath);
        // eslint-disable-next-line no-console
        console.log('[WebMCP Compiler] ✅ Generated builtin sources bundle');
      } catch (error) {
        console.error('[WebMCP Compiler] Compilation failed:', error);
        throw error;
      }
    },

    /**
     * Emit compiled tools as part of the build output
     */
    generateBundle() {
      // Emit each compiled tool file
      for (const [fileName, code] of compiledToolsMap) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: code,
        });
      }
    },

    /**
     * Watch mode: Re-compile when tool sources change
     */
    async handleHotUpdate({ file }) {
      // Only recompile if a tool script changed
      if (file.includes('/tools/') && file.endsWith('/script.js')) {
        // eslint-disable-next-line no-console
        console.log(`[WebMCP Compiler] Tool source changed: ${file}`);
        // Trigger full rebuild by returning empty array (Vite will reload)
        return [];
      }
      // Return undefined for other files (let Vite handle normally)
      return;
    },
  };
}

/**
 * Compile a single tool from source to self-registering IIFE
 * Returns both the tool info and compiled code
 */
async function compileTool(scriptPath: string): Promise<{ info: CompiledToolInfo; code: string }> {
  // Read source code
  const sourceCode = fs.readFileSync(scriptPath, 'utf-8');

  // Parse metadata
  const metadata = extractMetadata(sourceCode);
  if (!metadata) {
    throw new Error(`Failed to extract metadata from ${scriptPath}`);
  }

  // Validate required fields
  if (!metadata.name || !metadata.namespace || !metadata.version) {
    throw new Error(`Missing required metadata fields in ${scriptPath}`);
  }

  // Check that execute function exists
  if (!sourceCode.includes('function execute')) {
    throw new Error(`No execute function found in ${scriptPath}`);
  }

  // Generate tool ID and output filename
  const toolId = `${metadata.namespace}_${metadata.name}`;
  const outputFilename = `${toolId}.js`;

  // Transform source code
  const transformedCode = transformToolCode(sourceCode);

  // Wrap in self-registering IIFE
  const wrappedCode = wrapInIIFE(transformedCode, metadata);

  return {
    info: {
      id: toolId,
      file: `tools/${outputFilename}`,
      match: metadata.match,
      version: metadata.version,
      description: metadata.description || '',
    },
    code: wrappedCode,
  };
}

/**
 * Extract metadata from tool source code
 */
function extractMetadata(code: string): ToolMetadata | null {
  try {
    // Find the metadata object
    const metadataMatch = code.match(/export\s+const\s+metadata\s*=\s*({[\s\S]*?});/);
    if (!metadataMatch) {
      return null;
    }

    // Parse the metadata object (use Function to evaluate the object literal)
    // This is safe because we control the source code
    const metadataStr = metadataMatch[1];
    const metadata = new Function(`return ${metadataStr}`)();

    return metadata as ToolMetadata;
  } catch (error) {
    console.error('Failed to parse metadata:', error);
    return null;
  }
}

/**
 * Transform ES module exports to plain declarations
 */
function transformToolCode(code: string): string {
  return (
    code
      // Remove webmcp-tool pragma
      .replace(/^\s*'use webmcp-tool v\d+';?\s*/m, '')
      // Transform export const metadata = ... to const metadata = ...
      .replace(/export\s+const\s+metadata\s*=/g, 'const metadata =')
      // Transform export async function execute to async function execute
      .replace(/export\s+(async\s+)?function\s+execute/g, '$1function execute')
      // Transform export function shouldRegister to function shouldRegister
      .replace(/export\s+function\s+shouldRegister/g, 'function shouldRegister')
  );
}

/**
 * Wrap transformed code in self-registering IIFE
 * This IIFE registers the tool with window.agent when available
 */
function wrapInIIFE(code: string, metadata: ToolMetadata): string {
  const fullToolName = `${metadata.namespace}_${metadata.name}`;

  return `/**
 * WebMCP Tool: ${fullToolName}
 * Version: ${metadata.version}
 * Generated by vite-plugin-webmcp-compiler
 * DO NOT EDIT - This file is auto-generated
 */
(function() {
  'use strict';
  
  // Tool implementation
${code}
  
  // Self-registration with retry logic
  (function registerTool() {
    if (!window.agent || typeof window.agent.registerTool !== 'function') {
      // window.agent not ready, retry after 10ms
      setTimeout(registerTool, 10);
      return;
    }
    
    // Check if tool should be registered (optional export)
    if (typeof shouldRegister === 'function') {
      try {
        const shouldReg = shouldRegister();
        if (!shouldReg) {
          console.log('[WebMCP] Tool ${fullToolName} skipped registration (shouldRegister returned false)');
          return;
        }
      } catch (error) {
        console.error('[WebMCP] Error in shouldRegister for ${fullToolName}:', error);
        // Continue with registration if shouldRegister throws (fail-open)
      }
    }
    
    // Register the tool
    window.agent.registerTool({
      name: '${fullToolName}',
      description: metadata.description || '',
      inputSchema: metadata.inputSchema,
      execute: execute
    });
    
    console.log('[WebMCP] Registered tool ${fullToolName} v${metadata.version}');
  })();
})();
//# sourceURL=webmcp-tool:${fullToolName}.js
`;
}

/**
 * Generate static registry file
 */
function generateRegistry(tools: CompiledToolInfo[], outputPath: string): void {
  // Format tools array with proper TypeScript code style
  const toolsArray = tools
    .map((tool) => {
      // Escape single quotes in description
      const escapedDesc = tool.description.replace(/'/g, "\\'");
      
      // Format multi-line if description is long (> 80 chars)
      const descLine =
        escapedDesc.length > 80
          ? `description:\n      '${escapedDesc}',`
          : `description: '${escapedDesc}',`;

      return `  {
    id: '${tool.id}',
    file: '${tool.file}',
    match: [${tool.match.map((m) => `'${m}'`).join(', ')}],
    version: '${tool.version}',
    ${descLine}
  }`;
    })
    .join(',\n');

  const registryContent = `/**
 * WebMCP Compiled Tools Registry
 *
 * This file is AUTO-GENERATED by vite-plugin-webmcp-compiler.
 * DO NOT EDIT manually - changes will be overwritten on next build.
 *
 * Registry of pre-compiled tools with metadata for lifecycle injection.
 * Tools are compiled to static files that bypass CSP via chrome.scripting files:[].
 */

export interface CompiledToolInfo {
  id: string; // Full tool ID: namespace_name
  file: string; // Relative path from dist: tools/agentboard_page_info.js
  match: string[]; // URL patterns to match for injection
  version: string; // Tool version
  description: string; // Tool description for UI display
}

/**
 * Array of all compiled tools
 * Used by lifecycle.ts to determine which tools to inject into each tab
 */
export const COMPILED_TOOLS: CompiledToolInfo[] = [
${toolsArray},
];
`;

  fs.writeFileSync(outputPath, registryContent, 'utf-8');
}

/**
 * Generate builtin-sources.ts with tool source code as strings
 * Used by Options UI to display read-only source code for built-in tools
 */
function generateBuiltinSources(toolsSourceDir: string, outputPath: string): void {
  const sources: Record<string, string> = {};

  // Read WebMCP tool sources (script.js files)
  const toolDirs = fs.readdirSync(toolsSourceDir).filter((name) => {
    const fullPath = path.join(toolsSourceDir, name);
    return fs.statSync(fullPath).isDirectory();
  });

  for (const toolDir of toolDirs) {
    const scriptPath = path.join(toolsSourceDir, toolDir, 'script.js');

    if (fs.existsSync(scriptPath)) {
      const sourceCode = fs.readFileSync(scriptPath, 'utf-8');
      
      // Extract tool ID from metadata
      const metadata = extractMetadata(sourceCode);
      if (metadata && metadata.name && metadata.namespace) {
        const toolId = `${metadata.namespace}_${metadata.name}`;
        sources[toolId] = sourceCode;
      }
    }
  }

  // Read system tool source (TypeScript)
  const fetchToolPath = path.join(toolsSourceDir, 'fetch', 'fetch-url.ts');
  if (fs.existsSync(fetchToolPath)) {
    const sourceCode = fs.readFileSync(fetchToolPath, 'utf-8');
    sources['agentboard_fetch_url'] = sourceCode;
  }

  // Generate TypeScript source file
  const sourcesArray = Object.entries(sources)
    .map(([id, source]) => {
      // Escape for template literals:
      // 1. Backslashes must be escaped first (order matters!)
      // 2. Backticks (template literal delimiters)
      // 3. Template expressions ${...} -> need to escape as \${
      const escapedSource = source
        .replace(/\\/g, '\\\\')  // \ -> \\
        .replace(/`/g, '\\`')     // ` -> \`
        .replace(/\$\{/g, '\\${'); // ${ -> \${
      return `  ${id}: \`${escapedSource}\``;
    })
    .join(',\n');

  const sourcesContent = `/**
 * Built-in Tool Sources Bundle
 *
 * This file is AUTO-GENERATED by vite-plugin-webmcp-compiler.
 * DO NOT EDIT manually - changes will be overwritten on next build.
 *
 * Contains source code for all built-in tools (system + WebMCP).
 * Used by Options UI to display read-only source code for learning/reference.
 */

export const BUILTIN_SOURCES: Record<string, string> = {
${sourcesArray},
};
`;

  fs.writeFileSync(outputPath, sourcesContent, 'utf-8');
}
