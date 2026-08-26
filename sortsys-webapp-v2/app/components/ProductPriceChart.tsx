import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCurrency, formatDate } from '~/lib/format';
import { Colors } from '~/lib/colors';

type ProductPriceRecord = {
  timestamp: Date;
  price: number;
};

export default function ProductPriceChart({ records, baseUnit }: {
  records: ProductPriceRecord[];
  baseUnit: string;
}) {
  return <ResponsiveContainer height={150}>
    <AreaChart
      data={[...records].reverse().map(record => ({
        date: formatDate(record.timestamp),
        Preis: record.price,
      }))}
      margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
    >
      <defs>
        <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={Colors.green} stopOpacity={0.25} />
          <stop offset="100%" stopColor={Colors.green} stopOpacity={0.02} />
        </linearGradient>
      </defs>

      <CartesianGrid strokeDasharray="3 6" opacity={0.8} vertical={false} />

      <XAxis dataKey="date" hide />
      <YAxis dataKey="Preis" hide domain={[
        dataMin => dataMin * 0.6,
        dataMax => dataMax * 1.2,
      ]} />

      <Tooltip
        contentStyle={{
          borderRadius: 10,
          border: "1px solid rgba(0,0,0,0.08)",
          boxShadow: "0 8px 20px rgba(0,0,0,0.12)",
        }}
        formatter={(value) => [`${formatCurrency(Number(value))} / ${baseUnit}`, "Preis"]}
      />

      <Area
        type="linear"
        dataKey="Preis"
        stroke={Colors.green}
        fill="url(#priceFill)"
        strokeWidth={2}
        dot={false}
        activeDot={{ r: 4 }}
      />
    </AreaChart>
  </ResponsiveContainer>;
}
