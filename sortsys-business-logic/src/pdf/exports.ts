import { createRegiePdfBuilder } from "./regie.ts";
import { createPdfBusinessContext } from "./context.ts";
import { buildDailyReportPdfDocument } from "./daily.ts";
import { buildProjectCostsPdfDocument } from "./costs.ts";
import { buildWeeklyReportExports } from "./weekly.ts";
import type {
  PreparedStructuredPdfDocument,
  StructuredPdfDocument,
  PdfImage,
} from "./document.ts";
import type { ReportPdfData, CostPdfData, TypstAsset } from "./models.ts";
import { bytesToBase64 } from "../encoding.ts";
import { hasSignature, signatureSvg } from "../signatures.ts";
const renderer = createPdfBusinessContext;
export function pdfImageExtension(
  image: Pick<PdfImage, "mimeType" | "fileName" | "url">,
) {
  const mime = (image.mimeType ?? "").toLowerCase();
  for (const ext of ["png", "webp", "gif", "svg", "jpeg"])
    if (mime.includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  const ext = (image.fileName ?? image.url)
    .match(/\.(png|webp|gif|svg|jpg|jpeg)(?:\?|#|$)/i)?.[1]
    ?.toLowerCase();
  return ext === "jpeg" ? "jpg" : (ext ?? "jpg");
}
export function pdfImagePath(
  image: Pick<PdfImage, "mimeType" | "fileName" | "url">,
  index: number,
) {
  return `/image-${index}.${pdfImageExtension(image)}`;
}
export function preparePdfImages(
  documents: StructuredPdfDocument[],
  lookup: (image: PdfImage) => Uint8Array | undefined,
) {
  let index = 0;
  const assets: TypstAsset[] = [];
  return {
    documents: documents.map((document) => ({
      ...document,
      imageSections: document.imageSections?.map((section) => ({
        ...section,
        images: section.images.map((image) => {
          const bytes = lookup(image);
          const shadowPath = bytes?.length ? pdfImagePath(image, index) : null;
          index++;
          if (shadowPath)
            assets.push({ path: shadowPath, data: bytesToBase64(bytes!) });
          return { ...image, shadowPath };
        }),
      })),
    })),
    assets,
  };
}
export function typstReportBatch(data: ReportPdfData[]) {
  if (
    !data.length ||
    data.length > 7 ||
    data.some((item) => item.locale !== data[0]!.locale)
  )
    throw new Error("INVALID_PDF_BATCH");
  const locale = data[0]!.locale,
    label = (de: string, en: string) => (locale === "de" ? de : en),
    render = renderer(locale),
    assets: TypstAsset[] = [];
  const builder = createRegiePdfBuilder(createPdfBusinessContext(locale));
  const logo = data[0]!.logoDataUri?.match(
      /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/,
    ),
    logoPath = logo ? `/logo.${logo[1]}` : null;
  if (logo) assets.push({ path: logoPath!, data: logo[2]! });
  const documents: StructuredPdfDocument[] = data.map((item, index) => {
    const signatures = (
      [
        ["siteManager", label("Bauleiter", "Site manager")],
        ["client", label("Bauherr", "Client")],
      ] as const
    ).map(([key, title]) => {
      const signature = item.signatures?.[key];
      if (!signature || !hasSignature(signature)) return { title };
      const path = `/signature-${index}-${key}.svg`;
      assets.push({
        path,
        data: bytesToBase64(new TextEncoder().encode(signatureSvg(signature))),
      });
      return { title, imagePath: path, hint: signature.name };
    });
    const common = {
      exportedAt: item.exportedAt ?? new Date(),
      signatures,
      layout: {
        kind: "report" as const,
        sender: {
          name: item.companyName ?? "sortsys",
          lines: item.senderLines ?? [],
        },
      },
    };
    if ("autoId" in item.report)
      return {
        ...builder.buildRegieReportPdfDocument({
          report: item.report,
          projectTitle: item.project.title,
          productsById: item.products,
          usersById: item.users,
        }),
        ...common,
      };
    return {
      ...buildDailyReportPdfDocument({
        report: item.report,
        projectTitle: item.project.title,
        usersById: item.users,
        locale,
      }),
      ...common,
    };
  });
  const prepared = preparePdfImages(documents, (image) =>
    data
      .find((item) => item.imageBytes?.has(image.url))
      ?.imageBytes?.get(image.url),
  );
  assets.push(...prepared.assets);
  return {
    source: render.buildPdfBatchDocument(
      { documents: prepared.documents },
      logoPath,
    ),
    assets,
  };
}

export function typstCostDocument(
  data: CostPdfData,
  companyName: string | null,
  branding: { logoDataUri?: string; senderLines?: string[] } = {},
) {
  if (data.costs.deliveryNotes.length > 500)
    throw new Error("DOCUMENT_TOO_LARGE");
  const document = buildProjectCostsPdfDocument({
    costs: data.costs,
    projectTitle: data.project.title,
    locale: data.locale,
    exportedAt: data.createdAt,
    productsById: data.productsById,
    userNamesById: data.userNamesById,
    toolNamesById: data.toolNamesById,
  });
  document.layout = {
    kind: "report",
    sender: {
      name: companyName ?? "sortsys",
      lines: branding.senderLines ?? [],
    },
  };
  const logo = branding.logoDataUri?.match(
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  const logoPath = logo ? `/logo.${logo[1]}` : null;
  return {
    source: renderer(data.locale).buildPdfBatchDocument(
      { documents: preparePdfImages([document], () => undefined).documents },
      logoPath,
    ),
    assets: logo ? [{ path: logoPath!, data: logo[2]! }] : ([] as TypstAsset[]),
  };
}
export function typstWeeklyReportBatch(data: ReportPdfData[]) {
  if (
    !data.length ||
    data.length > 7 ||
    data.some(
      (item) =>
        "autoId" in item.report ||
        item.locale !== data[0]!.locale ||
        item.project.id !== data[0]!.project.id,
    )
  )
    throw new Error("INVALID_PDF_BATCH");
  const first = data[0]!;
  const users = new Map(data.flatMap((item) => [...item.users]));
  const reports = data.flatMap((item) =>
    "autoId" in item.report ? [] : [item.report],
  );
  const documents = buildWeeklyReportExports({
    reports,
    project: first.project,
    usersById: users,
    locale: first.locale,
  }).map((entry) => ({
    ...entry.document,
    exportedAt: first.exportedAt ?? new Date(),
    layout: {
      kind: "report" as const,
      sender: {
        name: first.companyName ?? "sortsys",
        lines: first.senderLines ?? [],
      },
    },
  }));
  const logo = first.logoDataUri?.match(
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  const path = logo ? `/logo.${logo[1]}` : null;
  return {
    source: renderer(first.locale).buildPdfBatchDocument({ documents }, path),
    assets: logo ? [{ path: path!, data: logo[2]! }] : ([] as TypstAsset[]),
  };
}
