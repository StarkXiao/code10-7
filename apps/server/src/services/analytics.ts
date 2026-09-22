/**
 * 长期使用分析（项目文档 13.2 / 13.4）。
 * 三个维度：材质 / 季节 / 穿着频率，外加"针法效果榜"。
 * 所有结论句都带样本量 n；n < 3 时显式提示样本不足。
 */
import {
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

/* -------------------------------------------------------------------------- */
/* 交叉分组：材质 × 季节 × 穿着频率（项目文档 13.2 / 13.4 的强化长期结论）        */
/* -------------------------------------------------------------------------- */

/** 至少 2 次破损才参与"最不耐用"排名，避免单次意外带偏结论 */
const CROSS_MIN_DAMAGE_FOR_RANKING = 2;
/** 材质建议候选至少要有这么多次穿着，否则"没坏过"很可能只是穿得少 */
const CROSS_MIN_WEAR_FOR_CANDIDATE = 8;

export interface CrossCell {
  key: string;
  materialPrimary: string;
  season: Season;
  band: WearFrequencyBand;
  garmentCount: number;
  wearCount: number;
  damageCount: number;
  recurrenceCount: number;
  /** 每 N 次穿着出现一次破损，越小越不耐用；0 破损时为 null */
  wearCountPerDamage: number | null;
  averageLifespanDays: number | null;
  observedLifespanCount: number;
  censoredLifespanCount: number;
  topDamageTypes: Array<{ key: string; count: number }>;
}

export interface CrossDictionary {
  stitches: Array<{ id: string; code: string; name: string }>;
  damageTypes: Array<{ id: string; code: string; suggestedStitchCodes: string[] }>;
  materials: Array<{ code: string; durabilityScore: number }>;
}

export interface MaterialAdvice {
  current: string;
  suggested: string;
  scope: 'same_season_band' | 'same_season' | 'global' | 'dictionary';
  wearCount: number;
  damageCount: number;
  wearCountPerDamage: number | null;
  sampleSize: number;
  text: string;
}

export interface StitchAdvice {
  stitchCode: string;
  stitchName: string;
  materialPrimary: string;
  source: 'observed' | 'observed_global' | 'dictionary';
  averageLifespanDays: number | null;
  sampleSize: number;
  text: string;
}

export interface CrossDurabilityResult {
  cells: CrossCell[];
  worst: CrossCell | null;
  best: CrossCell | null;
  materialAdvice: MaterialAdvice | null;
  stitchAdvice: StitchAdvice | null;
  insights: Insight[];
}

export async function crossDurability(wardrobeId: string, today = new Date()): Promise<CrossDurabilityResult> {
  // 含已退役衣物：退役件往往正是"不耐用"的证据，排除它们会系统性高估耐用性（幸存者偏差）
  const dataset = await loadDataset(wardrobeId, { includeRetired: true });
  const stats = computeAllGarmentStats(dataset, today);
  const [stitches, damageTypes, materials] = await Promise.all([
    prisma.stitch.findMany({ select: { id: true, code: true, name: true } }),
    prisma.damageType.findMany({ select: { id: true, code: true, suggestedStitchCodes: true } }),
    prisma.material.findMany({ select: { code: true, durabilityScore: true } }),
  ]);
  return aggregateCrossDurability(dataset, stats, {
    stitches,
    damageTypes: damageTypes.map((d) => ({
      id: d.id,
      code: d.code,
      suggestedStitchCodes: Array.isArray(d.suggestedStitchCodes) ? (d.suggestedStitchCodes as string[]) : [],
    })),
    materials,
  });
}

/**
 * 交叉分组的纯函数实现（单测直接覆盖）。
 * 季节归属口径：穿着用 seasonSnapshot，破损用发现月份，寿命样本用修补完成月份。
 */
export function aggregateCrossDurability(
  dataset: Dataset,
  stats: Map<string, GarmentStats>,
  dict: CrossDictionary,
): CrossDurabilityResult {
  interface Acc {
    materialPrimary: string;
    season: Season;
    band: WearFrequencyBand;
    garmentIds: Set<string>;
    wearCount: number;
    damageCount: number;
    recurrenceCount: number;
    lifespanSamples: RepairLifespanSample[];
    damageTypeCounts: Record<string, number>;
  }
  const cells = new Map<string, Acc>();
  const garmentById = new Map(dataset.garments.map((g) => [g.id, g]));
  const bandOf = (garmentId: string): WearFrequencyBand =>
    stats.get(garmentId)?.frequencyBand ?? 'occasional';
  const cellOf = (materialPrimary: string, season: Season, band: WearFrequencyBand): Acc => {
    const key = `${materialPrimary}|${season}|${band}`;
    let acc = cells.get(key);
    if (!acc) {
      acc = {
        materialPrimary,
        season,
        band,
        garmentIds: new Set(),
        wearCount: 0,
        damageCount: 0,
        recurrenceCount: 0,
        lifespanSamples: [],
        damageTypeCounts: {},
      };
      cells.set(key, acc);
    }
    return acc;
  };

  for (const wear of dataset.wears) {
    const garment = garmentById.get(wear.garmentId);
    if (!garment) continue;
    const acc = cellOf(garment.materialPrimary, wear.seasonSnapshot as Season, bandOf(wear.garmentId));
    acc.wearCount += 1;
    acc.garmentIds.add(wear.garmentId);
  }
  const damageTypeById = new Map(dict.damageTypes.map((d) => [d.id, d]));
  for (const damage of dataset.damages) {
    const garment = garmentById.get(damage.garmentId);
    if (!garment) continue;
    const acc = cellOf(
      garment.materialPrimary,
      seasonOfMonth(damage.detectedAt.getUTCMonth() + 1),
      bandOf(damage.garmentId),
    );
    acc.damageCount += 1;
    if (damage.recurrenceOf) acc.recurrenceCount += 1;
    acc.garmentIds.add(damage.garmentId);
    const typeCode = damageTypeById.get(damage.damageTypeId)?.code ?? damage.damageTypeId;
    acc.damageTypeCounts[typeCode] = (acc.damageTypeCounts[typeCode] ?? 0) + 1;
  }
  for (const garmentStats of stats.values()) {
    for (const sample of garmentStats.lifespanSamples) {
      const acc = cellOf(
        sample.materialPrimary,
        seasonOfMonth(sample.finishedAt.getUTCMonth() + 1),
        garmentStats.frequencyBand,
      );
      acc.lifespanSamples.push(sample);
    }
  }

  const rows: CrossCell[] = [...cells.values()].map((acc) => {
    const lifespan = summarizeLifespans(acc.lifespanSamples);
    return {
      key: `${acc.materialPrimary}|${acc.season}|${acc.band}`,
      materialPrimary: acc.materialPrimary,
      season: acc.season,
      band: acc.band,
      garmentCount: acc.garmentIds.size,
      wearCount: acc.wearCount,
      damageCount: acc.damageCount,
      recurrenceCount: acc.recurrenceCount,
      wearCountPerDamage: acc.damageCount > 0 ? round2(acc.wearCount / acc.damageCount) : null,
      averageLifespanDays: lifespan.averageDays,
      observedLifespanCount: lifespan.observedCount,
      censoredLifespanCount: lifespan.censoredCount,
      topDamageTypes: topN(acc.damageTypeCounts, 2),
    };
  });
  /** 耐用性：每 N 次穿着出现一次破损；0 破损视为无穷大（最耐用） */
  const durabilityOf = (row: Pick<CrossCell, 'damageCount' | 'wearCount'>) =>
    row.damageCount === 0 ? Number.POSITIVE_INFINITY : row.wearCount / row.damageCount;
  rows.sort((a, b) => durabilityOf(a) - durabilityOf(b) || b.damageCount - a.damageCount);

  const worst =
    rows.filter((r) => r.damageCount >= CROSS_MIN_DAMAGE_FOR_RANKING)[0] ??
    rows.find((r) => r.damageCount >= 1) ??
    null;
  const best =
    rows
      .filter((r) => r.key !== worst?.key && r.wearCount >= CROSS_MIN_WEAR_FOR_CANDIDATE)
      .sort((a, b) => durabilityOf(b) - durabilityOf(a))[0] ?? null;

  const materialAdvice = worst ? suggestMaterial(rows, worst, dict) : null;
  const stitchAdvice = worst
    ? suggestStitch(worst, [...stats.values()].flatMap((s) => s.lifespanSamples), dict)
    : null;

  const insights: Insight[] = [];
  if (!worst) {
    insights.push(insight('还没有破损记录。第一次破损后，这里会按「材质 × 季节 × 穿着频率」指出最不耐用组合。', 0));
  } else {
    insights.push(
      insight(
        `最不耐用组合是「${labelOfMaterial(worst.materialPrimary)} × ${labelOfSeason(worst.season)} × ${labelOfBand(worst.band)}」：${worst.wearCount} 次穿着出现 ${worst.damageCount} 次破损，平均每 ${worst.wearCountPerDamage} 次穿着就坏一次。`,
        worst.damageCount,
      ),
    );
    if (best) {
      insights.push(
        insight(
          best.damageCount === 0
            ? `最耐用组合是「${labelOfMaterial(best.materialPrimary)} × ${labelOfSeason(best.season)} × ${labelOfBand(best.band)}」：${best.wearCount} 次穿着零破损。`
            : `最耐用组合是「${labelOfMaterial(best.materialPrimary)} × ${labelOfSeason(best.season)} × ${labelOfBand(best.band)}」：平均每 ${best.wearCountPerDamage} 次穿着才坏一次。`,
          best.damageCount > 0 ? best.damageCount : best.wearCount,
        ),
      );
    }
  }
  const totalCensored = rows.reduce((sum, r) => sum + r.censoredLifespanCount, 0);
  if (totalCensored > 0) {
    insights.push(
      insight(`另有 ${totalCensored} 次修补至今未复发（右删失），不计入平均寿命，只记为"至少撑了这么久"。`, totalCensored),
    );
  }

  return { cells: rows, worst, best, materialAdvice, stitchAdvice, insights };
}

/**
 * 选材建议：优先在与最差组合相同的「季节 × 频率」场景内找更耐用的材质；
 * 同场景没有可对比数据时逐级放宽（同季节 → 全年），每级放宽都在文案里说明；
 * 衣橱数据完全不够时退回材质字典的通用耐用度。
 */
function suggestMaterial(rows: CrossCell[], worst: CrossCell, dict: CrossDictionary): MaterialAdvice | null {
  const durability = (damageCount: number, wearCount: number) =>
    damageCount === 0 ? Number.POSITIVE_INFINITY : wearCount / damageCount;
  // 同一材质在同一范围内可能拆成多格（不同季节/频率），先按材质合并再比较
  const aggregate = (pred: (row: CrossCell) => boolean) => {
    const merged = new Map<string, { wearCount: number; damageCount: number }>();
    for (const row of rows) {
      if (row.materialPrimary === worst.materialPrimary || !pred(row)) continue;
      const agg = merged.get(row.materialPrimary) ?? { wearCount: 0, damageCount: 0 };
      agg.wearCount += row.wearCount;
      agg.damageCount += row.damageCount;
      merged.set(row.materialPrimary, agg);
    }
    return [...merged.entries()]
      .map(([materialPrimary, agg]) => ({ materialPrimary, ...agg }))
      .filter((r) => r.wearCount >= CROSS_MIN_WEAR_FOR_CANDIDATE)
      .sort((a, b) => durability(b.damageCount, b.wearCount) - durability(a.damageCount, a.wearCount));
  };
  const performance = (wearCount: number, damageCount: number) =>
    damageCount === 0
      ? `${wearCount} 次穿着零破损`
      : `平均每 ${round2(wearCount / damageCount)} 次穿着才坏一次（${wearCount} 穿 ${damageCount} 坏）`;
  const scopes: Array<{
    scope: MaterialAdvice['scope'];
    pred: (row: CrossCell) => boolean;
    lead: (material: string) => string;
  }> = [
    {
      scope: 'same_season_band',
      pred: (r) => r.season === worst.season && r.band === worst.band,
      lead: (m) =>
        `下次选材优先考虑「${m}」替代「${labelOfMaterial(worst.materialPrimary)}」：同为${labelOfSeason(worst.season)}、${labelOfBand(worst.band)}穿着，`,
    },
    {
      scope: 'same_season',
      pred: (r) => r.season === worst.season,
      lead: (m) =>
        `同场景没有可对比的材质；放宽到${labelOfSeason(worst.season)}全季，下次可优先考虑「${m}」替代「${labelOfMaterial(worst.materialPrimary)}」：`,
    },
    {
      scope: 'global',
      pred: () => true,
      lead: (m) =>
        `同季节也没有可对比的材质；放宽到全年所有场景，下次可优先考虑「${m}」替代「${labelOfMaterial(worst.materialPrimary)}」：`,
    },
  ];
  for (const { scope, pred, lead } of scopes) {
    const top = aggregate(pred)[0];
    if (!top) continue;
    return {
      current: worst.materialPrimary,
      suggested: top.materialPrimary,
      scope,
      wearCount: top.wearCount,
      damageCount: top.damageCount,
      wearCountPerDamage: top.damageCount > 0 ? round2(top.wearCount / top.damageCount) : null,
      sampleSize: top.wearCount,
      text: `${lead(labelOfMaterial(top.materialPrimary))}${performance(top.wearCount, top.damageCount)}。`,
    };
  }
  const fallback = [...dict.materials]
    .filter((m) => m.code !== worst.materialPrimary)
    .sort((a, b) => b.durabilityScore - a.durabilityScore)[0];
  if (!fallback) return null;
  return {
    current: worst.materialPrimary,
    suggested: fallback.code,
    scope: 'dictionary',
    wearCount: 0,
    damageCount: 0,
    wearCountPerDamage: null,
    sampleSize: 0,
    text: `衣橱里还没有可对比的穿着数据；按材质通用耐用度，下次可优先考虑「${labelOfMaterial(fallback.code)}」（耐用度 ${fallback.durabilityScore}/5）。`,
  };
}

/**
 * 针法建议：先用该材质上真实复发数据里平均寿命最长的针法；
 * 该材质没数据时用全衣橱表现最好的针法；完全没有复发样本时
 * 退回字典——按最差组合最高发破损类型的推荐针法。
 */
function suggestStitch(
  worst: CrossCell,
  allSamples: RepairLifespanSample[],
  dict: CrossDictionary,
): StitchAdvice | null {
  const stitchById = new Map(dict.stitches.map((s) => [s.id, s]));
  const stitchByCode = new Map(dict.stitches.map((s) => [s.code, s]));
  // 注意：寿命样本的 stitchCode 字段存的是 stitch.id（见 stats.ts）
  const rank = (samples: RepairLifespanSample[]) => {
    const groups = new Map<string, RepairLifespanSample[]>();
    for (const sample of samples) {
      const list = groups.get(sample.stitchCode) ?? [];
      list.push(sample);
      groups.set(sample.stitchCode, list);
    }
    return [...groups.entries()]
      .map(([stitchId, list]) => ({ stitchId, ...summarizeLifespans(list) }))
      .filter((r) => r.observedCount > 0 && r.averageDays !== null)
      .sort((a, b) => b.averageDays! - a.averageDays!);
  };

  const own = rank(allSamples.filter((s) => s.materialPrimary === worst.materialPrimary))[0];
  if (own) {
    const stitch = stitchById.get(own.stitchId);
    return {
      stitchCode: stitch?.code ?? own.stitchId,
      stitchName: stitch?.name ?? own.stitchId,
      materialPrimary: worst.materialPrimary,
      source: 'observed',
      averageLifespanDays: own.averageDays,
      sampleSize: own.observedCount,
      text: `修「${labelOfMaterial(worst.materialPrimary)}」优先用「${stitch?.name ?? own.stitchId}」：你的记录里它平均撑了 ${own.averageDays} 天才复发（n=${own.observedCount}）。`,
    };
  }
  const global = rank(allSamples).find((r) => r.observedCount >= 2);
  if (global) {
    const stitch = stitchById.get(global.stitchId);
    return {
      stitchCode: stitch?.code ?? global.stitchId,
      stitchName: stitch?.name ?? global.stitchId,
      materialPrimary: worst.materialPrimary,
      source: 'observed_global',
      averageLifespanDays: global.averageDays,
      sampleSize: global.observedCount,
      text: `「${labelOfMaterial(worst.materialPrimary)}」还没有针法寿命记录；全部材质里「${stitch?.name ?? global.stitchId}」表现最好（平均 ${global.averageDays} 天，n=${global.observedCount}），可以先试。`,
    };
  }
  const topType = worst.topDamageTypes[0]?.key;
  const damageType = dict.damageTypes.find((d) => d.code === topType);
  const stitch = damageType ? stitchByCode.get(damageType.suggestedStitchCodes[0]) : undefined;
  if (!stitch) return null;
  return {
    stitchCode: stitch.code,
    stitchName: stitch.name,
    materialPrimary: worst.materialPrimary,
    source: 'dictionary',
    averageLifespanDays: null,
    sampleSize: 0,
    text: `还没有复发数据可比。按字典建议，「${labelOfMaterial(worst.materialPrimary)}」的「${labelOfDamageType(topType ?? '')}」优先用「${stitch.name}」；补完按时复检，下次这里就有自己的数据了。`,
  };
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

const BAND_LABELS: Record<string, string> = {
  high: '高频', medium: '中频', low: '低频', occasional: '偶发',
};

const DAMAGE_TYPE_LABELS: Record<string, string> = {
  hole: '破洞', seam_open: '开线', thinning: '磨薄', tear: '撕裂', zipper: '拉链损坏',
  button: '纽扣脱落', stain: '染色', shrink_deform: '缩水变形', pilling: '起球',
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

export function labelOfBand(code: string): string {
  return BAND_LABELS[code] ?? code;
}

export function labelOfDamageType(code: string): string {
  return DAMAGE_TYPE_LABELS[code] ?? code;
}
