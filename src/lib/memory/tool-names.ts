export const MEMORY_TOOL_NAMES = {
  list: 'agentboard_list_files',
  read: 'agentboard_read_file',
  write: 'agentboard_write_file',
  delete: 'agentboard_delete_file',
} as const;

export const RESERVED_MEMORY_TOOL_NAMES = new Set<string>(Object.values(MEMORY_TOOL_NAMES));
