/**
 * 长期使用分析（项目文档 13.2 / 13.4）。
 * 三个维度：材质 / 季节 / 穿着频率，外加"针法效果榜"。
 * 所有结论句都带样本量 n；n < 3 时显式提示样本不足。
 */
import {
  WEAR_FREQUENCY_BAND_LABEL,
  round4,
  seasonOfMonth,
  summarizeLifespans,
  weightedAverage,
  type WearFrequencyBand,
  type Season,
} from '@gml/shared';
import { prisma } from '../lib/prisma.js';
import {
  computeAllGarmentStats,
  computeHealth,
  loadDataset,
  round2,
  type Dataset,
  type GarmentStats,
  type RepairLifespanSample,
} from './stats.js';

export interface Insight {
  text: string;
  sampleSize: number;
  confident: boolean;
}

function insight(text: string, sampleSize: number): Insight {
  return { text: sampleSize < 3 ? `${text}（样本不足，仅供参考）` : text, sampleSize, confident: sampleSize >= 3 };
}

export interface MaterialRow {
  materialPrimary: string;
  garmentCount: number;
  wearCount: number;
  repairCount: number;
  recurrenceRate: number;
  averageLifespanDays: number | null;
  censoredLifespanCount: number;
  observedLifespanCount: number;
  averageCostPerWear: number | null;
  topDamageTypes: Array<{ key: string; count: number }>;
  topParts: Array<{ key: string; count: number }>;
}

export async function byMaterial(wardrobeId: string, today = new Date()) {
  const dataset = await loadDataset(wardrobeId);
  const stats = computeAllGarmentStats(dataset, today);
  return aggregateByMaterial(dataset, stats);
}

export function aggregateByMaterial(dataset: Dataset, stats: Map<string, GarmentStats>) {
  const groups = new Map<string, GarmentStats[]>();
  for (const garment of dataset.garments) {
    const key = garment.materialPrimary;
    const list = groups.get(key) ?? [];
    list.push(stats.get(garment.id)!);
    groups.set(key, list);
  }

  const rows: MaterialRow[] = [];
  for (const [materialPrimary, list] of groups) {
    const samples = list.flatMap((s) => s.lifespanSamples);
    const lifespan = summarizeLifespans(samples);
    const damageTypeCounts = mergeCounts(list.map((s) => s.typeDamageCounts));
    const partCounts = mergeCounts(list.map((s) => s.partDamageCounts));
    rows.push({
      materialPrimary,
      garmentCount: list.length,
      wearCount: list.reduce((sum, s) => sum + s.wearCount, 0),
      repairCount: list.reduce((sum, s) => sum + s.repairCount, 0),
      recurrenceRate: weightedAverage(
        list.map((s) => ({ value: s.recurrenceRate, weight: s.repairedEventCount })),
      ) ?? 0,
      averageLifespanDays: lifespan.averageDays,
      censoredLifespanCount: lifespan.censoredCount,
      observedLifespanCount: lifespan.observedCount,
      averageCostPerWear:
        weightedAverage(
          list.filter((s) => s.costPerWear !== null).map((s) => ({ value: s.costPerWear!, weight: s.wearCount })),
        ) ?? null,
      topDamageTypes: topN(damageTypeCounts, 3),
      topParts: topN(partCounts, 3),
    });
  }
  rows.sort((a, b) => b.garmentCount - a.garmentCount);

  const insights: Insight[] = [];
  const withLifespan = rows.filter((r) => r.averageLifespanDays !== null && r.observedLifespanCount > 0);
  if (withLifespan.length > 0) {
    const worst = withLifespan.reduce((a, b) => (a.averageLifespanDays! <= b.averageLifespanDays! ? a : b));
    insights.push(
      insight(
        `${labelOfMaterial(worst.materialPrimary)}的修补寿命最短：平均 ${worst.averageLifespanDays} 天，复修率 ${(worst.recurrenceRate * 100).toFixed(0)}%。`,
        worst.observedLifespanCount,
      ),
    );
  }
  const withCensored = rows.filter((r) => r.censoredLifespanCount > 0);
  if (withCensored.length > 0) {
    const total = withCensored.reduce((sum, r) => sum + r.censoredLifespanCount, 0);
    insights.push(
      insight(`还有 ${total} 次修补尚未复发（右删失样本），暂不计入平均寿命，只记为"至少撑了这么久"。`, total),
    );
  }
  const topPart = rows.flatMap((r) => r.topParts.map((p) => ({ ...p, material: r.materialPrimary })))[0];
  if (topPart) {
    insights.push(
      insight(`最常出问题的部位是 ${topPart.key}（${topPart.count} 次），优先在这里做预防性加固。`, topPart.count),
    );
  }

  return { rows, insights };
}

export async function bySeason(wardrobeId: string, today = new Date()) {
  const dataset = await loadDataset(wardrobeId);
  const stats = computeAllGarmentStats(dataset, today);
  return aggregateBySeason(dataset, stats);
}

