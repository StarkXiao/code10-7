/**
 * 交叉分组（材质 × 季节 × 穿着频率）的纯函数测试。
 * 用内存 Dataset 真实走一遍 computeAllGarmentStats，再验证聚合、
 * 最不耐用组合识别、选材/针法建议（含字典兜底）。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateCrossDurability,
  type CrossDictionary,
} from '../src/services/analytics.js';
import { computeAllGarmentStats, type Dataset } from '../src/services/stats.js';

const TODAY = new Date('2026-09-21T00:00:00Z');

const DICT: CrossDictionary = {
  stitches: [
    { id: 'st-back', code: 'backstitch', name: '回针缝' },
    { id: 'st-run', code: 'running_stitch', name: '平针缝' },
    { id: 'st-darn', code: 'darning_hand', name: '织补（手工）' },
  ],
  damageTypes: [
    { id: 'dt-hole', code: 'hole', suggestedStitchCodes: ['darning_hand', 'patch_applique'] },
    { id: 'dt-thin', code: 'thinning', suggestedStitchCodes: ['overcast'] },
  ],
  materials: [
    { code: 'cotton', durabilityScore: 4 },
    { code: 'polyester', durabilityScore: 5 },
    { code: 'cashmere', durabilityScore: 2 },
  ],
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function garment(id: string, materialPrimary: string, firstWearDate: string): any {
  return { id, materialPrimary, firstWearDate: new Date(firstWearDate), purchasePrice: 100, status: 'active' };
}
function wear(garmentId: string, wornOn: string, seasonSnapshot: string): any {
  return { garmentId, wornOn: new Date(wornOn), session: 'full_day', seasonSnapshot };
}
function damage(id: string, garmentId: string, detectedAt: string, damageTypeId: string, recurrenceOf: string | null = null): any {
  return { id, garmentId, status: 'resolved', detectedAt: new Date(detectedAt), damageTypeId, partId: null, recurrenceOf };
}
function repair(id: string, damageEventId: string, finishedAt: string, stitchId: string): any {
  return { id, damageEventId, status: 'passed', finishedAt: new Date(finishedAt), cost: 0, shopCost: 0, stitchId };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 生成某衣物在某月连续工作日的穿着记录（seasonSnapshot 手工指定） */
function wearsIn(garmentId: string, days: string[], season: string) {
  return days.map((day) => wear(garmentId, day, season));
}

