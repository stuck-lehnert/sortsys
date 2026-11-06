# Fixed, fictional development documents

The PDF plans, DWG plans and email examples in this directory are authored for
sortsys. Company, people, addresses and project details are fictional. These
files are repository fixtures; the development seed reads their committed bytes
and never regenerates them. `manifest.json` pins their hashes and sizes.

- `grundriss-erdgeschoss.{pdf,dwg}` and `grundriss-obergeschoss.{pdf,dwg}`:
  schematic architectural plans with walls, room names and dimensions.
- `baubesprechung.pdf` and `materialfreigabe.pdf`: project correspondence.
- The corresponding `.eml` and `.msg` files include readable German email text
  and an actual PDF attachment. No tracker, script or external attachment URL.

Maintainer regeneration, when intentionally changing the fixtures:

1. Install Python `reportlab`, `ezdxf` and `pymupdf` in an isolated environment.
2. Run `generate-pdfs.py` and visually inspect all four PDFs.
3. Convert the two committed DXF sources once with GNU LibreDWG 0.14:
   `dxf2dwg --as r2000 -o grundriss-erdgeschoss.dwg grundriss-erdgeschoss.dxf`
   (and similarly for the upper floor). Read them back and check visible entities.
4. Run `generate-mails.mjs` with the monorepo webapp dependencies installed.
5. Update `manifest.json`. Its checksums are verified by the Rust tests.

The DXF sources are included for reproducibility. LibreDWG is a maintainer tool,
not a runtime or browser dependency. Its code is not included in these files.