export function aggregateBySeason(dataset: Dataset, stats: Map<string, GarmentStats>) {
  const seasons: Season[] = ['spring', 'summer', 'autumn', 'winter'];
  const wearBySeason = new Map<string, number>(seasons.map((s) => [s, 0]));
  for (const wear of dataset.wears) {
    wearBySeason.set(wear.seasonSnapshot, (wearBySeason.get(wear.seasonSnapshot) ?? 0) + 1);
  }
  const damageBySeason = new Map<string, number>(seasons.map((s) => [s, 0]));
  for (const damage of dataset.damages) {
    const season = seasonOfMonth(damage.detectedAt.getUTCMonth() + 1);
    damageBySeason.set(season, (damageBySeason.get(season) ?? 0) + 1);
  }

  const rows = seasons.map((season) => {
    const wearCount = wearBySeason.get(season) ?? 0;
    const damageCount = damageBySeason.get(season) ?? 0;
    const garmentCount = dataset.garments.filter((g) =>
      (Array.isArray(g.seasonTags) ? (g.seasonTags as string[]) : []).includes(season),
    ).length;
    return {
      season,
      garmentCount,
      wearCount,
      damageCount,
      /** 每 N 次穿着出现一次破损，越小越容易坏 */
      wearCountPerDamage: damageCount > 0 ? round2(wearCount / damageCount) : null,
      wearShare: dataset.wears.length > 0 ? round2(wearCount / dataset.wears.length) : 0,
    };
  });

  const insights: Insight[] = [];
  const ranked = rows.filter((r) => r.wearCountPerDamage !== null).sort(
    (a, b) => (a.wearCountPerDamage ?? 0) - (b.wearCountPerDamage ?? 0),
  );
  if (ranked.length > 0) {
    const worst = ranked[0];
    insights.push(
      insight(
        `${labelOfSeason(worst.season)}最容易出问题：平均每 ${worst.wearCountPerDamage} 次穿着就有一次破损（该季共 ${worst.wearCount} 次穿着、${worst.damageCount} 次破损）。`,
        worst.damageCount,
      ),
    );
  }
  const mostWorn = [...rows].sort((a, b) => b.wearCount - a.wearCount)[0];
  if (mostWorn && mostWorn.wearCount > 0) {
    insights.push(
      insight(
        `${labelOfSeason(mostWorn.season)}是穿着主力季，占全部穿着的 ${(mostWorn.wearShare * 100).toFixed(0)}%。`,
        mostWorn.wearCount,
      ),
    );
  }
  const statValues = [...stats.values()];
  const unused = statValues.filter((s) => s.wearCount === 0).length;
  if (unused > 0) {
    insights.push(insight(`有 ${unused} 件衣物在档案里但一次都没穿过，可以考虑处置。`, unused));
  }
  return { rows, insights };
}

export async function byFrequency(wardrobeId: string, today = new Date()) {
  const dataset = await loadDataset(wardrobeId);
  const stats = computeAllGarmentStats(dataset, today);
  return aggregateByFrequency(dataset, stats);
}

export function aggregateByFrequency(dataset: Dataset, stats: Map<string, GarmentStats>) {
  const bands: WearFrequencyBand[] = ['high', 'medium', 'low', 'occasional'];
  const rows = bands.map((band) => {
    const list = [...stats.values()].filter((s) => s.frequencyBand === band);
    const samples = list.flatMap((s) => s.lifespanSamples);
    const lifespan = summarizeLifespans(samples);
    const costSamples = list.filter((s) => s.costPerWear !== null);
    const wearInBand = list.reduce((sum, s) => sum + s.wearCount, 0);
    return {
      band,
      garmentCount: list.length,
      wearCount: wearInBand,
      wearShare: dataset.wears.length > 0 ? round2(wearInBand / dataset.wears.length) : 0,
      averageRepairCount: list.length
        ? round2(list.reduce((sum, s) => sum + s.repairCount, 0) / list.length)
        : 0,
      averageLifespanDays: lifespan.averageDays,
      observedLifespanCount: lifespan.observedCount,
      censoredLifespanCount: lifespan.censoredCount,
      averageCostPerWear:
        weightedAverage(costSamples.map((s) => ({ value: s.costPerWear!, weight: Math.max(s.wearCount, 1) }))) ??
        null,
      averageHealthScore: list.length
        ? Math.round(list.reduce((sum, s) => sum + computeHealth(s).score, 0) / list.length)
        : null,
      garmentIds: list.map((s) => s.garmentId),
    };
  });

  const insights: Insight[] = [];
  const high = rows.find((r) => r.band === 'high');
  const low = rows.find((r) => r.band === 'low');
  if (high && high.garmentCount > 0 && low && low.garmentCount > 0) {
    insights.push(
      insight(
        `高频组平均修补 ${high.averageRepairCount} 次，低频组 ${low.averageRepairCount} 次——穿得多确实更容易坏，但高频组的每穿成本更低（${high.averageCostPerWear ?? '-'} vs ${low.averageCostPerWear ?? '-'}）。`,
        high.garmentCount,
      ),
    );
  } else if (high && high.garmentCount > 0) {
    insights.push(
      insight(
        `高频组共 ${high.garmentCount} 件，平均修补 ${high.averageRepairCount} 次，平均每穿成本 ${high.averageCostPerWear ?? '-'}。`,
        high.garmentCount,
      ),
    );
  }
  const lowUse = rows.find((r) => r.band === 'occasional');
  if (lowUse && lowUse.garmentCount > 0) {
    insights.push(
      insight(`有 ${lowUse.garmentCount} 件属于"偶发穿着"，长期占着衣柜但每穿成本最高，值得优先处置。`, lowUse.garmentCount),
    );
  }
  return { rows, insights };
}

