package runner

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	nativewebp "github.com/HugoSmits86/nativewebp"
	"golang.org/x/image/draw"
)

type ThumbnailResult struct {
	Data   []byte
	Width  int
	Height int
}

func ResizeToWebP(input []byte, maxWidth int, maxHeight int) (ThumbnailResult, error) {
	if maxWidth < 1 || maxHeight < 1 {
		return ThumbnailResult{}, fmt.Errorf("max dimensions must be positive")
	}

	source, err := decodeImage(input)
	if err != nil {
		return ThumbnailResult{}, err
	}

	width := source.Bounds().Dx()
	height := source.Bounds().Dy()
	targetWidth, targetHeight := fitWithin(width, height, maxWidth, maxHeight)

	var target image.Image
	if targetWidth == width && targetHeight == height {
		target = source
	} else {
		dst := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
		draw.CatmullRom.Scale(dst, dst.Bounds(), source, source.Bounds(), draw.Over, nil)
		target = dst
	}

	encoded, err := encodeWebPImage(target, false, len(input)/2)
	if err != nil {
		return ThumbnailResult{}, err
	}

	return ThumbnailResult{Data: encoded, Width: targetWidth, Height: targetHeight}, nil
}

func ConvertToWebP(input []byte) (ThumbnailResult, error) {
	source, err := decodeImage(input)
	if err != nil {
		return ThumbnailResult{}, err
	}

	exifMetadata := extractEXIFMetadataFromBytes(input)

	encoded, err := encodeWebPImage(source, len(exifMetadata) > 0, len(input))
	if err != nil {
		return ThumbnailResult{}, err
	}

	if len(exifMetadata) > 0 {
		if withExif, attachErr := attachEXIFMetadataToWebP(encoded, exifMetadata); attachErr == nil {
			encoded = withExif
		}
	}

	return ThumbnailResult{
		Data:   encoded,
		Width:  source.Bounds().Dx(),
		Height: source.Bounds().Dy(),
	}, nil
}

func ConvertToBlackAndWhiteWebP(input []byte) (ThumbnailResult, error) {
	source, err := decodeImage(input)
	if err != nil {
		return ThumbnailResult{}, err
	}

	bounds := source.Bounds()
	target := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	hasTransparency := false

	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			r, g, b, a := source.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()

			alpha := uint8(a >> 8)
			if alpha < 255 {
				hasTransparency = true
			}

			if alpha == 0 {
				target.SetNRGBA(x, y, color.NRGBA{R: 255, G: 255, B: 255, A: 0})
				continue
			}

			red := int(r >> 8)
			green := int(g >> 8)
			blue := int(b >> 8)
			luma := (299*red + 587*green + 114*blue) / 1000

			shade := uint8(0)
			if luma >= 160 {
				shade = 255
			}

			target.SetNRGBA(x, y, color.NRGBA{R: shade, G: shade, B: shade, A: alpha})
		}
	}

	encoded, err := encodeWebPImage(target, hasTransparency, len(input))
	if err != nil {
		return ThumbnailResult{}, err
	}

	return ThumbnailResult{
		Data:   encoded,
		Width:  bounds.Dx(),
		Height: bounds.Dy(),
	}, nil
}

func decodeImage(input []byte) (image.Image, error) {
	source, _, err := image.Decode(bytes.NewReader(input))
	if err == nil {
		return source, nil
	}

	webpSource, webpErr := nativewebp.Decode(bytes.NewReader(input))
	if webpErr == nil {
		return webpSource, nil
	}

	return nil, fmt.Errorf("decode source image: %w", err)
}

func encodeWebPImage(source image.Image, useExtendedFormat bool, capacityHint int) ([]byte, error) {
	if capacityHint < 0 {
		capacityHint = 0
	}

	buf := bytes.NewBuffer(make([]byte, 0, capacityHint))
	if err := nativewebp.Encode(buf, source, &nativewebp.Options{UseExtendedFormat: useExtendedFormat}); err != nil {
		return nil, fmt.Errorf("encode thumbnail webp: %w", err)
	}

	return buf.Bytes(), nil
}

func extractEXIFMetadataFromBytes(input []byte) []byte {
	if exif := extractEXIFFromJPEG(input); len(exif) > 0 {
		return exif
	}

	if exif := extractEXIFFromPNG(input); len(exif) > 0 {
		return exif
	}

	if exif := extractEXIFfromWebP(input); len(exif) > 0 {
		return exif
	}

	return nil
}

