package runner

import (
	"context"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type ocrOrientation struct {
	rotation   int
	confidence float64
}

// EXIF describes the camera orientation, not necessarily the direction of the
// text on a photographed sheet. Detect text direction after applying EXIF.
func detectOCRRotation(ctx context.Context, sourcePath, previewPath string) ocrOrientation {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "convert", sourcePath, "-auto-orient",
		"-resize", "2000x2000>", "-colorspace", "Gray", previewPath).Run(); err != nil {
		return ocrOrientation{}
	}
	output, err := exec.CommandContext(ctx, "tesseract", previewPath, "stdout",
		"-l", "osd", "--psm", "0").Output()
	if err != nil {
		// Short notes can contain too little text for orientation detection.
		return ocrOrientation{}
	}
	return parseOCRRotation(string(output))
}

func parseOCRRotation(output string) ocrOrientation {
	rotation, confidence := -1, 0.0
	for _, line := range strings.Split(output, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "Rotate":
			if parsed, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
				rotation = parsed
			}
		case "Orientation confidence":
			if parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
				confidence = parsed
			}
		}
	}
	if math.IsNaN(confidence) || math.IsInf(confidence, 0) || confidence < 2 {
		return ocrOrientation{}
	}
	if rotation == 90 || rotation == 180 || rotation == 270 {
		return ocrOrientation{rotation: rotation, confidence: confidence}
	}
	return ocrOrientation{}
}