export async function stitchEffectiveness(wardrobeId: string, today = new Date()) {
  const dataset = await loadDataset(wardrobeId);
  const stats = computeAllGarmentStats(dataset, today);
  const samples = [...stats.values()].flatMap((s) => s.lifespanSamples);
  const stitchRows = await prisma.stitch.findMany();
  const garmentRows = dataset.garments;

  const groups = new Map<string, typeof samples>();
  for (const sample of samples) {
    const garment = garmentRows.find((g) => g.id === sample.garmentId);
    const stitch = stitchRows.find((s) => s.id === sample.stitchCode);
    const key = `${stitch?.code ?? sample.stitchCode}|${garment?.materialPrimary ?? sample.materialPrimary}`;
    const list = groups.get(key) ?? [];
    list.push(sample);
    groups.set(key, list);
  }

  const rows = [...groups.entries()].map(([key, list]) => {
    const [stitchCode, materialPrimary] = key.split('|');
    const lifespan = summarizeLifespans(list);
    return {
      stitchCode,
      materialPrimary,
      sampleCount: list.length,
      observedCount: lifespan.observedCount,
      censoredCount: lifespan.censoredCount,
      averageLifespanDays: lifespan.averageDays,
      minObservedDays: lifespan.minObservedDays,
    };
  });
  rows.sort((a, b) => (b.averageLifespanDays ?? -1) - (a.averageLifespanDays ?? -1));

  const insights: Insight[] = [];
  const best = rows.find((r) => r.observedCount >= 3);
  if (best && best.averageLifespanDays !== null) {
    insights.push(
      insight(
        `目前表现最好的组合是「${labelOfStitch(best.stitchCode)} + ${labelOfMaterial(best.materialPrimary)}」：平均 ${best.averageLifespanDays} 天后才复发。`,
        best.observedCount,
      ),
    );
  }
  if (rows.length === 0) {
    insights.push(insight('还没有复发样本，等第一次复发后这里会出现针法效果对比。', 0));
  }
  return { rows, insights };
}

// ---------------------------------------------------------------------------
// 材质 × 季节 × 穿着频率 三维交叉（项目文档 13.2「强化长期使用结论」）
//
// 分析单位是「修补寿命样本」（见 stats.ts 的 lifespanSamples）：
// 一次修补之后到同部位复发的天数，未复发为右删失单独列示。
// 季节口径：被补破损「发现时」的月份（夏季磨坏的衣服，秋天才补也归夏季）。
// 频率口径：该衣物的月均穿着分档（high/medium/low/occasional）。
// ---------------------------------------------------------------------------

export interface DurabilityCell {
  materialPrimary: string;
  season: Season;
  band: WearFrequencyBand;
  garmentCount: number;
  damageCount: number;
  repairCount: number;
  recurrenceCount: number;
  recurrenceRate: number | null;
  wearCount: number;
  wearsPerDamage: number | null;
  averageLifespanDays: number | null;
  observedCount: number;
  censoredCount: number;
  averageLifespanWears: number | null;
  topDamageTypes: Array<{ key: string; count: number }>;
  topParts: Array<{ key: string; count: number }>;
  knitOrWoven: string | null;
}

export interface MaterialAlternative {
  materialPrimary: string;
  label: string;
  durabilityScore: number | null;
  averageLifespanDays: number | null;
  observedCount: number;
  reason: string;
  source: 'observed' | 'dictionary';
}

export interface StitchSuggestion {
  stitchCode: string;
  label: string;
  averageLifespanDays: number | null;
  observedCount: number;
  reason: string;
  source: 'observed' | 'dictionary';
  kind: 'recommend' | 'avoid';
}

export interface DurabilityConclusion {
  key: string;
  materialPrimary: string;
  materialLabel: string;
  season: Season;
  seasonLabel: string;
  band: WearFrequencyBand;
  bandLabel: string;
  knitOrWoven: string | null;
  cell: DurabilityCell;
  materialAlternatives: MaterialAlternative[];
  stitchSuggestions: StitchSuggestion[];
  preventionAdvice: string[];
  summary: string;
  sampleSize: number;
  confident: boolean;
}

export interface DurabilityMatrixResult {
  cells: DurabilityCell[];
  worst: DurabilityConclusion | null;
  /** 主结论 + 右删失/样本不足等补充说明，全部带样本量 */
  insights: Insight[];
}

const MIN_CROSS_SAMPLES = 3;

