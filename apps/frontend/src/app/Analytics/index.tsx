import { useEffect, useState } from "react";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

import { Container } from "@repo/theme";

import { ChartConfig, ChartContainer, ChartTooltip } from "@/components/Chart";

import styles from "./Analytics.module.scss";

/** GET /api/analytics/summary (apps/backend/src/presence). */
interface AnalyticsSummary {
  generatedAt: string;
  totals: {
    thisHour: number;
    today: number;
    thisWeek: number;
    thisMonth: number;
    thisYear: number;
    allTime: number;
  };
  /** "YYYY-MM-DD" in Pacific time, oldest first. */
  daily: { day: string; visitors: number }[];
}

const REFRESH_MS = 60_000;

const chartConfig: ChartConfig = {
  visitors: { label: "Unique visitors", color: "var(--visitors-color)" },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parseDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const shortDay = (day: string) => {
  const date = parseDay(day);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
};
const longDay = (day: string) =>
  `${WEEKDAYS[parseDay(day).getUTCDay()]}, ${shortDay(day)}`;

const axisTick = { fill: "var(--paragraph-color)", fontSize: "var(--text-12)" };

function VisitorsChart({ data }: { data: AnalyticsSummary["daily"] }) {
  return (
    <ChartContainer config={chartConfig} className={styles.chart}>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} barCategoryGap="12%" accessibilityLayer={false}>
          <CartesianGrid vertical={false} stroke="var(--border-color)" />
          <XAxis
            dataKey="day"
            tickFormatter={shortDay}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
          />
          <YAxis
            allowDecimals={false}
            width={32}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip
            cursor={{ fill: "var(--border-color)", opacity: 0.5, radius: 4 }}
            tooltipConfig={{
              indicator: "square",
              labelFormatter: (label: string) => longDay(label),
              valueFormatter: (value: number) => value.toLocaleString(),
            }}
          />
          <Bar
            dataKey="visitors"
            name="visitors"
            fill="var(--visitors-color)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}

function DataTable({ rows }: { rows: [string, number][] }) {
  return (
    <details className={styles.table}>
      <summary>View as table</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Unique visitors</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map(([label, value]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{value.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export default function Analytics() {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/analytics/summary");
        if (!response.ok) throw new Error(String(response.status));
        const summary = (await response.json()) as AnalyticsSummary;
        if (!cancelled) {
          setData(summary);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void load();
    const interval = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const totals = data?.totals;
  const tiles: [string, number | undefined][] = [
    ["This hour", totals?.thisHour],
    ["Today", totals?.today],
    ["This week", totals?.thisWeek],
    ["This month", totals?.thisMonth],
    ["This year", totals?.thisYear],
    ["All time", totals?.allTime],
  ];

  return (
    <div className={styles.root}>
      <Container className={styles.container}>
        <h1 className={styles.title}>Analytics</h1>
        <p className={styles.subtitle}>
          Unique visitors, Pacific time; weeks start Monday.{" "}
          {error
            ? "Couldn't load the latest numbers; retrying."
            : data
              ? `Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
              : "Loading…"}
        </p>

        <div className={styles.tiles}>
          {tiles.map(([label, value]) => (
            <div key={label} className={styles.tile}>
              <p className={styles.value}>
                {value === undefined ? "–" : value.toLocaleString()}
              </p>
              <p className={styles.label}>{label}</p>
            </div>
          ))}
        </div>

        {data && (
          <section className={styles.card}>
            <h2 className={styles.heading}>Last 90 days</h2>
            <p className={styles.caption}>Unique visitors per day</p>
            <VisitorsChart data={data.daily} />
            <DataTable
              rows={data.daily.map((d) => [longDay(d.day), d.visitors])}
            />
          </section>
        )}
      </Container>
    </div>
  );
}
