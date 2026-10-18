// T02461（PRD Q7）：追问引导词单一可信源。
// 此前「追问：/猜猜你想问：/你可能想问：」三词并存，统一为 FOLLOWUP_LABEL。
import { describe, it, expect } from 'vitest';
import { FOLLOWUP_LABEL } from '../src/utils/labels';

describe('FOLLOWUP_LABEL 单一可信源（T02461 Q7）', () => {
  it('追问引导词统一为「你可能想问：」', () => {
    expect(FOLLOWUP_LABEL).toBe('你可能想问：');
  });
});