export interface DictionaryData {
  materials: Map<string, { durabilityScore: number; typicalWeakPoints: string[] }>;
  stitches: Array<{
    code: string;
    suitableFabrics: string[];
    suitableDamageTypes: string[];
    difficulty: string;
  }>;
  damageTypes: Map<string, { suggestedStitchCodes: string[] }>;
  /** 破损类型表 ID → code（破损事件存的是 ID） */
  damageTypeCodeById: Map<string, string>;
  /** 部位表 ID → code */
  partCodeById: Map<string, string>;
  partNameByCode: Map<string, string>;
}

async function loadDictionary(): Promise<DictionaryData> {
  const [materials, stitches, damageTypes, parts] = await Promise.all([
    prisma.material.findMany(),
    prisma.stitch.findMany(),
    prisma.damageType.findMany(),
    prisma.part.findMany(),
  ]);
  return {
    materials: new Map(
      materials.map((m) => [
        m.code,
        {
          durabilityScore: m.durabilityScore,
          typicalWeakPoints: Array.isArray(m.typicalWeakPoints) ? (m.typicalWeakPoints as string[]) : [],
        },
      ]),
    ),
    stitches: stitches.map((s) => ({
      code: s.code,
      suitableFabrics: Array.isArray(s.suitableFabrics) ? (s.suitableFabrics as string[]) : [],
      suitableDamageTypes: Array.isArray(s.suitableDamageTypes) ? (s.suitableDamageTypes as string[]) : [],
      difficulty: s.difficulty,
    })),
    damageTypes: new Map(
      damageTypes.map((d) => [
        d.code,
        { suggestedStitchCodes: Array.isArray(d.suggestedStitchCodes) ? (d.suggestedStitchCodes as string[]) : [] },
      ]),
    ),
    damageTypeCodeById: new Map(damageTypes.map((d) => [d.id, d.code])),
    partCodeById: new Map(parts.map((p) => [p.id, p.code])),
    partNameByCode: new Map(parts.map((p) => [p.code, p.name])),
  };
}

export async function durabilityMatrix(wardrobeId: string, today = new Date()): Promise<DurabilityMatrixResult> {
  const [dataset, dict] = await Promise.all([loadDataset(wardrobeId, { includeRetired: true }), loadDictionary()]);
  const stats = computeAllGarmentStats(dataset, today);
  return aggregateDurabilityMatrix(dataset, stats, dict, today);
}

