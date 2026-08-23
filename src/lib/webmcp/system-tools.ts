import type { StorageConfig } from '../storage/config';
import type { SystemToolRegistration } from './tool-registry';
import { fetchUrlTool, FETCH_URL_METADATA, FETCH_URL_TOOL_NAME } from './tools/fetch';
import { createNavigateTool, NAVIGATE_TOOL_NAME } from './tools/navigate';
import { createReadPageTool, READ_PAGE_TOOL_NAME } from './tools/read_page';

/**
 * Concrete built-ins live at this composition boundary so ToolRegistryManager only reconciles
 * generic registrations and never acquires product-specific dependencies or configuration policy.
 */
const SYSTEM_TOOL_REGISTRATIONS: readonly SystemToolRegistration[] = [
  {
    name: FETCH_URL_TOOL_NAME,
    tool: fetchUrlTool,
    description: FETCH_URL_METADATA.description,
  },
  {
    name: NAVIGATE_TOOL_NAME,
    createForTab: createNavigateTool,
  },
  {
    name: READ_PAGE_TOOL_NAME,
    createForTab: createReadPageTool,
  },
];

export function getEnabledSystemToolRegistrations(
  config: Pick<StorageConfig, 'builtinScripts'>
): readonly SystemToolRegistration[] {
  const overrides = new Map(config.builtinScripts?.map(({ id, enabled }) => [id, enabled]));
  return SYSTEM_TOOL_REGISTRATIONS.filter(({ name }) => overrides.get(name) !== false);
}
