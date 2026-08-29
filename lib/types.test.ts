import { describe, expect, it } from 'vitest';
import { TABLE_DIMENSIONS_MM } from '@/lib/types';

// Sample test to prove the vitest + TS path-alias config works end to end.
// Real Vision/PathCalc unit tests belong in lib/vision and lib/pathcalc.
describe('TABLE_DIMENSIONS_MM', () => {
  it('has the correct known real-world dimensions for 대대', () => {
    expect(TABLE_DIMENSIONS_MM['대대']).toEqual({ widthMm: 2540, heightMm: 1270 });
  });

  it('has the correct known real-world dimensions for 중대', () => {
    expect(TABLE_DIMENSIONS_MM['중대']).toEqual({ widthMm: 2438, heightMm: 1219 });
  });
});