export function aggregateDurabilityMatrix(
  dataset: Dataset,
  stats: Map<string, GarmentStats>,
  dict: DictionaryData,
  today = new Date(),
): DurabilityMatrixResult {
  const garmentById = new Map(dataset.garments.map((g) => [g.id, g]));

  interface Acc {
    garmentIds: Set<string>;
    samples: RepairLifespanSample[];
    damages: typeof dataset.damages;
    wearCount: number;
    knitVotes: Record<string, number>;
  }
  const groups = new Map<string, Acc>();
  const groupKey = (material: string, season: string, band: string) => `${material}|${season}|${band}`;

  const bump = (material: string, season: Season, band: WearFrequencyBand): Acc => {
    const key = groupKey(material, season, band);
    const acc = groups.get(key) ?? {
      garmentIds: new Set<string>(),
      samples: [],
      damages: [],
      wearCount: 0,
      knitVotes: {},
    };
    groups.set(key, acc);
    return acc;
  };

  // 以破损事件为单位落格：材质 + 发现季节 + 衣物频率档
  for (const damage of dataset.damages) {
    if (damage.status === 'cancelled') continue;
    const garment = garmentById.get(damage.garmentId);
    if (!garment) continue;
    const garmentStats = stats.get(garment.id);
    if (!garmentStats) continue;
    const season = seasonOfMonth(damage.detectedAt.getUTCMonth() + 1);
    const acc = bump(garment.materialPrimary, season, garmentStats.frequencyBand);
    acc.garmentIds.add(garment.id);
    acc.damages.push(damage);
    acc.knitVotes[garment.knitOrWoven] = (acc.knitVotes[garment.knitOrWoven] ?? 0) + 1;
  }

  // 修补寿命样本按同样的口径落格（与上面的破损集合天然同格）
  for (const garmentStats of stats.values()) {
    const garment = garmentById.get(garmentStats.garmentId);
    if (!garment) continue;
    for (const sample of garmentStats.lifespanSamples) {
      const season = seasonOfMonth(sample.detectedAt.getUTCMonth() + 1);
      const acc = bump(sample.materialPrimary, season, garmentStats.frequencyBand);
      acc.garmentIds.add(sample.garmentId);
      acc.samples.push(sample);
    }
  }

  // 穿着次数：按穿着记录自带的 season_snapshot 归季（四季款也按实际穿着日期落季）
  for (const garment of dataset.garments) {
    const garmentStats = stats.get(garment.id);
    if (!garmentStats) continue;
    for (const [season, count] of Object.entries(garmentStats.seasonWearCounts)) {
      if (season === 'all') continue;
      const acc = bump(garment.materialPrimary, season as Season, garmentStats.frequencyBand);
      acc.wearCount += count;
      acc.garmentIds.add(garment.id);
    }
  }

  const cells: DurabilityCell[] = [];
  for (const [key, acc] of groups) {
    const [materialPrimary, season, band] = key.split('|') as [string, Season, WearFrequencyBand];
    const lifespan = summarizeLifespans(acc.samples);
    const observedSamples = acc.samples.filter((s) => !s.censored);
    const recurrenceCount = acc.damages.filter((d) => !!d.recurrenceOf).length;
    // 已修补破损事件数（与 stats.ts 复修率口径一致：去重 damageEventId）
    const repairedEventIds = new Set<string>();
    for (const damage of acc.damages) {
      if (dataset.repairs.some((r) => r.damageEventId === damage.id && r.status !== 'superseded')) {
        repairedEventIds.add(damage.id);
      }
    }
    const repairedEvents = repairedEventIds.size;
    const knitOrWoven = topEntry(acc.knitVotes)?.[0] ?? null;
    cells.push({
      materialPrimary,
      season,
      band,
      garmentCount: acc.garmentIds.size,
      damageCount: acc.damages.length,
      repairCount: acc.samples.length,
      recurrenceCount,
      recurrenceRate: repairedEvents > 0 ? round4(recurrenceCount / repairedEvents) : null,
      wearCount: acc.wearCount,
      wearsPerDamage: acc.damages.length > 0 ? round2(acc.wearCount / acc.damages.length) : null,
      averageLifespanDays: lifespan.averageDays,
      observedCount: lifespan.observedCount,
      censoredCount: lifespan.censoredCount,
      averageLifespanWears:
        observedSamples.length > 0
          ? round2(observedSamples.reduce((sum, s) => sum + (s.wears ?? 0), 0) / observedSamples.length)
          : null,
      topDamageTypes: topN(
        countOf(acc.damages.map((d) => dict.damageTypeCodeById.get(d.damageTypeId) ?? d.damageTypeId)),
        3,
      ),
      topParts: topN(
        countOf(acc.damages.map((d) => (d.partId ? dict.partCodeById.get(d.partId) ?? d.partId : null))),
        3,
      ),
      knitOrWoven,
    });
  }

  const insights: Insight[] = [];
  const worst = pickWorstCell(cells);
  if (!worst) {
    insights.push(insight('还没有破损与修补记录，无法做交叉结论；登记第一次破损并完成一次复检后，这里会给出最不耐用组合。', 0));
    return { cells: sortCells(cells), worst: null, insights };
  }

  const conclusion = buildConclusion(worst, cells, stats, dict);
  insights.push(insight(conclusion.summary, conclusion.sampleSize));

  const censoredTotal = cells.reduce((sum, c) => sum + c.censoredCount, 0);
  if (censoredTotal > 0) {
    insights.push(
      insight(
        `交叉表中另有 ${censoredTotal} 次修补尚未复发（右删失），只记为"至少撑了这么久"，不参与最差排名。`,
        censoredTotal,
      ),
    );
  }
  if (conclusion.cell.observedCount < MIN_CROSS_SAMPLES) {
    insights.push(
      insight(
        `该组合只有 ${conclusion.cell.observedCount} 个复发样本（建议 ≥ ${MIN_CROSS_SAMPLES}），结论已结合材质/针法字典基线，仍建议继续积累数据。`,
        Math.max(conclusion.cell.observedCount, 1),
      ),
    );
  }
  return { cells: sortCells(cells), worst: conclusion, insights };
}

/**
 * 最差组合排名：
 * 1) 只在"观测到复发"的格里比（右删失说明还没坏，不该被判成最差）；
 * 2) 主指标平均修补寿命（天）升序，寿命相近时复发率高、破损密度大的优先；
 * 3) 全都没有复发样本时，退化为按「每多少穿一次破损」排名，并标记低置信。
 */
function pickWorstCell(cells: DurabilityCell[]): DurabilityCell | null {
  const observed = cells.filter((c) => c.observedCount > 0);
  if (observed.length > 0) {
    return [...observed].sort((a, b) => {
      const life = (a.averageLifespanDays ?? 0) - (b.averageLifespanDays ?? 0);
      if (Math.abs(life) >= 7) return life; // 相差不到一周视为持平，继续比下一项
      const rec = (b.recurrenceRate ?? 0) - (a.recurrenceRate ?? 0);
      if (Math.abs(rec) >= 0.05) return rec;
      const density = (a.wearsPerDamage ?? Infinity) - (b.wearsPerDamage ?? Infinity);
      if (density !== 0) return density;
      return b.damageCount - a.damageCount;
    })[0];
  }
  const withDamage = cells.filter((c) => c.wearsPerDamage !== null && c.damageCount > 0);
  if (withDamage.length > 0) {
    return [...withDamage].sort(
      (a, b) => (a.wearsPerDamage ?? Infinity) - (b.wearsPerDamage ?? Infinity),
    )[0];
  }
  return null;
}

