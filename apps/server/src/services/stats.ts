/**
 * 统计口径实现（对应项目文档 13 章）。
 *
 * 设计：把数据一次取出来，用纯函数算指标 —— 这样 13.1 的公式能被单测直接验证，
 * 也保证"接口返回的数"和"报告页显示的数"来自同一段代码。
 */
import {
  DAMAGE_TERMINAL_STATUSES,
  costPerWear,
  daysBetween,
  frequencyBand,
  healthScore,
  num,
  recurrenceRate,
  repairLifespan,
  serviceDays,
  summarizeLifespans,
  wearFrequencyPerMonth,
  weightedWearCount,
  type DamageStatus,
  type HealthScoreResult,
  type LifespanResult,
  type WearFrequencyBand,
  type WearSession,
} from '@gml/shared';
import { prisma } from '../lib/prisma.js';

export interface Dataset {
  garments: GarmentRow[];
  damages: DamageRow[];
  repairs: RepairRow[];
  reviews: ReviewRow[];
  wears: WearRow[];
  careRules: Map<string, { wearCountBeforeWash: number; checkIntervalDays: number }>;
}

type GarmentRow = Awaited<ReturnType<typeof prisma.garment.findFirstOrThrow>>;
type DamageRow = Awaited<ReturnType<typeof prisma.damageEvent.findFirstOrThrow>>;
type RepairRow = Awaited<ReturnType<typeof prisma.repair.findFirstOrThrow>>;
type ReviewRow = Awaited<ReturnType<typeof prisma.reviewResult.findFirstOrThrow>>;
type WearRow = Awaited<ReturnType<typeof prisma.wearLog.findFirstOrThrow>>;

export async function loadDataset(
  wardrobeId: string,
  options: { includeRetired?: boolean } = {},
): Promise<Dataset> {
  const garments = await prisma.garment.findMany({
    where: {
      wardrobeId,
      deletedAt: null,
      ...(options.includeRetired ? {} : { status: { not: 'retired' } }),
    },
    orderBy: { createdAt: 'asc' },
  });
  const garmentIds = garments.map((g) => g.id);

  const [damages, repairs, reviews, wears, careRules] = await Promise.all([
    garmentIds.length
      ? prisma.damageEvent.findMany({ where: { garmentId: { in: garmentIds } }, orderBy: { detectedAt: 'asc' } })
      : Promise.resolve([] as DamageRow[]),
    garmentIds.length
      ? prisma.repair.findMany({
          where: { damageEvent: { garmentId: { in: garmentIds } } },
          orderBy: { finishedAt: 'asc' },
        })
      : Promise.resolve([] as RepairRow[]),
    garmentIds.length
      ? prisma.reviewResult.findMany({
          where: { repair: { damageEvent: { garmentId: { in: garmentIds } } } },
          orderBy: { reviewedAt: 'asc' },
        })
      : Promise.resolve([] as ReviewRow[]),
    garmentIds.length
      ? prisma.wearLog.findMany({ where: { garmentId: { in: garmentIds } }, orderBy: { wornOn: 'asc' } })
      : Promise.resolve([] as WearRow[]),
    prisma.careRule.findMany(),
  ]);

  return {
    garments,
    damages,
    repairs,
    reviews,
    wears,
    careRules: new Map(
      careRules.map((r) => [
        r.materialCode,
        { wearCountBeforeWash: r.wearCountBeforeWash, checkIntervalDays: r.checkIntervalDays },
      ]),
    ),
  };
}

export interface RepairLifespanSample extends LifespanResult {
  repairId: string;
  garmentId: string;
  materialPrimary: string;
  knitOrWoven: string;
  stitchCode: string;
  finishedAt: Date;
  /** 被补破损的发现时间（交叉分组的"季节"口径取这个月份） */
  detectedAt: Date;
  damageTypeId: string;
  partId: string | null;
}

export interface GarmentStats {
  garmentId: string;
  wearCount: number;
  weightedWearCount: number;
  wearCountLast30: number;
  wearCountLast90: number;
  perMonth: number;
  frequencyBand: WearFrequencyBand;
  serviceDays: number;
  firstWearDate: Date | null;
  lastWornOn: Date | null;
  openDamageCount: number;
  damageCount: number;
  repairCount: number;
  recurrenceCount: number;
  repairedEventCount: number;
  recurrenceRate: number;
  totalRepairCost: number;
  totalMaterialCost: number;
  purchasePrice: number;
  costPerWear: number | null;
  lifespanSamples: RepairLifespanSample[];
  seasonWearCounts: Record<string, number>;
  partDamageCounts: Record<string, number>;
  typeDamageCounts: Record<string, number>;
}