func extractEXIFFromJPEG(input []byte) []byte {
	if len(input) < 4 || input[0] != 0xFF || input[1] != 0xD8 {
		return nil
	}

	offset := 2
	for offset+1 < len(input) {
		if input[offset] != 0xFF {
			offset += 1
			continue
		}

		for offset < len(input) && input[offset] == 0xFF {
			offset += 1
		}
		if offset >= len(input) {
			break
		}

		marker := input[offset]
		offset += 1

		if marker == 0xD9 || marker == 0xDA {
			break
		}

		if marker >= 0xD0 && marker <= 0xD7 {
			continue
		}

		if offset+2 > len(input) {
			break
		}

		segmentLength := int(binary.BigEndian.Uint16(input[offset : offset+2]))
		offset += 2
		if segmentLength < 2 || offset+segmentLength-2 > len(input) {
			break
		}

		segment := input[offset : offset+segmentLength-2]
		offset += segmentLength - 2

		if marker == 0xE1 && len(segment) >= 6 && bytes.Equal(segment[:6], []byte("Exif\x00\x00")) {
			payload := make([]byte, len(segment)-6)
			copy(payload, segment[6:])
			return payload
		}
	}

	return nil
}

func extractEXIFFromPNG(input []byte) []byte {
	pngSignature := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}
	if len(input) < len(pngSignature) || !bytes.Equal(input[:len(pngSignature)], pngSignature) {
		return nil
	}

	offset := len(pngSignature)
	for offset+8 <= len(input) {
		chunkSize := int(binary.BigEndian.Uint32(input[offset : offset+4]))
		offset += 4
		if chunkSize < 0 || offset+4+chunkSize+4 > len(input) {
			break
		}

		chunkType := string(input[offset : offset+4])
		offset += 4

		chunkData := input[offset : offset+chunkSize]
		offset += chunkSize

		offset += 4 // CRC

		if chunkType == "eXIf" {
			payload := make([]byte, len(chunkData))
			copy(payload, chunkData)
			return payload
		}

		if chunkType == "IEND" {
			break
		}
	}

	return nil
}

func extractEXIFfromWebP(input []byte) []byte {
	if len(input) < 12 || !bytes.Equal(input[:4], []byte("RIFF")) || !bytes.Equal(input[8:12], []byte("WEBP")) {
		return nil
	}

	offset := 12
	for offset+8 <= len(input) {
		chunkType := string(input[offset : offset+4])
		chunkSize := int(binary.LittleEndian.Uint32(input[offset+4 : offset+8]))
		chunkStart := offset + 8
		if chunkSize < 0 || chunkStart+chunkSize > len(input) {
			break
		}

		if chunkType == "EXIF" {
			payload := make([]byte, chunkSize)
			copy(payload, input[chunkStart:chunkStart+chunkSize])
			return payload
		}

		offset = chunkStart + chunkSize
		if chunkSize%2 == 1 {
			offset += 1
		}
	}

	return nil
}

func attachEXIFMetadataToWebP(webpData []byte, exifData []byte) ([]byte, error) {
	if len(exifData) == 0 {
		return webpData, nil
	}

	if len(webpData) < 12 || !bytes.Equal(webpData[:4], []byte("RIFF")) || !bytes.Equal(webpData[8:12], []byte("WEBP")) {
		return nil, fmt.Errorf("invalid webp container")
	}

	updated := make([]byte, len(webpData))
	copy(updated, webpData)

	if !setVP8XExifFlag(updated) {
		return nil, fmt.Errorf("webp output missing VP8X chunk")
	}

	updated = appendRIFFChunk(updated, "EXIF", exifData)
	return updated, nil
}

func setVP8XExifFlag(webpData []byte) bool {
	offset := 12
	for offset+8 <= len(webpData) {
		chunkType := string(webpData[offset : offset+4])
		chunkSize := int(binary.LittleEndian.Uint32(webpData[offset+4 : offset+8]))
		chunkStart := offset + 8
		if chunkSize < 0 || chunkStart+chunkSize > len(webpData) {
			return false
		}

		if chunkType == "VP8X" && chunkSize >= 10 {
			webpData[chunkStart] |= 1 << 3
			return true
		}

		offset = chunkStart + chunkSize
		if chunkSize%2 == 1 {
			offset += 1
		}
	}

	return false
}

func appendRIFFChunk(webpData []byte, chunkType string, payload []byte) []byte {
	updated := append([]byte{}, webpData...)

	updated = append(updated, []byte(chunkType)...)

	sizeBytes := make([]byte, 4)
	binary.LittleEndian.PutUint32(sizeBytes, uint32(len(payload)))
	updated = append(updated, sizeBytes...)

	updated = append(updated, payload...)
	if len(payload)%2 == 1 {
		updated = append(updated, 0)
	}

	binary.LittleEndian.PutUint32(updated[4:8], uint32(len(updated)-8))
	return updated
}

func fitWithin(width int, height int, maxWidth int, maxHeight int) (int, int) {
	if width <= maxWidth && height <= maxHeight {
		return width, height
	}

	wr := float64(maxWidth) / float64(width)
	hr := float64(maxHeight) / float64(height)
	scale := wr
	if hr < scale {
		scale = hr
	}

	newWidth := int(float64(width) * scale)
	newHeight := int(float64(height) * scale)
	if newWidth < 1 {
		newWidth = 1
	}
	if newHeight < 1 {
		newHeight = 1
	}

	return newWidth, newHeight
}
