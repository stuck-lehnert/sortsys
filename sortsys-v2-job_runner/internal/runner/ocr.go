package runner

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

const minimumEmbeddedPDFTextLength = 80

type deliveryNoteOCRJobPayload struct {
	SourceObjectKey   string `json:"sourceObjectKey"`
	SourceMimeType    string `json:"sourceMimeType"`
	SourceFileName    string `json:"sourceFileName"`
	SourceDownloadURL string `json:"sourceDownloadUrl"`
}

type deliveryNoteOCRCompleteResult struct {
	Text       string   `json:"text"`
	Confidence float64  `json:"confidence"`
	Method     string   `json:"method"`
	PageCount  int      `json:"pageCount"`
	Warnings   []string `json:"warnings"`
}

func parseDeliveryNoteOCRJobPayload(raw []byte) (deliveryNoteOCRJobPayload, error) {
	var payload deliveryNoteOCRJobPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return payload, fmt.Errorf("parse delivery-note OCR payload: %w", err)
	}
	if strings.TrimSpace(payload.SourceDownloadURL) == "" {
		return payload, fmt.Errorf("missing sourceDownloadUrl")
	}
	if !isSupportedOCRMimeType(payload.SourceMimeType) {
		return payload, fmt.Errorf("unsupported OCR MIME type %q", payload.SourceMimeType)
	}
	return payload, nil
}

func (r *Runner) extractDeliveryNoteText(ctx context.Context, payload deliveryNoteOCRJobPayload) (deliveryNoteOCRCompleteResult, error) {
	source, err := r.downloadBytes(ctx, payload.SourceDownloadURL)
	if err != nil {
		return deliveryNoteOCRCompleteResult{}, err
	}
	workDir, err := os.MkdirTemp("", "sortsys-ocr-")
	if err != nil {
		return deliveryNoteOCRCompleteResult{}, fmt.Errorf("create OCR work directory: %w", err)
	}
	defer os.RemoveAll(workDir)

	sourcePath := filepath.Join(workDir, "source"+ocrFileExtension(payload.SourceMimeType))
	if err := os.WriteFile(sourcePath, source, 0o600); err != nil {
		return deliveryNoteOCRCompleteResult{}, fmt.Errorf("write OCR source: %w", err)
	}

	if payload.SourceMimeType == "application/pdf" {
		if result, ok := extractEmbeddedPDFText(ctx, sourcePath); ok {
			return result, nil
		}
		return runPDFOCR(ctx, sourcePath, workDir)
	}
	if isXLSX(payload.SourceMimeType, payload.SourceFileName) {
		return extractXLSXText(source)
	}
	return runImageOCR(ctx, sourcePath, workDir)
}

type xlsxWorkbook struct {
	Sheets []xlsxSheet `xml:"sheets>sheet"`
}

type xlsxSheet struct {
	Name           string `xml:"name,attr"`
	RelationshipID string `xml:"id,attr"`
}

type xlsxRelationships struct {
	Items []xlsxRelationship `xml:"Relationship"`
}

type xlsxRelationship struct {
	ID     string `xml:"Id,attr"`
	Target string `xml:"Target,attr"`
}

type xlsxWorksheet struct {
	Rows []xlsxRow `xml:"sheetData>row"`
}

type xlsxRow struct {
	Cells []xlsxCell `xml:"c"`
}

type xlsxCell struct {
	Reference string     `xml:"r,attr"`
	Type      string     `xml:"t,attr"`
	Value     string     `xml:"v"`
	Inline    xlsxInline `xml:"is"`
}

type xlsxInline struct {
	Text string    `xml:"t"`
	Runs []xlsxRun `xml:"r"`
}

type xlsxRun struct {
	Text string `xml:"t"`
}

type xlsxSharedStrings struct {
	Items []xlsxInline `xml:"si"`
}

