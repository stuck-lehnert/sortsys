.PHONY: all icons clean copy

all: icons copy

copy: icons
	cp icon*.png icon*.svg android*.png android*.svg ../public

clean:
	rm -rf *.png *.ico

icons: icon-192x192.png icon-512x512.png icon-white-192x192.png icon-white-512x512.png icon-black-192x192.png icon-black-512x512.png icon-maskable-192x192.png icon-maskable-512x512.png logo-white.png logo-black.png apple-touch-icon.png android-icon-maskable-512x512.png android-icon-black-512x512.png android-icon-white-512x512.png

icon-%.png: icon.svg
	magick -background none -density 768 $< -resize $* $@

icon-white-%.png: icon-white.svg
	magick -background none -density 768 $< -resize $* $@

icon-black-%.png: icon-black.svg
	magick -background none -density 768 $< -resize $* $@

icon-maskable-%.png: icon-maskable.svg
	magick -background none -density 768 $< -resize $* $@

logo-white.png: logo-white.svg
	magick -background none -density 768 $< $@

logo-black.png: logo-black.svg
	magick -background none -density 768 $< $@

apple-touch-icon.png: icon.svg
	magick -background none -density 768 $< -resize 180x180 $@

android-icon-maskable%.png: android-icon-maskable.svg
	magick -background none -density 768 $< -resize $* $@

android-icon-black-%.png: android-icon-black.svg
	magick -background none -density 768 $< -resize $* $@

android-icon-white-%.png: android-icon-black.svg
	magick -background none -density 768 $< -resize $* $@
