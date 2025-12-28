import { describe, it, expect } from 'vitest';
import { generateDuplicateName } from '../src/options/card-component';

describe('generateDuplicateName', () => {
  it('appends (1) for first duplicate', () => {
    expect(generateDuplicateName('My Agent', ['My Agent'])).toBe('My Agent (1)');
  });

  it('increments counter for existing duplicates', () => {
    const existing = ['My Agent', 'My Agent (1)', 'My Agent (2)'];
    expect(generateDuplicateName('My Agent', existing)).toBe('My Agent (3)');
  });

  it('handles duplicating an already numbered agent', () => {
    const existing = ['My Agent', 'My Agent (1)'];
    expect(generateDuplicateName('My Agent (1)', existing)).toBe('My Agent (2)');
  });

  it('finds gaps in numbering', () => {
    const existing = ['My Agent', 'My Agent (2)', 'My Agent (3)'];
    expect(generateDuplicateName('My Agent', existing)).toBe('My Agent (1)');
  });

  it('handles empty existing names', () => {
    expect(generateDuplicateName('My Agent', [])).toBe('My Agent (1)');
  });

  it('handles names with special characters', () => {
    const existing = ['Code-Assistant_v2'];
    expect(generateDuplicateName('Code-Assistant_v2', existing)).toBe('Code-Assistant_v2 (1)');
  });
});