/** 逐件衣物指标：所有函数都是纯计算，便于单测复算 */
export function computeGarmentStats(dataset: Dataset, garmentId: string, today = new Date()): GarmentStats {
  const garment = dataset.garments.find((g) => g.id === garmentId);
  if (!garment) throw new Error(`garment ${garmentId} not in dataset`);

  const damages = dataset.damages.filter((d) => d.garmentId === garmentId);
  const damageIds = new Set(damages.map((d) => d.id));
  const repairs = dataset.repairs.filter((r) => damageIds.has(r.damageEventId));
  const repairIds = new Set(repairs.map((r) => r.id));
  const reviews = dataset.reviews.filter((r) => repairIds.has(r.repairId));
  const wears = dataset.wears.filter((w) => w.garmentId === garmentId);

  const wearCount = wears.length;
  const perMonth = wearFrequencyPerMonth(wearCount, garment.firstWearDate, today);

  const openDamageCount = damages.filter((d) => !DAMAGE_TERMINAL_STATUSES.includes(d.status as DamageStatus)).length;
  const activeRepairs = repairs.filter((r) => r.status !== 'superseded');
  const recurrenceCount = damages.filter((d) => !!d.recurrenceOf).length;
  const repairedEventCount = new Set(repairs.map((r) => r.damageEventId)).size;

  const totalRepairCost = activeRepairs.reduce(
    (sum, r) => sum + num(r.cost?.toString()) + num(r.shopCost?.toString()),
    0,
  );

  const lifespanSamples: RepairLifespanSample[] = [];
  for (const repair of activeRepairs) {
    const damage = damages.find((d) => d.id === repair.damageEventId);
    if (!damage) continue;
    const nextRecurrence = damages
      .filter(
        (d) =>
          d.recurrenceOf === damage.id &&
          d.detectedAt.getTime() > repair.finishedAt.getTime(),
      )
      .sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime())[0];
    const wearsInRange = wears.filter(
      (w) =>
        w.wornOn.getTime() >= repair.finishedAt.getTime() &&
        w.wornOn.getTime() <= (nextRecurrence?.detectedAt ?? today).getTime(),
    ).length;
    const lifespan = repairLifespan({
      finishedAt: repair.finishedAt,
      nextDamageDetectedAt: nextRecurrence?.detectedAt ?? null,
      wearsInRange,
      today,
    });
    lifespanSamples.push({
      ...lifespan,
      repairId: repair.id,
      garmentId,
      materialPrimary: garment.materialPrimary,
      knitOrWoven: garment.knitOrWoven,
      stitchCode: repair.stitchId,
      finishedAt: repair.finishedAt,
      detectedAt: damage.detectedAt,
      damageTypeId: damage.damageTypeId,
      partId: damage.partId,
    });
  }

  const last30 = new Date(today.getTime() - 30 * 86_400_000);
  const last90 = new Date(today.getTime() - 90 * 86_400_000);

  return {
    garmentId,
    wearCount,
    weightedWearCount: weightedWearCount(wears as Array<{ session: WearSession }>),
    wearCountLast30: wears.filter((w) => w.wornOn >= last30).length,
    wearCountLast90: wears.filter((w) => w.wornOn >= last90).length,
    perMonth,
    frequencyBand: frequencyBand(perMonth),
    serviceDays: serviceDays(garment.firstWearDate, today),
    firstWearDate: garment.firstWearDate,
    lastWornOn: wears.length ? wears[wears.length - 1].wornOn : null,
    openDamageCount,
    damageCount: damages.length,
    repairCount: activeRepairs.length,
    recurrenceCount,
    repairedEventCount,
    recurrenceRate: recurrenceRate(recurrenceCount, repairedEventCount),
    totalRepairCost: round2(totalRepairCost),
    totalMaterialCost: 0,
    purchasePrice: num(garment.purchasePrice?.toString()),
    costPerWear: costPerWear({
      purchasePrice: num(garment.purchasePrice?.toString()),
      repairCost: totalRepairCost,
      materialCost: 0,
      residualValue: 0,
      wearCount,
    }),
    lifespanSamples,
    seasonWearCounts: countBy(wears.map((w) => w.seasonSnapshot)),
    partDamageCounts: countBy(damages.map((d) => d.partId ?? 'unknown')),
    typeDamageCounts: countBy(damages.map((d) => d.damageTypeId)),
  };
}

