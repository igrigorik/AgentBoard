const TOKEN_CHARACTER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/;

function isOptionalWhitespace(character: string): boolean {
  return character === ' ' || character === '\t';
}

function consumeToken(value: string, start: number): number {
  let index = start;
  while (index < value.length && TOKEN_CHARACTER.test(value[index])) index += 1;
  return index;
}

function consumeQuotedString(value: string, start: number): number | null {
  let index = start + 1;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x22) return index + 1;
    if (code === 0x5c) {
      index += 1;
      if (index >= value.length) return null;
      const escaped = value.charCodeAt(index);
      if (escaped !== 0x09 && (escaped < 0x20 || escaped === 0x7f)) return null;
      index += 1;
      continue;
    }
    const isQuotedText =
      code === 0x09 ||
      (code >= 0x20 && code <= 0x21) ||
      (code >= 0x23 && code <= 0x5b) ||
      (code >= 0x5d && code <= 0x7e) ||
      code >= 0x80;
    if (!isQuotedText) return null;
    index += 1;
  }
  return null;
}

/** Parse a complete HTTP Content-Type field without accepting malformed trailing parameters. */
export function parseHttpContentType(value: string | null): string | null {
  if (value === null) return null;
  let index = 0;
  while (index < value.length && isOptionalWhitespace(value[index])) index += 1;

  const typeEnd = consumeToken(value, index);
  if (typeEnd === index || value[typeEnd] !== '/') return null;
  const subtypeStart = typeEnd + 1;
  const subtypeEnd = consumeToken(value, subtypeStart);
  if (subtypeEnd === subtypeStart) return null;
  const essence = value.slice(index, subtypeEnd).toLowerCase();
  index = subtypeEnd;

  for (;;) {
    while (index < value.length && isOptionalWhitespace(value[index])) index += 1;
    if (index === value.length) return essence;
    if (value[index] !== ';') return null;
    index += 1;
    while (index < value.length && isOptionalWhitespace(value[index])) index += 1;

    const nameEnd = consumeToken(value, index);
    if (nameEnd === index || value[nameEnd] !== '=') return null;
    index = nameEnd + 1;

    if (value[index] === '"') {
      const quotedEnd = consumeQuotedString(value, index);
      if (quotedEnd === null) return null;
      index = quotedEnd;
    } else {
      const parameterEnd = consumeToken(value, index);
      if (parameterEnd === index) return null;
      index = parameterEnd;
    }
  }
}
