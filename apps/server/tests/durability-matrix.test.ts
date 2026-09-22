import { describe, expect, it } from 'vitest';
import { aggregateDurabilityMatrix, type DictionaryData } from '../src/services/analytics.js';
import type { Dataset } from '../src/services/stats.js';

const TODAY = new Date('2026-09-21T00:00:00Z');

function dict(): DictionaryData {
  return {
    materials: new Map([
      ['cotton', { durabilityScore: 4, typicalWeakPoints: ['腋下', '肘部'] }],
      ['polyester', { durabilityScore: 5, typicalWeakPoints: ['缝合线处'] }],
      ['silk', { durabilityScore: 2, typicalWeakPoints: ['腋下'] }],
    ]),
    stitches: [
      { code: 'invisible_stitch', suitableFabrics: ['woven', 'knit'], suitableDamageTypes: ['seam_open'], difficulty: 'easy' },
      { code: 'backstitch', suitableFabrics: ['woven'], suitableDamageTypes: ['tear', 'seam_open'], difficulty: 'easy' },
      { code: 'darning_hand', suitableFabrics: ['knit'], suitableDamageTypes: ['hole'], difficulty: 'hard' },
      { code: 'fusible', suitableFabrics: ['woven'], suitableDamageTypes: ['hole', 'tear'], difficulty: 'easy' },
    ],
    damageTypes: new Map([
      ['hole', { suggestedStitchCodes: ['darning_hand'] }],
      ['seam_open', { suggestedStitchCodes: ['invisible_stitch', 'backstitch'] }],
    ]),
    damageTypeCodeById: new Map([
      ['dt-hole', 'hole'],
      ['dt-seam', 'seam_open'],
    ]),
    partCodeById: new Map([
      ['p1', 'elbow_right'],
      ['p2', 'underarm'],
    ]),
    partNameByCode: new Map([
      ['elbow_right', '肘部'],
      ['underarm', '腋下'],
    ]),
  };
}

interface GarmentOpts {
  id: string;
  material: string;
  knit?: string;
  firstWear?: string;
}

function garment(opts: GarmentOpts) {
  return {
    id: opts.id,
    materialPrimary: opts.material,
    knitOrWoven: opts.knit ?? 'woven',
    seasonTags: ['all'],
    status: 'active',
    firstWearDate: new Date(opts.firstWear ?? '2026-01-01'),
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
  };
}

function damage(opts: {
  id: string;
  garmentId: string;
  detectedAt: string;
  type?: string;
  partId?: string | null;
  status?: string;
  recurrenceOf?: string | null;
}) {
  const typeId = { hole: 'dt-hole', seam_open: 'dt-seam' }[opts.type ?? 'hole'] ?? opts.type;
  return {
    id: opts.id,
    garmentId: opts.garmentId,
    damageTypeId: typeId,
    partId: opts.partId ?? null,
    detectedAt: new Date(opts.detectedAt),
    status: opts.status ?? 'resolved',
    recurrenceOf: opts.recurrenceOf ?? null,
  };
}

function repair(opts: { id: string; damageEventId: string; stitchId: string; finishedAt: string; status?: string }) {
  return {
    id: opts.id,
    damageEventId: opts.damageEventId,
    stitchId: opts.stitchId,
    finishedAt: new Date(opts.finishedAt),
    status: opts.status ?? 'passed',
  };
}

import type { GarmentStats } from '../src/services/stats.js';

/**
 * 直接构造 GarmentStats，绕开 prisma 行类型：
 * 寿命样本与衣物的关联全部来自这张 map。
 */
function statsMap(entries: Array<{
  garmentId: string;
  band: 'high' | 'medium' | 'low' | 'occasional';
  seasonWearCounts?: Record<string, number>;
  samples?: Array<Record<string, unknown>>;
}>): Map<string, GarmentStats> {
  return new Map(
    entries.map((e) => [
      e.garmentId,
      {
        garmentId: e.garmentId,
        wearCount: Object.values(e.seasonWearCounts ?? {}).reduce((s, n) => s + n, 0),
        frequencyBand: e.band,
        seasonWearCounts: e.seasonWearCounts ?? {},
        lifespanSamples: (e.samples ?? []) as unknown as GarmentStats['lifespanSamples'],
      } as GarmentStats,
    ]),
  );
}

function sample(over: Record<string, unknown>) {
  return {
    repairId: over.repairId,
    garmentId: over.garmentId,
    materialPrimary: over.materialPrimary,
    knitOrWoven: over.knitOrWoven ?? 'woven',
    stitchCode: over.stitchCode,
    finishedAt: over.finishedAt,
    detectedAt: over.detectedAt ?? over.finishedAt,
    damageTypeId: over.damageTypeId ?? 'hole',
    partId: over.partId ?? null,
    days: over.days,
    censored: over.censored ?? false,
    wears: over.wears ?? null,
  };
}