function buildConclusion(
  cell: DurabilityCell,
  cells: DurabilityCell[],
  stats: Map<string, GarmentStats>,
  dict: DictionaryData,
): DurabilityConclusion {
  const materialLabel = labelOfMaterial(cell.materialPrimary);
  const seasonLabel = labelOfSeason(cell.season);
  const bandLabel = WEAR_FREQUENCY_BAND_LABEL[cell.band];

  // —— 选材建议：先看同季同频其他材质的真实寿命，再用材质耐用度字典兜底 ——
  const peers = cells
    .filter((c) => c.season === cell.season && c.band === cell.band && c.materialPrimary !== cell.materialPrimary)
    .sort(
      (a, b) =>
        (b.averageLifespanDays ?? -1) - (a.averageLifespanDays ?? -1) ||
        b.observedCount - a.observedCount,
    );

  const alternatives: MaterialAlternative[] = [];
  const worseLife = cell.averageLifespanDays;
  for (const peer of peers) {
    if (alternatives.length >= 2) break;
    if (peer.observedCount >= 2 && worseLife !== null && (peer.averageLifespanDays ?? 0) > worseLife) {
      alternatives.push({
        materialPrimary: peer.materialPrimary,
        label: labelOfMaterial(peer.materialPrimary),
        durabilityScore: dict.materials.get(peer.materialPrimary)?.durabilityScore ?? null,
        averageLifespanDays: peer.averageLifespanDays,
        observedCount: peer.observedCount,
        reason: `你的档案里，${labelOfSeason(peer.season)}${bandLabel}穿着的${labelOfMaterial(peer.materialPrimary)}平均修补寿命 ${peer.averageLifespanDays} 天，比${materialLabel}的 ${worseLife} 天更长。`,
        source: 'observed',
      });
    }
  }
  if (alternatives.length === 0) {
    const currentScore = dict.materials.get(cell.materialPrimary)?.durabilityScore ?? null;
    const fromDict = [...dict.materials.entries()]
      .filter(([code, m]) => code !== cell.materialPrimary && code !== 'other' && code !== 'blend')
      .filter(([, m]) => currentScore === null || m.durabilityScore > currentScore)
      .sort((a, b) => b[1].durabilityScore - a[1].durabilityScore)
      .slice(0, 2);
    for (const [code, m] of fromDict) {
      alternatives.push({
        materialPrimary: code,
        label: labelOfMaterial(code),
        durabilityScore: m.durabilityScore,
        averageLifespanDays: null,
        observedCount: 0,
        reason: `同季同频还没有可对照的材质；按材质耐用度基线，${labelOfMaterial(code)}评分 ${m.durabilityScore}/5${currentScore !== null ? `，高于${materialLabel}的 ${currentScore}/5` : ''}。`,
        source: 'dictionary',
      });
    }
  }
  const seasonTip = SEASON_MATERIAL_TIP[cell.season];
  if (seasonTip) {
    const already = alternatives.some((a) => a.materialPrimary === seasonTip.material);
    if (!already && alternatives.length < 3) {
      alternatives.push({
        materialPrimary: seasonTip.material,
        label: labelOfMaterial(seasonTip.material),
        durabilityScore: dict.materials.get(seasonTip.material)?.durabilityScore ?? null,
        averageLifespanDays: null,
        observedCount: 0,
        reason: seasonTip.reason,
        source: 'dictionary',
      });
    }
  }

  // —— 针法建议：先看该材质真实复发寿命榜，再按破损类型/布种字典匹配 ——
  const stitchSuggestions = buildStitchSuggestions(cell, stats, dict);

  // —— 预防性加固建议 ——
  const preventionAdvice = buildPreventionAdvice(cell, dict);

  const metrics = [
    cell.averageLifespanDays !== null ? `平均只撑 ${cell.averageLifespanDays} 天` : null,
    cell.recurrenceRate !== null ? `复修率 ${(cell.recurrenceRate * 100).toFixed(0)}%` : null,
    cell.wearsPerDamage !== null ? `每 ${cell.wearsPerDamage} 次穿着出一次破损` : null,
    `共 ${cell.observedCount} 个复发样本`,
  ].filter(Boolean);
  const summary = `最不耐用组合：${seasonLabel} × ${bandLabel}穿着 × ${materialLabel}${cell.knitOrWoven ? `（${KNIT_WOVEN_LABEL[cell.knitOrWoven] ?? cell.knitOrWoven}）` : ''}——${metrics.join('，')}。下一件优先改选${alternatives[0]?.label ?? '更耐磨的材质'}，修补优先用${stitchSuggestions[0]?.label ?? '受力针法'}。`;

  return {
    key: `${cell.materialPrimary}|${cell.season}|${cell.band}`,
    materialPrimary: cell.materialPrimary,
    materialLabel,
    season: cell.season,
    seasonLabel,
    band: cell.band,
    bandLabel,
    knitOrWoven: cell.knitOrWoven,
    cell,
    materialAlternatives: alternatives,
    stitchSuggestions,
    preventionAdvice,
    summary,
    sampleSize: cell.observedCount,
    confident: cell.observedCount >= MIN_CROSS_SAMPLES,
  };
}

