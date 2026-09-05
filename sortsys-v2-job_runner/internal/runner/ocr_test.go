package runner

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestParseDeliveryNoteOCRJobPayload(t *testing.T) {
	raw, err := json.Marshal(map[string]string{
		"sourceObjectKey":   "tenant/scans/note.png",
		"sourceMimeType":    "image/png",
		"sourceFileName":    "note.png",
		"sourceDownloadUrl": "http://storage/note.png",
	})
	if err != nil {
		t.Fatal(err)
	}

	payload, err := parseDeliveryNoteOCRJobPayload(raw)
	if err != nil {
		t.Fatalf("expected valid payload: %v", err)
	}
	if payload.SourceObjectKey != "tenant/scans/note.png" {
		t.Fatalf("unexpected object key %q", payload.SourceObjectKey)
	}
}

func TestOCRPayloadRejectsUnsupportedDocuments(t *testing.T) {
	raw := []byte(`{"sourceMimeType":"image/svg+xml","sourceDownloadUrl":"http://storage/note.svg"}`)
	if _, err := parseDeliveryNoteOCRJobPayload(raw); err == nil {
		t.Fatal("expected SVG payload to be rejected")
	}
}

func TestOCRPayloadAcceptsXLSXDocuments(t *testing.T) {
	raw := []byte(`{"sourceMimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","sourceFileName":"prices.xlsx","sourceDownloadUrl":"http://storage/prices.xlsx"}`)

	if _, err := parseDeliveryNoteOCRJobPayload(raw); err != nil {
		t.Fatalf("expected XLSX payload to be accepted: %v", err)
	}
}

func TestExtractXLSXTextPreservesWorksheetsColumnsAndValues(t *testing.T) {
	var workbook bytes.Buffer
	archive := zip.NewWriter(&workbook)

	files := map[string]string{
		"xl/workbook.xml":            `<?xml version="1.0"?><workbook xmlns:r="relationships"><sheets><sheet name="Preise 2026" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
		"xl/sharedStrings.xml":       `<?xml version="1.0"?><sst><si><t>Artikel</t></si><si><t>Gipsplatte 12,5 mm</t></si><si><t>Preis</t></si></sst>`,
		"xl/worksheets/sheet1.xml":   `<?xml version="1.0"?><worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row><row><c r="A2" t="s"><v>1</v></c><c r="C2"><v>8.75</v></c></row></sheetData></worksheet>`,
	}

	for name, content := range files {
		file, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}

	result, err := extractXLSXText(workbook.Bytes())
	if err != nil {
		t.Fatalf("extract XLSX text: %v", err)
	}

	if result.Method != "xlsx" || result.Confidence != 1 || result.PageCount != 1 {
		t.Fatalf("unexpected XLSX metadata: %#v", result)
	}
	if !strings.Contains(result.Text, "--- worksheet: Preise 2026 ---") {
		t.Fatalf("missing worksheet marker in %q", result.Text)
	}
	if !strings.Contains(result.Text, "Artikel\t\tPreis") {
		t.Fatalf("missing empty middle column in %q", result.Text)
	}
	if !strings.Contains(result.Text, "Gipsplatte 12,5 mm\t\t8.75") {
		t.Fatalf("missing worksheet row in %q", result.Text)
	}
}

func TestNormalizeOCRTextBoundsProviderInput(t *testing.T) {
	input := strings.Repeat("x", 1_000_100)
	output := normalizeOCRText("\r\n" + input + "\r\n")

	if len([]rune(output)) != 1_000_000 {
		t.Fatalf("expected 1000000 runes, got %d", len([]rune(output)))
	}
	if strings.Contains(output, "\r") {
		t.Fatal("expected carriage returns to be normalized")
	}
}