function datasetOf(parts: {
  garments: unknown[];
  damages?: unknown[];
  repairs?: unknown[];
}): Dataset {
  return {
    garments: parts.garments as Dataset['garments'],
    damages: (parts.damages ?? []) as Dataset['damages'],
    repairs: (parts.repairs ?? []) as Dataset['repairs'],
    reviews: [] as Dataset['reviews'],
    wears: [] as Dataset['wears'],
    careRules: new Map(),
  };
}

describe('材质 × 季节 × 穿着频率 交叉分析', () => {
  it('按破损发现月份归季，并选出平均寿命最短的组合为最不耐用', () => {
    // 真丝高频：夏季破洞，补后 20 天复发（最差）
    // 棉高频：夏季开线，补后 60 天复发
    const garments = [
      garment({ id: 'g-silk', material: 'silk', firstWear: '2025-06-01' }),
      garment({ id: 'g-cotton', material: 'cotton', firstWear: '2025-06-01' }),
    ];
    const damages = [
      damage({ id: 'd1', garmentId: 'g-silk', detectedAt: '2026-07-01', type: 'hole', partId: 'p1', recurrenceOf: null }),
      damage({ id: 'd1r', garmentId: 'g-silk', detectedAt: '2026-07-21', type: 'hole', partId: 'p1', recurrenceOf: 'd1' }),
      damage({ id: 'd2', garmentId: 'g-cotton', detectedAt: '2026-07-05', type: 'seam_open', partId: 'p2' }),
      damage({ id: 'd2r', garmentId: 'g-cotton', detectedAt: '2026-09-03', type: 'seam_open', partId: 'p2', recurrenceOf: 'd2' }),
    ];
    const repairs = [
      repair({ id: 'r1', damageEventId: 'd1', stitchId: 'fusible', finishedAt: '2026-07-01' }),
      repair({ id: 'r2', damageEventId: 'd2', stitchId: 'backstitch', finishedAt: '2026-07-05' }),
    ];
    const stats = statsMap([
      {
        garmentId: 'g-silk',
        band: 'high',
        seasonWearCounts: { summer: 30 },
        samples: [
          sample({
            repairId: 'r1',
            garmentId: 'g-silk',
            materialPrimary: 'silk',
            stitchCode: 'fusible',
            finishedAt: new Date('2026-07-01'),
            detectedAt: new Date('2026-07-01'),
            days: 20,
            wears: 18,
            damageTypeId: 'hole',
            partId: 'p1',
          }),
        ],
      },
      {
        garmentId: 'g-cotton',
        band: 'high',
        seasonWearCounts: { summer: 40 },
        samples: [
          sample({
            repairId: 'r2',
            garmentId: 'g-cotton',
            materialPrimary: 'cotton',
            stitchCode: 'backstitch',
            finishedAt: new Date('2026-07-05'),
            detectedAt: new Date('2026-07-05'),
            days: 60,
            wears: 40,
            damageTypeId: 'seam_open',
            partId: 'p2',
          }),
        ],
      },
    ]);

    const result = aggregateDurabilityMatrix(datasetOf({ garments, damages, repairs }), stats, dict(), TODAY);
    expect(result.worst).not.toBeNull();
    expect(result.worst!.materialPrimary).toBe('silk');
    expect(result.worst!.season).toBe('summer');
    expect(result.worst!.band).toBe('high');
    expect(result.worst!.cell.averageLifespanDays).toBe(20);
    expect(result.worst!.summary).toContain('真丝');
    expect(result.worst!.summary).toContain('夏');
  });

  it('右删失样本（未复发）不参与最差排名', () => {
    const garments = [
      garment({ id: 'g1', material: 'cotton' }),
      garment({ id: 'g2', material: 'denim' }),
    ];
    const damages = [
      damage({ id: 'd1', garmentId: 'g1', detectedAt: '2026-07-01' }),
      damage({ id: 'd1r', garmentId: 'g1', detectedAt: '2026-08-10', recurrenceOf: 'd1' }),
      damage({ id: 'd2', garmentId: 'g2', detectedAt: '2026-07-01' }),
    ];
    const repairs = [
      repair({ id: 'r1', damageEventId: 'd1', stitchId: 'backstitch', finishedAt: '2026-07-01' }),
      repair({ id: 'r2', damageEventId: 'd2', stitchId: 'patch_applique', finishedAt: '2026-07-02' }),
    ];
    const stats = statsMap([
      {
        garmentId: 'g1',
        band: 'high',
        samples: [
          sample({
            repairId: 'r1', garmentId: 'g1', materialPrimary: 'cotton', stitchCode: 'backstitch',
            finishedAt: new Date('2026-07-01'), detectedAt: new Date('2026-07-01'), days: 40,
          }),
        ],
      },
      {
        garmentId: 'g2',
        band: 'high',
        samples: [
          sample({
            repairId: 'r2', garmentId: 'g2', materialPrimary: 'denim', stitchCode: 'patch_applique',
            finishedAt: new Date('2026-07-02'), detectedAt: new Date('2026-07-01'), days: 81, censored: true,
          }),
        ],
      },
    ]);

    const result = aggregateDurabilityMatrix(datasetOf({ garments, damages, repairs }), stats, dict(), TODAY);
    // 牛仔格只有删失样本，不该被判为最差
    expect(result.worst!.materialPrimary).toBe('cotton');
    const denimCell = result.cells.find((c) => c.materialPrimary === 'denim');
    expect(denimCell?.observedCount).toBe(0);
    expect(denimCell?.censoredCount).toBe(1);
  });

  it('给出选材与针法建议：优先使用观察数据，缺失时退回字典', () => {
    const garments = [garment({ id: 'g1', material: 'silk' })];
    const damages = [
      damage({ id: 'd1', garmentId: 'g1', detectedAt: '2026-07-01', type: 'seam_open', partId: 'p2' }),
      damage({ id: 'd1r', garmentId: 'g1', detectedAt: '2026-07-15', type: 'seam_open', partId: 'p2', recurrenceOf: 'd1' }),
    ];
    const repairs = [repair({ id: 'r1', damageEventId: 'd1', stitchId: 'fusible', finishedAt: '2026-07-01' })];
    const stats = statsMap([
      {
        garmentId: 'g1',
        band: 'high',
        seasonWearCounts: { summer: 10 },
        samples: [
          sample({
            repairId: 'r1', garmentId: 'g1', materialPrimary: 'silk', stitchCode: 'fusible',
            finishedAt: new Date('2026-07-01'), detectedAt: new Date('2026-07-01'),
            days: 14, damageTypeId: 'seam_open', partId: 'p2',
          }),
        ],
      },
    ]);

    const result = aggregateDurabilityMatrix(datasetOf({ garments, damages, repairs }), stats, dict(), TODAY);
    const worst = result.worst!;
    // 字典兜底：没有同季同频其他材质的观察数据 → 推荐耐用度更高的涤纶（5 > 真丝 2）
    expect(worst.materialAlternatives.length).toBeGreaterThan(0);
    expect(worst.materialAlternatives.some((a) => a.source === 'dictionary')).toBe(true);
    // 字典兜底：开线 + 梭织 → 藏针缝/回针缝
    const recommended = worst.stitchSuggestions.filter((s) => s.kind === 'recommend').map((s) => s.stitchCode);
    expect(recommended).toContain('invisible_stitch');
    // 高频场景附带"避免只靠熨烫贴合补"
    expect(worst.stitchSuggestions.some((s) => s.kind === 'avoid' && s.stitchCode === 'fusible')).toBe(true);
    // 预防建议引用了部位字典名
    expect(worst.preventionAdvice.join('')).toContain('腋下');
  });

  it('样本量 < 3 时结论标记为低置信', () => {
    const garments = [garment({ id: 'g1', material: 'cotton' })];
    const damages = [
      damage({ id: 'd1', garmentId: 'g1', detectedAt: '2026-01-10' }),
      damage({ id: 'd1r', garmentId: 'g1', detectedAt: '2026-02-01', recurrenceOf: 'd1' }),
    ];
    const repairs = [repair({ id: 'r1', damageEventId: 'd1', stitchId: 'backstitch', finishedAt: '2026-01-10' })];
    const stats = statsMap([
      {
        garmentId: 'g1',
        band: 'medium',
        samples: [
          sample({
            repairId: 'r1', garmentId: 'g1', materialPrimary: 'cotton', stitchCode: 'backstitch',
            finishedAt: new Date('2026-01-10'), detectedAt: new Date('2026-01-10'), days: 22,
          }),
        ],
      },
    ]);
    const result = aggregateDurabilityMatrix(datasetOf({ garments, damages, repairs }), stats, dict(), TODAY);
    expect(result.worst!.confident).toBe(false);
    expect(result.worst!.season).toBe('winter');
    expect(result.insights.some((i) => i.text.includes('样本不足') || i.text.includes('继续积累'))).toBe(true);
  });

  it('没有任何破损时不产生最差组合，只返回引导性结论', () => {
    const garments = [garment({ id: 'g1', material: 'cotton' })];
    const stats = statsMap([{ garmentId: 'g1', band: 'low', seasonWearCounts: { winter: 1 } }]);
    const result = aggregateDurabilityMatrix(datasetOf({ garments }), stats, dict(), TODAY);
    expect(result.worst).toBeNull();
    expect(result.insights[0].sampleSize).toBe(0);
  });
});
