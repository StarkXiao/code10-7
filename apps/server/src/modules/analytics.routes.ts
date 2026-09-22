import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { handler, ok, parseQuery } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { computeOverview, loadDataset } from '../services/stats.js';
import {
  byFrequency,
  byMaterial,
  bySeason,
  durabilityMatrix,
  garmentAnalytics,
  healthDistribution,
  stitchEffectiveness,
} from '../services/analytics.js';

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

analyticsRouter.get(
  '/overview',
  handler(async (req, res) => {
    const includeRetired = req.query.includeRetired === 'true';
    const dataset = await loadDataset(req.ctx.wardrobeId, { includeRetired });
    const overview = computeOverview(dataset);
    const health = await healthDistribution(req.ctx.wardrobeId);
    const reminders = await prisma.reminder.groupBy({
      by: ['status'],
      where: { wardrobeId: req.ctx.wardrobeId },
      _count: { _all: true },
    });
    ok(req, res, {
      overview,
      healthLevels: health.levels,
      remindersByStatus: Object.fromEntries(reminders.map((r) => [r.status, r._count._all])),
    });
  }),
);

analyticsRouter.get(
  '/by-material',
  handler(async (req, res) => {
    ok(req, res, await byMaterial(req.ctx.wardrobeId));
  }),
);

analyticsRouter.get(
  '/by-season',
  handler(async (req, res) => {
    ok(req, res, await bySeason(req.ctx.wardrobeId));
  }),
);

analyticsRouter.get(
  '/by-frequency',
  handler(async (req, res) => {
    ok(req, res, await byFrequency(req.ctx.wardrobeId));
  }),
);

analyticsRouter.get(
  '/stitch-effectiveness',
  handler(async (req, res) => {
    ok(req, res, await stitchEffectiveness(req.ctx.wardrobeId));
  }),
);

analyticsRouter.get(
  '/durability-matrix',
  handler(async (req, res) => {
    ok(req, res, await durabilityMatrix(req.ctx.wardrobeId));
  }),
);

analyticsRouter.get(
  '/health-distribution',
  handler(async (req, res) => {
    ok(req, res, await healthDistribution(req.ctx.wardrobeId));
  }),
);

analyticsRouter.get(
  '/garments/:id/health',
  handler(async (req, res) => {
    const garment = await prisma.garment.findFirst({
      where: { id: req.params.id, wardrobeId: req.ctx.wardrobeId, deletedAt: null },
    });
    if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在');
    const analytics = await garmentAnalytics(garment.id);
    if (!analytics) throw new HttpError('NOT_FOUND', '统计信息不可用');
    ok(req, res, {
      garmentId: garment.id,
      health: analytics.health,
      stats: analytics.stats,
      lifespan: analytics.lifespan,
    });
  }),
);

analyticsRouter.get(
  '/wear-trend',
  handler(async (req, res) => {
    const query = parseQuery(
      z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }),
      req.query,
    );
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - query.months);
    const logs = await prisma.wearLog.findMany({
      where: { garment: { wardrobeId: req.ctx.wardrobeId, deletedAt: null }, wornOn: { gte: since } },
      select: { wornOn: true, garmentId: true },
      orderBy: { wornOn: 'asc' },
    });
    const byMonth: Record<string, number> = {};
    for (const log of logs) {
      const key = log.wornOn.toISOString().slice(0, 7);
      byMonth[key] = (byMonth[key] ?? 0) + 1;
    }
    const damages = await prisma.damageEvent.findMany({
      where: { garment: { wardrobeId: req.ctx.wardrobeId }, detectedAt: { gte: since } },
      select: { detectedAt: true },
    });
    const damageByMonth: Record<string, number> = {};
    for (const damage of damages) {
      const key = damage.detectedAt.toISOString().slice(0, 7);
      damageByMonth[key] = (damageByMonth[key] ?? 0) + 1;
    }
    const months = [...new Set([...Object.keys(byMonth), ...Object.keys(damageByMonth)])].sort();
    ok(req, res, {
      months: months.map((month) => ({
        month,
        wearCount: byMonth[month] ?? 0,
        damageCount: damageByMonth[month] ?? 0,
      })),
    });
  }),
);