export function computeAllGarmentStats(dataset: Dataset, today = new Date()): Map<string, GarmentStats> {
  const map = new Map<string, GarmentStats>();
  for (const garment of dataset.garments) {
    map.set(garment.id, computeGarmentStats(dataset, garment.id, today));
  }
  return map;
}

export interface WardrobeOverview {
  garmentCount: number;
  activeCount: number;
  needsRepairCount: number;
  inRepairCount: number;
  observingCount: number;
  retiredCount: number;
  totalWearCount: number;
  totalRepairCount: number;
  recurrenceRate: number;
  averageLifespanDays: number | null;
  censoredLifespanCount: number;
  totalCost: number;
  lifetimeCostPerWear: number | null;
}

export function computeOverview(dataset: Dataset, today = new Date()): WardrobeOverview {
  const stats = computeAllGarmentStats(dataset, today);
  const allSamples = [...stats.values()].flatMap((s) => s.lifespanSamples);
  const lifespan = summarizeLifespans(allSamples);
  const wearCount = [...stats.values()].reduce((sum, s) => sum + s.wearCount, 0);
  const totalCost = [...stats.values()].reduce(
    (sum, s) => sum + s.purchasePrice + s.totalRepairCost + s.totalMaterialCost,
    0,
  );
  const recurrenceCount = dataset.damages.filter((d) => !!d.recurrenceOf).length;
  const repairedEvents = new Set(dataset.repairs.map((r) => r.damageEventId)).size;

  return {
    garmentCount: dataset.garments.length,
    activeCount: dataset.garments.filter((g) => g.status === 'active').length,
    needsRepairCount: dataset.garments.filter((g) => g.status === 'needs_repair').length,
    inRepairCount: dataset.garments.filter((g) => g.status === 'in_repair').length,
    observingCount: dataset.garments.filter((g) => g.status === 'observing').length,
    retiredCount: dataset.garments.filter((g) => g.status === 'retired').length,
    totalWearCount: wearCount,
    totalRepairCount: dataset.repairs.filter((r) => r.status !== 'superseded').length,
    recurrenceRate: recurrenceRate(recurrenceCount, repairedEvents),
    averageLifespanDays: lifespan.averageDays,
    censoredLifespanCount: lifespan.censoredCount,
    totalCost: round2(totalCost),
    lifetimeCostPerWear: wearCount > 0 ? round2(totalCost / wearCount) : null,
  };
}

export function computeHealth(stats: GarmentStats): HealthScoreResult {
  return healthScore({
    openDamageCount: stats.openDamageCount,
    repairCount: stats.repairCount,
    serviceDays: stats.serviceDays,
    perMonth: stats.perMonth,
  });
}

/** 依据未终结破损 / 观察期状态回推衣物生命周期状态（状态机的唯一入口） */
export async function syncGarmentStatus(garmentId: string): Promise<string> {
  const garment = await prisma.garment.findUniqueOrThrow({ where: { id: garmentId } });
  if (garment.status === 'retired') return 'retired';

  const damages = await prisma.damageEvent.findMany({
    where: { garmentId },
    select: { id: true, status: true },
  });
  const openDamages = damages.filter((d) => !DAMAGE_TERMINAL_STATUSES.includes(d.status as DamageStatus));
  const repairs = await prisma.repair.findMany({
    where: { damageEvent: { garmentId } },
    select: { status: true },
  });

  let status = 'active';
  if (repairs.some((r) => r.status === 'observing')) status = 'observing';
  else if (openDamages.some((d) => d.status === 'in_repair')) status = 'in_repair';
  else if (openDamages.length > 0) status = 'needs_repair';

  if (status !== garment.status) {
    await prisma.garment.update({ where: { id: garmentId }, data: { status } });
  }
  return status;
}

export function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export { daysBetween, num };
