import type JSZip from "jszip";

export type NewProjectFileType = "docx" | "pptx" | "xlsx" | "drawio";

export const NEW_PROJECT_FILE_TYPES: Array<{
  type: NewProjectFileType;
  extension: string;
  mimeType: string;
  germanLabel: string;
  englishLabel: string;
}> = [
  {
    type: "docx",
    extension: ".docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    germanLabel: "Word",
    englishLabel: "Word",
  },
  {
    type: "pptx",
    extension: ".pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    germanLabel: "PowerPoint",
    englishLabel: "PowerPoint",
  },
  {
    type: "xlsx",
    extension: ".xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    germanLabel: "Excel",
    englishLabel: "Excel",
  },
  {
    type: "drawio",
    extension: ".drawio",
    mimeType: "application/vnd.jgraph.mxfile",
    germanLabel: "DrawIO",
    englishLabel: "DrawIO",
  },
];

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const OFFICE_RELATIONSHIPS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const OFFICE_DOCUMENT_SCHEMA =
  "http://schemas.openxmlformats.org/officeDocument/2006";
const PACKAGE_RELATIONSHIPS =
  "http://schemas.openxmlformats.org/package/2006/relationships";

async function createZip() {
  const { default: JSZip } = await import("jszip");
  return new JSZip();
}

function addPackageRelationships(zip: JSZip, documentTarget: string) {
  zip.file("_rels/.rels", `${XML_HEADER}
<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">
  <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="${documentTarget}"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="${OFFICE_DOCUMENT_SCHEMA}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

  const createdAt = new Date().toISOString();
  zip.file("docProps/core.xml", `${XML_HEADER}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>sortsys</dc:creator>
  <cp:lastModifiedBy>sortsys</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified>
</cp:coreProperties>`);
}

async function createDocxBlob() {
  const zip = await createZip();
  addPackageRelationships(zip, "word/document.xml");

  zip.file("[Content_Types].xml", `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file("docProps/app.xml", `${XML_HEADER}
<Properties xmlns="${OFFICE_DOCUMENT_SCHEMA}/extended-properties"
  xmlns:vt="${OFFICE_RELATIONSHIPS}/docPropsVTypes">
  <Application>sortsys</Application>
</Properties>`);
  zip.file("word/document.xml", `${XML_HEADER}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p/>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`);

  return zip.generateAsync({ type: "blob", mimeType: NEW_PROJECT_FILE_TYPES[0].mimeType });
}

async function createXlsxBlob() {
  const zip = await createZip();
  addPackageRelationships(zip, "xl/workbook.xml");

  zip.file("[Content_Types].xml", `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file("docProps/app.xml", `${XML_HEADER}
<Properties xmlns="${OFFICE_DOCUMENT_SCHEMA}/extended-properties"
  xmlns:vt="${OFFICE_RELATIONSHIPS}/docPropsVTypes">
  <Application>sortsys</Application>
</Properties>`);
  zip.file("xl/workbook.xml", `${XML_HEADER}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="${OFFICE_RELATIONSHIPS}">
  <sheets><sheet name="Tabelle1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `${XML_HEADER}
<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">
  <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="${OFFICE_RELATIONSHIPS}/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", `${XML_HEADER}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData/>
</worksheet>`);
  zip.file("xl/styles.xml", `${XML_HEADER}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`);

  return zip.generateAsync({ type: "blob", mimeType: NEW_PROJECT_FILE_TYPES[2].mimeType });
}

async function createPptxBlob() {
  const zip = await createZip();
  addPackageRelationships(zip, "ppt/presentation.xml");

  zip.file("[Content_Types].xml", `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file("docProps/app.xml", `${XML_HEADER}
<Properties xmlns="${OFFICE_DOCUMENT_SCHEMA}/extended-properties"
  xmlns:vt="${OFFICE_RELATIONSHIPS}/docPropsVTypes">
  <Application>sortsys</Application><Slides>1</Slides>
</Properties>`);
  zip.file("ppt/presentation.xml", `${XML_HEADER}
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="${OFFICE_RELATIONSHIPS}"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `${XML_HEADER}
<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">
  <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="${OFFICE_RELATIONSHIPS}/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `${XML_HEADER}
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="${OFFICE_RELATIONSHIPS}"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm/></p:grpSpPr>
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `${XML_HEADER}
<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">
  <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`);
  zip.file("ppt/slideLayouts/slideLayout1.xml", `${XML_HEADER}
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="${OFFICE_RELATIONSHIPS}"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Leer"><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm/></p:grpSpPr>
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`);
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", `${XML_HEADER}
<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">
  <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`);
  zip.file("ppt/slideMasters/slideMaster1.xml", `${XML_HEADER}
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="${OFFICE_RELATIONSHIPS}"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm/></p:grpSpPr>
  </p:spTree></p:cSld>
  <p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4"
    accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink"
    hlink="hlink" tx1="dk1" tx2="dk2"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>`);
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", `${XML_HEADER}
<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">
  <Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="${OFFICE_RELATIONSHIPS}/theme" Target="../theme/theme1.xml"/>
</Relationships>`);
  zip.file("ppt/theme/theme1.xml", `${XML_HEADER}
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="sortsys">
  <a:themeElements>
    <a:clrScheme name="sortsys">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2>
      <a:accent1><a:srgbClr val="0050E6"/></a:accent1><a:accent2><a:srgbClr val="6F6F6F"/></a:accent2>
      <a:accent3><a:srgbClr val="198038"/></a:accent3><a:accent4><a:srgbClr val="8A3FFC"/></a:accent4>
      <a:accent5><a:srgbClr val="0072C3"/></a:accent5><a:accent6><a:srgbClr val="BA4E00"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="sortsys"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="sortsys">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`);

  return zip.generateAsync({ type: "blob", mimeType: NEW_PROJECT_FILE_TYPES[1].mimeType });
}

export async function createBlankProjectFile(type: NewProjectFileType, fileName: string) {
  const definition = NEW_PROJECT_FILE_TYPES.find(entry => entry.type === type);
  if (!definition) throw new Error("Unsupported project file type");

  let blob: Blob;
  switch (type) {
    case "docx":
      blob = await createDocxBlob();
      break;
    case "pptx":
      blob = await createPptxBlob();
      break;
    case "xlsx":
      blob = await createXlsxBlob();
      break;
    case "drawio":
      blob = new Blob([
        `${XML_HEADER}
<mxfile host="sortsys" modified="${new Date().toISOString()}" version="31.1.8">
  <diagram id="page-1" name="Seite 1">
    <mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1"
      connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827"
      pageHeight="1169" math="0" shadow="0">
      <root><mxCell id="0"/><mxCell id="1" parent="0"/></root>
    </mxGraphModel>
  </diagram>
</mxfile>`,
      ], { type: definition.mimeType });
      break;
  }

  return new File([blob], fileName, {
    type: definition.mimeType,
    lastModified: Date.now(),
  });
}
