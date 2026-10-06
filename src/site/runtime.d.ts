export type DashboardKit = { icon(name: string): string; logo(extra?: string): string; footer(withLaunch?: boolean): string };
export type LiveDashboard = { html(path: string, kit: DashboardKit): string; setup(ctx: { rerender(): void; signal: AbortSignal }): void };
export function mountSite(options?: { dashboard?: LiveDashboard }): { refresh(): void; dispose(): void };
