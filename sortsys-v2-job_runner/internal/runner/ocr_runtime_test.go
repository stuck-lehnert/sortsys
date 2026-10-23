package runner

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/xml"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Synthetic delivery-note text rendered with Go Regular. Embedding the raster
// keeps font-rendering dependencies out of the worker's module graph.
//
//go:embed fixtures/ocr-runtime.png
var ocrRuntimeSamplePNG []byte

// This suite also runs as a static test binary inside the production worker image.
func TestOCRRuntime(t *testing.T) {
	if os.Getenv("SORTSYS_TEST_OCR_TOOLS") != "1" {
		t.Skip("set SORTSYS_TEST_OCR_TOOLS=1 to require the native OCR runtime")
	}

	for _, tool := range []string{"convert", "pdftotext", "pdftoppm", "tesseract"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Fatalf("required OCR tool %s: %v", tool, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	languages, err := exec.CommandContext(ctx, "tesseract", "--list-langs").CombinedOutput()
	if err != nil {
		t.Fatalf("list recognition languages: %v (%s)", err, languages)
	}

	for _, language := range []string{"deu", "eng"} {
		if !slices.Contains(strings.Fields(string(languages)), language) {
			t.Fatalf("missing recognition language %s: %s", language, languages)
		}
	}

	t.Run("policy", func(t *testing.T) {
		assertOCRRuntimePolicy(t, ctx)
	})

	source := ocrRuntimeImage(t)

	for _, format := range []string{"png", "jpeg", "webp", "oriented-jpeg"} {
		t.Run(format, func(t *testing.T) {
			workDir := t.TempDir()
			data := encodeOCRRuntimeImage(t, source, format)
			sourcePath := filepath.Join(workDir, "source."+format)

			if err := os.WriteFile(sourcePath, data, 0o600); err != nil {
				t.Fatal(err)
			}

			// runImageOCR can fall back to the original input. Check preprocessing
			// separately so a missing ImageMagick module cannot pass unnoticed.
			prepared := filepath.Join(workDir, "preprocessed.png")
			command := exec.CommandContext(ctx, "convert", sourcePath, "-auto-orient",
				"-deskew", "40%", "-colorspace", "Gray", "-contrast-stretch", "0x8%", prepared)

			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("preprocess %s: %v (%s)", format, err, output)
			}

			preparedBytes, err := os.ReadFile(prepared)
			if err != nil {
				t.Fatal(err)
			}

			preparedImage, err := png.Decode(bytes.NewReader(preparedBytes))
			if err != nil {
				t.Fatalf("decode preprocessed image: %v", err)
			}

			if preparedImage.Bounds().Dx() <= preparedImage.Bounds().Dy() {
				t.Fatal("preprocessing did not preserve or restore landscape orientation")
			}

			result, err := runImageOCR(ctx, sourcePath, workDir)
			if err != nil {
				t.Fatal(err)
			}

			assertOCRRuntimeText(t, result, 1)
		})
	}

	t.Run("embedded-pdf", func(t *testing.T) {
		text := "Delivery note 2026: building materials for the construction site. " +
			"Invoice total 123.45 EUR. Quantity 24. Article concrete."
		stream := "BT /F1 12 Tf 20 300 Td (" + text + ") Tj ET"
		objects := [][]byte{
			[]byte("<< /Type /Catalog /Pages 2 0 R >>"),
			[]byte("<< /Type /Pages /Count 1 /Kids [3 0 R] >>"),
			[]byte("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 400] " +
				"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
			ocrRuntimePDFStream([]byte(stream)),
			[]byte("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
		}
		sourcePath := writeOCRRuntimePDF(t, objects)
		result, ok := extractEmbeddedPDFText(ctx, sourcePath)

		if !ok || result.Method != "embedded_pdf_text" || result.PageCount != 1 {
			t.Fatalf("embedded PDF extraction failed: %#v", result)
		}

		if !strings.Contains(result.Text, "Invoice total 123.45 EUR") {
			t.Fatalf("embedded PDF text was lost: %q", result.Text)
		}
	})

	t.Run("scanned-pdf", func(t *testing.T) {
		data := encodeOCRRuntimeImage(t, source, "jpeg")
		objects := [][]byte{
			[]byte("<< /Type /Catalog /Pages 2 0 R >>"),
			[]byte("<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>"),
		}

		for range 2 {
			contentID := len(objects) + 2
			page := fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 504 188] "+
				"/Resources << /XObject << /Scan 7 0 R >> >> /Contents %d 0 R >>", contentID)
			objects = append(objects, []byte(page),
				ocrRuntimePDFStream([]byte("q 504 0 0 188 0 0 cm /Scan Do Q")))
		}

		header := fmt.Sprintf("<< /Type /XObject /Subtype /Image /Width %d /Height %d "+
			"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n",
			source.Bounds().Dx(), source.Bounds().Dy(), len(data))
		imageObject := append([]byte(header), data...)
		imageObject = append(imageObject, []byte("\nendstream")...)
		objects = append(objects, imageObject)
		sourcePath := writeOCRRuntimePDF(t, objects)

		if _, ok := extractEmbeddedPDFText(ctx, sourcePath); ok {
			t.Fatal("scanned PDF unexpectedly contained embedded text")
		}

		result, err := runPDFOCR(ctx, sourcePath, t.TempDir())
		if err != nil {
			t.Fatal(err)
		}

		assertOCRRuntimeText(t, result, 2)

		if !strings.Contains(result.Text, "--- page ---") {
			t.Fatalf("missing page boundary: %q", result.Text)
		}
	})
}

type ocrRuntimeImagePolicy struct {
	Domain  string `xml:"domain,attr"`
	Rights  string `xml:"rights,attr"`
	Pattern string `xml:"pattern,attr"`
}

func assertOCRRuntimePolicy(t *testing.T, ctx context.Context) {
	t.Helper()

	configDirectory := os.Getenv("MAGICK_CONFIGURE_PATH")
	if configDirectory == "" {
		configDirectory = "/etc/ImageMagick-7"
	}

	data, err := os.ReadFile(filepath.Join(configDirectory, "policy.xml"))
	if err != nil {
		t.Fatal(err)
	}

	var document struct {
		XMLName  xml.Name                `xml:"policymap"`
		Policies []ocrRuntimeImagePolicy `xml:"policy"`
	}

	if err := xml.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}

	expected := []ocrRuntimeImagePolicy{
		{Domain: "Undefined", Rights: "none"},
		{Domain: "delegate", Rights: "none", Pattern: "*"},
		{Domain: "filter", Rights: "none", Pattern: "*"},
		{Domain: "path", Rights: "none", Pattern: "@*"},
		{Domain: "path", Rights: "none", Pattern: "|*"},
		{Domain: "path", Rights: "none", Pattern: "-"},
		{Domain: "module", Rights: "none", Pattern: "*"},
		{Domain: "module", Rights: "read|write", Pattern: "{JPEG,PNG,WEBP}"},
		{Domain: "coder", Rights: "none", Pattern: "*"},
		{Domain: "coder", Rights: "read|write", Pattern: "PNG"},
		{Domain: "coder", Rights: "read", Pattern: "{JPEG,WEBP}"},
	}

	if !slices.Equal(document.Policies, expected) {
		t.Fatalf("unexpected ImageMagick permissions or policy ordering: %#v", document.Policies)
	}

	workDir := t.TempDir()
	imagePath := filepath.Join(workDir, "allowed.png")

	if err := os.WriteFile(imagePath, ocrRuntimeSamplePNG, 0o600); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name    string
		prefix  string
		content string
	}{
		{
			name: "svg", prefix: "SVG:",
			content: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">` +
				`<rect width="32" height="32" fill="red"/></svg>`,
		},
		{
			name: "mvg", prefix: "MVG:",
			content: "push graphic-context\nviewbox 0 0 32 32\n" +
				"fill red\nrectangle 0,0 32,32\npop graphic-context\n",
		},
		{name: "indirect-file", prefix: "@", content: imagePath + "\n"},
	}

	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			source := filepath.Join(workDir, item.name+".source")
			if err := os.WriteFile(source, []byte(item.content), 0o600); err != nil {
				t.Fatal(err)
			}

			assertOCRRuntimeDenied(t, ctx, item.prefix+source,
				filepath.Join(workDir, item.name+".png"))
		})
	}

	t.Run("jpeg-output", func(t *testing.T) {
		assertOCRRuntimeDenied(t, ctx, imagePath, filepath.Join(workDir, "blocked.jpg"))
	})
}