// extractXLSXText keeps the workbook's sheet and row structure intact. The LLM
// can therefore infer headers and columns without receiving the binary file.
func extractXLSXText(source []byte) (deliveryNoteOCRCompleteResult, error) {
	reader, err := zip.NewReader(bytes.NewReader(source), int64(len(source)))
	if err != nil {
		return deliveryNoteOCRCompleteResult{}, fmt.Errorf("open XLSX workbook: %w", err)
	}

	files := make(map[string]*zip.File, len(reader.File))
	for _, file := range reader.File {
		files[path.Clean(file.Name)] = file
	}

	sharedStrings, err := readXLSXSharedStrings(files)
	if err != nil {
		return deliveryNoteOCRCompleteResult{}, err
	}

	sheets, err := readXLSXSheets(files)
	if err != nil {
		return deliveryNoteOCRCompleteResult{}, err
	}

	var transcript strings.Builder
	for sheetIndex, sheet := range sheets {
		worksheet, err := readXLSXXML[xlsxWorksheet](files, sheet.Path)
		if err != nil {
			return deliveryNoteOCRCompleteResult{}, fmt.Errorf("read XLSX sheet %q: %w", sheet.Name, err)
		}

		if sheetIndex > 0 {
			transcript.WriteString("\n\n")
		}
		fmt.Fprintf(&transcript, "--- worksheet: %s ---\n", sheet.Name)

		for _, row := range worksheet.Rows {
			values := make([]string, 0, len(row.Cells))
			lastColumn := -1

			for _, cell := range row.Cells {
				column := xlsxColumnIndex(cell.Reference)
				for lastColumn+1 < column {
					values = append(values, "")
					lastColumn++
				}

				values = append(values, xlsxCellText(cell, sharedStrings))
				lastColumn = column
			}

			for len(values) > 0 && values[len(values)-1] == "" {
				values = values[:len(values)-1]
			}
			if len(values) > 0 {
				transcript.WriteString(strings.Join(values, "\t"))
				transcript.WriteByte('\n')
			}
		}
	}

	text := normalizeOCRText(transcript.String())
	if text == "" {
		return deliveryNoteOCRCompleteResult{}, fmt.Errorf("XLSX workbook contains no readable cells")
	}

	return deliveryNoteOCRCompleteResult{
		Text:       text,
		Confidence: 1,
		Method:     "xlsx",
		PageCount:  len(sheets),
		Warnings:   []string{},
	}, nil
}

type namedXLSXSheet struct {
	Name string
	Path string
}

func readXLSXSheets(files map[string]*zip.File) ([]namedXLSXSheet, error) {
	workbook, err := readXLSXXML[xlsxWorkbook](files, "xl/workbook.xml")
	if err != nil {
		return nil, fmt.Errorf("read XLSX workbook metadata: %w", err)
	}
	relationships, err := readXLSXXML[xlsxRelationships](files, "xl/_rels/workbook.xml.rels")
	if err != nil {
		return nil, fmt.Errorf("read XLSX workbook relationships: %w", err)
	}

	targets := make(map[string]string, len(relationships.Items))
	for _, relationship := range relationships.Items {
		target := strings.TrimPrefix(relationship.Target, "/")
		if !strings.HasPrefix(target, "xl/") {
			target = path.Join("xl", target)
		}
		targets[relationship.ID] = path.Clean(target)
	}

	sheets := make([]namedXLSXSheet, 0, len(workbook.Sheets))
	for _, sheet := range workbook.Sheets {
		if target := targets[sheet.RelationshipID]; target != "" {
			sheets = append(sheets, namedXLSXSheet{Name: sheet.Name, Path: target})
		}
	}
	if len(sheets) == 0 {
		return nil, fmt.Errorf("XLSX workbook contains no worksheets")
	}

	return sheets, nil
}

func readXLSXSharedStrings(files map[string]*zip.File) ([]string, error) {
	if files["xl/sharedStrings.xml"] == nil {
		return nil, nil
	}

	shared, err := readXLSXXML[xlsxSharedStrings](files, "xl/sharedStrings.xml")
	if err != nil {
		return nil, fmt.Errorf("read XLSX shared strings: %w", err)
	}

	values := make([]string, 0, len(shared.Items))
	for _, item := range shared.Items {
		values = append(values, xlsxInlineText(item))
	}

	return values, nil
}

func readXLSXXML[T any](files map[string]*zip.File, fileName string) (T, error) {
	var value T
	file := files[path.Clean(fileName)]
	if file == nil {
		return value, fmt.Errorf("missing %s", fileName)
	}

	stream, err := file.Open()
	if err != nil {
		return value, err
	}
	defer stream.Close()

	decoder := xml.NewDecoder(io.LimitReader(stream, 64*1024*1024))
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}

	return value, nil
}

func xlsxCellText(cell xlsxCell, sharedStrings []string) string {
	switch cell.Type {
	case "s":
		index, err := strconv.Atoi(strings.TrimSpace(cell.Value))
		if err == nil && index >= 0 && index < len(sharedStrings) {
			return sharedStrings[index]
		}
		return ""
	case "inlineStr":
		return xlsxInlineText(cell.Inline)
	case "b":
		if strings.TrimSpace(cell.Value) == "1" {
			return "true"
		}
		return "false"
	default:
		return strings.TrimSpace(cell.Value)
	}
}

func xlsxInlineText(value xlsxInline) string {
	if value.Text != "" {
		return strings.TrimSpace(value.Text)
	}

	parts := make([]string, 0, len(value.Runs))
	for _, run := range value.Runs {
		parts = append(parts, run.Text)
	}

	return strings.TrimSpace(strings.Join(parts, ""))
}

func xlsxColumnIndex(reference string) int {
	column := 0
	found := false
	for _, character := range strings.ToUpper(reference) {
		if character < 'A' || character > 'Z' {
			break
		}
		column = column*26 + int(character-'A'+1)
		found = true
	}
	if !found {
		return 0
	}

	return column - 1
}

