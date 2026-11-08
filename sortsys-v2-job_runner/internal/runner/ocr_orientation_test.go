package runner

import "testing"

func TestParseOCRRotation(t *testing.T) {
	for _, item := range []struct {
		name, output string
		want         int
	}{
		{"clockwise", "Orientation in degrees: 270\nRotate: 90\nOrientation confidence: 11.03\nScript: Cyrillic", 90},
		{"inverted", "Rotate: 180\nOrientation confidence: 20", 180},
		{"counterclockwise", "Rotate: 270\nOrientation confidence: 10", 270},
		{"upright", "Rotate: 0\nOrientation confidence: 30", 0},
		{"uncertain", "Rotate: 90\nOrientation confidence: 1.2", 0},
		{"weak candidate", "Rotate: 90\nOrientation confidence: 2.57", 90},
		{"missing confidence", "Rotate: 90", 0},
		{"not a quarter turn", "Rotate: 45\nOrientation confidence: 20", 0},
		{"wrong field", "Orientation in degrees: 270\nOrientation confidence: 20", 0},
		{"malformed", "Rotate: ninety\nOrientation confidence: 20", 0},
		{"nonfinite", "Rotate: 90\nOrientation confidence: NaN", 0},
		{"infinite", "Rotate: 90\nOrientation confidence: +Inf", 0},
		{"no text", "Too few characters. Skipping this page", 0},
	} {
		t.Run(item.name, func(t *testing.T) {
			if got := parseOCRRotation(item.output); got.rotation != item.want {
				t.Fatalf("rotation = %d, want %d", got.rotation, item.want)
			}
		})
	}
}