func assertOCRRuntimeDenied(t *testing.T, ctx context.Context, source, destination string) {
	t.Helper()

	output, err := exec.CommandContext(ctx, "convert", source, destination).CombinedOutput()
	if err == nil {
		t.Fatalf("ImageMagick unexpectedly allowed %s -> %s", source, destination)
	}

	// Missing decoders or malformed fixtures do not prove policy enforcement.
	if !strings.Contains(strings.ToLower(string(output)), "security policy") {
		t.Fatalf("expected a policy denial, received %v (%s)", err, output)
	}
}

func ocrRuntimeImage(t *testing.T) image.Image {
	t.Helper()

	sample, err := png.Decode(bytes.NewReader(ocrRuntimeSamplePNG))
	if err != nil {
		t.Fatal(err)
	}

	return sample
}

func encodeOCRRuntimeImage(t *testing.T, source image.Image, format string) []byte {
	t.Helper()

	if format == "webp" {
		data, err := encodeWebPImage(source, false, 0)
		if err != nil {
			t.Fatal(err)
		}

		return data
	}

	if format == "oriented-jpeg" {
		bounds := source.Bounds()
		rotated := image.NewRGBA(image.Rect(0, 0, bounds.Dy(), bounds.Dx()))

		for y := 0; y < bounds.Dy(); y++ {
			for x := 0; x < bounds.Dx(); x++ {
				rotated.Set(y, bounds.Dx()-1-x, source.At(x, y))
			}
		}

		exif := []byte{
			'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0,
			0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0,
			0, 0, 0, 0,
		}

		return injectJPEGExif(encodeOCRRuntimeImage(t, rotated, "jpeg"), exif)
	}

	var buffer bytes.Buffer
	var err error

	if format == "png" {
		err = png.Encode(&buffer, source)
	} else {
		err = jpeg.Encode(&buffer, source, &jpeg.Options{Quality: 95})
	}

	if err != nil {
		t.Fatal(err)
	}

	return buffer.Bytes()
}