func extractEmbeddedPDFText(ctx context.Context, sourcePath string) (deliveryNoteOCRCompleteResult, bool) {
	output, err := exec.CommandContext(ctx, "pdftotext", "-layout", sourcePath, "-").Output()
	if err != nil {
		return deliveryNoteOCRCompleteResult{}, false
	}
	text := normalizeOCRText(string(output))
	if len([]rune(text)) < minimumEmbeddedPDFTextLength {
		return deliveryNoteOCRCompleteResult{}, false
	}
	return deliveryNoteOCRCompleteResult{
		Text: text, Confidence: 1, Method: "embedded_pdf_text",
		PageCount: max(1, strings.Count(string(output), "\f")), Warnings: []string{},
	}, true
}

func runPDFOCR(ctx context.Context, sourcePath, workDir string) (deliveryNoteOCRCompleteResult, error) {
	prefix := filepath.Join(workDir, "page")
	command := exec.CommandContext(ctx, "pdftoppm", "-r", "220", "-png", sourcePath, prefix)
	if output, err := command.CombinedOutput(); err != nil {
		return deliveryNoteOCRCompleteResult{}, fmt.Errorf("render PDF for OCR: %w (%s)", err, strings.TrimSpace(string(output)))
	}
	pages, err := filepath.Glob(prefix + "-*.png")
	if err != nil || len(pages) == 0 {
		return deliveryNoteOCRCompleteResult{}, fmt.Errorf("PDF renderer produced no pages")
	}
	return recognizeOCRPages(ctx, pages)
}

func runImageOCR(ctx context.Context, sourcePath, workDir string) (deliveryNoteOCRCompleteResult, error) {
	prepared := filepath.Join(workDir, "prepared.png")
	command := exec.CommandContext(ctx, "convert", sourcePath, "-auto-orient", "-deskew", "40%", "-colorspace", "Gray", "-contrast-stretch", "0x8%", prepared)
	if err := command.Run(); err != nil {
		prepared = sourcePath
	}
	return recognizeOCRPages(ctx, []string{prepared})
}

func recognizeOCRPages(ctx context.Context, pages []string) (deliveryNoteOCRCompleteResult, error) {
	var texts []string
	var weightedConfidence float64
	var samples int
	for index, page := range pages {
		text, confidence, count, err := recognizeOCRPage(ctx, page)
		if err != nil {
			return deliveryNoteOCRCompleteResult{}, fmt.Errorf("OCR page %d: %w", index+1, err)
		}
		texts = append(texts, text)
		weightedConfidence += confidence * float64(count)
		samples += count
	}
	confidence := 0.0
	if samples > 0 {
		confidence = weightedConfidence / float64(samples)
	}
	warnings := []string{}
	if confidence < 0.72 {
		warnings = append(warnings, "local OCR confidence is low; use document fallback")
	}
	return deliveryNoteOCRCompleteResult{
		Text:       normalizeOCRText(strings.Join(texts, "\n\n--- page ---\n\n")),
		Confidence: confidence, Method: "tesseract", PageCount: len(pages), Warnings: warnings,
	}, nil
}

func recognizeOCRPage(ctx context.Context, imagePath string) (string, float64, int, error) {
	output, err := exec.CommandContext(ctx, "tesseract", imagePath, "stdout", "-l", "deu+eng", "--psm", "6", "tsv").Output()
	if err != nil {
		return "", 0, 0, fmt.Errorf("run tesseract: %w", err)
	}
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	var text strings.Builder
	var previousLine string
	var sum float64
	var count int
	for scanner.Scan() {
		fields := strings.SplitN(scanner.Text(), "\t", 12)
		if len(fields) != 12 || fields[0] == "level" || strings.TrimSpace(fields[11]) == "" {
			continue
		}
		line := strings.Join(fields[1:5], ":")
		if text.Len() > 0 {
			if line != previousLine {
				text.WriteByte('\n')
			} else {
				text.WriteByte(' ')
			}
		}
		text.WriteString(strings.TrimSpace(fields[11]))
		previousLine = line
		if value, parseErr := strconv.ParseFloat(fields[10], 64); parseErr == nil && value >= 0 {
			sum += value / 100
			count++
		}
	}
	if err := scanner.Err(); err != nil {
		return "", 0, 0, fmt.Errorf("read tesseract output: %w", err)
	}
	if count == 0 {
		return text.String(), 0, 0, nil
	}
	return text.String(), sum / float64(count), count, nil
}

func normalizeOCRText(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n"))
	runes := []rune(value)
	if len(runes) > 1_000_000 {
		return string(runes[:1_000_000])
	}
	return value
}

func isSupportedOCRMimeType(value string) bool {
	return value == "application/pdf" || value == "image/jpeg" || value == "image/png" || value == "image/webp" || value == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}

func isXLSX(mimeType, fileName string) bool {
	return mimeType == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || strings.EqualFold(filepath.Ext(fileName), ".xlsx")
}

func ocrFileExtension(value string) string {
	switch value {
	case "application/pdf":
		return ".pdf"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		return ".xlsx"
	default:
		return ".png"
	}
}
