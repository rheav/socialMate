import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SpyViewsPoint } from "../api";
import { fmtCount } from "../format";
import { chartDomain, fmtAxisCount, viewsDailyPoints } from "./spyFormat";

const SERIES = [
  { key: "d1", label: "24h", color: "var(--chart-1)" },
  { key: "d3", label: "3 dias", color: "var(--chart-2)" },
  { key: "d7", label: "7 dias", color: "var(--chart-3)" },
] as const;

function dayTick(day: string): string {
  const [, month, date] = day.split("-");
  return `${date}/${month}`;
}

function ViewsTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as SpyViewsPoint & { day: string };
  const when = new Date(point.at).toLocaleString("pt-BR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1 text-muted-foreground">leitura de {when}</div>
      {SERIES.map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
          <span className="font-semibold tabular-nums">{fmtCount(point[s.key])}</span>
        </div>
      ))}
      {(point.missing > 0 || !point.complete) && <div className="mt-1 text-[11px] text-muted-foreground">parcial</div>}
    </div>
  );
}

/** The 24 h, 3 and 7 day sums of each day's last reading. */
export function ViewsChart({ history }: { history: SpyViewsPoint[] }) {
  const points = viewsDailyPoints(history);
  if (!points.length) {
    return (
      <div className="flex h-[220px] w-full items-center justify-center rounded-xl border bg-card/40 p-4 text-xs text-muted-foreground">
        O histórico começa na próxima leitura das views.
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid horizontal vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="day"
              tickFormatter={dayTick}
              minTickGap={24}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            />
            <YAxis
              width={58}
              domain={chartDomain(points.flatMap((p) => [p.d1, p.d7]))}
              tickFormatter={fmtAxisCount}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            />
            <Tooltip content={<ViewsTooltip />} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            {SERIES.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={{ r: 3, fill: "var(--card)", stroke: s.color, strokeWidth: 1.5 }}
                activeDot={{ r: 4, fill: s.color, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {points.length === 1 && (
        <p className="mt-2 text-center text-xs text-muted-foreground">Há apenas uma leitura no histórico.</p>
      )}
    </div>
  );
}
