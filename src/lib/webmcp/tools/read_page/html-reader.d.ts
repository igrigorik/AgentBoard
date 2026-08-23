import type { HtmlReadResult } from './html-protocol';

export function execute(args?: { maxLength?: number }): Promise<HtmlReadResult>;
