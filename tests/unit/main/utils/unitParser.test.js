import { describe, it, expect } from 'vitest';
import { parseCpuMillis, parseMemoryBytes } from '../../../../src/main/utils/unitParser.js';

describe('unitParser', () => {
  describe('parseCpuMillis', () => {
    it('handles millicores (m)', () => {
      expect(parseCpuMillis('250m')).toBe(250);
      expect(parseCpuMillis('1000m')).toBe(1000);
    });

    it('handles whole cores', () => {
      expect(parseCpuMillis('1')).toBe(1000);
      expect(parseCpuMillis('2.5')).toBe(2500);
    });

    it('handles nanocores (n)', () => {
      expect(parseCpuMillis('1000000000n')).toBe(1000);
      expect(parseCpuMillis('500000000n')).toBe(500);
    });

    it('handles microcores (u)', () => {
      expect(parseCpuMillis('2000u')).toBe(2);
    });

    it('handles default/null/empty', () => {
      expect(parseCpuMillis(null)).toBe(0);
      expect(parseCpuMillis('')).toBe(0);
    });
  });

  describe('parseMemoryBytes', () => {
    it('handles Ki, Mi, Gi', () => {
      expect(parseMemoryBytes('512Ki')).toBe(512 * 1024);
      expect(parseMemoryBytes('256Mi')).toBe(256 * 1024 * 1024);
      expect(parseMemoryBytes('1Gi')).toBe(1024 * 1024 * 1024);
    });

    it('handles raw bytes', () => {
      expect(parseMemoryBytes('1024')).toBe(1024);
    });

    it('handles invalid or empty inputs', () => {
      expect(parseMemoryBytes(null)).toBe(0);
      expect(parseMemoryBytes('invalid')).toBe(0);
    });
  });
});
