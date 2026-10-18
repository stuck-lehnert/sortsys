import { compareBusinessText } from "../number.ts";
import type { QueryOutputs } from "@sortsys/v2-client/contract";
import type {
  PdfTableSection,
  PdfImageSection,
  StructuredPdfDocument,
} from "./document.ts";
import { createPdfBusinessContext } from "./context.ts";
export function buildDailyReportPdfDocument(options: {
  report: QueryOutputs["projects.dailyReports.get"];
  projectTitle: string;
  usersById: ReadonlyMap<string, QueryOutputs["users.get"] | null | undefined>;
  locale: string;
  exportedAt?: Date;
}): StructuredPdfDocument {
  const { report, projectTitle, usersById } = options;
  const { uiText, formatDate, formatNumber, formatPdfNumber, userFullName } =
    createPdfBusinessContext(options.locale);
  const sortedWorkHours = [...report.workHours].sort((left, right) => {
    const leftLabel = left.userId
      ? usersById.get(left.userId)
        ? userFullName(usersById.get(left.userId)!)
        : left.userId
      : "Unbekannt";
    const rightLabel = right.userId
      ? usersById.get(right.userId)
        ? userFullName(usersById.get(right.userId)!)
        : right.userId
      : "Unbekannt";
    return compareBusinessText(leftLabel, rightLabel);
  });

  const workHourRows = sortedWorkHours.map((entry) => {
    const user = entry.userId ? usersById.get(entry.userId) : null;
    return [
      user ? userFullName(user) : "Unbekannt",
      formatPdfNumber(entry.hours),
    ];
  });

  const totalHours = report.workHours.reduce(
    (sum, entry) => sum + Number(entry.hours ?? 0),
    0,
  );

  const summaryRows: PdfTableSection["rows"] = [
    [uiText("Projekt"), projectTitle],
    ["Tag", formatDate(report.day, "long")],
    [
      uiText("Gesamtstunden", "Total hours"),
      { value: `${formatPdfNumber(totalHours)} h`, bold: true },
    ],
  ];

  const sections: PdfTableSection[] = [
    {
      title: uiText("Zusammenfassung"),
      columns: [uiText("Kennzahl"), uiText("Wert")],
      rows: summaryRows,
      presentation: "summary",
      withHeader: false,
      align: ["left", "left"],
      columnWidths: ["1fr", "2fr"],
    },
  ];

  if (report.summary?.trim()) {
    sections.push({
      title: uiText("Beschreibung der Arbeiten"),
      columns: [""],
      rows: [[report.summary]],
      withHeader: false,
    });
  }

  if (workHourRows.length > 0) {
    sections.push({
      title: uiText("Arbeitszeit"),
      columns: ["Mitarbeiter", uiText("Stunden")],
      rows: workHourRows,
      totalRows: [[uiText("Gesamt", "Total"), formatPdfNumber(totalHours)]],
      align: ["left", "right"],
      columnWidths: ["2fr", "1fr"],
    });
  }

  if (
    report.weather &&
    Object.values(report.weather).some((value) => value != null && value !== "")
  ) {
    const weatherRows: string[][] = [];
    if (report.weather.summary)
      weatherRows.push([uiText("Beschreibung"), report.weather.summary]);
    if (typeof report.weather.temperatureC === "number")
      weatherRows.push([
        "Temperatur",
        `${formatNumber(report.weather.temperatureC)} °C`,
      ]);
    if (typeof report.weather.precipitationMm === "number")
      weatherRows.push([
        "Niederschlag",
        `${formatNumber(report.weather.precipitationMm)} mm`,
      ]);
    if (typeof report.weather.windKph === "number")
      weatherRows.push([
        "Wind",
        `${formatNumber(report.weather.windKph)} km/h`,
      ]);

    if (weatherRows.length > 0) {
      sections.push({
        title: uiText("Wetter"),
        columns: ["Feld", uiText("Wert")],
        rows: weatherRows,
        withHeader: false,
        align: ["left", "left"],
        columnWidths: ["1fr", "2fr"],
      });
    }
  }

  const photoImages = (report.photos ?? [])
    .map((photo, index) => ({
      title: uiText(`Foto ${index + 1}`, `Photo ${index + 1}`),
      caption: `${photo.fileName} · ${formatDate(photo.createdAt)}`,
      url: photo.downloadUrl || photo.previewUrl || photo.thumbnailUrl || "",
      fileName: photo.fileName,
      mimeType: photo.mimeType,
    }))
    .filter((image) => !!image.url);
  const imageSections: PdfImageSection[] = photoImages.length
    ? [
        {
          title: uiText("Fotos"),
          subtitle: uiText(
            `${photoImages.length} ${photoImages.length === 1 ? "Foto" : "Fotos"} zum Bautagesbericht`,
            `${photoImages.length} ${photoImages.length === 1 ? "photo" : "photos"} for the daily report`,
          ),
          images: photoImages,
        },
      ]
    : [];

  return {
    title: uiText(
      `Bautagesbericht ${formatDate(report.day, "long")}`,
      `Daily report ${formatDate(report.day, "long")}`,
    ),
    reportLabel: uiText("Bautagesbericht"),
    showReportLabel: false,
    sections,
    exportedAt: options.exportedAt,
    signatures: [{ title: uiText("Bauleiter") }, { title: uiText("Bauherr") }],
    imageSections,
    emptyMessage: uiText("Keine Daten zum Bautagesbericht verfügbar."),
  };
}
