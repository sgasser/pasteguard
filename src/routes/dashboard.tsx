import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { buildCss } from "hono-tailwind";
import { z } from "zod";
import { getConfig } from "../config";
import { getLogger } from "../logging/logger";
import DashboardPage from "../views/dashboard/page";

const LogsQuerySchema = z.object({
	limit: z.coerce.number().min(1).max(1000).default(100),
	offset: z.coerce.number().min(0).default(0),
});

const config = getConfig();

export const dashboardRoutes = new Hono();

// Build the dashboard CSS once per process. hono-tailwind's tailwind() middleware
// rebuilds it on every request unless it writes the CSS to a file on disk.
let dashboardCss: Promise<string> | undefined;

/**
 * GET /dashboard/tailwind.css - Dashboard styles (served without dashboard auth)
 */
dashboardRoutes.get("/tailwind.css", async (c) => {
	dashboardCss ??= buildCss().catch((error: unknown) => {
		dashboardCss = undefined;
		throw error;
	});

	return c.body(await dashboardCss, 200, {
		"Content-Type": "text/css; charset=utf-8",
		"Cache-Control": "no-store",
	});
});

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
dashboardRoutes.get("/api/logs", zValidator("query", LogsQuerySchema), async (c) => {
	const { limit, offset } = c.req.valid("query");

	const logger = getLogger();
	const logs = await logger.getLogs(limit, offset);

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
dashboardRoutes.get("/api/stats", async (c) => {
	const config = getConfig();
	const logger = getLogger();
	const stats = await logger.getStats();
	const entityStats = await logger.getEntityStats();

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