function buildStitchSuggestions(
  cell: DurabilityCell,
  stats: Map<string, GarmentStats>,
  dict: DictionaryData,
): StitchSuggestion[] {
  const suggestions: StitchSuggestion[] = [];

  // 数据驱动：同材质的针法寿命榜（观察样本），取比该格平均寿命长的
  const byStitch = new Map<string, RepairLifespanSample[]>();
  for (const s of stats.values()) {
    for (const sample of s.lifespanSamples) {
      if (sample.materialPrimary !== cell.materialPrimary) continue;
      const list = byStitch.get(sample.stitchCode) ?? [];
      list.push(sample);
      byStitch.set(sample.stitchCode, list);
    }
  }
  const ranked = [...byStitch.entries()]
    .map(([code, list]) => ({ code, lifespan: summarizeLifespans(list) }))
    .filter((x) => x.lifespan.observedCount >= 2)
    .sort((a, b) => (b.lifespan.averageDays ?? -1) - (a.lifespan.averageDays ?? -1));
  for (const item of ranked) {
    if (suggestions.length >= 2) break;
    suggestions.push({
      stitchCode: item.code,
      label: labelOfStitch(item.code),
      averageLifespanDays: item.lifespan.averageDays,
      observedCount: item.lifespan.observedCount,
      reason: `你的档案里，${labelOfMaterial(cell.materialPrimary)}用${labelOfStitch(item.code)}平均 ${item.lifespan.averageDays} 天才复发（${item.lifespan.observedCount} 个样本）。`,
      source: 'observed',
      kind: 'recommend',
    });
  }

  if (suggestions.length === 0) {
    // 字典兜底：该格高发破损类型的建议针法 ∩ 布种适配
    const fabricTags = fabricTagsOf(cell.materialPrimary, cell.knitOrWoven);
    const topTypes = cell.topDamageTypes.map((t) => t.key);
    const consider = new Set<string>();
    for (const type of topTypes) {
      for (const code of dict.damageTypes.get(type)?.suggestedStitchCodes ?? []) consider.add(code);
    }
    if (consider.size === 0) {
      for (const stitch of dict.stitches) consider.add(stitch.code);
    }
    const matched = dict.stitches
      .filter((s) => consider.has(s.code))
      .filter((s) => s.suitableFabrics.some((f) => fabricTags.includes(f)))
      .sort(
        (a, b) =>
          stitchDifficultyRank(a.difficulty) - stitchDifficultyRank(b.difficulty) ||
          (b.suitableDamageTypes.filter((t) => topTypes.includes(t)).length -
            a.suitableDamageTypes.filter((t) => topTypes.includes(t)).length),
      );
    for (const stitch of matched.slice(0, 2)) {
      suggestions.push({
        stitchCode: stitch.code,
        label: labelOfStitch(stitch.code),
        averageLifespanDays: null,
        observedCount: 0,
        reason: `尚无同材质针法寿命数据；按针法字典，${labelOfStitch(stitch.code)}适配${fabricTags.map((t) => FABRIC_TAG_LABEL[t] ?? t).join('、')}布与高发破损类型。`,
        source: 'dictionary',
        kind: 'recommend',
      });
    }
  }

  // 通用避坑：熨烫贴合补在高频穿着下不耐用
  if (cell.band === 'high' && !suggestions.some((s) => s.source === 'observed')) {
    suggestions.push({
      stitchCode: 'fusible',
      label: labelOfStitch('fusible'),
      averageLifespanDays: null,
      observedCount: 0,
      reason: '高频穿着场景避免只靠熨烫贴合补：字典标注它最不耐洗，至多作为临时处理，务必叠加缝线固定。',
      source: 'dictionary',
      kind: 'avoid',
    });
  }
  return suggestions.slice(0, 3);
}

function buildPreventionAdvice(cell: DurabilityCell, dict: DictionaryData): string[] {
  const advice: string[] = [];
  const parts = cell.topParts
    .map((p) => (p.key === 'unknown' ? null : dict.partNameByCode.get(p.key) ?? p.key))
    .filter((x): x is string => !!x);
  if (parts.length > 0) {
    advice.push(`优先对${parts.slice(0, 3).join('、')}做预防性加固（贴衬/锁边/加裆），别等破了再补。`);
  }
  const weakPoints = dict.materials.get(cell.materialPrimary)?.typicalWeakPoints ?? [];
  if (weakPoints.length > 0) {
    advice.push(`${labelOfMaterial(cell.materialPrimary)}的典型薄弱部位是${weakPoints.join('、')}，换季检查时重点看。`);
  }
  if (cell.band === 'high') {
    advice.push('高频穿着建议备 2–3 件轮换，减少同一部位连续受力；补丁边缘先锁边再缝，避免洗后继续脱散。');
  }
  if (cell.season === 'summer') {
    advice.push('夏季轻薄面料汗渍与摩擦叠加，洗后避免高温烘干，湿态不要大力拧绞。');
  }
  if (cell.season === 'winter') {
    advice.push('冬季针织/厚料以织补保留弹性为先，补完平铺阴干，悬挂会拉长变形。');
  }
  return advice;
}

const KNIT_WOVEN_LABEL: Record<string, string> = { knit: '针织', woven: '梭织', leather: '皮革' };

const FABRIC_TAG_LABEL: Record<string, string> = {
  woven: '梭织',
  knit: '针织',
  denim: '牛仔',
  leather: '皮革',
  wool: '羊毛类',
  cashmere: '羊绒类',
  jacket: '外套',
};

