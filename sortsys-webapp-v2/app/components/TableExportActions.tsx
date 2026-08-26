import { useState } from "react";
import { MyButton } from "~/components/MyButton";
import { Icons } from "~/lib/icons";
import { exportTable, type TableExportColumn, type TableExportFormat } from "~/lib/tableExport";

export function TableExportActions<RowT>(props: {
  title: string;
  fileName: string;
  rows: RowT[] | (() => Promise<RowT[]> | RowT[]);
  columns: TableExportColumn<RowT>[];
  subtitle?: string;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState<TableExportFormat | null>(null);

  async function run(format: TableExportFormat) {
    setPending(format);
    try {
      const rows = typeof props.rows === 'function'
        ? await props.rows()
        : props.rows;

      await exportTable({
        format,
        title: props.title,
        fileName: props.fileName,
        rows,
        columns: props.columns,
        subtitle: props.subtitle,
      });
    } catch (err) {
      window.alert((err as Error)?.message || 'Export fehlgeschlagen.');
    } finally {
      setPending(null);
    }
  }

  return <>
    <MyButton
      kind="ghost"
      size="sm"
      renderIcon={Icons.Download}
      disabled={props.disabled || !!pending}
      loading={pending === 'pdf'}
      onClick={() => void run('pdf')}
    >PDF</MyButton>
    <MyButton
      kind="ghost"
      size="sm"
      renderIcon={Icons.Excel}
      disabled={props.disabled || !!pending}
      loading={pending === 'excel'}
      onClick={() => void run('excel')}
    >Excel</MyButton>
  </>;
}