const JUNE = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00Z`);

interface Fixture {
  dataset: Dataset;
  withRepairs: boolean;
}

function buildFixture(options: { withRepairs?: boolean; withDamages?: boolean } = {}): Fixture {
  const { withRepairs = true, withDamages = true } = options;
  // A：棉，2026-06 起穿，30 次夏季穿着 → 月均 ≈8.2 → 高频
  // B：涤纶，同期 12 次夏季穿着 → 中频，零破损
  // C：羊绒，2026-01 起穿，3 次冬季穿着 → 偶发，1 次破损
  const garments = [
    garment('g-a', 'cotton', '2026-06-01T00:00:00Z'),
    garment('g-b', 'polyester', '2026-06-01T00:00:00Z'),
    garment('g-c', 'cashmere', '2026-01-01T00:00:00Z'),
  ];
  const wears = [
    ...wearsIn('g-a', JUNE, 'summer'),
    ...wearsIn('g-b', JUNE.slice(0, 12), 'summer'),
    ...wearsIn('g-c', ['2026-01-10T10:00:00Z', '2026-01-11T10:00:00Z', '2026-01-12T10:00:00Z'], 'winter'),
  ];
  const damages = withDamages
    ? [
        damage('d-1', 'g-a', '2026-07-01T10:00:00Z', 'dt-hole'),
        damage('d-2', 'g-a', '2026-07-15T10:00:00Z', 'dt-hole', 'd-1'),
        damage('d-3', 'g-a', '2026-08-10T10:00:00Z', 'dt-thin', 'd-2'),
        damage('d-4', 'g-c', '2026-01-20T10:00:00Z', 'dt-hole'),
      ]
    : [];
  const repairs =
    withDamages && withRepairs
      ? [
          repair('r-1', 'd-1', '2026-07-03T10:00:00Z', 'st-run'),
          repair('r-2', 'd-2', '2026-07-20T10:00:00Z', 'st-back'),
          repair('r-3', 'd-3', '2026-08-12T10:00:00Z', 'st-back'),
        ]
      : [];
  return {
    withRepairs,
    dataset: {
      garments,
      damages,
      repairs,
      reviews: [],
      wears,
      careRules: new Map(),
    } as Dataset,
  };
}

function aggregate(fixture: Fixture) {
  const stats = computeAllGarmentStats(fixture.dataset, TODAY);
  return aggregateCrossDurability(fixture.dataset, stats, DICT);
}

describe('交叉分组：材质 × 季节 × 穿着频率', () => {
  it('按事件归属分组：穿着用 seasonSnapshot，破损按发现月份推季节', () => {
    const result = aggregate(buildFixture());
    const cotton = result.cells.find((c) => c.key === 'cotton|summer|high');
    expect(cotton).toBeDefined();
    expect(cotton!.garmentCount).toBe(1);
    expect(cotton!.wearCount).toBe(30);
    expect(cotton!.damageCount).toBe(3);
    expect(cotton!.recurrenceCount).toBe(2);
    expect(cotton!.wearCountPerDamage).toBe(10);

    const cashmere = result.cells.find((c) => c.key === 'cashmere|winter|occasional');
    expect(cashmere).toBeDefined();
    expect(cashmere!.wearCount).toBe(3);
    expect(cashmere!.damageCount).toBe(1);
    expect(cashmere!.wearCountPerDamage).toBe(3);

    const polyester = result.cells.find((c) => c.key === 'polyester|summer|medium');
    expect(polyester!.damageCount).toBe(0);
    expect(polyester!.wearCountPerDamage).toBeNull();
  });

  it('寿命样本落在修补完成月份所在的格子里，右删失单独计数', () => {
    const result = aggregate(buildFixture());
    const cotton = result.cells.find((c) => c.key === 'cotton|summer|high')!;
    // r-1（平针，12 天后复发）、r-2（回针，21 天后复发）、r-3（回针，至今未复发）
    expect(cotton.observedLifespanCount).toBe(2);
    expect(cotton.censoredLifespanCount).toBe(1);
    expect(cotton.averageLifespanDays).toBe(16.5);
  });

  it('最不耐用组合要求至少 2 次破损，单次意外不参与排名', () => {
    const result = aggregate(buildFixture());
    // 羊绒格 3 次穿着就坏 1 次，但只有 1 个样本 → 排名让位给棉（3 次破损）
    expect(result.worst?.key).toBe('cotton|summer|high');
    expect(result.best?.key).toBe('polyester|summer|medium');
    const worstInsight = result.insights.find((i) => i.text.includes('最不耐用组合'));
    expect(worstInsight?.text).toContain('棉');
    expect(worstInsight?.text).toContain('夏季');
    expect(worstInsight?.text).toContain('高频');
    expect(worstInsight?.confident).toBe(true);
  });

  it('选材建议：同场景无对比时逐级放宽，并排除穿着量太小的材质', () => {
    const result = aggregate(buildFixture());
    // 夏季×高频只有棉 → 放宽到夏季全季，涤纶 12 穿 0 坏胜出；羊绒只有 3 穿不够格
    expect(result.materialAdvice?.suggested).toBe('polyester');
    expect(result.materialAdvice?.scope).toBe('same_season');
    expect(result.materialAdvice?.text).toContain('放宽');
    expect(result.materialAdvice?.text).toContain('零破损');
  });

  it('针法建议：用该材质上真实复发数据里平均寿命最长的针法', () => {
    const result = aggregate(buildFixture());
    expect(result.stitchAdvice?.stitchCode).toBe('backstitch');
    expect(result.stitchAdvice?.source).toBe('observed');
    expect(result.stitchAdvice?.averageLifespanDays).toBe(21);
    expect(result.stitchAdvice?.text).toContain('回针缝');
  });

  it('没有复发样本时，针法建议退回字典（按最高发破损类型）', () => {
    const result = aggregate(buildFixture({ withRepairs: false }));
    expect(result.stitchAdvice?.source).toBe('dictionary');
    // 棉格最高发破损是破洞（2 次）→ 字典推荐手工织补
    expect(result.stitchAdvice?.stitchCode).toBe('darning_hand');
    expect(result.stitchAdvice?.text).toContain('织补');
  });

  it('完全没有破损时：不排名、不给建议，只提示先积累数据', () => {
    const result = aggregate(buildFixture({ withDamages: false }));
    expect(result.worst).toBeNull();
    expect(result.materialAdvice).toBeNull();
    expect(result.stitchAdvice).toBeNull();
    expect(result.insights[0]?.text).toContain('还没有破损记录');
  });

  it('退役衣物也计入分组（避免幸存者偏差）', () => {
    const fixture = buildFixture();
    (fixture.dataset.garments[0] as { status: string }).status = 'retired';
    const result = aggregate(fixture);
    expect(result.cells.find((c) => c.key === 'cotton|summer|high')?.damageCount).toBe(3);
  });
});
