package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	nativewebp "github.com/HugoSmits86/nativewebp"
)

func TestThumbnailUploadsOnlyThePreviewAndPreservesTheOriginal(t *testing.T) {
	t.Parallel()

	var original bytes.Buffer
	if err := png.Encode(&original, image.NewRGBA(image.Rect(0, 0, 80, 40))); err != nil {
		t.Fatal(err)
	}
	originalBytes := append([]byte(nil), original.Bytes()...)
	var lock sync.Mutex
	var requests []string
	var preview []byte
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		lock.Lock()
		defer lock.Unlock()
		requests = append(requests, request.Method+" "+request.URL.Path)
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/original.png":
			response.Write(originalBytes)
		case request.Method == http.MethodPut && request.URL.Path == "/thumbnail.webp":
			if request.Header.Get("Content-Type") != "image/webp" {
				t.Error("preview has the wrong content type")
			}
			if request.Header.Get("X-Upload-Token") != "preview-only" {
				t.Error("preview upload did not preserve its scoped headers")
			}
			var err error
			preview, err = io.ReadAll(request.Body)
			if err != nil {
				t.Error(err)
			}
			response.Header().Set("ETag", `"preview-etag"`)
			response.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected storage request: %s %s", request.Method, request.URL.Path)
			response.WriteHeader(http.StatusForbidden)
		}
	}))
	defer server.Close()

	worker := Runner{httpClient: server.Client()}
	result, err := worker.generateAndUploadThumbnail(context.Background(), thumbnailJobPayload{
		SourceObjectKey: "original.png", SourceMimeType: "image/png", SourceFileName: "Original.png",
		SourceDownloadURL:  server.URL + "/original.png",
		ThumbnailObjectKey: "thumbnail.webp", ThumbnailUploadURL: server.URL + "/thumbnail.webp",
		ThumbnailUploadHeaders: map[string]string{"X-Upload-Token": "preview-only"},
		MaxWidth:               20, MaxHeight: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	lock.Lock()
	defer lock.Unlock()
	if len(requests) != 2 || requests[0] != "GET /original.png" || requests[1] != "PUT /thumbnail.webp" {
		t.Fatalf("unexpected storage operations: %v", requests)
	}
	decoded, err := nativewebp.Decode(bytes.NewReader(preview))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Bounds().Dx() != 20 || decoded.Bounds().Dy() != 10 {
		t.Fatalf("unexpected preview dimensions: %v", decoded.Bounds())
	}
	if result.Width != 20 || result.Height != 10 || result.SizeBytes != int64(len(preview)) || result.ETag != "preview-etag" {
		t.Fatalf("incorrect preview receipt: %+v", result)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"sourceMimeType", "sourceFileName", "sourceSizeBytes", "sourceEtag"} {
		if _, exists := fields[field]; exists {
			t.Errorf("preview receipt must not replace original metadata: %s", field)
		}
	}
}

func TestInvalidThumbnailSourceDoesNotUploadAnything(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			t.Errorf("invalid source triggered an upload: %s", request.Method)
			response.WriteHeader(http.StatusForbidden)
			return
		}
		response.Write([]byte("not an image"))
	}))
	defer server.Close()
	worker := Runner{httpClient: server.Client()}
	_, err := worker.generateAndUploadThumbnail(context.Background(), thumbnailJobPayload{
		SourceDownloadURL:  server.URL + "/original.png",
		ThumbnailUploadURL: server.URL + "/thumbnail.webp",
	})
	if err == nil {
		t.Fatal("invalid image was accepted")
	}
}