/** 材质 + 针织/梭织 → 针法字典里的布料标签集合 */
function fabricTagsOf(material: string, knitOrWoven: string | null): string[] {
  if (material === 'denim') return ['denim', 'woven'];
  if (material === 'leather') return ['leather'];
  if (material === 'wool') return ['wool', knitOrWoven === 'woven' ? 'woven' : 'knit'];
  if (material === 'cashmere') return ['cashmere', 'knit'];
  if (knitOrWoven === 'knit') return ['knit'];
  if (knitOrWoven === 'leather') return ['leather'];
  return ['woven'];
}

function stitchDifficultyRank(difficulty: string): number {
  return { easy: 0, medium: 1, hard: 2 }[difficulty] ?? 1;
}

const SEASON_MATERIAL_TIP: Partial<Record<Season, { material: string; reason: string }>> = {
  summer: {
    material: 'cotton',
    reason: '夏季高频穿着场景优先棉或棉混纺，兼顾透气与耐磨；真丝、纯亚麻在高频摩擦下更容易出问题。',
  },
  winter: {
    material: 'wool',
    reason: '冬季外套/针织可考虑羊毛或含化纤的混纺，比纯羊绒耐磨且成本更低；羊绒留给低频场合。',
  },
};

function countOf(values: Array<string | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    if (value === null) continue;
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function topEntry<T>(record: Record<string, T>): [string, T] | null {
  let best: [string, T] | null = null;
  for (const entry of Object.entries(record)) {
    if (!best || (entry[1] as number) > (best[1] as number)) best = entry;
  }
  return best;
}

function sortCells(cells: DurabilityCell[]): DurabilityCell[] {
  const bandOrder: Record<string, number> = { high: 0, medium: 1, low: 2, occasional: 3 };
  return [...cells].sort(
    (a, b) =>
      (a.averageLifespanDays ?? Number.MAX_SAFE_INTEGER) - (b.averageLifespanDays ?? Number.MAX_SAFE_INTEGER) ||
      b.damageCount - a.damageCount ||
      (bandOrder[a.band] ?? 9) - (bandOrder[b.band] ?? 9),
  );
}

export async function healthDistribution(wardrobeId: string, today = new Date()) {
  const dataset = await loadDataset(wardrobeId);
  const stats = computeAllGarmentStats(dataset, today);
  const levels = { good: 0, attention: 0, concern: 0, retire: 0 } as Record<string, number>;
  const items = dataset.garments.map((garment) => {
    const garmentStats = stats.get(garment.id)!;
    const health = computeHealth(garmentStats);
    levels[health.level] += 1;
    return {
      garmentId: garment.id,
      code: garment.code,
      name: garment.name,
      materialPrimary: garment.materialPrimary,
      score: health.score,
      level: health.level,
      advice: health.advice,
      wearCount: garmentStats.wearCount,
      repairCount: garmentStats.repairCount,
      costPerWear: garmentStats.costPerWear,
      frequencyBand: garmentStats.frequencyBand,
      serviceDays: garmentStats.serviceDays,
    };
  });
  items.sort((a, b) => a.score - b.score);
  return { levels, items };
}

export interface GarmentDetailAnalytics {
  stats: GarmentStats;
  health: ReturnType<typeof computeHealth>;
  lifespan: ReturnType<typeof summarizeLifespans>;
}

export async function garmentAnalytics(garmentId: string): Promise<GarmentDetailAnalytics | null> {
  const garment = await prisma.garment.findFirst({ where: { id: garmentId, deletedAt: null } });
  if (!garment) return null;
  const dataset = await loadDataset(garment.wardrobeId, { includeRetired: true });
  const stats = computeAllGarmentStats(dataset);
  const garmentStats = stats.get(garmentId);
  if (!garmentStats) return null;
  return {
    stats: garmentStats,
    health: computeHealth(garmentStats),
    lifespan: summarizeLifespans(garmentStats.lifespanSamples),
  };
}

function mergeCounts(list: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const counts of list) {
    for (const [key, value] of Object.entries(counts)) out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

function topN(counts: Record<string, number>, n: number): Array<{ key: string; count: number }> {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

const MATERIAL_LABELS: Record<string, string> = {
  cotton: '棉', wool: '羊毛', cashmere: '羊绒', linen: '亚麻', silk: '真丝',
  polyester: '涤纶', nylon: '锦纶', denim: '牛仔', leather: '皮革', blend: '混纺', other: '其他',
};

const SEASON_LABELS: Record<string, string> = {
  spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季', all: '四季',
};

const STITCH_LABELS: Record<string, string> = {
  invisible_stitch: '藏针缝', backstitch: '回针缝', running_stitch: '平针缝', overcast: '锁边缝',
  darning_hand: '手工织补', darning_machine: '机器织补', patch_applique: '贴布补丁',
  fusible: '熨烫贴合补', serging: '机器锁边', part_replacement: '换件替换',
};

export function labelOfMaterial(code: string): string {
  return MATERIAL_LABELS[code] ?? code;
}

export function labelOfSeason(code: string): string {
  return SEASON_LABELS[code] ?? code;
}

export function labelOfStitch(code: string): string {
  return STITCH_LABELS[code] ?? code;
}
