import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { SpySnapshot } from "../api";
import { chartDomain, fmtAxisCount, temporalPoints } from "./spyFormat";

interface FollowersChartProps {
  snapshots: SpySnapshot[];
}

function formatDateTick(dayStr: string): string {
  if (!dayStr) return "";
  const parts = dayStr.split("-");
  if (parts.length < 3) return dayStr;
  return `${parts[2]}/${parts[1]}`;
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload || !payload.length) return null;
  const data = payload[0].payload as SpySnapshot;
  const followers = data.followers;
  if (followers == null) return null;

  const parts = data.day.split("-").map(Number);
  const dateObj = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
  const dateStr = dateObj.toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const followersStr = followers.toLocaleString("pt-BR");
  const originStr = data.source === "visit" ? "visita" : "passada diária";

  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md text-popover-foreground">
      <div className="text-muted-foreground mb-1">{dateStr}</div>
      <div className="font-semibold text-sm">
        {followersStr}{" "}
        <span className="font-normal text-xs text-muted-foreground">seguidores</span>
      </div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{originStr}</div>
    </div>
  );
}

export function FollowersChart({ snapshots }: FollowersChartProps) {
  const pointsWithFollowers = snapshots.filter((s) => s.followers != null);
  const count = pointsWithFollowers.length;

  if (count === 0) {
    return (
      <div className="flex h-[260px] w-full items-center justify-center rounded-xl border bg-card/40 p-4 text-xs text-muted-foreground">
        Ainda sem medição.
      </div>
    );
  }

  const followersValues = pointsWithFollowers.map((s) => s.followers as number);
  const domain = chartDomain(followersValues);

  return (
    <div className="flex flex-col">
      <div className="h-[260px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={temporalPoints(snapshots)}
            margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
          >
            <CartesianGrid
              horizontal={true}
              vertical={false}
              stroke="var(--border)"
            />
            <XAxis
              dataKey="time"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(time: number) => formatDateTick(new Date(time).toISOString().slice(0, 10))}
              minTickGap={32}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            />
            <YAxis
              width={58}
              domain={domain}
              tickFormatter={fmtAxisCount}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="followers"
              stroke="var(--chart-1)"
              strokeWidth={2}
              fill="var(--chart-1)"
              fillOpacity={0.12}
              dot={{ r: 3, fill: "var(--card)", stroke: "var(--chart-1)", strokeWidth: 1.5 }}
              activeDot={{ r: 4, fill: "var(--chart-1)", strokeWidth: 0 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {count === 1 && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Há apenas uma medição no histórico.
        </p>
      )}
    </div>
  );
}
