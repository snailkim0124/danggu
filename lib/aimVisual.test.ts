import { describe, expect, it } from 'vitest';
import { formatThicknessFraction, tipOffsetToUnitPoint } from './aimVisual';

describe('formatThicknessFraction', () => {
  it('labels a full/center hit as 풀(전체)', () => {
    expect(formatThicknessFraction(1).label).toBe('풀(전체)');
    expect(formatThicknessFraction(0.97).label).toBe('풀(전체)');
  });

  it('labels a half-ball hit as 1/2', () => {
    expect(formatThicknessFraction(0.5)).toEqual({ numerator: 4, denominator: 8, label: '1/2' });
  });

  it('labels a three-quarter hit as 3/4', () => {
    expect(formatThicknessFraction(0.75).label).toBe('3/4');
  });

  it('labels a quarter hit as 1/4', () => {
    expect(formatThicknessFraction(0.25).label).toBe('1/4');
  });

  it('labels an odd eighth without reducing (3/8, 5/8, 7/8)', () => {
    expect(formatThicknessFraction(3 / 8).label).toBe('3/8');
    expect(formatThicknessFraction(5 / 8).label).toBe('5/8');
    expect(formatThicknessFraction(7 / 8).label).toBe('7/8');
  });

  it('labels the thinnest non-zero eighth as 1/8, not a special-cased word', () => {
    expect(formatThicknessFraction(1 / 8).label).toBe('1/8');
  });

  it('labels a razor-thin (rounds to zero) edge hit as 0/8, not a reduced 0/1', () => {
    expect(formatThicknessFraction(0).label).toBe('0/8');
    expect(formatThicknessFraction(0.05).label).toBe('0/8');
  });

  it('clamps out-of-range input', () => {
    expect(formatThicknessFraction(-1).label).toBe('0/8');
    expect(formatThicknessFraction(2).label).toBe('풀(전체)');
  });
});

describe('tipOffsetToUnitPoint', () => {
  it('centers when tipOffset is undefined (direct/bank shots)', () => {
    expect(tipOffsetToUnitPoint(undefined)).toEqual({ x: 0, y: 0 });
  });

  it('centers on a dead-centre tipOffset', () => {
    expect(tipOffsetToUnitPoint({ vertical: 0, horizontal: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('places follow (positive vertical) above centre (negative svg y)', () => {
    const p = tipOffsetToUnitPoint({ vertical: 1, horizontal: 0 });
    expect(p.y).toBeLessThan(0);
  });

  it('places draw (negative vertical) below centre (positive svg y)', () => {
    const p = tipOffsetToUnitPoint({ vertical: -1, horizontal: 0 });
    expect(p.y).toBeGreaterThan(0);
  });

  it('passes horizontal spin through unchanged in sign', () => {
    expect(tipOffsetToUnitPoint({ vertical: 0, horizontal: 0.7 }).x).toBe(0.7);
    expect(tipOffsetToUnitPoint({ vertical: 0, horizontal: -0.7 }).x).toBe(-0.7);
  });

  it('clamps out-of-range tipOffset to the unit disc bounds', () => {
    expect(tipOffsetToUnitPoint({ vertical: 5, horizontal: -5 })).toEqual({ x: -1, y: -1 });
  });
});
