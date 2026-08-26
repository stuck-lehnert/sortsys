package runner

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"

	nativewebp "github.com/HugoSmits86/nativewebp"
)

func TestFitWithinPreservesAspectRatio(t *testing.T) {
	t.Parallel()

	w, h := fitWithin(2400, 1200, 240, 240)
	if w != 240 || h != 120 {
		t.Fatalf("unexpected dimensions: got %dx%d", w, h)
	}
}

func TestConvertToWebPPreservesJPEGExifMetadata(t *testing.T) {
	t.Parallel()

	src := image.NewRGBA(image.Rect(0, 0, 64, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 64; x++ {
			src.Set(x, y, color.RGBA{R: 210, G: 120, B: 80, A: 255})
		}
	}

	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, src, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode source jpeg: %v", err)
	}

	exifPayload := []byte{'I', 'I', '*', 0, 8, 0, 0, 0, 0, 0}
	jpegWithExif := injectJPEGExif(encoded.Bytes(), exifPayload)

	converted, err := ConvertToWebP(jpegWithExif)
	if err != nil {
		t.Fatalf("ConvertToWebP returned error: %v", err)
	}

	preservedExif := extractEXIFfromWebP(converted.Data)
	if len(preservedExif) == 0 {
		t.Fatalf("expected EXIF metadata in converted webp")
	}

	if !bytes.Equal(preservedExif, exifPayload) {
		t.Fatalf("unexpected EXIF payload after conversion")
	}
}

func injectJPEGExif(jpegData []byte, exifPayload []byte) []byte {
	app1Data := append([]byte("Exif\x00\x00"), exifPayload...)
	segmentLen := len(app1Data) + 2

	segment := make([]byte, 0, segmentLen+2)
	segment = append(segment, 0xFF, 0xE1)
	lengthField := make([]byte, 2)
	binary.BigEndian.PutUint16(lengthField, uint16(segmentLen))
	segment = append(segment, lengthField...)
	segment = append(segment, app1Data...)

	output := make([]byte, 0, len(jpegData)+len(segment))
	output = append(output, jpegData[:2]...)
	output = append(output, segment...)
	output = append(output, jpegData[2:]...)
	return output
}

func TestResizeToWebPDoesNotUpscaleSmallImage(t *testing.T) {
	t.Parallel()

	src := image.NewRGBA(image.Rect(0, 0, 120, 60))
	for y := 0; y < 60; y++ {
		for x := 0; x < 120; x++ {
			src.Set(x, y, color.RGBA{R: 100, G: 150, B: 220, A: 255})
		}
	}

	var encoded bytes.Buffer
	if err := png.Encode(&encoded, src); err != nil {
		t.Fatalf("encode source: %v", err)
	}

	resized, err := ResizeToWebP(encoded.Bytes(), 240, 240)
	if err != nil {
		t.Fatalf("ResizeToWebP returned error: %v", err)
	}

	if resized.Width != 120 || resized.Height != 60 {
		t.Fatalf("expected no upscaling to 120x60, got %dx%d", resized.Width, resized.Height)
	}

	if len(resized.Data) == 0 {
		t.Fatalf("expected webp output bytes")
	}

	decoded, err := nativewebp.Decode(bytes.NewReader(resized.Data))
	if err != nil {
		t.Fatalf("decode webp result: %v", err)
	}

	if decoded.Bounds().Dx() != resized.Width || decoded.Bounds().Dy() != resized.Height {
		t.Fatalf("decoded dimensions mismatch: got %dx%d, expected %dx%d", decoded.Bounds().Dx(), decoded.Bounds().Dy(), resized.Width, resized.Height)
	}
}