func assertOCRRuntimeText(t *testing.T, result deliveryNoteOCRCompleteResult, pages int) {
	t.Helper()

	if result.Method != "tesseract" || result.PageCount != pages {
		t.Fatalf("unexpected OCR metadata: %#v", result)
	}

	if result.Confidence <= 0 || result.Confidence > 1 {
		t.Fatalf("invalid OCR confidence: %v", result.Confidence)
	}

	for _, word := range []string{"Lieferschein", "Müller", "Beton", "Delivery", "123.45"} {
		if strings.Count(result.Text, word) < pages {
			t.Fatalf("OCR lost %q on one or more pages: %q", word, result.Text)
		}
	}
}

func ocrRuntimePDFStream(content []byte) []byte {
	header := fmt.Sprintf("<< /Length %d >>\nstream\n", len(content))
	return append(append([]byte(header), content...), []byte("\nendstream")...)
}

func writeOCRRuntimePDF(t *testing.T, objects [][]byte) string {
	t.Helper()

	var content bytes.Buffer
	content.WriteString("%PDF-1.4\n")
	offsets := []int{0}

	for index, object := range objects {
		offsets = append(offsets, content.Len())
		fmt.Fprintf(&content, "%d 0 obj\n", index+1)
		content.Write(object)
		content.WriteString("\nendobj\n")
	}

	xref := content.Len()
	fmt.Fprintf(&content, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))

	for _, offset := range offsets[1:] {
		fmt.Fprintf(&content, "%010d 00000 n \n", offset)
	}

	fmt.Fprintf(&content, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n",
		len(offsets), xref)
	sourcePath := filepath.Join(t.TempDir(), "document.pdf")

	if err := os.WriteFile(sourcePath, content.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	return sourcePath
}
