import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { tailwind } from "hono-tailwind";
import { z } from "zod";
import { getConfig } from "../config";
import { getLogger } from "../services/logger";
import DashboardPage from "../views/dashboard/page";

const LogsQuerySchema = z.object({
	limit: z.coerce.number().min(1).max(1000).default(100),
	offset: z.coerce.number().min(0).default(0),
});

const config = getConfig();

export const dashboardRoutes = new Hono();

dashboardRoutes.use("/tailwind.css", tailwind());

if (config.dashboard.auth) {
	dashboardRoutes.use(
		"*",
		basicAuth({
			username: config.dashboard.auth.username,
			password: config.dashboard.auth.password,
			realm: "PasteGuard Dashboard",
		}),
	);
}

/**
 * GET /api/logs - Get recent request logs
 */
dashboardRoutes.get("/api/logs", zValidator("query", LogsQuerySchema), (c) => {
	const { limit, offset } = c.req.valid("query");

	const logger = getLogger();
	const logs = logger.getLogs(limit, offset);

	return c.json({
		logs,
		pagination: {
			limit,
			offset,
			count: logs.length,
		},
	});
});

/**
 * GET /api/stats - Get statistics
 */
dashboardRoutes.get("/api/stats", (c) => {
	const config = getConfig();
	const logger = getLogger();
	const stats = logger.getStats();
	const entityStats = logger.getEntityStats();

	return c.json({
		...stats,
		entity_breakdown: entityStats,
		mode: config.mode,
	});
});

/**
 * GET /dashboard - Dashboard HTML UI
 */
dashboardRoutes.get("/", (c) => {
	return c.html(<DashboardPage />);
});
