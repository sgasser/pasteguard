import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { buildCss } from "hono-tailwind";
import { z } from "zod";
import { type Config, getConfig } from "../config";
import { getLogger } from "../logging/logger";
import DashboardPage from "../views/dashboard/page";

const LogsQuerySchema = z.object({
	limit: z.coerce.number().min(1).max(1000).default(100),
	offset: z.coerce.number().min(0).default(0),
});

// Relative to the working directory, like config.yaml. The stylesheet limits
// Tailwind's class scan to the dashboard views.
const DASHBOARD_CSS_INPUT = "src/views/dashboard/tailwind.css";

type DashboardAuth = Config["dashboard"]["auth"];

/**
 * Builds the dashboard's Tailwind CSS
 */
function buildDashboardCss(): Promise<string> {
	return buildCss({ in: DASHBOARD_CSS_INPUT });
}

/**
 * Creates the dashboard routes, behind basic auth when `auth` is set
 */
export function createDashboardRoutes(
	auth: DashboardAuth = getConfig().dashboard.auth,
	buildStyles: () => Promise<string> = buildDashboardCss,
): Hono {
	const routes = new Hono();

	if (auth) {
		routes.use(
			"*",
			basicAuth({
				username: auth.username,
				password: auth.password,
				realm: "PasteGuard Dashboard",
			}),
		);
	}

	// Build the CSS on the first request and reuse it. hono-tailwind's tailwind() middleware
	// rebuilds it on every request unless it writes the CSS to a file on disk.
	let css: Promise<string> | undefined;

	/**
	 * GET /dashboard/tailwind.css - Dashboard styles
	 */
	routes.get("/tailwind.css", async (c) => {
		css ??= buildStyles().catch((error: unknown) => {
			css = undefined;
			throw error;
		});

		return c.body(await css, 200, {
			"Content-Type": "text/css; charset=utf-8",
			"Cache-Control": "no-store",
		});
	});

	/**
	 * GET /api/logs - Get recent request logs
	 */
	routes.get("/api/logs", zValidator("query", LogsQuerySchema), async (c) => {
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
	routes.get("/api/stats", async (c) => {
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
	routes.get("/", (c) => {
		return c.html(<DashboardPage />);
	});

	return routes;
}

export const dashboardRoutes = createDashboardRoutes();
